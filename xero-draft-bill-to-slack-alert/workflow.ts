// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/xero-draft-bill-to-slack-alert
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// The Xero credential lives only on the TRIGGER (publish --trigger
// authentication_id) — the workflow body never re-reads Xero, it just
// formats whatever the "New Bill" (draft) trigger already delivered.
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
 *  `DueDateString` ("2026-08-15T00:00:00") and `DueDate` (`/Date(ms+tz)/`). */
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

interface Bill {
  invoiceId: string | null;
  invoiceNumber: string | null;
  total: string | null;
  currencyCode: string | null;
  dueDate: string | null;
  vendorName: string | null;
}

/** Read the bill (a Xero Invoice, Type ACCPAY) off whatever the "New Bill"
 *  trigger delivered. `InvoiceNumber` is an absent key, not null, on a bill
 *  with none — hence the fallback text rather than a blank line. */
function readBill(payload: any): Bill {
  const bill = payload?.bill ?? payload ?? {};
  const contact = bill.Contact ?? bill.contact ?? {};
  return {
    invoiceId: firstString(bill.InvoiceID, bill.invoice_id, bill.id),
    invoiceNumber: firstString(bill.InvoiceNumber, bill.invoice_number),
    total: formatAmount(bill.Total ?? bill.total),
    currencyCode: firstString(bill.CurrencyCode, bill.currency_code),
    dueDate: toIsoDate(bill.DueDateString ?? bill.DueDate ?? bill.due_date),
    vendorName: firstString(contact.Name, contact.name),
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

/** A manual run may ask to build the message without posting, so the alert
 *  can be reviewed without touching Slack. The Xero trigger never sets it. */
function isDryRun(payload: any): boolean {
  const v = payload?.dryRun ?? payload?.dry_run;
  return v === true || v === "true";
}

function buildMessageText(bill: Bill): string {
  // Kept deliberately close to the classic Zap's wording and emoji.
  const link = bill.invoiceId
    ? `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${bill.invoiceId}`
    : "https://go.xero.com/AccountsPayable/";
  return [
    `📋 <${link}|New Bill Alert>`,
    "",
    `Vendor: ${bill.vendorName ?? "(unknown vendor)"}`,
    `Amount: ${[bill.total, bill.currencyCode].filter(Boolean).join(" ") || "(unknown)"}`,
    `Due Date: ${bill.dueDate ?? "(no due date)"}`,
    `Invoice #: ${bill.invoiceNumber ?? "(not numbered)"}`,
  ].join("\n");
}

const workflow = defineDurable<Record<string, unknown>, unknown>(
  "xero-draft-bill-to-slack-alert",
  async (ctx, rawInput) => {
    const payload = InputSchema.parse(normalizeInput(rawInput)) as any;
    const ref = billRef(payload);
    if (!ref) {
      console.log("skipping: no invoice id in payload (empty/test delivery)");
      return { skipped: true, reason: "no invoice id in payload" };
    }

    const bill = readBill(payload);
    const text = buildMessageText(bill);
    const dryRun = isDryRun(payload);

    if (dryRun) {
      console.log(`dry run: would post new-bill alert for ${bill.invoiceNumber ?? ref} to #finance`);
      return { outcome: "dry-run", posted: false, bill, text };
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

    console.log(`posted new-bill alert for ${bill.invoiceNumber ?? ref} to #finance`);
    return {
      outcome: "posted",
      posted: true,
      bill: { id: bill.invoiceId, number: bill.invoiceNumber, vendor: bill.vendorName },
      slackTs: postedTs(posted),
    };
  },
);

export default workflow;
