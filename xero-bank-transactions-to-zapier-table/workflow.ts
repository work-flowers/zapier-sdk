// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/xero-bank-transactions-to-zapier-table
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// This workflow used to be driven by Xero's `bank_transaction` POLLING trigger,
// which delivered one transaction per run. It is now driven by a SCHEDULE
// trigger (`ScheduleCLIAPI` / `everyHour`, no connection — `auth_type` is "")
// and reads Xero itself, in a bounded date window, once per fire.
//
// WHY: a durable trigger has no polling-interval field. The `--trigger` payload
// accepts only selected_api / action / authentication_id / params — verified
// across all 43 live triggers in the account — so the classic Zap's
// `polling_interval_override: 5` had nowhere to go and this Zap silently began
// polling at the account default. Five Xero pollers on one tenant then
// exhausted Xero's 5,000-calls-per-day-per-tenant limit on 2026-08-06
// (`x-rate-limit-problem: day`, `x-daylimit-remaining: 0`, and
// `x-minlimit-remaining: 60` proving it was NOT a burst), which took every Xero
// Zap in the workspace down for ~10 hours.
//
// A schedule trigger costs Xero nothing, so moving the read into the body puts
// the interval back under our control: ~24-48 calls/day instead of ~1,440.
const XERO_APP_KEY = "XeroCLIAPI";
const XERO_CONNECTION = "xero_wf";

/** Xero organisation ("tenant") — work.flowers. `_zap_raw_request` has NO
 *  `organization` field in its schema and silently strips one, so an org-scoped
 *  call fails with "Please select an organization to perform this step on."
 *  unless the tenant goes in as a HEADER. */
const XERO_ORGANIZATION = "62699a8c-3351-40e8-9265-bdca5e037b03";
const XERO_API = "https://api.xero.com/api.xro/2.0";

/**
 * "Xero Bank Transactions" — the mirror this workflow owns.
 *
 * Read by `drive-invoice-to-xero` to answer "has this invoice already been
 * paid?". That workflow is only as correct as this one is current: when this
 * Zap's write step was accidentally paused, the Table silently fell ~5 days
 * behind and invoices that HAD been paid got duplicate draft bills, with no
 * error anywhere. Treat a pause here as a production incident downstream.
 */
const TABLE_ID = "01KCDV6Y17F31J2Q6S1EMYZC8K";

/** The Table's natural key: one row per Xero bank transaction. */
const KEY_FIELD = "bank_transaction_id";

/**
 * Every field this workflow mirrors, in Table order. `currency_rate` is
 * included deliberately — the classic Zap never mapped it, so that column was
 * null on every row despite being populated on ~36% of transactions (any
 * non-base-currency one).
 */
const MIRRORED_FIELDS = [
  KEY_FIELD,
  "date",
  "bank_account_id",
  "reference",
  "contact_id",
  "contact_name",
  "type",
  "currency_code",
  "currency_rate",
  "total",
  "has_attachments",
] as const;

// --- Window tuning ---------------------------------------------------------
//
// The window is [newest mirrored row − OVERLAP_DAYS, today]. The overlap is
// what makes this self-healing: a run that fails, or an hour the Zap spent
// disabled, is simply re-read on the next fire. The old polling trigger could
// not do that — it primed its dedupe on first poll, so a gap stayed a gap
// forever (see known_gaps.no_backfill_by_design in zap.json). The overlap also
// means recent rows get re-read every hour, which finally lets the update path
// correct the stale `reference` / `currency_rate` / `has_attachments` values
// Xero fills in AFTER a transaction is created.

/** Days to re-read behind the newest mirrored row. Also the self-heal depth:
 *  the Zap can be down this long without losing anything. */
const OVERLAP_DAYS = 7;

/** Used only when the Table has no readable newest row (empty, renamed column,
 *  failed read). Deliberately modest — this is a mirror, not a backfill tool. */
const INITIAL_LOOKBACK_DAYS = 30;

