// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/xero-invoice-paid-to-gmail-confirmation
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// The Xero credential is needed in BOTH places: on the TRIGGER (publish
// --trigger authentication_id, which is what watches for the invoice update)
// and as the `xero_wf` alias here, because the workflow re-reads the invoice
// before it emails anyone. Gmail is only used by the workflow body.
const XERO_APP_KEY = "XeroCLIAPI";
const XERO_CONNECTION = "xero_wf";

const GMAIL_APP_KEY = "GoogleMailV2CLIAPI";
const GMAIL_CONNECTION = "gmail_wf";

/** Xero organisation ("tenant") — workFlowers / Company Flow Pte. Ltd. */
const XERO_ORGANIZATION = "62699a8c-3351-40e8-9265-bdca5e037b03";

/** Every confirmation is blind-copied here, as the classic Zap did. */
const BCC = ["dennis@work.flowers"];

/**
 * Statuses that mean "this invoice is settled in full".
 *
 * Xero only reports PAID once AmountDue reaches zero, but both are checked —
 * see the fully-paid guard in `run` for why that matters.
 */
const PAID_STATUS = "PAID";

/** `updated_invoice_v2` is the sales-invoice trigger, so ACCREC is expected.
 *  Checked anyway: a payment confirmation must never go to a supplier whose
 *  bill we paid (ACCPAY), which would read as nonsense. */
const SALES_INVOICE_TYPE = "ACCREC";

// The Xero "Updated Sales Invoice" trigger delivers one invoice. Accept
// anything and extract defensively — the payload nests the invoice under
// `invoice` and the manual/dry-run path passes it bare.
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
 *  classic Zap pasted that straight into the email body. `/Date(1783036800000+0000)/`
 *  is the other shape, and the one that matters here: a PAID invoice carries
 *  `FullyPaidOnDate` in that form with no `FullyPaidOnDateString` beside it. */
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

/** Case-insensitive dedupe of anything that looks like an address. Xero lets a
 *  contact and its contact persons carry the same address, and the classic Zap
 *  would then have put it in `To` twice. */
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
 * classic Zap's `To` field mapped exactly that path, so both are handled.
 * A person with `IncludeInEmails: false` is excluded: that flag is Xero's own
 * "don't copy this person on invoice email" switch, and ignoring it would mail
 * someone the customer deliberately took off the list.
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
  amountPaid: string | null;
  amountDue: number | null;
  total: string | null;
  fullyPaidOn: string | null;
  reference: string | null;
  contactName: string | null;
  recipients: string[];
}

/** Read the invoice shape Xero's `find_invoice_by_id` returns. */
function readInvoice(payload: any): Invoice {
  const inv = payload?.invoice ?? payload ?? {};
  const contact = inv.Contact ?? inv.contact ?? {};
  return {
    invoiceId: firstString(inv.InvoiceID, inv.invoice_id, inv.id),
    invoiceNumber: firstString(inv.InvoiceNumber, inv.invoice_number),
    status: (firstString(inv.Status, inv.status) ?? "").toUpperCase(),
    type: (firstString(inv.Type, inv.type) ?? "").toUpperCase(),
    currency: firstString(inv.CurrencyCode, inv.currency_code),
    amountPaid: formatAmount(inv.AmountPaid ?? inv.amount_paid),
    amountDue: toNumber(inv.AmountDue ?? inv.amount_due),
    total: formatAmount(inv.Total ?? inv.total),
    fullyPaidOn: toIsoDate(inv.FullyPaidOnDateString ?? inv.FullyPaidOnDate ?? inv.fully_paid_on_date),
    reference: firstString(inv.Reference, inv.reference),
    contactName: firstString(contact.Name, contact.name),
    recipients: collectEmails(
      firstString(contact.EmailAddress, contact.email_address),
      contactPersonEmails(contact),
    ),
  };
}

/**
 * The invoice reference to look up, from whatever the trigger delivered.
 *
 * `find_invoice_by_id` accepts a GUID or an invoice number, so either will do.
 * Only this one field is taken from the trigger payload — everything the email
 * says is read back from Xero, so the workflow does not depend on the trigger's
 * field naming beyond this.
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

/** A manual run may ask for everything except the send, so the composed email
 *  can be reviewed without mailing a customer. The Xero trigger never sets it. */
function isDryRun(payload: any): boolean {
  const v = payload?.dryRun ?? payload?.dry_run;
  return v === true || v === "true";
}

function buildSubject(inv: Invoice): string {
  return `Payment Received - Invoice ${inv.invoiceNumber ?? ""}`.trim();
}

function buildBody(inv: Invoice): string {
  // Kept deliberately close to the classic Zap's wording. The changes are
  // formatting-only: dates render as YYYY-MM-DD rather than
  // `2026-07-20T00:00:00`, amounts to two decimal places, and an empty
  // Reference drops its line instead of leaving a dangling `- Reference:`.
  const lines = [
    `- Invoice Number: ${inv.invoiceNumber ?? "(not numbered)"}`,
    `- Amount Paid: ${[inv.currency, inv.amountPaid].filter(Boolean).join(" ") || "(unknown)"}`,
  ];
  if (inv.fullyPaidOn) lines.push(`- Payment Date: ${inv.fullyPaidOn}`);
  if (inv.reference) lines.push(`- Reference: ${inv.reference}`);

  return [
    "Hi team,",
    "",
    "Thank you for your payment! We're writing to confirm that we've received your payment for " +
      `invoice ${inv.invoiceNumber ?? ""}.`.trimEnd(),
    "",
    "Payment Details:",
    ...lines,
    "",
    "If you have any questions about this payment or your invoice, please don't hesitate to reach out.",
    "",
    "Best regards,",
    "workFlowers Team",
  ].join("\n");
}

