// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/gmail-attachments-to-drive-by-type
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
// Only Google Drive needs one: the Gmail credential lives on the TRIGGER
// (publish --trigger authentication_id), and Files by Zapier / AI by Zapier
// both run on built-in credentials with no connection at all.
const DRIVE_APP_KEY = "GoogleDriveCLIAPI";
const DRIVE_CONNECTION = "gdrive";

const FILES_APP_KEY = "FilesByZapierCLIAPI";
const AI_APP_KEY = "AICLIAPI";

// AI by Zapier on Zapier's built-in credentials ("0" = Included in Plan).
//
// TIER = TASK COST. The only valid values are `standard/auto`, `advanced/auto`
// and `premium/auto`, billed at 1x / 3x / 5x tasks per run respectively (plus
// the same multiplier again per tool call — this step makes none). Standard is
// Zapier's recommended tier for classification and extraction, which is exactly
// this workload; the Advanced default exists mainly to enable tool calls.
//
// Standard was verified to reach the same routing verdict as Advanced on every
// case in the README's "Verified behaviour" table, including SimplePay's
// statement-history inference, stable across repeat runs. Re-run those cases
// before changing this.
const AI_MODEL = "standard/auto";
const AI_AUTHENTICATION = "0";

// Destination folders under Google Drive.
const FOLDER_INVOICES = "14RpcjSzye4BVZPS_1OzspabmQzDwFVRE";
const FOLDER_PAID_RECEIPTS = "1te8aN26Kl5PVH3qY1bXrw9vzX3CfsQwC";
const FOLDER_SIGNED_AGREEMENTS = "1-1HCfTIdnngXv_1fhUHuPpjI6Nupk7-K";
const FOLDER_FINANCIAL_REPORTING = "1t719k98AHrfMVgcrSNOx9REIvnsL8_Bo";

/**
 * Category -> destination folder. A category absent from this map is filed
 * nowhere; that is deliberate and matches the classic Zap, which had branches
 * for only these four destinations.
 *
 * `Vendor Account Statement` and `Other` are classified but never filed — the
 * classifier still emits them so run history shows what was seen and skipped.
 */
const CATEGORY_FOLDERS: Record<string, { id: string; name: string }> = {
  Invoice: { id: FOLDER_INVOICES, name: "Invoices" },
  Receipt: { id: FOLDER_PAID_RECEIPTS, name: "Paid Receipts" },
  "Legal Agreement": { id: FOLDER_SIGNED_AGREEMENTS, name: "Signed Agreements" },
  "Governance Document": { id: FOLDER_SIGNED_AGREEMENTS, name: "Signed Agreements" },
  "Financial Statements": { id: FOLDER_FINANCIAL_REPORTING, name: "Financial Reporting" },
};

// --- Skip gates -------------------------------------------------------------
// Carried over from the classic Zap's "A bunch of filters" step. The Gmail
// trigger query excludes most of these too, but Gmail's phrase matching is
// fuzzy, so these code checks are the authoritative gate.

/** Zapier's own notification mailer — never a business document. */
const BLOCKED_SENDERS = new Set(["no-reply.1tdl9c@zapiermail.com"]);

/**
 * Subject substrings that disqualify an email outright (case-insensitive).
 * `from Company Flow` catches OUR OWN outgoing invoices, which Xero mails us a
 * copy of — those are accounts-receivable, not bills to pay.
 */
const BLOCKED_SUBJECTS = [
  "your monthly aspire account statement",
  "from company flow",
  "your trade statement for assets",
  "your monthly statement for assets",
];

/** Gmail labels that mean we sent it, not received it. */
const BLOCKED_LABELS = new Set(["SENT", "DRAFT"]);

/** Attachments processed per email. Beyond this, the overflow is logged rather
 *  than silently dropped — see `attachmentsSkippedOverCap` in the output. */
const MAX_ATTACHMENTS = 10;

/** Extracted characters per PDF fed to the classifier. Long agreements are cut;
 *  the category is always evident well inside this budget. */
const MAX_TEXT_CHARS = 20000;

/** Email body characters fed to the classifier as context. */
const MAX_BODY_CHARS = 2000;

// The Gmail "New Email Matching Search" trigger delivers a message object.
// Accept anything and extract defensively.
const InputSchema = z.unknown();

