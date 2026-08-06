// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/xero-invoice-alerts
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Why this Zap exists ---------------------------------------------------
//
// It replaces THREE Xero polling triggers with one hourly schedule:
//
//   xero-draft-bill-to-slack-alert            bill / status=draft       -> Slack
//   xero-bill-approved-to-subcontractor-email bill / status=authorised  -> Gmail
//   xero-draft-sales-invoice-to-slack-alert   sales_invoice_v2 / draft  -> Slack
//
// Xero rate-limits per TENANT: 60 calls/min and 5,000 calls/day. Five Xero
// pollers on tenant 62699a8c exhausted the DAILY limit on 2026-08-06 —
// `x-rate-limit-problem: day`, `x-daylimit-remaining: 0`, and crucially
// `x-minlimit-remaining: 60`, i.e. the per-minute budget was untouched, so it
// was not a burst — taking every Xero Zap in the workspace down for ~10 hours.
//
// A durable trigger has NO polling-interval field (the `--trigger` payload
// accepts only selected_api / action / authentication_id / params), so a
// polling durable cannot be throttled. A schedule trigger costs Xero nothing,
// which moves the cost basis from ~1,440 polls/day PER POLLER to one windowed
// read per fire: ~24-48 calls/day for all three alerts combined.
//
// THE TRADE: Zapier's polling dedupe went away with the pollers, so this Zap
// keeps its own. See ALERT_STATE_TABLE.

// --- Bindings --------------------------------------------------------------
const XERO_APP_KEY = "XeroCLIAPI";
const XERO_CONNECTION = "xero_wf";

/** Xero organisation ("tenant") — work.flowers. `_zap_raw_request` has NO
 *  `organization` field in its schema and silently strips one, so the tenant
 *  must go in as a HEADER or the call fails with "Please select an
 *  organization to perform this step on." */
const XERO_ORGANIZATION = "62699a8c-3351-40e8-9265-bdca5e037b03";
const XERO_API = "https://api.xero.com/api.xro/2.0";

const SLACK_APP_KEY = "SlackCLIAPI";
const SLACK_CONNECTION = "slack_wf";
/** #finance — the same channel the classic Zaps posted to. */
const SLACK_CHANNEL = "C08GRA41E1J";

const GMAIL_APP_KEY = "GoogleMailV2CLIAPI";
const GMAIL_CONNECTION = "gmail_wf";

/** Xero's "Subcontractor Fees" account. Only bills coding at least one line
 *  item here get an approval confirmation — the classic Zap's filter. */
const SUBCONTRACTOR_ACCOUNT_CODE = "490";

/**
 * "Xero Invoice Alert State" — this Zap's own dedupe store, one row per
 * invoice, keyed on `xero_invoice_id`. Table reads and writes cost no tasks.
 *
 * `last_alerted_status` is the dedupe key: an alert fires only when an
 * invoice's current *qualifying* status differs from the status we last
 * alerted on. That is what makes the draft -> authorised transition detectable
 * ON PURPOSE, rather than as a side effect of two separate polling
 * subscriptions each keeping their own dedupe store — which is why the two
 * `bill` pollers could not simply be merged into one unfiltered poller.
 */
const ALERT_STATE_TABLE = "01KZACA2ZA3XJWWGSMNEC381ZE";
const KEY_FIELD = "xero_invoice_id";

// --- Window and safety limits ----------------------------------------------

/**
 * Days of `UpdatedDateUTC` to re-read each fire, and the self-heal depth: the
 * Zap can be down this long without missing anything.
 *
 * It is UpdatedDateUTC and NOT Date, deliberately. A bill issued three weeks
 * ago and approved today still carries its original `Date`, so a window on
 * `Date` would never see the approval. `UpdatedDateUTC` bumps on both creation
 * and status change, which is exactly the set of events this Zap alerts on.
 */
const OVERLAP_DAYS = 7;

/** Xero returns 100 invoices per page; each page is one API call, so the walk
 *  is hard-bounded rather than running until it sees a short page. */
const MAX_PAGES = 3;

/** Cap on invoices considered in one run. */
const MAX_INVOICES = 200;

/**
 * Cap on alerts actually sent in one run. This is a blast-radius limit, not an
 * optimisation: if the state table were ever emptied or mis-primed, without it
 * a single fire could post hundreds of Slack messages and emails. Anything
 * over the cap keeps its state UNRECORDED, so the next fire picks it up and
 * the backlog drains gradually instead of all at once.
 */
