// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/gmail-attachments-to-drive-by-type
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
// The Gmail credential lives on the TRIGGER (publish --trigger
// authentication_id); Files by Zapier runs on built-in credentials.
const DRIVE_APP_KEY = "GoogleDriveCLIAPI";
const DRIVE_CONNECTION = "gdrive";

const FILES_APP_KEY = "FilesByZapierCLIAPI";

// Jev, called through Zapier's authenticated fetch: the API key lives in an
// "API by Zapier" connection (Bearer auth), so it never appears in source, and
// the request goes out through Zapier's Relay rather than the durable sandbox's
// own network. Billed per input token by TypeSafe (fractions of a cent per
// email), not in Zapier tasks.
const JEV_CONNECTION = "typesafe";
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
// `jev-latest` moves when TypeSafe ships a new release. The thresholds below
// were checked against jev-1.13.0; the response's `model` is logged on every
// run so a silent model change shows up in run history.
const JEV_MODEL = "jev-latest";

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

/** Extracted characters across ALL attachments on one email. Jev accepts about
 *  32k tokens of state per request (~4 chars a token), and a request over that
 *  is rejected outright, so an email with many long PDFs shares this budget
 *  equally instead. The largest email in the 48-email test set used ~22k. */
const MAX_TOTAL_TEXT_CHARS = 80000;

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
// Written with char-code arithmetic instead of regex escape literals on
// purpose: a backslash-u0000 or lone-surrogate escape in this file's OWN SOURCE
// hits the same jsonb 22P05 rejection this function exists to prevent, whenever
// the source is shipped through a JSON channel that decodes escapes (observed
// publishing via the Zapier MCP connector). Keep this block pure printable ASCII.
function stripUncheckpointableChars(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // C0 controls, keeping tab (9), newline (10) and carriage return (13).
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) continue;
    // High surrogate: keep only as half of a valid pair.
    if (c >= 55296 && c <= 56319) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 56320 && next <= 57343) {
        out += text[i] + text[i + 1];
        i++;
      }
      continue;
    }
    // A low surrogate here did not follow a high one: lone, drop it.
    if (c >= 56320 && c <= 57343) continue;
    out += text[i];
  }
  return out;
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
//
// Jev (TypeSafe's System One model) answers TYPED QUESTIONS about the email and
// its attachments: one Choice for the category and four yes/no "Nouls" for the
// payment signals, per attachment, all in one request. It returns
// probabilities, never generated text, so there is nothing to parse and no
// field it can invent. These question definitions are the reviewable "prompt"
// for this step (repo rule 6 — see CLAUDE.md for why they live in code rather
// than a *-prompt.md file).
//
// Verified offline on the 48 most recent real emails (59 PDFs) against the AI by
// Zapier classifier this replaced: same filing outcome on 58, and the 59th was
// a misfile by the old classifier — see the README's "Verified behaviour".

/**
 * Category -> what it means. Every key must stay in step with CATEGORY_FOLDERS
 * and decide(), which match on these exact strings. The money-direction clauses
 * (payments TO us, credit notes) were added after the first offline run filed
 * remittance advices and a Slack credit note as receipts and invoices.
 */
const CATEGORY_CRITERIA: Record<string, string> = {
  Invoice:
    "A request for payment addressed to us (Company Flow Pte. Ltd. / workFlowers) for a charge we owe. States an amount owed and typically an invoice number, issue date and due date. Includes invoices stamped paid. A credit note or notice of credit added to our account is not an invoice.",
  Receipt:
    "A confirmation that a payment WE (Company Flow / workFlowers) made to a vendor has been completed: payment confirmations, card-charge confirmations, tax receipts for our purchases.",
  "Legal Agreement":
    "A fully executed business contract between us and a counterparty — SOW, project addendum, MSA, NDA — that is signed or evidently executed (e.g. a signing certificate or completed e-signature). An unsigned draft for review is Other.",
  "Governance Document":
    "Corporate governance records: directors' or shareholder resolutions, board minutes, share certificates.",
  "Vendor Account Statement":
    "A periodic statement of account from a vendor summarising activity (invoices and payments) over a period, rather than billing one transaction.",
  "Financial Statements":
    "Financial statements, management accounts, tax filings or incorporation documents for Company Flow Pte. Ltd. / workFlowers itself. Another company's financials are Other.",
  Other:
    "Anything else: money coming IN to us (remittance or payment advices from customers or banks, a customer's goods-received note), credit notes, product warranty or coverage terms, marketing, newsletters, tickets, boarding passes, booking confirmations, unsigned drafts, personal documents, documents issued BY us to a client.",
};