/** Xero returns 100 bank transactions per page. Each page is one API call, so
 *  the loop is hard-bounded rather than running until it sees an empty page. */
const MAX_PAGES = 3;

/**
 * Belt-and-braces cap on how many transactions one run will upsert. At the
 * observed rate (~685 rows over ~1 year, so ~12/week) a 7-day window returns
 * ~12-15, so this is pure headroom.
 *
 * It MUST be >= MAX_PAGES * 100. When it was 200 against 3 pages, a wide window
 * fetched 201-215 transactions and then silently processed only the first 200
 * *sorted by transaction id* — an arbitrary subset, so recent transactions could
 * be excluded from the mirror indefinitely while the run still reported success.
 */
const MAX_TRANSACTIONS = MAX_PAGES * 100;

// The schedule trigger's payload carries nothing this workflow needs — it is a
// tick, not a record. Accept anything and ignore it. Firing the workflow by
// hand with an empty body is therefore a valid manual re-sync.
const InputSchema = z.unknown();

// --- Pure helpers ----------------------------------------------------------

function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline can deliver input double-encoded (a JSON string of a
  // JSON string), while a manual `trigger-workflow --input` delivers it
  // single-encoded. Parse until we reach a non-string, or stop on parse failure.
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
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/[^0-9.+-]/g, ""));
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

/** A Zapier Table `labeled_string` cell reads back as `{ value, label }`. */
function labeledValue(cell: unknown): string | null {
  if (cell && typeof cell === "object" && "value" in (cell as any)) {
    return firstString((cell as any).value);
  }
  return firstString(cell);
}

// --- Date arithmetic, in integers -----------------------------------------
//
// NEVER write `new Date` (or `Date.now()`) in the workflow body outside a
// `ctx.step`. The durable runtime replaces `Date` with a Proxy whose `construct`
// trap throws DeterminismViolation BEFORE it inspects its arguments, so even a
// perfectly deterministic `new Date(Date.UTC(y, m, d))` is rejected as hard as a
// clock read. It cost `drive-invoice-to-xero` 100% of its runs.
//
// `daysFromCivil` / `isoDateFromEpochMs` are Hinnant's civil-from-days pair, as
// already used in `drive-invoice-to-xero` and
// `xero-overdue-invoice-to-gmail-reminder`.

/** Days in a month, proleptic Gregorian. */
function daysInMonth(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Days since the Unix epoch for a `YYYY-MM-DD` triple. */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** `YYYY-MM-DD` from epoch milliseconds. */
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

/** `YYYY-MM-DD` from an ISO-ish date string, or null. Rejects an impossible
 *  month or day rather than letting it normalise into a different year. */
function toIsoDate(v: unknown): string | null {
  const s = firstString(v);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) {
    const [, y, mo, d] = m;
    const month = Number(mo);
    const day = Number(d);
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > daysInMonth(Number(y), month)) return null;
    return `${y}-${mo}-${d}`;
  }
  // Xero's raw JSON API returns dates in .NET epoch form — `Date` comes back as
  // "/Date(1784937600000+0000)/" while only `DateString` is ISO-ish. The
  // POLLING trigger this workflow used to run on delivered a plain date, so a
  // parser that handled only the ISO form worked for a year and then silently
  // returned null for every row the moment the read moved to the raw API. See
  // the 2026-08-07 entry in zap.json's version_history.
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

/**
 * Midnight-UTC datetime for the Table's `date` column.
 *
 * Xero sends `2026-07-26T00:00:00+00:00`; a bare `YYYY-MM-DD` would be read in
 * the account's local timezone (Asia/Singapore) and land 8 hours off, which
 * shifts every date-window query run against this Table. Pin `Z` explicitly.
 */
function toTableDate(v: unknown): string | null {
  const iso = toIsoDate(v);
  return iso ? `${iso}T00:00:00Z` : null;
}

/**
 * Xero's `where` predicate wants `DateTime(y,m,d)` with unpadded integers —
 * a zero-padded `07` risks being read as octal by some parsers.
 */
function xeroDateTimeLiteral(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `DateTime(${y},${m},${d})`;
}