const MAX_ALERTS_PER_RUN = 25;

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

/** First item of a runAction result ({ data: [...] } or a bare array). */
function firstResult(res: unknown): any {
  if (Array.isArray(res)) return res[0];
  const data = (res as any)?.data;
  return Array.isArray(data) ? data[0] : data;
}

/** A Zapier Table `labeled_string` cell reads back as `{ value, label }`. Every
 *  field on this Zap's table is a plain string, but a defensive read costs
 *  nothing and stops a future column-type change from silently breaking dedupe. */
function labeledValue(cell: unknown): string | null {
  if (cell && typeof cell === "object" && "value" in (cell as any)) {
    return firstString((cell as any).value);
  }
  return firstString(cell);
}

const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

function isEmail(v: unknown): v is string {
  return typeof v === "string" && EMAIL_RE.test(v.trim());
}

// --- Date arithmetic, in integers -----------------------------------------
//
// NEVER write `new Date` (or `Date.now()`) in the workflow body outside a
// `ctx.step`. The durable runtime replaces `Date` with a Proxy whose `construct`
// trap throws DeterminismViolation BEFORE it inspects its arguments, so even a
// deterministic `new Date(Date.UTC(y, m, d))` is rejected as hard as a clock
// read. It cost `drive-invoice-to-xero` 100% of its runs.

