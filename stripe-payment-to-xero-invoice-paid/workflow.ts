// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/stripe-payment-to-xero-invoice-paid
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Stripe is bound only on the TRIGGER (publish --trigger authentication_id).
// Xero is used by the workflow body: once to look up the invoice, once to
// record the payment against it.
const XERO_APP_KEY = "XeroCLIAPI";
const XERO_CONNECTION = "xero_wf";

/** Xero organisation ("tenant") — workFlowers / Company Flow Pte. Ltd. */
const XERO_ORGANIZATION = "62699a8c-3351-40e8-9265-bdca5e037b03";

/** The sole Stripe clearing account in Xero — verified via
 *  list-action-input-field-choices (no separate USD account exists; Stripe
 *  deposits land here regardless of the invoice's original currency, same
 *  as the classic Zap's hardcoded mapping). */
const STRIPE_SGD_ACCOUNT_ID = "a7c3277b-8f30-4d25-9aca-8237422b908b";

/** Harvest tags every invoice-payment Stripe charge with this metadata value
 *  — the classic Zap's "Harvest Invoice" filter step. */
const HARVEST_VIA = "harvest";

/** Harvest's Stripe charge description reads "Charge for Invoice <number>" —
 *  verified against 8 live Harvest-tagged payments (HAR-1 through HAR-13),
 *  all matching this exact prefix. */
const DESCRIPTION_PREFIX = /^Charge for Invoice\s+(.+)$/i;

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

/**
 * Stripe's `amount_received` — VERIFIED already decimal-scaled, not cents.
 *
 * Cross-checked against a real, already-recorded case: Stripe payment
 * `pi_3TbFjkJYWXjnDZq80rolzF1Q` (amount_received: 900, amount_received_formatted:
 * "SGD 900.00") is recorded in Xero on invoice HAR-13 as Payment.Amount
 * "900.00", Reference exactly this payment intent id. No /100 conversion
 * needed — Zapier's Stripe app exposes these fields pre-scaled to the
 * invoice's real currency amount, unlike Stripe's raw REST API.
 */
function readPaymentAmount(payload: any): number | null {
  const formatted = firstString(payload?.amount_received_formatted, payload?.amount_formatted);
  if (formatted) {
    const n = toNumber(formatted);
    if (n !== null) return n;
  }
  return toNumber(payload?.amount_received ?? payload?.amount);
}

interface StripePayment {
  paymentIntentId: string | null;
  via: string | null;
  status: string | null;
  description: string | null;
  amount: number | null;
  createdIso: string | null;
}

/** Read the Stripe "New Payment" trigger payload. `metadata`/`description`
 *  are read off the `charge` sub-object first (matching the classic Zap's
 *  `charge.metadata.via` / implied `charge.description`), falling back to the
 *  top-level PaymentIntent fields the trigger also carries (identical values
 *  in every sample seen — Stripe copies metadata from PI to charge). */
function readPayment(payload: any): StripePayment {
  const charge = payload?.charge ?? {};
  const chargeMeta = charge?.metadata ?? {};
  const topMeta = payload?.metadata ?? {};
  return {
    paymentIntentId: firstString(payload?.id, payload?.payment_intent_id),
    via: firstString(chargeMeta?.via, topMeta?.via),
    status: firstString(payload?.status, charge?.status),
    description: firstString(charge?.description, payload?.description),
    amount: readPaymentAmount(payload),
    createdIso: firstString(payload?.created_formatted)
      ?? (toNumber(payload?.created) !== null ? isoDateFromEpochMs(toNumber(payload!.created)! * 1000) : null),
  };
}

/** Harvest's invoice number out of "Charge for Invoice HAR-13" -> "HAR-13". */
function extractInvoiceNumber(description: string | null): string | null {
  if (!description) return null;
  const m = DESCRIPTION_PREFIX.exec(description.trim());
  return m ? m[1].trim() : null;
}

/** A manual run may ask to build/validate without recording the payment, so
 *  it can be reviewed without touching Xero's ledger. The Stripe trigger
 *  never sets it. */
function isDryRun(payload: any): boolean {
  const v = payload?.dryRun ?? payload?.dry_run;
  return v === true || v === "true";
}

/** First item from a runAction result ({ data: [...] } or a bare array). */
function firstResult(res: any): any {
  if (!res) return null;
  if (Array.isArray(res)) return res[0] ?? null;
  if (Array.isArray(res.data)) return res.data[0] ?? null;
  return res.data ?? res;
}

interface Invoice {
  invoiceId: string | null;
  invoiceNumber: string | null;
  status: string | null;
  type: string | null;
  currencyCode: string | null;
  amountDue: number | null;
  total: string | null;
}

function readInvoice(raw: any): Invoice {
  return {
    invoiceId: firstString(raw?.InvoiceID, raw?.invoice_id, raw?.id),
    invoiceNumber: firstString(raw?.InvoiceNumber, raw?.invoice_number),
    status: (firstString(raw?.Status, raw?.status) ?? "").toUpperCase() || null,
    type: (firstString(raw?.Type, raw?.type) ?? "").toUpperCase() || null,
    currencyCode: firstString(raw?.CurrencyCode, raw?.currency_code),
    amountDue: toNumber(raw?.AmountDue ?? raw?.amount_due),
    total: firstString(raw?.Total, raw?.total),
  };
}

