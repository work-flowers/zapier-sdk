// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/xero-draft-sales-invoice-to-slack-alert
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// The Xero credential lives only on the TRIGGER (publish --trigger
// authentication_id) — the workflow body never re-reads Xero, it just
// formats whatever the "New Sales Invoice" (draft) trigger already delivered.
const SLACK_APP_KEY = "SlackCLIAPI";
const SLACK_CONNECTION = "slack_wf";

/** #finance — same channel the classic Zap posted to. */
const SLACK_CHANNEL = "C08GRA41E1J";

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
 *  `...String` ("2026-08-15T00:00:00") and `/Date(ms+tz)/` shapes. */
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

/** Two decimal places, thousands-separated — a Slack alert should not read
 *  `7398.170000000001`. */
function formatAmount(v: unknown): string | null {
  const n = toNumber(v);
  if (n === null) return null;
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** The Slack `ts` of the message this workflow just posted. */
function postedTs(result: unknown): string | null {
  const row = (result as any)?.data?.[0];
  return firstString(row?.message?.ts, row?.ts);
}

interface LineItem {
  description: string | null;
  quantity: string | null;
  lineAmount: string | null;
}

/**
 * Xero's `LineItems` on an invoice, defensively read.
 *
 * The classic Zap's template referenced `LineItems[]Description` etc., which
 * Zapier's array-flattening renders as one list per field (all descriptions,
 * then all quantities, then all amounts) rather than one line per item — a
 * two-line invoice reads as a jumble of three disjoint lists. This reads the
 * same array but keeps each item's fields together.
 */
function readLineItems(inv: any): LineItem[] {
  const raw = inv?.LineItems ?? inv?.line_items;
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
    description: firstString(it?.Description, it?.description),
    quantity: firstString(it?.Quantity, it?.quantity),
    lineAmount: formatAmount(it?.LineAmount ?? it?.line_amount),
  }));
}

interface Invoice {
  invoiceId: string | null;
  invoiceNumber: string | null;
  contactName: string | null;
  date: string | null;
  dueDate: string | null;
  status: string | null;
  currencyCode: string | null;
  amountDue: string | null;
  totalTax: string | null;
  lineItems: LineItem[];
}

/** Read the invoice shape Xero's "New Sales Invoice" trigger delivers. */
function readInvoice(payload: any): Invoice {
  const inv = payload?.invoice ?? payload ?? {};
  const contact = inv.Contact ?? inv.contact ?? {};
  return {
    invoiceId: firstString(inv.InvoiceID, inv.invoice_id, inv.id),
    invoiceNumber: firstString(inv.InvoiceNumber, inv.invoice_number),
    contactName: firstString(contact.Name, contact.name),
    date: toIsoDate(inv.DateString ?? inv.Date ?? inv.date),
    dueDate: toIsoDate(inv.DueDateString ?? inv.DueDate ?? inv.due_date),
    status: firstString(inv.Status, inv.status),
    currencyCode: firstString(inv.CurrencyCode, inv.currency_code),
    amountDue: formatAmount(inv.AmountDue ?? inv.amount_due),
    totalTax: formatAmount(inv.TotalTax ?? inv.total_tax),
    lineItems: readLineItems(inv),
  };
}

function invoiceRef(payload: any): string | null {
  const inv = payload?.invoice ?? payload ?? {};
  return firstString(
    inv.InvoiceID,
    inv.invoice_id,
    inv.id,
    payload?.InvoiceID,
    payload?.invoice_id,
    payload?.id,
  );
}

/** A manual run may ask to build the message without posting, so the alert
 *  can be reviewed without touching Slack. The Xero trigger never sets it. */
function isDryRun(payload: any): boolean {
  const v = payload?.dryRun ?? payload?.dry_run;
  return v === true || v === "true";
}

function buildLineItemsText(items: LineItem[], currencyCode: string | null): string {
  if (items.length === 0) return "(no line items)";
  return items
    .map((it) => {
      const desc = it.description ?? "(no description)";
      const qty = it.quantity ?? "?";
      const amount = [currencyCode, it.lineAmount ?? "?"].filter(Boolean).join(" ");
      return `• ${desc} — Qty: ${qty} | Amount: ${amount}`;
    })
    .join("\n");
}

function buildMessageText(inv: Invoice): string {
  // Kept deliberately close to the classic Zap's wording, emoji and section
  // layout. The line items list is the one substantive change — see
  // readLineItems above.
  return [
    "📋 *Invoice Details*",
    "",
    `*Invoice #:* ${inv.invoiceNumber ?? "(not numbered)"}`,
    `*Customer:* ${inv.contactName ?? "(unknown customer)"}`,
    `*Date:* ${inv.date ?? "(unknown)"}`,
    `*Due Date:* ${inv.dueDate ?? "(no due date)"}`,
    "",
    `*Status:* ${inv.status ?? "(unknown)"}`,
    `*Amount Due:* ${[inv.currencyCode, inv.amountDue].filter(Boolean).join(" ") || "(unknown)"}`,
    `*Total Tax:* ${[inv.currencyCode, inv.totalTax].filter(Boolean).join(" ") || "(unknown)"}`,
    "",
    "*Line Items:*",
    buildLineItemsText(inv.lineItems, inv.currencyCode),
  ].join("\n");
}

const workflow = defineDurable<Record<string, unknown>, unknown>(
  "xero-draft-sales-invoice-to-slack-alert",
  async (ctx, rawInput) => {
    const payload = InputSchema.parse(normalizeInput(rawInput)) as any;
    const ref = invoiceRef(payload);
    if (!ref) {
      console.log("skipping: no invoice id in payload (empty/test delivery)");
      return { skipped: true, reason: "no invoice id in payload" };
    }

    const inv = readInvoice(payload);
    const text = buildMessageText(inv);
    const dryRun = isDryRun(payload);

    if (dryRun) {
      console.log(`dry run: would post draft-invoice alert for ${inv.invoiceNumber ?? ref} to #finance`);
      return { outcome: "dry-run", posted: false, invoice: inv, text };
    }

    // The classic Zap's step here was published `paused: true` and so had
    // never actually posted to Slack — this is the first time this alert
    // will reach the channel for real.
    const posted = await ctx.step("post-slack-alert", async () =>
      sdk.runAction({
        appKey: SLACK_APP_KEY,
        actionType: "write",
        actionKey: "private_channel_message",
        connection: SLACK_CONNECTION,
        inputs: {
          channel: SLACK_CHANNEL,
          text,
          add_app_to_channel: "yes",
          as_bot: "yes",
          add_edit_link: "yes",
          unfurl: "yes",
          link_names: "yes",
          reply_broadcast: "no",
        },
      }),
    );

    console.log(`posted draft-invoice alert for ${inv.invoiceNumber ?? ref} to #finance`);
    return {
      outcome: "posted",
      posted: true,
      invoice: {
        id: inv.invoiceId,
        number: inv.invoiceNumber,
        customer: inv.contactName,
        lineItemCount: inv.lineItems.length,
      },
      slackTs: postedTs(posted),
    };
  },
);

export default workflow;
