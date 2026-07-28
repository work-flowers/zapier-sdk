// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/xero-overdue-invoice-to-gmail-reminder
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// The Xero credential is needed in BOTH places: on the TRIGGER (publish
// --trigger authentication_id, which is what polls for overdue invoices) and as
// the `xero_wf` alias here, because the workflow re-reads the invoice to pick
// up its online-invoice URL and PDF. Gmail is only used by the workflow body.
const XERO_APP_KEY = "XeroCLIAPI";
const XERO_CONNECTION = "xero_wf";

const GMAIL_APP_KEY = "GoogleMailV2CLIAPI";
const GMAIL_CONNECTION = "gmail_wf";

/** Xero organisation ("tenant") — workFlowers / Company Flow Pte. Ltd. */
const XERO_ORGANIZATION = "62699a8c-3351-40e8-9265-bdca5e037b03";

/**
 * The only status a reminder may be written for.
 *
 * AUTHORISED is Xero's "Awaiting Payment". DRAFT and SUBMITTED have not been
 * sent to the customer at all, and VOIDED/DELETED/PAID are not owed. The
 * trigger polls on a due-date window, so it can hand over an invoice that was
 * settled between the poll and this run.
 */
const AWAITING_PAYMENT = "AUTHORISED";

/** `overdue_sales_invoice` only reports sales invoices, but a reminder chasing
 *  payment must never be addressed to a supplier we owe (ACCPAY). */
const SALES_INVOICE_TYPE = "ACCREC";

// The Xero "Overdue Sales Invoice" trigger delivers one invoice. Accept
// anything and extract defensively.
const InputSchema = z.unknown();

// --- Pure helpers ----------------------------------------------------------

function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline can deliver input double-encoded (a JSON string of a
  // JSON string), while a manual run delivers it single-encoded. Parse until we
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
  if (!res) return null;
  if (Array.isArray(res)) return res[0] ?? null;
  if (Array.isArray(res.data)) return res.data[0] ?? null;
  return res.data ?? res;
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^0-9.+-]/g, "");
    if (cleaned === "" || cleaned === "-" || cleaned === "+") return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * `YYYY-MM-DD` from epoch milliseconds, without touching `Date`.
 *
 * The durable runtime runs workflow code in GUARDED mode and throws
 * `DeterminismViolation: Non-deterministic API "new Date()" called` on the
 * constructor — including `new Date(ms)`, which is perfectly deterministic.
 * Rather than pay a step just to format a date, this is Hinnant's
 * civil-from-days conversion done in integer arithmetic.
 */