const workflow = defineDurable<Record<string, unknown>, unknown>(
  "xero-invoice-paid-to-gmail-confirmation",
  async (ctx, rawInput) => {
    const payload = InputSchema.parse(normalizeInput(rawInput)) as any;
    const ref = invoiceRef(payload);
    if (!ref) {
      console.log("skipping: no invoice id or number in payload (empty/test delivery)");
      return { skipped: true, reason: "no invoice reference in payload" };
    }
    const dryRun = isDryRun(payload);

    // 1. Re-read the invoice from Xero rather than trusting the trigger body.
    //    The trigger fires on a *change* to the invoice; what the email asserts
    //    ("we have received your payment") has to be true at send time, and
    //    only Xero can say so. Costs one task, on every delivery.
    const found = await ctx.step("find-invoice", async () =>
      sdk.runAction({
        appKey: XERO_APP_KEY,
        actionType: "search",
        actionKey: "find_invoice_by_id",
        connection: XERO_CONNECTION,
        inputs: {
          organization: XERO_ORGANIZATION,
          invoice_id: ref,
          include_pdf: false,
          include_online_url: false,
        },
      }),
    );

    const result = firstResult(found);
    if (!result) {
      console.log(`skipping: Xero returned no invoice for ${ref}`);
      return { skipped: true, reason: "invoice not found in Xero", invoiceRef: ref };
    }
    const inv = readInvoice(result);

    // 2. Fully-paid guard — the substantive fix over the classic Zap.
    //
    //    The trigger's `change: "paid"` filter reads Xero's invoice History,
    //    which lags the update itself, and a part-payment also moves an
    //    invoice's paid amount. Without this guard a customer who paid half of
    //    a SGD 10,000 invoice gets "Thank you for your payment!" naming the
    //    part they sent, and no further confirmation when they settle the rest.
    //    Both conditions are checked because they answer different questions:
    //    Status is Xero's own verdict, AmountDue is the arithmetic.
    if (inv.status !== PAID_STATUS || (inv.amountDue !== null && inv.amountDue > 0)) {
      console.log(
        `skipping ${inv.invoiceNumber ?? ref}: not settled in full ` +
          `(status ${inv.status || "unknown"}, ${inv.amountDue ?? "?"} still due)`,
      );
      return {
        skipped: true,
        reason: "invoice is not paid in full",
        invoice: { number: inv.invoiceNumber, status: inv.status, amountDue: inv.amountDue },
      };
    }

    if (inv.type && inv.type !== SALES_INVOICE_TYPE) {
      console.log(`skipping ${inv.invoiceNumber ?? ref}: type ${inv.type} is not a sales invoice`);
      return { skipped: true, reason: `invoice type ${inv.type} is not ${SALES_INVOICE_TYPE}` };
    }

    // 3. Recipients. The classic Zap put the contact's address and its first
    //    contact person's address in `To` unconditionally, so a contact with no
    //    contact persons sent one empty recipient, and a contact whose person
    //    shares the main address sent it twice.
    if (inv.recipients.length === 0) {
      console.log(
        `skipping ${inv.invoiceNumber ?? ref}: ${inv.contactName ?? "the contact"} has no email address in Xero`,
      );
      return {
        skipped: true,
        reason: "contact has no email address in Xero",
        invoice: { number: inv.invoiceNumber, contact: inv.contactName },
      };
    }

    const message = {
      to: inv.recipients,
      bcc: BCC,
      subject: buildSubject(inv),
      body: buildBody(inv),
    };

    const base = {
      invoice: {
        id: inv.invoiceId,
        number: inv.invoiceNumber,
        status: inv.status,
        contact: inv.contactName,
        currency: inv.currency,
        amountPaid: inv.amountPaid,
        total: inv.total,
        fullyPaidOn: inv.fullyPaidOn,
        reference: inv.reference,
      },
      message,
    };

    if (dryRun) {
      console.log(`dry run: would confirm ${inv.invoiceNumber} to ${message.to.join(", ")}`);
      return { ...base, outcome: "dry-run", sent: false };
    }

    // 4. Send. `from` is deliberately not set: the Gmail connection is
    //    dennis@work.flowers, so the default sender is already correct, and the
    //    field is a dynamic enum that rejects an unvalidated literal.
    const sent = await ctx.step("send-payment-confirmation", async () =>
      sdk.runAction({
        appKey: GMAIL_APP_KEY,
        actionType: "write",
        actionKey: "message",
        connection: GMAIL_CONNECTION,
        inputs: {
          to: message.to,
          bcc: message.bcc,
          subject: message.subject,
          body: message.body,
          body_type: "plain",
          send_to_groups: false,
          signature_delimiter: true,
          render_signature_in_html: false,
        },
      }),
    );

    const delivered = firstResult(sent);
    console.log(
      `confirmed payment of ${inv.currency} ${inv.amountPaid} for ${inv.invoiceNumber} ` +
        `to ${message.to.join(", ")}`,
    );
    return {
      ...base,
      outcome: "confirmation-sent",
      sent: true,
      messageId: firstString(delivered?.id, delivered?.message_id, delivered?.threadId),
    };
  },
);

export default workflow;
