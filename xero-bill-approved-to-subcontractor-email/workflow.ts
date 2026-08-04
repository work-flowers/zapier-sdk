// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/xero-bill-approved-to-subcontractor-email
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// The Xero credential lives only on the TRIGGER (publish --trigger
// authentication_id) — the workflow body never re-reads Xero, it just
// formats whatever the "New Bill" (authorised) trigger already delivered.
const GMAIL_APP_KEY = "GoogleMailV2CLIAPI";
const GMAIL_CONNECTION = "gmail_wf";

/** Xero's "Subcontractor Fees" expense account code — the classic Zap's
 *  "Subcontractor Fees" filter step matched any line item's AccountCode
 *  against this (as an `icontains`, loosened past the point of usefulness;
 *  tightened here to an exact match — see README). */
const SUBCONTRACTOR_ACCOUNT_CODE = "490";

const InputSchema = z.unknown();

// --- Pure helpers ------------------------------------------------------------

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
 * `DeterminismViolation` on the `Date` constructor even when the argument
 * makes it deterministic (e.g. `new Date(ms)`). Hinnant's civil-from-days
 * conversion in integer arithmetic sidesteps it entirely.
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

/** `YYYY-MM-DD` from any of Xero's date spellings, or null. Xero sends both
 *  plain ISO strings ("2026-09-01T00:00:00") and `/Date(ms+tz)/`. */
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

/** Two decimal places, thousands-separated — a payment confirmation should
 *  not read `7398.170000000001`. */
function formatAmount(v: unknown): string | null {
  const n = toNumber(v);
  if (n === null) return null;
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

function isEmail(v: unknown): v is string {
  return typeof v === "string" && EMAIL_RE.test(v.trim());
}

interface LineItem {
  accountCode: string | null;
}

function readLineItems(bill: any): LineItem[] {
  const raw = bill?.LineItems ?? bill?.line_items;
  const list: any[] = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.LineItem)
      ? raw.LineItem
      : raw?.LineItem
        ? [raw.LineItem]
        : raw && typeof raw === "object"
          ? [raw]
          : [];
  return list.map((it) => ({
    accountCode: firstString(it?.AccountCode, it?.account_code),
  }));
}

/** Any line item coded to the Subcontractor Fees account. */
function hasSubcontractorLineItem(lineItems: LineItem[]): boolean {
  return lineItems.some((li) => li.accountCode === SUBCONTRACTOR_ACCOUNT_CODE);
}

/**
 * Xero's `attachments` on the bill — each a Zapier "file" field, an opaque
 * `hydrate|||...|||hydrate` reference string that a downstream write action
 * (here, Gmail's `file` input) resolves at send time. Passed straight
 * through, exactly as `xero-overdue-invoice-to-gmail-reminder` does for
 * `InvoicePDF` — this is the subcontractor's own uploaded invoice/receipt,
 * not a Xero-rendered PDF of the bill.
 */
function readAttachmentFiles(bill: any): string[] {
  const raw = bill?.attachments ?? bill?.Attachments;
  const list: any[] = Array.isArray(raw) ? raw : [];
  const files: string[] = [];
  for (const att of list) {
    const f = firstString(att?.file, att?.File);
    if (f) files.push(f);
  }
  return files;
}

interface Bill {
  invoiceId: string | null;
  invoiceNumber: string | null;
  total: string | null;
  currencyCode: string | null;
  dueDate: string | null;
  contactFirstName: string | null;
  contactEmail: string | null;
  lineItems: LineItem[];
  attachmentFiles: string[];
}

/** Read the bill (a Xero Invoice, Type ACCPAY) off whatever the "New Bill"
 *  trigger delivered. */
function readBill(payload: any): Bill {
  const bill = payload?.bill ?? payload ?? {};
  const contact = bill.Contact ?? bill.contact ?? {};
  return {
    invoiceId: firstString(bill.InvoiceID, bill.invoice_id, bill.id),
    invoiceNumber: firstString(bill.InvoiceNumber, bill.invoice_number),
    total: formatAmount(bill.Total ?? bill.total),
    currencyCode: firstString(bill.CurrencyCode, bill.currency_code),
    dueDate: toIsoDate(bill.DueDateString ?? bill.DueDate ?? bill.due_date),
    contactFirstName: firstString(contact.FirstName, contact.first_name, contact.Name, contact.name),
    contactEmail: firstString(contact.EmailAddress, contact.email_address),
    lineItems: readLineItems(bill),
    attachmentFiles: readAttachmentFiles(bill),
  };
}

function billRef(payload: any): string | null {
  const bill = payload?.bill ?? payload ?? {};
  return firstString(
    bill.InvoiceID,
    bill.invoice_id,
    bill.id,
    payload?.InvoiceID,
    payload?.invoice_id,
    payload?.id,
  );
}