interface Snapshot {
  bank_transaction_id: string;
  date: string | null;
  bank_account_id: string;
  reference: string;
  contact_id: string;
  contact_name: string;
  type: string;
  currency_code: string;
  currency_rate: number | null;
  total: number | null;
  has_attachments: boolean;
}

/** Build the row this transaction should have. */
function extractSnapshot(payload: unknown): Snapshot | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, any>;
  // Xero's own name is BankTransactionID; the old polling trigger also added a
  // lowercase `id`, which a raw API read does not, so both are accepted.
  const id = firstString(p.BankTransactionID, p.id);
  if (!id) return null;
  return {
    bank_transaction_id: id,
    // `DateString` FIRST, and each candidate tried independently rather than
    // via `??`. `p.Date` is always present on a raw API read, so `p.Date ??
    // p.DateString` never reached DateString — and since `Date` is .NET epoch
    // form, every row got a null date, which the update path then wrote back
    // over good stored values. That wiped the date on 214 rows.
    date: toTableDate(p.DateString) ?? toTableDate(p.Date) ?? toTableDate(p.date),
    bank_account_id: firstString(p.BankAccount?.AccountID) ?? "",
    reference: firstString(p.Reference) ?? "",
    // Transfers (SPEND-TRANSFER / RECEIVE-TRANSFER) carry no contact at all.
    contact_id: firstString(p.Contact?.ContactID) ?? "",
    contact_name: firstString(p.Contact?.Name) ?? "",
    type: firstString(p.Type) ?? "",
    currency_code: firstString(p.CurrencyCode) ?? "",
    currency_rate: toNumber(p.CurrencyRate),
    total: toNumber(p.Total),
    has_attachments: p.HasAttachments === true,
  };
}

/**
 * NEVER BLANK A POPULATED FIELD.
 *
 * This is the guard that should have stopped the 2026-08-07 incident on its
 * own, independently of the date-parsing bug that caused it. A bad extraction
 * produced `date: null`, `changedFields` duly reported a difference against a
 * good stored date, and the update path wrote the null straight over it —
 * destroying the value on 214 rows and marching this workflow's own read window
 * backwards through history as the mirror's apparent newest row receded.
 *
 * A mirror should only ever be able to ADD or CORRECT information, never to
 * delete it: if we could not read a value, we have learned nothing about it, so
 * the stored value stands. Worst case we keep something stale, which is
 * recoverable; a wiped column is not distinguishable from a real absence.
 *
 * The same fill-don't-blank discipline is used for Xero contact writes in
 * `drive-invoice-to-xero` ("fill a gap or fix drift, never blank").
 */
function wouldBlankAPopulatedField(stored: Record<string, unknown>, snap: Snapshot, field: string): boolean {
  const want: unknown = (snap as any)[field];
  const got = field === "type" || field === "currency_code" ? labeledValue(stored[field]) : stored[field];
  const wantBlank = want == null || (typeof want === "string" && want.trim() === "");
  const gotBlank = got == null || (typeof got === "string" && String(got).trim() === "");
  return wantBlank && !gotBlank;
}

/** Compare a stored row against the snapshot, field by field, as the Table
 *  would return them. Returns the fields that actually differ.
 *
 *  A field whose snapshot value is blank while the stored value is populated is
 *  NOT reported as a difference — see `wouldBlankAPopulatedField`. */