/** The five questions asked about attachment `i` (0-based in `attachments`). */
function jevQuestions(count: number): Record<string, unknown> {
  const qs: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    const ref = `attachments[${i}]`;
    qs[`category_${i}`] = {
      type: "choice",
      instructions: `Which kind of business document is \`${ref}\`, from the point of view of Company Flow Pte. Ltd. (workFlowers) filing its own records?`,
      criteria: CATEGORY_CRITERIA,
    };
    qs[`paid_${i}`] = {
      type: "noul",
      instructions: `Does \`${ref}\` itself show that the payment it describes has already been completed?`,
      criteria: {
        true: 'The document shows an amount due of zero, an explicit paid marker ("Paid", "Date paid", "Payment received", "Thank you for your payment", "No payment due"), a card or payment method recorded against the transaction, or a payment-history row settling the full amount.',
        false:
          "The document requests payment or shows a non-zero amount outstanding, with none of those markers. A due date equal to the issue date is NOT evidence of payment.",
      },
    };
    qs[`superseded_${i}`] = {
      type: "noul",
      instructions: `Is a DIFFERENT attachment on this email a receipt or payment confirmation for the same transaction as \`${ref}\` (same invoice number, or same vendor, same total and dates within a few days)?`,
    };
    qs[`autopaid_${i}`] = {
      type: "noul",
      instructions: `Is a DIFFERENT attachment on this email an account statement for the same vendor as \`${ref}\` whose history lists at least three earlier invoices, EACH followed by a payment clearing it on the same day or the next day, with \`${ref}\` being the newest and only outstanding line?`,
    };
    qs[`lapsed_${i}`] = {
      type: "noul",
      instructions: `Does anything on this email indicate that automatic payment for \`${ref}\` has lapsed — a dunning or overdue notice, suspension warning, failed payment, or payment-method change?`,
    };
  }
  return qs;
}

/**
 * Yes/no thresholds. 0.5 is the natural cut for a calibrated probability; the
 * "when unsure, file it" bias lives in decide(), which only withholds an
 * invoice on a positive signal. Re-run the offline cases before moving these.
 */
const PAID_THRESHOLD = 0.5;
const SIGNAL_THRESHOLD = 0.5;

/**
 * The invoice number a document quotes, found in CODE rather than by the model:
 * signal 1 of decide() is a deterministic join between an invoice and the
 * receipt that settles it, so the join key must be copied verbatim from the
 * text. "Invoice number YIGHXGH9-0008", "Invoice #1148057", "Invoice No: X",
 * or a bare "INV-0083".
 *
 * Table-layout PDFs extract the label and its value apart ("Invoice No:\r\n
 * Billing Period:\r\nInvoice Date:\r\n…\r\nINV-26-0008"), so after the label
 * this takes the first nearby token that contains a digit and isn't a date,
 * rather than the next word. On the 48-email test set that matched the old AI
 * classifier's number on every invoice and receipt that arrived in a pair.
 */