function isoDateFromEpochMs(ms: number): string {
  let z = Math.floor(ms / 86400000) + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` from any of Xero's date spellings, or null.
 *
 *  Xero's `*DateString` fields come back as `2026-07-20T00:00:00`, and the
 *  classic Zap pasted that straight into the email body.
 *  `/Date(1785628800000+0000)/` is the other shape Xero uses, and the one
 *  `DueDate` carries when `DueDateString` is absent. */
function toIsoDate(v: unknown): string | null {
  const s = firstString(v);
  if (!s) return null;
  const plain = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (plain) return plain[1];
  const dotNet = /\/Date\((-?\d+)/.exec(s);
  if (dotNet) {
    const ms = Number(dotNet[1]);
    if (Number.isFinite(ms)) return isoDateFromEpochMs(ms);
  }
  return null;
}

/** Two decimal places, thousands-separated — an amount in an email to a
 *  customer should not read `7398.170000000001`. */
function formatAmount(v: unknown): string | null {
  const n = toNumber(v);
  if (n === null) return null;
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

/** Case-insensitive dedupe of anything that looks like an address. */
function collectEmails(...vals: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of vals.flat(4)) {
    const s = firstString(v);
    if (!s || !EMAIL_RE.test(s)) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * Every contact-person address on a Xero contact.
 *
 * Xero's JSON gives `ContactPersons: [ … ]`, but Zapier's Xero app has been
 * seen rendering the XML shape `ContactPersons: { ContactPerson: … }` — the
 * classic Zap's `Cc` field mapped `Contact.ContactPersons[]EmailAddress`, so
 * both are handled. A person with `IncludeInEmails: false` is excluded: that
 * flag is Xero's own "don't copy this person on invoice email" switch, and
 * ignoring it would chase someone the customer deliberately took off the list.
 */
function contactPersonEmails(contact: any): string[] {
  const raw = contact?.ContactPersons ?? contact?.contact_persons;
  const list: any[] = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.ContactPerson)
      ? raw.ContactPerson
      : raw?.ContactPerson
        ? [raw.ContactPerson]
        : raw && typeof raw === "object"
          ? [raw]
          : [];
  return collectEmails(
    list
      .filter((p) => p?.IncludeInEmails !== false && p?.IncludeInEmails !== "false")
      .map((p) => firstString(p?.EmailAddress, p?.email_address)),
  );
}

interface Invoice {
  invoiceId: string | null;
  invoiceNumber: string | null;
  status: string;
  type: string;
  currency: string | null;
  amountDue: number | null;
  amountDueText: string | null;
  dueDate: string | null;
  reference: string | null;
  contactName: string | null;
  greetingName: string | null;
  onlineInvoiceUrl: string | null;
  pdf: string | null;
  to: string[];
  cc: string[];
}

/** Read the invoice shape Xero's `find_invoice_by_id` returns. */
function readInvoice(payload: any): Invoice {
  const inv = payload?.invoice ?? payload ?? {};
  const contact = inv.Contact ?? inv.contact ?? {};
  const to = collectEmails(firstString(contact.EmailAddress, contact.email_address));
  // Anyone already in To must not also be Cc'd — the classic Zap Cc'd every
  // contact person, including the one whose address is the contact's own.
  const cc = contactPersonEmails(contact).filter(
    (e) => !to.some((t) => t.toLowerCase() === e.toLowerCase()),
  );
  return {
    invoiceId: firstString(inv.InvoiceID, inv.invoice_id, inv.id),
    invoiceNumber: firstString(inv.InvoiceNumber, inv.invoice_number),
    status: (firstString(inv.Status, inv.status) ?? "").toUpperCase(),
    type: (firstString(inv.Type, inv.type) ?? "").toUpperCase(),
    currency: firstString(inv.CurrencyCode, inv.currency_code),
    amountDue: toNumber(inv.AmountDue ?? inv.amount_due),
    amountDueText: formatAmount(inv.AmountDue ?? inv.amount_due),
    dueDate: toIsoDate(inv.DueDateString ?? inv.DueDate ?? inv.due_date),
    reference: firstString(inv.Reference, inv.reference),
    contactName: firstString(contact.Name, contact.name),
    greetingName: firstString(contact.FirstName, contact.first_name),
    onlineInvoiceUrl: firstString(
      inv.OnlineInvoiceUrl,
      inv.online_invoice_url,
      payload?.OnlineInvoiceUrl,
    ),
    // A Zapier file field is an opaque reference string, passed straight
    // through to Gmail's `file` input.
    pdf: firstString(inv.InvoicePDF, inv.invoice_pdf, payload?.InvoicePDF),
    to,
    cc,
  };
}

/**
 * The invoice reference to look up, from whatever the trigger delivered.
 *
 * `find_invoice_by_id` accepts a GUID or an invoice number. Only this one field
 * is taken from the trigger payload — everything the reminder says is read back
 * from Xero, so the workflow does not depend on the trigger's field naming
 * beyond this.
 */
function invoiceRef(payload: any): string | null {
  const inv = payload?.invoice ?? payload ?? {};
  return firstString(
    inv.InvoiceID,
    inv.invoice_id,
    inv.id,
    payload?.InvoiceID,
    payload?.invoice_id,
    payload?.id,
    inv.InvoiceNumber,
    inv.invoice_number,
  );
}

/** A manual run may ask for everything except the draft, so the composed
 *  reminder can be reviewed without leaving a draft behind. The Xero trigger
 *  never sets it. */
function isDryRun(payload: any): boolean {
  const v = payload?.dryRun ?? payload?.dry_run;
  return v === true || v === "true";
}

function buildSubject(inv: Invoice): string {
  return `Reminder: Invoice ${inv.invoiceNumber ?? ""} is Overdue`.replace(/\s+/g, " ").trim();
}

function buildBody(inv: Invoice): string {
  // Kept deliberately close to the classic Zap's wording, with two fixes:
  //
  //  - the classic read "the following invoice from {{Contact.Name}} is now
  //    overdue", which interpolated the *customer's own* name and so told them
  //    their invoice came from themselves. The issuer is workFlowers.
  //  - the due date renders as YYYY-MM-DD rather than `2026-07-20T00:00:00`.
  const details = [
    `Invoice Number: ${inv.invoiceNumber ?? "(not numbered)"}`,
    `Amount Due: ${[inv.currency, inv.amountDueText].filter(Boolean).join(" ") || "(unknown)"}`,
  ];
  if (inv.dueDate) details.push(`Due Date: ${inv.dueDate}`);
  if (inv.reference) details.push(`Reference: ${inv.reference}`);
  if (inv.onlineInvoiceUrl) details.push(`Online Invoice: ${inv.onlineInvoiceUrl}`);

  return [
    `Hi ${inv.greetingName ?? inv.contactName ?? "there"},`,
    "",
    "This is a friendly reminder that the following invoice from workFlowers is now overdue:",
    "",
    ...details,
    "",
    "Please arrange payment at your earliest convenience. If payment has already been made, " +
      "please disregard this notice.",
    "",
    "If you have any questions regarding this invoice, please don't hesitate to reach out.",
    "",
    "Thank you for your prompt attention to this matter.",
    "",
    "Best regards,",
    "Dennis",
  ].join("\n");
}

const workflow = defineDurable<Record<string, unknown>, unknown>(
  "xero-overdue-invoice-to-gmail-reminder",
  async (ctx, rawInput) => {
    const payload = InputSchema.parse(normalizeInput(rawInput)) as any;
    const ref = invoiceRef(payload);
    if (!ref) {
      console.log("skipping: no invoice id or number in payload (empty/test delivery)");
      return { skipped: true, reason: "no invoice reference in payload" };
    }
    const dryRun = isDryRun(payload);

    // 1. Re-read the invoice from Xero. This is the classic Zap's step 2, kept
    //    for the same reason — the online-invoice URL and the PDF are only
    //    returned when asked for — but `include_pdf` is now TRUE. The classic
    //    Zap asked for no PDF here and then attached
    //    `gives[trigger].InvoicePDF`, a field the trigger does not return, so
    //    the reminder it drafted never actually carried the invoice.
    const found = await ctx.step("find-invoice", async () =>
      sdk.runAction({
        appKey: XERO_APP_KEY,
        actionType: "search",
        actionKey: "find_invoice_by_id",
        connection: XERO_CONNECTION,
        inputs: {
          organization: XERO_ORGANIZATION,
          invoice_id: ref,
          include_pdf: true,
          include_online_url: true,
        },
      }),
    );

    const result = firstResult(found);
    if (!result) {
      console.log(`skipping: Xero returned no invoice for ${ref}`);
      return { skipped: true, reason: "invoice not found in Xero", invoiceRef: ref };
    }
    const inv = readInvoice(result);

    // 2. Still-owed guard. The trigger polls a due-date window, so an invoice
    //    can be paid, voided or credited between the poll and this run. Chasing
    //    a customer for money they have already sent is the one failure mode
    //    worth spending code on here.
    if (inv.status !== AWAITING_PAYMENT || (inv.amountDue !== null && inv.amountDue <= 0)) {
      console.log(
        `skipping ${inv.invoiceNumber ?? ref}: no longer awaiting payment ` +
          `(status ${inv.status || "unknown"}, ${inv.amountDue ?? "?"} due)`,
      );
      return {
        skipped: true,
        reason: "invoice is no longer awaiting payment",
        invoice: { number: inv.invoiceNumber, status: inv.status, amountDue: inv.amountDue },
      };
    }

    if (inv.type && inv.type !== SALES_INVOICE_TYPE) {
      console.log(`skipping ${inv.invoiceNumber ?? ref}: type ${inv.type} is not a sales invoice`);
      return { skipped: true, reason: `invoice type ${inv.type} is not ${SALES_INVOICE_TYPE}` };
    }

    // 3. Recipients. The classic Zap addressed the contact's own address and
    //    Cc'd every contact person; a contact with neither produced a draft
    //    addressed to nobody.
    if (inv.to.length === 0 && inv.cc.length === 0) {
      console.log(
        `skipping ${inv.invoiceNumber ?? ref}: ${inv.contactName ?? "the contact"} has no email address in Xero`,
      );
      return {
        skipped: true,
        reason: "contact has no email address in Xero",
        invoice: { number: inv.invoiceNumber, contact: inv.contactName },
      };
    }

    // A contact with only contact-person addresses still deserves a reminder:
    // promote them to To rather than drafting a Cc-only email.
    const to = inv.to.length > 0 ? inv.to : inv.cc;
    const cc = inv.to.length > 0 ? inv.cc : [];

    const message = {
      to,
      cc,
      subject: buildSubject(inv),
      body: buildBody(inv),
      attachedPdf: Boolean(inv.pdf),
    };

    const base = {
      invoice: {
        id: inv.invoiceId,
        number: inv.invoiceNumber,
        status: inv.status,
        contact: inv.contactName,
        currency: inv.currency,
        amountDue: inv.amountDueText,
        dueDate: inv.dueDate,
        reference: inv.reference,
        onlineInvoiceUrl: inv.onlineInvoiceUrl,
      },
      message,
    };

    if (dryRun) {
      console.log(`dry run: would draft a reminder for ${inv.invoiceNumber} to ${to.join(", ")}`);
      return { ...base, outcome: "dry-run", drafted: false };
    }

    // 4. Create the draft — never send. A debt-chasing email goes out only
    //    after a person has read it, which is what the classic Zap did too
    //    (Gmail "Create Draft", not "Send Email").
    //
    //    `from` is deliberately not set: the Gmail connection is
    //    dennis@work.flowers, so the default sender is already correct, and the
    //    field is a dynamic enum that rejects an unvalidated literal.
    const draft = await ctx.step("create-reminder-draft", async () =>
      sdk.runAction({
        appKey: GMAIL_APP_KEY,
        actionType: "write",
        actionKey: "draft_v2",
        connection: GMAIL_CONNECTION,
        inputs: {
          to: message.to,
          cc: message.cc,
          subject: message.subject,
          body: message.body,
          body_type: "plain",
          signature_delimiter: true,
          render_signature_in_html: false,
          ...(inv.pdf ? { file: [inv.pdf] } : {}),
        },
      }),
    );

    const created = firstResult(draft);
    console.log(
      `drafted overdue reminder for ${inv.invoiceNumber} (${inv.currency} ${inv.amountDueText} ` +
        `due ${inv.dueDate}) to ${to.join(", ")}${cc.length ? ` cc ${cc.join(", ")}` : ""}` +
        `${inv.pdf ? " with the invoice PDF attached" : " (no PDF returned by Xero)"}`,
    );
    return {
      ...base,
      outcome: "reminder-drafted",
      drafted: true,
      draftId: firstString(created?.id, created?.message_id, created?.threadId),
    };
  },
);

export default workflow;