function changedFields(stored: Record<string, unknown>, snap: Snapshot): string[] {
  const diffs: string[] = [];
  for (const field of MIRRORED_FIELDS) {
    const want: unknown = snap[field];
    const got = stored[field];
    // `has_attachments` is a genuine boolean, so `false` is a real value rather
    // than an absence and this guard must not apply to it.
    if (field !== "has_attachments" && wouldBlankAPopulatedField(stored, snap, field)) continue;
    if (field === "type" || field === "currency_code") {
      if ((labeledValue(got) ?? "") !== String(want ?? "")) diffs.push(field);
      continue;
    }
    if (field === "has_attachments") {
      if (Boolean(got) !== Boolean(want)) diffs.push(field);
      continue;
    }
    if (field === "total" || field === "currency_rate") {
      const a = toNumber(got);
      const b = want as number | null;
      if (a == null && b == null) continue;
      if (a == null || b == null || Math.abs(a - b) > 0.000001) diffs.push(field);
      continue;
    }
    if (field === "date") {
      // Compare on the calendar day; the stored form may or may not carry Z.
      if ((firstString(got) ?? "").slice(0, 10) !== (firstString(want) ?? "").slice(0, 10)) {
        diffs.push(field);
      }
      continue;
    }
    if ((firstString(got) ?? "") !== String(want ?? "")) diffs.push(field);
  }
  return diffs;
}

/** Rows for one transaction id, oldest ULID first so racers agree on a winner. */
async function findRows(id: string): Promise<any[]> {
  const hit = await sdk.listTableRecords({
    table: TABLE_ID,
    keyMode: "names",
    filters: [{ fieldKey: KEY_FIELD, operator: "exact", value: id }],
    pageSize: 100,
  });
  return [...(hit?.data ?? [])].sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
}

/** One page of bank transactions dated on or after `sinceIso`. */
async function fetchPage(sinceIso: string, page: number): Promise<any[]> {
  const res = await sdk.runAction({
    appKey: XERO_APP_KEY,
    actionType: "write",
    actionKey: "_zap_raw_request",
    connection: XERO_CONNECTION,
    inputs: {
      method: "GET",
      url: `${XERO_API}/BankTransactions`,
      fail_on_errors: true,
      headers: { "Xero-Tenant-Id": XERO_ORGANIZATION, Accept: "application/json" },
      querystring: {
        where: `Date>=${xeroDateTimeLiteral(sinceIso)}`,
        order: "Date",
        page: String(page),
      },
    },
  });
  const body = firstResult(res)?.response?.body;
  if (typeof body !== "string") return [];
  return JSON.parse(body)?.BankTransactions ?? [];
}