function invoiceNumberFromText(text: string): string {
  const label = /invoice\s*(?:number|no\b\.?|num(?:ber)?\b|#)/gi;
  const date = /^(?:\d{1,4}[\/.-]\d{1,2}[\/.-]\d{1,4}|\d{1,2}-[A-Za-z]{3}-\d{2,4})$/;
  for (const m of text.matchAll(label)) {
    const window = text.slice(m.index + m[0].length, m.index + m[0].length + 200);
    for (const t of window.matchAll(/[A-Z0-9][A-Z0-9\-\/]{3,}/gi)) {
      if (/\d/.test(t[0]) && !date.test(t[0])) return t[0];
    }
  }
  const bare = text.match(/\b(INV-?\d{3,})\b/i);
  return bare ? bare[1] : "";
}

interface Classification {
  filename: string;
  category: string;
  paymentStatus: string;
  supersededByReceipt: boolean;
  autoPaidByRecurringCharge: boolean;
  invoiceNumber: string;
}

/** Jev's per-attachment probabilities, kept in the run output for review. */
interface JevSignals {
  category: string;
  categoryProbability: number;
  paid: number;
  superseded: number;
  autoPaid: number;
  lapsed: number;
}

/** Read one attachment's answers off a Jev response; null if any is missing. */
function readJevSignals(answers: any, i: number): JevSignals | null {
  const category = answers?.[`category_${i}`];
  const nouls = ["paid", "superseded", "autopaid", "lapsed"].map(
    (k) => answers?.[`${k}_${i}`]?.noul,
  );
  if (typeof category?.choice !== "string" || nouls.some((n) => typeof n !== "number")) {
    return null;
  }
  return {
    category: category.choice,
    categoryProbability: Number(category.probabilities?.[category.choice] ?? 0),
    paid: nouls[0],
    superseded: nouls[1],
    autoPaid: nouls[2],
    lapsed: nouls[3],
  };
}

/** Turn Jev's probabilities into the yes/no fields decide() routes on. */
function toClassification(
  filename: string,
  text: string,
  s: JevSignals | null,
): Classification | null {
  if (!s) return null;
  const isInvoice = s.category === "Invoice";
  const isMoney = isInvoice || s.category === "Receipt";
  return {
    filename,
    category: s.category,
    // A receipt is by definition a completed payment; only an invoice's paid
    // state is in question.
    paymentStatus: !isMoney
      ? "Not Applicable"
      : s.category === "Receipt" || s.paid >= PAID_THRESHOLD
        ? "Paid"
        : "Unpaid",
    supersededByReceipt: isInvoice && s.superseded >= SIGNAL_THRESHOLD,
    autoPaidByRecurringCharge:
      isInvoice && s.autoPaid >= SIGNAL_THRESHOLD && s.lapsed < SIGNAL_THRESHOLD,
    invoiceNumber: isMoney ? invoiceNumberFromText(text) : "",
  };
}

/** Jev statuses worth a step retry: rate limits and server-side failures. */
function isRetryableJevStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

type Decision =
  | { action: "file"; folderId: string; folderName: string; reason: string }
  | { action: "skip"; reason: string };

/**
 * Route each classified attachment to a folder, or drop it.
 *
 * The whole point of classifying an email's attachments together is this
 * function: an invoice is withheld from the Invoices folder when the SAME email
 * also carries the receipt that settles it. Independent signals establish that,
 * checked strongest first so the recorded reason names the real evidence.
 *
 * A PAID INVOICE IS THE RECEIPT when no actual receipt exists. Card-billed
 * vendors often send no separate receipt at all — just the invoice stamped
 * "Paid" (Aspire), or an invoice plus a statement proving the auto-charge
 * (SimplePay). In those cases the paid invoice is the only record of payment,
 * so it files to Paid Receipts. When the email DOES carry a real receipt, the
 * receipt is the filed record and the invoice still skips — filing both would
 * put two documents for the same payment in the folder.
 */
function decide(
  classifications: Array<Classification | null>,
  readable: boolean[],
): Decision[] {
  // `readable[i]` is false when nothing could be extracted from the PDF —
  // encrypted, scanned, malformed, or converted to genuinely empty text. Such an
  // attachment is classified from its filename and the surrounding email alone,
  // which is a guess, so it is never filed and never counted as evidence about
  // its siblings. An unreadable "Receipt" inferred from a filename must not be
  // able to suppress a real outstanding invoice — that is the expensive mistake
  // this whole function exists to avoid.
  const present = classifications.filter(
    (c, i): c is Classification => c !== null && readable[i],
  );

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

  return classifications.map((c, i) => {
    if (!readable[i]) {
      return {
        action: "skip",
        reason:
          "no text could be extracted — not filed on filename and email evidence alone",
      };
    }
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
      // The invoice's own evidence of settlement: paid markers on the document,
      // or a sibling statement proving the vendor auto-clears every invoice.
      const paidOnOwnEvidence =
        c.paymentStatus === "Paid" || (c.autoPaidByRecurringCharge && hasVendorStatement);
      if (paidOnOwnEvidence) {
        const evidence =
          c.autoPaidByRecurringCharge && hasVendorStatement
            ? "the account statement on this email shows this vendor's invoices auto-cleared by same-day card payments"
            : "payment markers on the invoice itself";
        // A readable receipt on this email always files to Paid Receipts, so
        // it is the record of this payment — the invoice would be a duplicate.
        if (hasReceipt) {
          return {
            action: "skip",
            reason: `already paid — ${evidence}; the receipt on this email is the filed record`,
          };
        }
        // No receipt exists, so the paid invoice IS the receipt.
        return {
          action: "file",
          folderId: FOLDER_PAID_RECEIPTS,
          folderName: "Paid Receipts",
          reason: `paid invoice — ${evidence}; no receipt on this email, so the invoice is the record of payment`,
        };
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
    // text rather than failing the run — the classifier still gets its filename
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

    // 2. Classify every attachment in ONE Jev call, with the email as context.
    // Questions address attachments by index (`attachments[i]`), so answers map
    // back by position with no filename matching.
    const perAttachmentChars = Math.min(
      MAX_TEXT_CHARS,
      Math.floor(MAX_TOTAL_TEXT_CHARS / Math.max(attachments.length, 1)),
    );
    const state = {
      email: [
        `FROM: ${email.fromName} <${email.fromEmail}>`,
        `SUBJECT: ${email.subject}`,
        `DATE: ${email.date}`,
        "BODY:",
        email.bodyPlain.slice(0, MAX_BODY_CHARS),
      ].join("\n"),
      attachments: attachments.map((att, index) => ({
        number: index + 1,
        filename: att.filename,
        text: extracted[index].text.slice(0, perAttachmentChars) || "(no text could be extracted)",
      })),
    };

    const jev = await ctx.step("classify-attachments", async () => {
      const res = await sdk.fetch(JEV_URL, {
        connection: JEV_CONNECTION,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: JEV_MODEL,
          state,
          questions: jevQuestions(attachments.length),
        }),
      });
      const body = await res.text();
      // Throw only where a retry can help. Any other failure is returned so the
      // run fails below with TypeSafe's own message, rather than the step's
      // "exhausted all retry attempts" after three identical rejections.
      if (isRetryableJevStatus(res.status)) {
        throw new Error(`Jev ${res.status}: ${body.slice(0, 500)}`);
      }
      return { status: res.status, body };
    });
    if (jev.status !== 200) {
      throw new Error(`Jev rejected the classification request (${jev.status}): ${jev.body.slice(0, 1000)}`);
    }
    const response = JSON.parse(jev.body);
    console.log(
      `classified by ${response.model} (${response.usage?.input_tokens ?? "?"} input tokens)`,
    );

    const signals = attachments.map((_, index) => readJevSignals(response.answers, index));
    const classifications = attachments.map((att, index) =>
      toClassification(att.filename, extracted[index].text, signals[index]),
    );
    // An attachment is only filed on evidence we could actually read out of it.
    const readable = extracted.map((e) => e.ok && e.text.length > 0);
    const decisions = decide(classifications, readable);

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
          // Jev's raw probabilities, so a surprising decision can be read
          // straight off the run output.
          signals: signals[index],
          textExtracted: readable[index],
          // Why the text is missing — an encrypted PDF and a Files by Zapier
          // failure both land on textExtracted:false but need different fixes.
          textExtractionError: readable[index]
            ? null
            : ("error" in extracted[index] ? extracted[index].error : null) ??
              "converted to empty text",
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