// --- Pure helpers ----------------------------------------------------------
function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline can deliver input double-encoded (a JSON string of a
  // JSON string), while run-durable delivers it single-encoded. Parse until we
  // reach a non-string, or stop on parse failure.
  let v: unknown = rawInput;
  for (let i = 0; i < 4 && typeof v === "string"; i++) {
    const t = v.trim();
    if (t[0] !== "{" && t[0] !== "[" && t[0] !== '"') break;
    try {
      v = JSON.parse(t);
    } catch {
      break;
    }
  }
  return v;
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

/** First item of a runAction result ({ data: [...] } or a bare array). */
function firstResult(res: any): any {
  if (res && Array.isArray(res.data)) return res.data[0] ?? null;
  if (Array.isArray(res)) return res[0] ?? null;
  return res ?? null;
}

/** Invoice numbers are compared across two documents that format them
 *  differently ("2215-5909-1740" vs "2215 5909 1740"), so strip everything
 *  that isn't alphanumeric and uppercase what's left. */
function normalizeInvoiceNumber(v: unknown): string {
  return String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Short strings match by accident ("1", "INV"), so a number is only usable as
 *  a cross-document join key once it's long enough to be distinctive. */
const MIN_INVOICE_NUMBER_LENGTH = 4;

// --- Extracted-text hygiene -------------------------------------------------
// Everything a `ctx.step` returns is checkpointed to PostgreSQL as JSON. Postgres
// rejects a JSON string containing U+0000 outright with SQLSTATE 22P05
// ("unsupported Unicode escape sequence"), and the durable framework surfaces
// that only as `checkpoint failed`. Because the step's input is identical on
// every retry, the checkpoint fails identically all 5 times and the run dies with
// StepExhaustedError — a failure the step's own try/catch cannot see, because it
// happens after the function returns. So nothing that could carry a control
// character may leave the extract step unscrubbed.

/**
 * Files by Zapier hands back the file's RAW BYTES decoded as text when it can't
 * convert a PDF and `failOnConversionError: false` stops it from throwing. That
 * is what a password-protected PDF produces: 128 KB beginning `%PDF-1.6`, ~38%
 * U+FFFD replacement characters and ~10% control characters, NULs included.
 *
 * It is not text, and it must not be treated as text: fed to the classifier it
 * would burn MAX_TEXT_CHARS of binary noise for nothing, and checkpointed it
 * kills the run. Genuine extracted text carries essentially none of either
 * marker, so the thresholds sit far below what was measured on the real file.
 */
function looksLikeRawFileBytes(text: string): boolean {
  if (/^\s*(%PDF-|PK\x03\x04|\x89PNG)/.test(text)) return true;
  const sample = text.slice(0, 4000);
  if (sample.length === 0) return false;
  let control = 0;
  let replacement = 0;
  for (const ch of sample) {
    const c = ch.codePointAt(0)!;
    if (c === 0xfffd) replacement++;
    else if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) control++;
  }
  return control / sample.length > 0.02 || replacement / sample.length > 0.05;
}

/**
 * Drop the characters PostgreSQL's JSON parser refuses — NUL and the rest of the
 * C0 controls (tab/newline/carriage return kept, they are legitimate in extracted
 * text) plus lone surrogates, which are unrepresentable in UTF-8.
 *
 * Applied to every string leaving the step, including error messages: an upstream
 * error that quotes the offending bytes back at us would checkpoint just as badly
 * as the text itself.
 */
const C0_EXCEPT_WHITESPACE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function stripUncheckpointableChars(text: string): string {
  return text.replace(C0_EXCEPT_WHITESPACE, "").replace(LONE_SURROGATE, "");
}

interface Attachment {
  filename: string;
  url: string;
  mimeType: string | null;
  size: number | null;
}

function isPdf(a: { filename: string; mimeType: string | null }): boolean {
  if (a.mimeType && /pdf/i.test(a.mimeType)) return true;
  return /\.pdf$/i.test(a.filename);
}

/**
 * Every PDF on the message.
 *
 * Gmail's message resource exposes attachments three ways — an
 * `attachmentsArray`, numbered `attachment_1`/`attachment_2`/… keys, and the
 * raw MIME `payload.parts` tree. The array is the normal path; the numbered
 * keys are read as a fallback, deduped on URL, because a message shape that
 * omits the array would otherwise silently file nothing.
 */
function extractAttachments(m: Record<string, any>): Attachment[] {
  const out: Attachment[] = [];
  const seen = new Set<string>();

  const push = (raw: any) => {
    if (!raw || typeof raw !== "object") return;
    const url = firstString(raw.attachment, raw.file, raw.url);
    const filename = firstString(
      raw.truncatedFileName,
      raw.filename,
      raw.file_name,
      raw.name,
    );
    if (!url || !filename || seen.has(url)) return;
    const size = typeof raw.size === "number" ? raw.size : null;
    const att: Attachment = {
      filename,
      url,
      mimeType: firstString(raw.mime_type, raw.mimeType),
      size,
    };
    if (!isPdf(att)) return;
    seen.add(url);
    out.push(att);
  };

  if (Array.isArray(m.attachmentsArray)) m.attachmentsArray.forEach(push);
  for (const [key, value] of Object.entries(m)) {
    if (/^attachment_\d+$/.test(key)) push(value);
  }
  return out;
}

interface Email {
  messageId: string | null;
  threadId: string | null;
  subject: string;
  fromEmail: string;
  fromName: string;
  date: string;
  bodyPlain: string;
  labels: string[];
  attachments: Attachment[];
}

function extractEmail(raw: unknown): Email | null {
  const o = (raw ?? {}) as Record<string, any>;
  const m = (o.message ?? o.data ?? o) as Record<string, any>;
  if (!m || typeof m !== "object") return null;
  const labels = (Array.isArray(m.labels) ? m.labels : [])
    .map((l: unknown) => firstString(l))
    .filter((l: unknown): l is string => typeof l === "string");
  return {
    messageId: firstString(m.message_id, m.id),
    threadId: firstString(m.thread_id),
    subject: firstString(m.subject) ?? "",
    fromEmail: (firstString(m.from?.email, m.from) ?? "").toLowerCase(),
    fromName: firstString(m.from?.name) ?? "",
    date: firstString(m.date) ?? "",
    bodyPlain: firstString(m.body_plain, m.body_html) ?? "",
    labels,
    attachments: extractAttachments(m),
  };
}

/** Why this email is not worth classifying, or null to proceed. */
function blockReason(email: Email): string | null {
  if (email.labels.some((l) => BLOCKED_LABELS.has(l.toUpperCase()))) {
    return `message carries a ${email.labels.find((l) => BLOCKED_LABELS.has(l.toUpperCase()))} label`;
  }
  if (BLOCKED_SENDERS.has(email.fromEmail)) {
    return `blocked sender ${email.fromEmail}`;
  }
  const subject = email.subject.toLowerCase();
  const hit = BLOCKED_SUBJECTS.find((s) => subject.includes(s));
  if (hit) return `blocked subject phrase "${hit}"`;
  if (email.attachments.length === 0) return "no PDF attachments";
  return null;
}

// --- Classifier -------------------------------------------------------------

/**
 * PROMPT SOURCE OF TRUTH: ./classifier-prompt.md
 *
 * The markdown file is the reviewable copy and this literal must match its
 * "## Prompt" section verbatim (repo rule 6). `node scripts/check-prompts.mjs`
 * from the repo root fails the moment the two drift apart.
 *
 * Backticks and `${` are escaped here only to survive the template literal —
 * the check script reverses that before comparing.
 */
const CLASSIFIER_PROMPT = `You are a document-filing assistant for **Company Flow Pte. Ltd.**, trading as **workFlowers** — a private limited company incorporated in Singapore (UEN 202442050M). Your classifications drive an automation that files business documents into Google Drive, so accuracy matters more than speed.

You are given **one email** — its sender, subject, date and body — together with **every PDF attachment on that email**, each with its filename and extracted text. Attachments are numbered starting at 1.

Return **one result object per attachment, in the same order as the attachments were given**. Never merge, reorder, split or omit attachments: if you are given 3 attachments, return exactly 3 objects.

### Categories

Classify each attachment as exactly one of:

- **Invoice** — a request for payment addressed to us. States an amount owed and typically an invoice number, issue date and due date.
- **Receipt** — confirmation that a payment has already been completed. Includes payment confirmations, credit-card charge confirmations and tax receipts.
- **Legal Agreement** — a fully executed contract, including statements of work, project addendums, master services agreements and NDAs. Only classify here when the document is signed or otherwise evidently executed; an unsigned draft for review is **Other**.
- **Governance Document** — corporate governance records such as directors' resolutions, shareholder resolutions, board minutes and share certificates.
- **Vendor Account Statement** — a periodic statement of account from a vendor summarising activity over a period, rather than billing a single transaction.
- **Financial Statements** — financial statements, management accounts, tax filings or incorporation documents **for Company Flow Pte. Ltd. / workFlowers itself**. Another company's financial statements are **Other**.
- **Other** — anything that fits none of the above: marketing material, newsletters, tickets, boarding passes, unsigned drafts, personal documents.

### The rule that matters most

The Invoices folder exists to hold **bills that still need to be paid**. An invoice that has already been settled must not be filed there.

So for every attachment you classify as **Invoice**, you must also work out whether it is already paid.

#### Payment evidence within the document

Mark **Payment Status** as \`Paid\` when the document itself shows any of:

- an amount due of zero
- an explicit paid marker — "Paid", "Paid on <date>", "Date paid", "Payment received", "Thank you for your payment", "No payment due"
- a payment method and card last-four digits recorded against the transaction
- a payment-history table with a settled row covering the full amount

Mark it \`Unpaid\` when the document requests payment, shows a non-zero amount outstanding, and carries none of the above.

**Do not treat a due date equal to the issue date as evidence of payment.** Due-on-receipt terms are common on invoices that are genuinely unpaid and still need attention.

Use \`Not Applicable\` for any attachment that is not an Invoice or a Receipt.

#### Payment evidence from a sibling attachment

This is the case that a document-by-document reading gets wrong.

SaaS vendors charging a credit card routinely send **a single email carrying both the invoice and its receipt**. Read alone, the invoice looks unpaid — it shows an amount due, a "pay online" link and payment instructions, with no paid marker anywhere on it. The only proof of settlement is the *other* attachment.

For each **Invoice**, set **Superseded By Receipt** to \`Yes\` when another attachment on this same email is a receipt or payment confirmation for the same transaction. Establish that they are the same transaction by, in order of preference:

1. **the same invoice number** appearing on both documents — receipts normally quote the invoice number they settle;
2. failing that, the same vendor, the same total amount and dates within a few days of each other.

Set it to \`No\` when there is no such sibling. Set it to \`No\` for every attachment that is not an Invoice.

Also weigh the email itself. A subject such as "Your receipt from <vendor>", or a body confirming that a card has been charged, is strong evidence that the transaction the attachments describe is already settled.

#### Payment evidence from a sibling account statement

There is a second way a vendor bills a card automatically, and it leaves no receipt at all.

Some vendors email a monthly invoice together with an **account statement**, where the statement is generated the moment the invoice is issued — before that month's card charge has posted. The statement therefore shows the new invoice as an open balance even though it will be settled automatically within the day. What gives it away is the *history* above that line: every previous invoice on the same statement is immediately followed by a payment that clears it.

For an **Invoice**, set **Auto-Paid By Recurring Charge** to \`Yes\` only when **all** of these hold:

1. Another attachment on this email is an account statement for the same vendor and account.
2. That statement lists **at least three prior invoices**, and **every one of them** is followed by a payment entry that clears its balance to zero.
3. Those settling payments post **on the same day as their invoice**, or within one day of it — that is what marks the charge as automatic rather than manually paid later.
4. The invoice being classified is the **most recent** line on the statement, and the only one left outstanding.
5. Nothing indicates the arrangement has lapsed — no dunning notice, no overdue or suspension warning, no failed-payment entry, no change-of-payment-method notice.

When every one of those holds, also set **Payment Status** to \`Paid\`, and say in **Payment Evidence** how many prior invoices show the pattern and what the settling entries are called.

If any condition fails — a gap in the history, payments posting weeks later, more than one outstanding balance, fewer than three priors — set it to \`No\` and treat the invoice as unpaid. A vendor that merely *offers* card payment, without a statement history proving it is actually being used, does **not** qualify.

Set **Auto-Paid By Recurring Charge** to \`No\` for every attachment that is not an Invoice.

### Bias

When you genuinely cannot tell, prefer \`Unpaid\` / \`No\` over guessing.

Filing an already-paid invoice is a small annoyance — someone deletes it. Skipping a genuinely unpaid invoice means a real bill is never seen and goes unpaid. Err toward filing.

### Per-attachment fields

For each attachment return:

- **Attachment Filename** — copied verbatim from the attachment you are describing, so each result can be matched back to its file.
- **Document Category** — one of the seven categories above.
- **Payment Status** — \`Paid\`, \`Unpaid\`, or \`Not Applicable\`.
- **Superseded By Receipt** — \`Yes\` or \`No\`, per the sibling-receipt rule above.
- **Auto-Paid By Recurring Charge** — \`Yes\` or \`No\`, per the sibling-statement rule above.
- **Payment Evidence** — one sentence naming the specific text or sibling attachment your Payment Status, Superseded By Receipt and Auto-Paid By Recurring Charge conclusions rest on. Quote the wording where you can. Leave blank where Payment Status is \`Not Applicable\`.
- **Invoice Number** — the invoice number the document relates to. Populate for both invoices and receipts, since matching the two depends on it. Blank if absent.
- **Invoice Date** — issue date, ISO-8601 (\`YYYY-MM-DD\`). Blank if absent.
- **Due Date** — payment due date, ISO-8601 (\`YYYY-MM-DD\`). Blank if absent.
- **Amount** — the document's total, digits and decimal point only, no currency symbol or thousands separators (e.g. \`133.58\`). Blank if absent.
- **Currency** — ISO-4217 code (e.g. \`SGD\`, \`USD\`). Blank if absent.
- **Vendor** — the counterparty issuing the document, not us. Blank if unclear.
- **Justification** — two or three sentences explaining the category you chose and why.`;

/**
 * Structured output, one object per attachment (`isOutputArray: true`).
 * Descriptions are kept in step with the wording in classifier-prompt.md.
 */
const OUTPUT_FIELDS = [
  {
    name: "Attachment Filename",
    description: "Filename copied verbatim from the attachment being described, so the result can be matched back to its file.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Document Category",
    description: "The category of the document.",
    type: "category_single",
    isRequired: true,
    options: [
      "Invoice",
      "Receipt",
      "Legal Agreement",
      "Governance Document",
      "Vendor Account Statement",
      "Financial Statements",
      "Other",
    ],
  },
  {
    name: "Payment Status",
    description: "Whether the document shows its amount as already paid. Not Applicable for anything that is not an invoice or a receipt.",
    type: "category_single",
    isRequired: true,
    options: ["Paid", "Unpaid", "Not Applicable"],
  },
  {
    name: "Superseded By Receipt",
    description: "For an Invoice: whether another attachment on this same email is a receipt or payment confirmation for the same transaction.",
    type: "category_single",
    isRequired: true,
    options: ["Yes", "No"],
  },
  {
    name: "Auto-Paid By Recurring Charge",
    description: "For an Invoice: whether an account statement on this same email proves the vendor auto-charges a card — at least three prior invoices each cleared by a same-day payment, this invoice the only one outstanding.",
    type: "category_single",
    isRequired: true,
    options: ["Yes", "No"],
  },
  {
    name: "Payment Evidence",
    description: "One sentence naming the specific text or sibling attachment the payment conclusions rest on.",
    type: "text",
    isRequired: false,
  },
  {
    name: "Invoice Number",
    description: "The invoice number the document relates to. Populated for both invoices and receipts, since matching the two depends on it.",
    type: "text",
    isRequired: false,
  },
  {
    name: "Invoice Date",
    description: "Issue date, ISO-8601 (YYYY-MM-DD).",
    type: "date",
    isRequired: false,
  },
  {
    name: "Due Date",
    description: "Payment due date, ISO-8601 (YYYY-MM-DD).",
    type: "date",
    isRequired: false,
  },
  {
    name: "Amount",
    description: "The document total, digits and decimal point only, no currency symbol or thousands separators.",
    type: "text",
    isRequired: false,
  },
  {
    name: "Currency",
    description: "ISO-4217 currency code.",
    type: "text",
    isRequired: false,
  },
  {
    name: "Vendor",
    description: "The counterparty issuing the document, not us.",
    type: "text",
    isRequired: false,
  },
  {
    name: "Justification",
    description: "Two or three sentences explaining the chosen category and the reasoning behind it.",
    type: "text",
    isRequired: true,
  },
];

interface Classification {
  filename: string;
  category: string;
  paymentStatus: string;
  supersededByReceipt: boolean;
  autoPaidByRecurringCharge: boolean;
  paymentEvidence: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  dueDate: string | null;
  amount: string;
  currency: string;
  vendor: string;
  justification: string;
}

/** Map one model row onto the fields the routing logic reads. */
function readClassification(row: any, fallbackFilename: string): Classification {
  const get = (k: string) => firstString(row?.[k]) ?? "";
  return {
    filename: get("Attachment Filename") || fallbackFilename,
    category: get("Document Category"),
    paymentStatus: get("Payment Status"),
    supersededByReceipt: get("Superseded By Receipt").toLowerCase() === "yes",
    autoPaidByRecurringCharge:
      get("Auto-Paid By Recurring Charge").toLowerCase() === "yes",
    paymentEvidence: get("Payment Evidence"),
    invoiceNumber: get("Invoice Number"),
    invoiceDate: firstString(row?.["Invoice Date"]),
    dueDate: firstString(row?.["Due Date"]),
    amount: get("Amount"),
    currency: get("Currency"),
    vendor: get("Vendor"),
    justification: get("Justification"),
  };
}

/**
 * Pair each attachment with its classification.
 *
 * Matched on filename first — the model is asked to echo it back precisely so
 * results survive any reordering — then falling back to positional order for a
 * row whose filename didn't come back clean. Each row is consumed at most once,
 * so two attachments sharing a name can't both bind to the same result.
 */
function alignClassifications(
  attachments: Attachment[],
  rows: any[],
): Array<Classification | null> {
  const used = new Set<number>();
  const byName = new Map<string, number>();
  rows.forEach((row, i) => {
    const name = firstString(row?.["Attachment Filename"]);
    if (name && !byName.has(name)) byName.set(name, i);
  });

  return attachments.map((att, i) => {
    const named = byName.get(att.filename);
    if (named !== undefined && !used.has(named)) {
      used.add(named);
      return readClassification(rows[named], att.filename);
    }
    if (i < rows.length && !used.has(i)) {
      used.add(i);
      return readClassification(rows[i], att.filename);
    }
    return null;
  });
}

type Decision =
  | { action: "file"; folderId: string; folderName: string; reason: string }
  | { action: "skip"; reason: string };

/**
 * Route each classified attachment to a folder, or drop it.
 *
 * The whole point of classifying an email's attachments together is this
 * function: an invoice is withheld from the Invoices folder when the SAME email
 * also carries the receipt that settles it. Four independent signals establish
 * that, checked strongest first so the recorded reason names the real evidence.
 */
function decide(classifications: Array<Classification | null>): Decision[] {
  const present = classifications.filter((c): c is Classification => c !== null);

  // Invoice numbers quoted by RECEIPTS on this email. Collected from receipts
  // only, so an invoice can never mark itself settled.
  const receiptInvoiceNumbers = new Set(
    present
      .filter((c) => c.category === "Receipt")
      .map((c) => normalizeInvoiceNumber(c.invoiceNumber))
      .filter((n) => n.length >= MIN_INVOICE_NUMBER_LENGTH),
  );

  // Is there a receipt on this email at all? Both receipt-based signals are
  // gated on this. Without it the model can report "superseded by receipt" on
  // an email whose only sibling is a STATEMENT — observed on SimplePay — which
  // reaches the right verdict by the wrong route and records a reason that
  // names evidence that does not exist.
  const hasReceipt = present.some((c) => c.category === "Receipt");

  // A receipt on this email that isn't itself flagged unpaid. Used only as the
  // last, weakest signal, and only when there's more than one attachment.
  const hasSettlingReceipt = present.some(
    (c) => c.category === "Receipt" && c.paymentStatus !== "Unpaid",
  );

  // The recurring-auto-charge signal is only meaningful when an account
  // statement is actually attached — that statement's payment history IS the
  // evidence. Requiring one here is a cheap structural check on the model's
  // claim: no statement, no way for the pattern to have been observed.
  const hasVendorStatement = present.some(
    (c) => c.category === "Vendor Account Statement",
  );

  return classifications.map((c) => {
    if (!c) {
      return { action: "skip", reason: "no classification returned for this attachment" };
    }
    const folder = CATEGORY_FOLDERS[c.category];
    if (!folder) {
      return {
        action: "skip",
        reason: c.category
          ? `category "${c.category}" has no destination folder`
          : "classifier returned no category",
      };
    }

    if (c.category === "Invoice") {
      const number = normalizeInvoiceNumber(c.invoiceNumber);
      if (number.length >= MIN_INVOICE_NUMBER_LENGTH && receiptInvoiceNumbers.has(number)) {
        return {
          action: "skip",
          reason: `already paid — a receipt on this email settles invoice ${c.invoiceNumber}`,
        };
      }
      if (c.supersededByReceipt && hasReceipt) {
        return {
          action: "skip",
          reason: "already paid — classifier matched a receipt on this email to this invoice",
        };
      }
      if (c.autoPaidByRecurringCharge && hasVendorStatement) {
        return {
          action: "skip",
          reason:
            "already paid — the account statement on this email shows this vendor's invoices auto-cleared by same-day card payments",
        };
      }
      if (c.paymentStatus === "Paid") {
        return { action: "skip", reason: "already paid — payment markers on the invoice itself" };
      }
      if (hasSettlingReceipt && present.length > 1) {
        return {
          action: "skip",
          reason: "already paid — this email also carries a paid receipt",
        };
      }
    }

    return {
      action: "file",
      folderId: folder.id,
      folderName: folder.name,
      reason: `${c.category} -> ${folder.name}`,
    };
  });
}

// --- Workflow ----------------------------------------------------------------
// Gmail "New Email Matching Search" -> classify every PDF on the email in ONE
// AI call -> file each to its Google Drive folder.
//
// WHY PER-EMAIL, NOT PER-ATTACHMENT. The classic Zap this replaces used Gmail's
// "New Attachment" trigger, which fires once per attachment, so each PDF was
// classified with no knowledge of its siblings. That makes the SaaS case
// unsolvable: a card-billed vendor sends ONE email carrying both the invoice and
// its receipt, and the invoice PDF on its own shows an amount due, a pay-online
// link and no paid marker anywhere. Its only evidence of settlement is the other
// attachment. Triggering per email puts both PDFs in front of the classifier at
// once, so the invoice can be recognised as already paid and withheld from the
// Invoices folder — which exists to hold bills that still need paying.
//
// It also costs less: one AI call per email instead of one per attachment.
//
// WHAT THE OLD "DUE DATE == INVOICE DATE" FILTER DID. The classic Zap dropped
// any invoice whose due date equalled its issue date, as a proxy for "billed to
// a card, already paid". That is dropped here: due-on-receipt terms are common
// on invoices that are genuinely unpaid, and silently discarding them means a
// real bill is never seen. Payment is now established from evidence — a sibling
// receipt, or paid markers in the document — not from date arithmetic.
const workflow = defineDurable<Record<string, unknown>, unknown>(
  "gmail-attachments-to-drive-by-type",
  async (ctx, rawInput) => {
    const email = extractEmail(InputSchema.parse(normalizeInput(rawInput)));
    if (!email) {
      console.log("skipping: no message in payload (empty/test delivery)");
      return { skipped: true, reason: "no message in payload" };
    }

    const blocked = blockReason(email);
    if (blocked) {
      console.log(`skipping "${email.subject}": ${blocked}`);
      return {
        skipped: true,
        reason: blocked,
        messageId: email.messageId,
        subject: email.subject,
        from: email.fromEmail,
      };
    }

    const attachments = email.attachments.slice(0, MAX_ATTACHMENTS);
    const attachmentsSkippedOverCap = email.attachments
      .slice(MAX_ATTACHMENTS)
      .map((a) => a.filename);
    if (attachmentsSkippedOverCap.length > 0) {
      console.log(
        `WARNING: ${attachmentsSkippedOverCap.length} attachment(s) beyond the ${MAX_ATTACHMENTS} cap were not processed: ${attachmentsSkippedOverCap.join(", ")}`,
      );
    }

    // 1. Extract each PDF's text. Files by Zapier needs no connection.
    //
    // A PDF that won't convert (scanned, encrypted, malformed) yields empty
    // text rather than failing the run — the classifier still sees its filename
    // and the surrounding email, which is often enough to categorise it.
    const extracted = await Promise.all(
      attachments.map((att, index) =>
        ctx.step(`extract-text-${index}`, async () => {
          try {
            const res = await sdk.runAction({
              appKey: FILES_APP_KEY,
              actionType: "write",
              actionKey: "text_from_file_new",
              inputs: { file: att.url, fileType: "pdf", failOnConversionError: false },
            });
            const raw = firstString(firstResult(res)?.text) ?? "";
            // `failOnConversionError: false` means an unconvertible PDF comes
            // back as its own raw bytes rather than as an error. Recognise that
            // and take the empty-text path the caller already handles.
            if (looksLikeRawFileBytes(raw)) {
              return {
                text: "",
                ok: false as const,
                error: "file did not convert to text (encrypted, scanned or malformed PDF)",
              };
            }
            return { text: stripUncheckpointableChars(raw), ok: true as const };
          } catch (err) {
            return {
              text: "",
              ok: false as const,
              error: stripUncheckpointableChars(String((err as Error)?.message ?? err)),
            };
          }
        }),
      ),
    );

    // 2. Classify every attachment in ONE call, with the email as context.
    const inputFields: Record<string, string> = {
      Email: [
        `FROM: ${email.fromName} <${email.fromEmail}>`,
        `SUBJECT: ${email.subject}`,
        `DATE: ${email.date}`,
        "BODY:",
        email.bodyPlain.slice(0, MAX_BODY_CHARS),
      ].join("\n"),
    };
    attachments.forEach((att, index) => {
      inputFields[`Attachment ${index + 1} filename`] = att.filename;
      inputFields[`Attachment ${index + 1} extracted text`] =
        extracted[index].text.slice(0, MAX_TEXT_CHARS) || "(no text could be extracted)";
    });

    const completion = await ctx.step("classify-attachments", async () =>
      sdk.runAction({
        appKey: AI_APP_KEY,
        actionType: "write",
        actionKey: "get_completion",
        inputs: {
          provider_id: "",
          authentication_id: AI_AUTHENTICATION,
          model_id: AI_MODEL,
          isOutputArray: true,
          instructions: CLASSIFIER_PROMPT,
          inputFields,
          outputFields: OUTPUT_FIELDS,
        },
      }),
    );

    const rows: any[] = firstResult(completion)?.result?.items ?? [];
    const classifications = alignClassifications(attachments, rows);
    const decisions = decide(classifications);

    // 3. File each attachment the routing kept.
    const results = await Promise.all(
      attachments.map(async (att, index) => {
        const decision = decisions[index];
        const classification = classifications[index];
        const base = {
          filename: att.filename,
          category: classification?.category ?? null,
          paymentStatus: classification?.paymentStatus ?? null,
          invoiceNumber: classification?.invoiceNumber || null,
          vendor: classification?.vendor || null,
          amount: classification?.amount || null,
          currency: classification?.currency || null,
          invoiceDate: classification?.invoiceDate ?? null,
          dueDate: classification?.dueDate ?? null,
          paymentEvidence: classification?.paymentEvidence || null,
          justification: classification?.justification || null,
          textExtracted: extracted[index].ok && extracted[index].text.length > 0,
        };

        if (decision.action === "skip") {
          console.log(`skip ${att.filename}: ${decision.reason}`);
          return { ...base, filed: false, folder: null, reason: decision.reason, driveFileId: null };
        }

        const uploaded = await ctx.step(`upload-${index}`, async () =>
          sdk.runAction({
            appKey: DRIVE_APP_KEY,
            actionType: "write",
            actionKey: "file",
            connection: DRIVE_CONNECTION,
            inputs: {
              drive: "",
              folder: decision.folderId,
              convert: false,
              file: att.url,
            },
          }),
        );

        console.log(`filed ${att.filename} -> ${decision.folderName}`);
        return {
          ...base,
          filed: true,
          folder: decision.folderName,
          reason: decision.reason,
          driveFileId: firstString(firstResult(uploaded)?.id),
        };
      }),
    );

    return {
      messageId: email.messageId,
      threadId: email.threadId,
      subject: email.subject,
      from: email.fromEmail,
      attachmentCount: email.attachments.length,
      attachmentsSkippedOverCap,
      filedCount: results.filter((r) => r.filed).length,
      skippedCount: results.filter((r) => !r.filed).length,
      attachments: results,
    };
  },
);

export default workflow;