/** A manual run may ask to build the email without sending, so it can be
 *  reviewed without mailing a real subcontractor. The Xero trigger never
 *  sets it. */
function isDryRun(payload: any): boolean {
  const v = payload?.dryRun ?? payload?.dry_run;
  return v === true || v === "true";
}

function buildSubject(bill: Bill): string {
  return `Invoice ${bill.invoiceNumber ?? ""} Approved`.trim();
}

function buildBody(bill: Bill): string {
  // Kept deliberately close to the classic Zap's wording and sign-off.
  return [
    `Hi ${bill.contactFirstName ?? "there"},`,
    "",
    "This email is to confirm that your invoice has been approved in Xero.",
    "",
    "Invoice Details:",
    `Invoice Number: ${bill.invoiceNumber ?? "(not numbered)"}`,
    `Amount Due: ${[bill.currencyCode, bill.total].filter(Boolean).join(" ") || "(unknown)"}`,
    `Due Date: ${bill.dueDate ?? "(no due date)"}`,
    "",
    "Thank you for your work on this project. This invoice will be processed according to our standard payment terms.",
    "",
    "If you have any questions or concerns, please don't hesitate to reach out.",
    "",
    "Thanks,",
    "Dennis",
  ].join("\n");
}

const workflow = defineDurable<Record<string, unknown>, unknown>(
  "xero-bill-approved-to-subcontractor-email",
  async (ctx, rawInput) => {
    const payload = InputSchema.parse(normalizeInput(rawInput)) as any;
    const ref = billRef(payload);
    if (!ref) {
      console.log("skipping: no invoice id in payload (empty/test delivery)");
      return { skipped: true, reason: "no invoice id in payload" };
    }

    const bill = readBill(payload);

    // The classic Zap's "Subcontractor Fees" filter — only bills coding at
    // least one line item to the Subcontractor Fees account get a
    // confirmation. Every other approved bill (rent, software, etc.) is
    // silently out of scope for this Zap.
    if (!hasSubcontractorLineItem(bill.lineItems)) {
      console.log(
        `skipping ${bill.invoiceNumber ?? ref}: no line item coded to account ${SUBCONTRACTOR_ACCOUNT_CODE}`,
      );
      return {
        skipped: true,
        reason: `no line item coded to the Subcontractor Fees account (${SUBCONTRACTOR_ACCOUNT_CODE})`,
        invoice: { number: bill.invoiceNumber },
      };
    }

    if (!isEmail(bill.contactEmail)) {
      console.log(`skipping ${bill.invoiceNumber ?? ref}: ${bill.contactFirstName ?? "the vendor"} has no email address in Xero`);
      return {
        skipped: true,
        reason: "vendor has no email address in Xero",
        invoice: { number: bill.invoiceNumber, contact: bill.contactFirstName },
      };
    }

    const subject = buildSubject(bill);
    const body = buildBody(bill);
    const dryRun = isDryRun(payload);

    if (dryRun) {
      console.log(`dry run: would confirm ${bill.invoiceNumber ?? ref} to ${bill.contactEmail}`);
      return {
        outcome: "dry-run",
        sent: false,
        message: { to: [bill.contactEmail], subject, body, file: bill.attachmentFiles },
      };
    }

    // The classic Zap's step here was published `paused: true` (as was the
    // "Subcontractor Fees" filter before it) and so had never actually sent
    // a confirmation — this is the first time this email goes out for real.
    // `from` is deliberately not set: the Gmail connection already sends as
    // dennis@work.flowers, and the field is a dynamic enum that rejects an
    // unvalidated literal.
    const sent = await ctx.step("send-confirmation-email", async () =>
      sdk.runAction({
        appKey: GMAIL_APP_KEY,
        actionType: "write",
        actionKey: "message",
        connection: GMAIL_CONNECTION,
        inputs: {
          to: [bill.contactEmail],
          subject,
          body,
          body_type: "plain",
          send_to_groups: false,
          signature_delimiter: true,
          ...(bill.attachmentFiles.length > 0 ? { file: bill.attachmentFiles } : {}),
        },
      }),
    );

    const row = (sent as any)?.data?.[0];
    console.log(`confirmed approval of ${bill.invoiceNumber ?? ref} to ${bill.contactEmail}`);
    return {
      outcome: "confirmation-sent",
      sent: true,
      invoice: { id: bill.invoiceId, number: bill.invoiceNumber, contactEmail: bill.contactEmail },
      messageId: firstString(row?.id, row?.message_id, row?.threadId),
    };
  },
);

export default workflow;