const workflow = defineDurable<Record<string, unknown>, unknown>(
  "xero-bank-transactions-to-zapier-table",
  async (ctx, rawInput) => {
    const payload = (InputSchema.parse(normalizeInput(rawInput)) ?? {}) as any;

    /**
     * Compute the whole pass and report what it WOULD write, writing nothing.
     *
     * This exists because of the 2026-08-07 incident. The version that wiped the
     * date column was "validated" by a `run-durable` that died at the Xero fetch
     * on a rate limit, so the extraction and upsert code below was never
     * executed even once before it reached production. A skip-path test proves
     * nothing about the code after it — and without a dry run there was no way
     * to exercise the main path against real Xero data without also writing to
     * the production Table.
     *
     * `trigger-workflow <id> --input '{"dryRun":true}'` is now the safe test.
     */
    const dryRun = payload?.dryRun === true || payload?.dry_run === true || payload?.dryRun === "true";

    // The ONLY clock read, and it is inside a step so its value is fixed for
    // every retry of this run.
    const today = await ctx.step("today", async () => isoDateFromEpochMs(Date.now()));

    // 1. How far back to read. One free Table read: no filters, newest first,
    //    a single row. Free, so it costs nothing to be precise.
    const newestRow = await ctx.step("latest-mirrored-row", async () =>
      sdk.listTableRecords({
        table: TABLE_ID,
        keyMode: "names",
        sort: { fieldKey: "date", direction: "desc" },
        pageSize: 1,
      }),
    );
    const latestRowDate = toIsoDate((newestRow?.data ?? [])[0]?.data?.date);

    // An unreadable newest row is a harder fault than a stale one — an empty
    // table, a renamed `date` column and a failed read are indistinguishable
    // from here — so fall back to a fixed lookback rather than trusting it.
    const sinceIso =
      latestRowDate == null
        ? shiftIsoDate(today, -INITIAL_LOOKBACK_DAYS)
        : shiftIsoDate(latestRowDate, -OVERLAP_DAYS);
    if (latestRowDate == null) {
      console.log(
        `WARNING: no newest row could be read from table ${TABLE_ID} — falling back to a ` +
          `${INITIAL_LOOKBACK_DAYS}-day lookback from ${today}. If this repeats, check the ` +
          `\`date\` column still exists and the table is not empty.`,
      );
    }
    console.log(`syncing Xero bank transactions dated ${sinceIso}..${today} (newest mirrored row: ${latestRowDate ?? "none"})`);

    // 2. Read Xero. Bounded pages, all inside ONE step so the whole fetch is a
    //    single retry unit and a partial page walk is never half-applied.
    const fetch = await ctx.step("fetch-bank-transactions", async () => {
      const rows: any[] = [];
      let pages = 0;
      let truncated = false;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const batch = await fetchPage(sinceIso, page);
        pages = page;
        rows.push(...batch);
        if (batch.length < 100) break;
        if (page === MAX_PAGES) truncated = true;
      }
      return { rows, pages, truncated };
    });

    // Deterministic order, so the per-item step names below are stable across
    // retries regardless of what order Xero returned things in.
    const seen = new Set<string>();
    const snapshots: Snapshot[] = [];
    for (const raw of fetch.rows) {
      const snap = extractSnapshot(raw);
      if (!snap || seen.has(snap.bank_transaction_id)) continue;
      seen.add(snap.bank_transaction_id);
      snapshots.push(snap);
    }
    snapshots.sort((a, b) => a.bank_transaction_id.localeCompare(b.bank_transaction_id));

    const capped = snapshots.length > MAX_TRANSACTIONS;
    const batch = capped ? snapshots.slice(0, MAX_TRANSACTIONS) : snapshots;

    // Never truncate silently — a capped run that reports success would read as
    // "the mirror is current" when it is not.
    if (fetch.truncated || capped) {
      console.log(
        `WARNING: this run did NOT cover its whole window. ` +
          `Xero pages fetched: ${fetch.pages}/${MAX_PAGES}${fetch.truncated ? " (page cap hit)" : ""}; ` +
          `transactions ${batch.length}/${snapshots.length}${capped ? " (transaction cap hit)" : ""}. ` +
          `The remainder is NOT lost — the next fire re-reads the same window — but if this ` +
          `warning repeats, raise MAX_PAGES/MAX_TRANSACTIONS or narrow OVERLAP_DAYS.`,
      );
    }

    // 3. Upsert each transaction. Step names are index-based off the sorted
    //    batch: short, unique, and stable across retries because `fetch` is
    //    memoized by its own step.
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let duplicatesRemoved = 0;
    const changedIds: string[] = [];

    for (let i = 0; i < batch.length; i++) {
      const snap = batch[i];
      const tag = String(i).padStart(3, "0");

      const existing = await ctx.step(`find-row-${tag}`, async () => findRows(snap.bank_transaction_id));

      if (existing.length === 0) {
        if (dryRun) {
          created++;
          changedIds.push(snap.bank_transaction_id);
          console.log(
            `dry run: would CREATE ${snap.bank_transaction_id} date=${snap.date} ` +
              `(${snap.contact_name || "no contact"} ${snap.type} ${snap.currency_code} ${snap.total})`,
          );
          continue;
        }
        await ctx.step(`create-row-${tag}`, async () =>
          sdk.createTableRecords({
            table: TABLE_ID,
            keyMode: "names",
            records: [{ data: { ...snap } }],
          }),
        );

        // Two runs for the same transaction can both find nothing and both
        // create. Re-read and converge: earliest ULID wins, strays go. Deletes
        // are idempotent, so whichever racer gets here second is still correct.
        const after = await ctx.step(`dedupe-after-create-${tag}`, async () =>
          findRows(snap.bank_transaction_id),
        );
        if (after.length > 1) {
          await ctx.step(`delete-duplicates-${tag}`, async () =>
            sdk.deleteTableRecords({
              table: TABLE_ID,
              records: after.slice(1).map((r: any) => r.id),
            }),
          );
          duplicatesRemoved += after.length - 1;
        }
        created++;
        changedIds.push(snap.bank_transaction_id);
        console.log(
          `created ${snap.bank_transaction_id} (${snap.contact_name || "no contact"} ` +
            `${snap.type} ${snap.currency_code} ${snap.total})`,
        );
        continue;
      }

      // Already mirrored. Clear any strays first so the key stays unique.
      if (existing.length > 1 && !dryRun) {
        await ctx.step(`delete-duplicates-${tag}`, async () =>
          sdk.deleteTableRecords({
            table: TABLE_ID,
            records: existing.slice(1).map((r: any) => r.id),
          }),
        );
        duplicatesRemoved += existing.length - 1;
      }

      // Refresh the row only when something actually moved. Xero restates a
      // transaction after creation — it fills `Reference` at reconciliation,
      // and `has_attachments` flips to true when `drive-invoice-to-xero`
      // attaches an invoice — so re-reading the window is a chance to correct
      // the mirror. The old polling trigger almost never got that chance,
      // which is why stale columns accumulated.
      const winner = existing[0];
      const storedRow = (winner?.data ?? {}) as Record<string, unknown>;
      const diffs = changedFields(storedRow, snap);
      if (diffs.length === 0) {
        unchanged++;
        continue;
      }

      // Build the write from the snapshot MINUS any field that would blank a
      // populated stored value. Excluding it from `diffs` is not enough on its
      // own: the write sends the whole snapshot, so a null still lands unless it
      // is dropped from the payload too. Omitting a key leaves that column
      // untouched. This is the second half of the guard described on
      // `wouldBlankAPopulatedField` — the half whose absence caused the incident.
      const writeData: Record<string, unknown> = {};
      const preserved: string[] = [];
      for (const field of MIRRORED_FIELDS) {
        if (field !== "has_attachments" && wouldBlankAPopulatedField(storedRow, snap, field)) {
          preserved.push(field);
          continue;
        }
        writeData[field] = (snap as any)[field];
      }
      if (preserved.length > 0) {
        console.log(
          `WARNING: ${snap.bank_transaction_id} — could not read ${preserved.join(", ")} from Xero, ` +
            `so the stored value(s) were KEPT rather than blanked. If this is widespread, the ` +
            `extraction for that field is broken (this is exactly how the date column was wiped ` +
            `on 214 rows in the 2026-08-07 incident).`,
        );
      }

      if (dryRun) {
        updated++;
        changedIds.push(snap.bank_transaction_id);
        console.log(
          `dry run: would UPDATE ${snap.bank_transaction_id} [${diffs.join(", ")}] ` +
            `stored date=${firstString(storedRow.date) ?? "(none)"} -> ${snap.date ?? "(none)"}`,
        );
        continue;
      }

      await ctx.step(`update-row-${tag}`, async () =>
        sdk.updateTableRecords({
          table: TABLE_ID,
          keyMode: "names",
          records: [{ id: String(winner.id), data: writeData }],
        }),
      );
      updated++;
      changedIds.push(snap.bank_transaction_id);
      console.log(`updated ${snap.bank_transaction_id}: ${diffs.join(", ")}`);
    }

    console.log(
      `sync complete for ${sinceIso}..${today}: ${created} created, ${updated} updated, ` +
        `${unchanged} unchanged, ${duplicatesRemoved} duplicate row(s) removed ` +
        `(${fetch.pages} Xero page read${fetch.pages === 1 ? "" : "s"})`,
    );

    return {
      dryRun,
      windowFrom: sinceIso,
      windowTo: today,
      latestRowDateBefore: latestRowDate,
      xeroPagesRead: fetch.pages,
      xeroCoverageIncomplete: fetch.truncated || capped,
      transactionsFetched: snapshots.length,
      transactionsProcessed: batch.length,
      created,
      updated,
      unchanged,
      duplicatesRemoved,
      changedIds,
    };
  },
);

export default workflow;