const workflow = defineDurable<Record<string, unknown>, unknown>(
  "stripe-payment-to-xero-invoice-paid",
  async (ctx, rawInput) => {
    const payload = InputSchema.parse(normalizeInput(rawInput)) as any;
    const payment = readPayment(payload);

    if (!payment.paymentIntentId) {
      console.log("skipping: no payment intent id in payload (empty/test delivery)");
      return { skipped: true, reason: "no payment intent id in payload" };
    }

    // Only Harvest-tagged charges are in scope for this Zap — most Stripe
    // payments (subscriptions, direct invoices, one-off charges) are not.
    if ((payment.via ?? "").toLowerCase() !== HARVEST_VIA) {
      console.log(`skipping ${payment.paymentIntentId}: via "${payment.via ?? "(none)"}" is not Harvest`);
      return { skipped: true, reason: "not a Harvest-tagged payment", via: payment.via };
    }

    if (payment.status && payment.status !== "succeeded") {
      console.log(`skipping ${payment.paymentIntentId}: status "${payment.status}" is not succeeded`);
      return { skipped: true, reason: `payment status "${payment.status}" is not succeeded` };
    }

    // A Harvest-tagged payment whose description we can't parse is a real
    // event we failed to understand — surface it loudly rather than leaving
    // an invoice looking unpaid in Xero with no trace of why.
    const invoiceNumber = extractInvoiceNumber(payment.description);
    if (!invoiceNumber) {
      throw new Error(
        `Could not extract an invoice number from Stripe payment ${payment.paymentIntentId}'s ` +
          `description "${payment.description ?? "(none)"}" (expected "Charge for Invoice <number>")`,
      );
    }

    // 1. Look up the invoice in Xero. A real read, one task, run regardless
    //    of dryRun — nothing here mutates anything.
    const found = await ctx.step("find-invoice", async () =>
      sdk.runAction({
        appKey: XERO_APP_KEY,
        actionType: "search",
        actionKey: "invoice_v2",
        connection: XERO_CONNECTION,
        inputs: {
          organization: XERO_ORGANIZATION,
          search_by: "Number",
          search_value: invoiceNumber,
        },
      }),
    );

    const invoiceRaw = firstResult(found);
    if (!invoiceRaw) {
      throw new Error(
        `Could not find invoice "${invoiceNumber}" in Xero for Stripe payment ${payment.paymentIntentId}`,
      );
    }
    const invoice = readInvoice(invoiceRaw);

    // 2. Idempotency guard. Verified against real data: invoice HAR-13 is
    //    already PAID with this exact payment recorded (Reference ===
    //    payment.paymentIntentId). A retriggered or replayed delivery of the
    //    same Stripe event must not record a second payment.
    if (invoice.status === "PAID" || (invoice.amountDue !== null && invoice.amountDue <= 0)) {
      console.log(`skipping ${invoiceNumber}: already fully paid in Xero (status ${invoice.status})`);
      return {
        skipped: true,
        reason: "invoice is already fully paid in Xero",
        invoice: { number: invoice.invoiceNumber, status: invoice.status },
      };
    }

    const dryRun = isDryRun(payload);
    const paymentInputs = {
      organization: XERO_ORGANIZATION,
      invoice_type: "Invoice",
      invoice_number: invoice.invoiceId ?? invoiceNumber,
      account_id: STRIPE_SGD_ACCOUNT_ID,
      date: payment.createdIso ?? undefined,
      amount: payment.amount ?? undefined,
      reference: payment.paymentIntentId,
    };

    if (dryRun) {
      console.log(`dry run: would record payment of ${payment.amount} on ${invoiceNumber}`);
      return {
        outcome: "dry-run",
        recorded: false,
        invoice: { id: invoice.invoiceId, number: invoice.invoiceNumber, amountDue: invoice.amountDue },
        payment: paymentInputs,
      };
    }

    // 3. Record the payment. The classic Zap's step here was published
    //    `paused: true` (as were the filter and formatter before it) and so
    //    had never actually run — this is the first time this payment gets
    //    recorded by this workflow.
    const created = await ctx.step("record-payment", async () =>
      sdk.runAction({
        appKey: XERO_APP_KEY,
        actionType: "write",
        actionKey: "payment",
        connection: XERO_CONNECTION,
        inputs: paymentInputs,
      }),
    );

    const row = firstResult(created);
    console.log(`recorded payment of ${payment.amount} on ${invoiceNumber} (Stripe ${payment.paymentIntentId})`);
    return {
      outcome: "payment-recorded",
      recorded: true,
      invoice: { id: invoice.invoiceId, number: invoice.invoiceNumber },
      amount: payment.amount,
      xeroPaymentId: firstString(row?.PaymentID, row?.payment_id),
    };
  },
);

export default workflow;