function daysInMonth(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function daysFromCivil(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function isoDateFromEpochMs(ms: number): string {
  const z = Math.floor(ms / 86400000) + 719468;
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
 * Full `YYYY-MM-DDTHH:MM:SSZ` from epoch milliseconds.
 *
 * The `Z` is load-bearing for the Table's datetime columns: a bare
 * `YYYY-MM-DD` is interpreted in the account's timezone (Asia/Singapore) and
 * lands 8 hours off, which shifts every date comparison at the boundaries.
 */
function isoTimestampFromEpochMs(ms: number): string {
  const msOfDay = ((ms % 86400000) + 86400000) % 86400000;
  const s = Math.floor(msOfDay / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${isoDateFromEpochMs(ms)}T${hh}:${mm}:${ss}Z`;
}

/** `YYYY-MM-DD` from any of Xero's date spellings, or null. Xero sends both
 *  `DueDateString` ("2026-08-15T00:00:00") and `DueDate` (`/Date(ms+tz)/`). */
function toIsoDate(v: unknown): string | null {
  const s = firstString(v);
  if (!s) return null;
  const plain = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (plain) {
    const month = Number(plain[2]);
    const day = Number(plain[3]);
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > daysInMonth(Number(plain[1]), month)) return null;
    return `${plain[1]}-${plain[2]}-${plain[3]}`;
  }
  const dotNet = /\/Date\((-?\d+)/.exec(s);
  if (dotNet) {
    const ms = Number(dotNet[1]);
    if (Number.isFinite(ms)) return isoDateFromEpochMs(ms);
  }
  return null;
}

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return daysFromCivil(y, m, d);
}

function shiftIsoDate(iso: string, days: number): string {
  return isoDateFromEpochMs((dayNumber(iso) + days) * 86400000);
}

/** Xero's `where` predicate wants `DateTime(y,m,d)` with unpadded integers —
 *  a zero-padded `07` risks being read as octal. */
function xeroDateTimeLiteral(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `DateTime(${y},${m},${d})`;
}

/** Two decimal places, thousands-separated — an alert should not read
 *  `7398.170000000001`. */
function formatAmount(v: unknown): string | null {
  const n = toNumber(v);
  if (n === null) return null;
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** The Slack `ts` of the message just posted. */
function postedTs(result: unknown): string | null {
  const row = (result as any)?.data?.[0];
  return firstString(row?.message?.ts, row?.ts);
}

// --- Routing ---------------------------------------------------------------

type Channel = "slack-bill-draft" | "email-subcontractor" | "slack-sales-draft";

/**
 * Which of the three retired Zaps this invoice belongs to, or null for the
 * (large) majority that are none of their business: PAID, VOIDED, DELETED,
 * SUBMITTED, and authorised sales invoices.
 */
function classify(type: string | null, status: string | null): Channel | null {
  const t = (type ?? "").toUpperCase();
  const s = (status ?? "").toUpperCase();
  if (t === "ACCPAY" && s === "DRAFT") return "slack-bill-draft";
  if (t === "ACCPAY" && s === "AUTHORISED") return "email-subcontractor";
  if (t === "ACCREC" && s === "DRAFT") return "slack-sales-draft";
  return null;
}

// --- Reading Xero invoices -------------------------------------------------

interface LineItem {
  description: string | null;
  quantity: string | null;
  lineAmount: string | null;
  accountCode: string | null;
}

/**
 * Xero's `LineItems`, defensively read.
 *
 * The classic sales-invoice Zap's template referenced `LineItems[]Description`
 * etc., which Zapier's array-flattening renders as one list per field (all
 * descriptions, then all quantities) rather than one line per item — a
 * two-line invoice read as a jumble of three disjoint lists. This keeps each
 * item's fields together.
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
    accountCode: firstString(it?.AccountCode, it?.account_code),
  }));
}

/** Any line item coded to the Subcontractor Fees account. */
function hasSubcontractorLineItem(lineItems: LineItem[]): boolean {
  return lineItems.some((li) => li.accountCode === SUBCONTRACTOR_ACCOUNT_CODE);
}

interface Invoice {
  invoiceId: string | null;
  invoiceNumber: string | null;
  type: string | null;
  status: string | null;
  contactName: string | null;
  contactFirstName: string | null;
  contactEmail: string | null;
  date: string | null;
  dueDate: string | null;
  currencyCode: string | null;
  total: string | null;
  totalRaw: number | null;
  amountDue: string | null;
  totalTax: string | null;
  lineItems: LineItem[];
}

function readInvoice(inv: any): Invoice {
  const contact = inv?.Contact ?? inv?.contact ?? {};
  return {
    invoiceId: firstString(inv?.InvoiceID, inv?.invoice_id, inv?.id),
    invoiceNumber: firstString(inv?.InvoiceNumber, inv?.invoice_number),
    type: firstString(inv?.Type, inv?.type),
    status: firstString(inv?.Status, inv?.status),
    contactName: firstString(contact.Name, contact.name),
    contactFirstName: firstString(contact.FirstName, contact.first_name, contact.Name, contact.name),
    contactEmail: firstString(contact.EmailAddress, contact.email_address),
    date: toIsoDate(inv?.DateString ?? inv?.Date ?? inv?.date),
    dueDate: toIsoDate(inv?.DueDateString ?? inv?.DueDate ?? inv?.due_date),
    currencyCode: firstString(inv?.CurrencyCode, inv?.currency_code),
    total: formatAmount(inv?.Total ?? inv?.total),
    totalRaw: toNumber(inv?.Total ?? inv?.total),
    amountDue: formatAmount(inv?.AmountDue ?? inv?.amount_due),
    totalTax: formatAmount(inv?.TotalTax ?? inv?.total_tax),
    lineItems: readLineItems(inv),
  };
}

// --- Message building — ported verbatim from the three retired Zaps --------

function buildBillSlackText(inv: Invoice): string {
  // Kept deliberately close to the classic Zap's wording and emoji.
  const link = inv.invoiceId
    ? `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${inv.invoiceId}`
    : "https://go.xero.com/AccountsPayable/";
  return [
    `📋 <${link}|New Bill Alert>`,
    "",
    `Vendor: ${inv.contactName ?? "(unknown vendor)"}`,
    `Amount: ${[inv.total, inv.currencyCode].filter(Boolean).join(" ") || "(unknown)"}`,
    `Due Date: ${inv.dueDate ?? "(no due date)"}`,
    `Invoice #: ${inv.invoiceNumber ?? "(not numbered)"}`,
  ].join("\n");
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

function buildSalesInvoiceSlackText(inv: Invoice): string {
  // Kept deliberately close to the classic Zap's wording, emoji and layout.
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

function buildSubcontractorSubject(inv: Invoice): string {
  return `Invoice ${inv.invoiceNumber ?? ""} Approved`.trim();
}

function buildSubcontractorBody(inv: Invoice): string {
  // Kept deliberately close to the classic Zap's wording and sign-off.
  //
  // NOTE: the retired Zap also attached the vendor's own uploaded invoice,
  // taken from the `bill` trigger payload's `attachments[].file` hydrate
  // references. A raw Xero API read cannot produce those — Xero exposes only
  // `upload_attachment` (write), with no read counterpart — so this email is
  // text-only. Agreed 2026-08-06: the attachment was the vendor's own
  // document, and the retired Zap never actually sent (its classic step was
  // published `paused: true` and the durable had 0 runs), so nothing regressed.
  return [
    `Hi ${inv.contactFirstName ?? "there"},`,
    "",
    "This email is to confirm that your invoice has been approved in Xero.",
    "",
    "Invoice Details:",
    `Invoice Number: ${inv.invoiceNumber ?? "(not numbered)"}`,
    `Amount Due: ${[inv.currencyCode, inv.total].filter(Boolean).join(" ") || "(unknown)"}`,
    `Due Date: ${inv.dueDate ?? "(no due date)"}`,
    "",
    "Thank you for your work on this project. This invoice will be processed according to our standard payment terms.",
    "",
    "If you have any questions or concerns, please don't hesitate to reach out.",
    "",
    "Thanks,",
    "Dennis",
  ].join("\n");
}

// --- Xero / Table access ---------------------------------------------------

/** One page of invoices updated on or after `sinceIso`. */
async function fetchInvoicePage(sinceIso: string, page: number): Promise<any[]> {
  const res = await sdk.runAction({
    appKey: XERO_APP_KEY,
    actionType: "write",
    actionKey: "_zap_raw_request",
    connection: XERO_CONNECTION,
    inputs: {
      method: "GET",
      url: `${XERO_API}/Invoices`,
      fail_on_errors: true,
      headers: { "Xero-Tenant-Id": XERO_ORGANIZATION, Accept: "application/json" },
      querystring: {
        where: `UpdatedDateUTC>=${xeroDateTimeLiteral(sinceIso)}`,
        order: "UpdatedDateUTC",
        page: String(page),
      },
    },
  });
  const body = firstResult(res)?.response?.body;
  if (typeof body !== "string") return [];
  return JSON.parse(body)?.Invoices ?? [];
}

/**
 * One invoice, in full.
 *
 * Xero's invoice LIST response is not guaranteed to carry `LineItems` or the
 * contact's `EmailAddress`, and both are load-bearing here — line items drive
 * the Subcontractor Fees filter and the sales-invoice alert body, and the
 * email address is the subcontractor's address. Rather than depend on what the
 * list happens to include, every invoice we are actually going to alert on is
 * re-read in full. Alerts are rare (a handful a week), so this costs almost
 * nothing, and it cannot silently degrade.
 */
async function fetchInvoiceDetail(invoiceId: string): Promise<any> {
  const res = await sdk.runAction({
    appKey: XERO_APP_KEY,
    actionType: "write",
    actionKey: "_zap_raw_request",
    connection: XERO_CONNECTION,
    inputs: {
      method: "GET",
      url: `${XERO_API}/Invoices/${invoiceId}`,
      fail_on_errors: true,
      headers: { "Xero-Tenant-Id": XERO_ORGANIZATION, Accept: "application/json" },
    },
  });
  const body = firstResult(res)?.response?.body;
  if (typeof body !== "string") return null;
  return (JSON.parse(body)?.Invoices ?? [])[0] ?? null;
}

/** State rows for one invoice id, oldest ULID first so racers agree. */
async function findStateRows(invoiceId: string): Promise<any[]> {
  const hit = await sdk.listTableRecords({
    table: ALERT_STATE_TABLE,
    keyMode: "names",
    filters: [{ fieldKey: KEY_FIELD, operator: "exact", value: invoiceId }],
    pageSize: 100,
  });
  return [...(hit?.data ?? [])].sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
}

const workflow = defineDurable<Record<string, unknown>, unknown>(
  "xero-invoice-alerts",
  async (ctx, rawInput) => {
    const payload = (InputSchema.parse(normalizeInput(rawInput)) ?? {}) as any;

    // A manual run can ask for the whole pass to be computed and reported
    // WITHOUT sending anything or writing any state. `trigger-workflow --input
    // '{"dryRun":true}'` is therefore a safe way to inspect what this Zap
    // would do. The schedule trigger never sets it.
    const dryRun = payload?.dryRun === true || payload?.dry_run === true || payload?.dryRun === "true";

    // The ONLY clock read, inside a step so it is fixed for every retry.
    const clock = await ctx.step("now", async () => {
      const ms = Date.now();
      return { today: isoDateFromEpochMs(ms), nowIso: isoTimestampFromEpochMs(ms) };
    });
    const sinceIso = shiftIsoDate(clock.today, -OVERLAP_DAYS);

    // 1. Is this the very first run? A polling trigger primes its dedupe on
    //    first poll and alerts on nothing; without the equivalent, the first
    //    fire would alert on every qualifying invoice in the window at once.
    //
    //    An EMPTY read and a FAILED read must not be confused: a failed read
    //    throws out of the step (and retries), because treating it as "empty"
    //    would silently suppress every alert.
    const probe = await ctx.step("probe-alert-state", async () =>
      sdk.listTableRecords({ table: ALERT_STATE_TABLE, keyMode: "names", pageSize: 1 }),
    );
    const priming = (probe?.data ?? []).length === 0;
    if (priming) {
      console.log(
        `PRIMING RUN: the alert-state table (${ALERT_STATE_TABLE}) is empty, so this pass will ` +
          `record state for every qualifying invoice and send NOTHING. This mirrors how a Zapier ` +
          `polling trigger primes its dedupe on first poll. Alerts begin on the next fire.`,
      );
    }

    // 2. Read Xero once. Bounded pages, all in ONE step so the page walk is a
    //    single retry unit.
    const fetched = await ctx.step("fetch-invoices", async () => {
      const rows: any[] = [];
      let pages = 0;
      let truncated = false;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const batch = await fetchInvoicePage(sinceIso, page);
        pages = page;
        rows.push(...batch);
        if (batch.length < 100) break;
        if (page === MAX_PAGES) truncated = true;
      }
      return { rows, pages, truncated };
    });

    // Deterministic order so per-item step names are stable across retries.
    // The batch itself is memoized by the step above, so an index can never
    // re-map onto a different invoice on a retry.
    const seen = new Set<string>();
    const candidates: { inv: Invoice; channel: Channel }[] = [];
    for (const raw of fetched.rows) {
      const inv = readInvoice(raw);
      if (!inv.invoiceId || seen.has(inv.invoiceId)) continue;
      seen.add(inv.invoiceId);
      const channel = classify(inv.type, inv.status);
      if (!channel) continue;
      candidates.push({ inv, channel });
    }
    candidates.sort((a, b) => (a.inv.invoiceId ?? "").localeCompare(b.inv.invoiceId ?? ""));

    const overInvoiceCap = candidates.length > MAX_INVOICES;
    const batch = overInvoiceCap ? candidates.slice(0, MAX_INVOICES) : candidates;

    // Never truncate silently — a capped run reporting success would read as
    // "everything is alerted" when it is not.
    if (fetched.truncated || overInvoiceCap) {
      console.log(
        `WARNING: this run did NOT cover its whole window. Xero pages ${fetched.pages}/${MAX_PAGES}` +
          `${fetched.truncated ? " (page cap hit)" : ""}; qualifying invoices ` +
          `${batch.length}/${candidates.length}${overInvoiceCap ? " (invoice cap hit)" : ""}. ` +
          `Nothing is lost — the next fire re-reads the same window — but if this repeats, raise ` +
          `MAX_PAGES/MAX_INVOICES or narrow OVERLAP_DAYS.`,
      );
    }

    console.log(
      `xero-invoice-alerts: window UpdatedDateUTC>=${sinceIso} (today ${clock.today}), ` +
        `${fetched.rows.length} invoice(s) read, ${batch.length} qualifying` +
        `${dryRun ? " — DRY RUN, nothing will be sent or written" : ""}`,
    );

    // 3. Decide and act, one invoice at a time.
    const alerted: any[] = [];
    const skipped: any[] = [];
    let alertsSent = 0;
    let stateWritten = 0;
    let alertCapHit = false;

    for (let i = 0; i < batch.length; i++) {
      const { inv, channel } = batch[i];
      const invoiceId = inv.invoiceId as string;
      const tag = String(i).padStart(3, "0");
      const status = (inv.status ?? "").toUpperCase();

      const rows = await ctx.step(`find-state-${tag}`, async () => findStateRows(invoiceId));

      // Converge on the earliest ULID if a race ever produced duplicates.
      if (rows.length > 1) {
        await ctx.step(`delete-dupe-state-${tag}`, async () =>
          sdk.deleteTableRecords({
            table: ALERT_STATE_TABLE,
            records: rows.slice(1).map((r: any) => r.id),
          }),
        );
      }
      const existing = rows[0] ?? null;
      const storedAlertedStatus = (labeledValue(existing?.data?.last_alerted_status) ?? "").toUpperCase();

      // THE DEDUPE DECISION. An alert fires only when the qualifying status
      // differs from the one we last alerted on — so a bill alerts once as
      // DRAFT and again when it becomes AUTHORISED, but never twice for the
      // same status no matter how many times the window re-reads it.
      const shouldAlert = !priming && storedAlertedStatus !== status;

      if (!shouldAlert) {
        // Still refresh last_seen so the row shows the Zap is watching.
        if (!dryRun && existing) {
          await ctx.step(`touch-state-${tag}`, async () =>
            sdk.updateTableRecords({
              table: ALERT_STATE_TABLE,
              keyMode: "names",
              records: [
                {
                  id: String(existing.id),
                  data: { last_seen_status: status, last_seen: clock.nowIso },
                },
              ],
            }),
          );
          stateWritten++;
        }
      }

      if (shouldAlert && alertsSent >= MAX_ALERTS_PER_RUN) {
        // Deliberately leave state UNRECORDED so the next fire retries this
        // invoice. The backlog drains gradually rather than all at once.
        alertCapHit = true;
        skipped.push({ invoiceId, number: inv.invoiceNumber, channel, reason: "alert cap reached" });
        continue;
      }

      // 3a. Re-read the invoice in full before alerting — the list response is
      //     not guaranteed to carry LineItems or the contact's email.
      let full = inv;
      let sendOutcome: string | null = null;
      let skipReason: string | null = null;

      if (shouldAlert) {
        const detail = await ctx.step(`fetch-detail-${tag}`, async () => fetchInvoiceDetail(invoiceId));
        if (detail) full = readInvoice(detail);
      }

      if (shouldAlert && channel === "email-subcontractor") {
        // The classic Zap's "Subcontractor Fees" filter — only bills coding at
        // least one line item to account 490 get a confirmation. Every other
        // approved bill (rent, software, …) is out of scope.
        if (!hasSubcontractorLineItem(full.lineItems)) {
          skipReason = `no line item coded to the Subcontractor Fees account (${SUBCONTRACTOR_ACCOUNT_CODE})`;
        } else if (!isEmail(full.contactEmail)) {
          skipReason = "vendor has no email address in Xero";
        }
      }

      if (shouldAlert && !skipReason) {
        if (dryRun) {
          sendOutcome = "dry-run";
          const preview =
            channel === "email-subcontractor"
              ? `${buildSubcontractorSubject(full)} -> ${full.contactEmail}`
              : channel === "slack-bill-draft"
                ? buildBillSlackText(full).split("\n")[0]
                : buildSalesInvoiceSlackText(full).split("\n")[0];
          console.log(`dry run: would send ${channel} for ${full.invoiceNumber ?? invoiceId} (${preview})`);
        } else if (channel === "email-subcontractor") {
          // `from` is deliberately not set: the Gmail connection already sends
          // as dennis@work.flowers, and the field is a dynamic enum that
          // rejects an unvalidated literal.
          const sent = await ctx.step(`send-email-${tag}`, async () =>
            sdk.runAction({
              appKey: GMAIL_APP_KEY,
              actionType: "write",
              actionKey: "message",
              connection: GMAIL_CONNECTION,
              inputs: {
                to: [full.contactEmail],
                subject: buildSubcontractorSubject(full),
                body: buildSubcontractorBody(full),
                body_type: "plain",
                send_to_groups: false,
                signature_delimiter: true,
              },
            }),
          );
          sendOutcome = "email-sent";
          console.log(
            `confirmed approval of ${full.invoiceNumber ?? invoiceId} to ${full.contactEmail} ` +
              `(message ${firstString((sent as any)?.data?.[0]?.id) ?? "?"})`,
          );
        } else {
          const text =
            channel === "slack-bill-draft"
              ? buildBillSlackText(full)
              : buildSalesInvoiceSlackText(full);
          const posted = await ctx.step(`post-slack-${tag}`, async () =>
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
          sendOutcome = "slack-posted";
          console.log(
            `posted ${channel} for ${full.invoiceNumber ?? invoiceId} to #finance ` +
              `(ts ${postedTs(posted) ?? "?"})`,
          );
        }
        if (sendOutcome !== "dry-run") alertsSent++;
      }

      if (skipReason) {
        console.log(`skipping ${full.invoiceNumber ?? invoiceId}: ${skipReason}`);
        skipped.push({ invoiceId, number: full.invoiceNumber, channel, reason: skipReason });
      }

      // 3b. Record state. A skipped-by-filter invoice still records its
      //     alerted status, so the filter is not re-evaluated (and not
      //     re-logged) every single hour for the rest of time.
      if (dryRun) {
        if (shouldAlert && !skipReason) alerted.push({ invoiceId, number: full.invoiceNumber, channel, outcome: "dry-run" });
        continue;
      }

      if (shouldAlert) {
        const data: Record<string, unknown> = {
          [KEY_FIELD]: invoiceId,
          invoice_number: full.invoiceNumber ?? "",
          invoice_type: (full.type ?? "").toUpperCase(),
          last_seen_status: status,
          last_alerted_status: status,
          last_alert_channel: channel,
          contact_name: full.contactName ?? "",
          total: full.totalRaw,
          currency_code: full.currencyCode ?? "",
          last_seen: clock.nowIso,
          last_alerted_at: clock.nowIso,
          last_skip_reason: skipReason ?? "",
        };
        if (existing) {
          const priorCount = toNumber(existing?.data?.alert_count) ?? 0;
          await ctx.step(`update-state-${tag}`, async () =>
            sdk.updateTableRecords({
              table: ALERT_STATE_TABLE,
              keyMode: "names",
              records: [
                { id: String(existing.id), data: { ...data, alert_count: priorCount + (skipReason ? 0 : 1) } },
              ],
            }),
          );
        } else {
          await ctx.step(`create-state-${tag}`, async () =>
            sdk.createTableRecords({
              table: ALERT_STATE_TABLE,
              keyMode: "names",
              records: [
                { data: { ...data, first_seen: clock.nowIso, alert_count: skipReason ? 0 : 1 } },
              ],
            }),
          );
        }
        stateWritten++;
        if (!skipReason) {
          alerted.push({ invoiceId, number: full.invoiceNumber, channel, outcome: sendOutcome });
        }
      } else if (!existing) {
        // Priming, or an invoice seen for the first time in a state we have
        // nothing to say about — record it so it is not reconsidered.
        await ctx.step(`create-state-${tag}`, async () =>
          sdk.createTableRecords({
            table: ALERT_STATE_TABLE,
            keyMode: "names",
            records: [
              {
                data: {
                  [KEY_FIELD]: invoiceId,
                  invoice_number: inv.invoiceNumber ?? "",
                  invoice_type: (inv.type ?? "").toUpperCase(),
                  last_seen_status: status,
                  // Priming records the CURRENT status as already-alerted, so
                  // the next fire treats it as old news. That is exactly what a
                  // polling trigger's first poll does.
                  last_alerted_status: priming ? status : "",
                  last_alert_channel: "",
                  contact_name: inv.contactName ?? "",
                  total: inv.totalRaw,
                  currency_code: inv.currencyCode ?? "",
                  first_seen: clock.nowIso,
                  last_seen: clock.nowIso,
                  alert_count: 0,
                  last_skip_reason: priming ? "priming run — recorded without alerting" : "",
                },
              },
            ],
          }),
        );
        stateWritten++;
      }
    }

    if (alertCapHit) {
      console.log(
        `WARNING: hit MAX_ALERTS_PER_RUN (${MAX_ALERTS_PER_RUN}). ${skipped.filter((s) => s.reason === "alert cap reached").length} ` +
          `invoice(s) were left UNRECORDED on purpose and will be picked up next fire. If this ` +
          `was not a one-off, the alert-state table may have been emptied — check before raising the cap.`,
      );
    }

    console.log(
      `xero-invoice-alerts done: ${alertsSent} alert(s) sent, ${skipped.length} skipped, ` +
        `${stateWritten} state row(s) written${priming ? " (PRIMING — no alerts by design)" : ""}`,
    );

    return {
      windowFrom: sinceIso,
      today: clock.today,
      dryRun,
      priming,
      invoicesRead: fetched.rows.length,
      xeroPagesRead: fetched.pages,
      coverageIncomplete: fetched.truncated || overInvoiceCap,
      qualifying: candidates.length,
      considered: batch.length,
      alertsSent,
      alertCapHit,
      stateRowsWritten: stateWritten,
      alerted,
      skipped,
    };
  },
);

export default workflow;
