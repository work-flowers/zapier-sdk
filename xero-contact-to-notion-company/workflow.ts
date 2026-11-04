// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/xero-contact-to-notion-company
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- What this is ----------------------------------------------------------
//
// The XERO -> NOTION half of the company/contact link.
// `xero-contact-from-notion-deal` covers Notion -> Xero: a Company (or a Deal's
// company) gets a contact created in Xero, and the new ContactID is written back
// onto the Notion page. This workflow covers the case that one structurally
// cannot:
//
//   A contact is created in Xero by other means — typically a transaction
//   arrives from a new vendor and the contact is made by hand. If a Company
//   record already exists in Notion, its Notion Company ID (the `ID` property,
//   e.g. "COM-766") is pasted into the Xero contact's ACCOUNT NUMBER. This
//   workflow spots that and completes the link.
//
// Nothing changes on the Notion side in that flow, so no Notion webhook fires
// and the other durable never runs.
//
// Migrated from two functionally identical CLASSIC Zaps, "Add Xero Contact ID to
// Company IDs Table" and "Associate Xero Contact with Notion Company". Two
// things changed in the migration:
//
//  1. IT WRITES TO NOTION, NOT THE TABLE. The classic Zaps wrote the ContactID
//     into `[Table] Company IDs` (f15) and left the Notion property empty. That
//     made the link TEMPORARY — `notion-companies-to-zapier-table` is a true
//     mirror ("empty in Notion clears the table value") so the next edit of that
//     company wiped f15 back out — and it left the other durable's dedupe guard
//     BLIND, since that guard reads the Notion property. Xero's contact action
//     matches on NAME, so a later re-run would have silently overwritten the
//     hand-made vendor contact's people.
//
//  2. IT POLLS EVERY 15 MINUTES — since 2026-11. From 2026-08 to 2026-11 it ran
//     on a schedule and swept a 7-day window, because a durable poller had no
//     interval knob and polled ~1/min (~1,440 Xero calls/day; five Xero pollers
//     exhausted the tenant's 5,000/day on 2026-08-06). The trigger param
//     `_zap_polling_interval_minutes: 15` (undocumented; Zapier support's
//     "temporary workaround", verified 2026-11-04) restores the classic Zap's
//     15-minute cadence, ~96 calls/day. The poller now hands over ONE contact
//     per run; the old sweep survives as a manual `{"sweep":true}` recovery mode.

// --- Bindings --------------------------------------------------------------
const XERO_APP_KEY = "XeroCLIAPI";
const XERO_CONNECTION = "xero_wf";

/** Xero organisation ("tenant") — work.flowers. `_zap_raw_request` has NO
 *  `organization` field and silently strips one, so the tenant must go in as a
 *  HEADER or the call fails with "Please select an organization…". */
const XERO_ORGANIZATION = "62699a8c-3351-40e8-9265-bdca5e037b03";
const XERO_API = "https://api.xero.com/api.xro/2.0";

/** Notion, work.flowers workspace — NEVER the Knoxx connection, which cannot
 *  see work.flowers databases. */
const NOTION_CONNECTION = "notion_wf";
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

/**
 * `[Table] Company IDs` — the free lookup that makes this cheap.
 *
 * Owned and populated by `notion-companies-to-zapier-table`, mirroring Notion
 * Companies. Read-only here EXCEPT for the cache-warm noted on
 * `warmTableCache`. Reads and writes cost no tasks.
 */
const COMPANY_TABLE = "01JM8PH8YM93A482M8BFZ6WKW6";
/** Notion's `ID` property, e.g. "COM-766" — what goes in Xero's Account Number. */
const TABLE_NOTION_COMPANY_ID = "Notion Company ID"; // f11
/** The Notion page UUID. The trigger data cannot supply this — Account Number
 *  carries the human-readable `ID`, not a UUID — so the Table read is the ONLY
 *  source of it, which is why it is not just a gate. */
const TABLE_NOTION_PAGE_ID = "Notion Page ID"; // f14
const TABLE_XERO_CONTACT_ID = "Xero Contact ID"; // f15

/** The Notion Companies property this workflow writes. */
const COMPANY_XERO_ID_PROP = "Xero Contact ID";

// --- Window and limits (the manual sweep only) ------------------------------

/** Days of `UpdatedDateUTC` a `{"sweep":true}` run re-reads: how long the
 *  poller can have been down and still be fully recovered by one sweep. */
const OVERLAP_DAYS = 7;

/** Xero returns 100 contacts per page; each page is one API call, so the walk is
 *  hard-bounded rather than running until it sees a short page. Observed volume
 *  is ~12 contacts per 13 days, so one page is the norm by a wide margin. */
const MAX_PAGES = 3;

/** Blast-radius cap on Notion writes per sweep. Nothing is lost when it trips —
 *  re-run the sweep. */
const MAX_LINKS_PER_RUN = 25;

const InputSchema = z.unknown();

// --- Pure helpers ----------------------------------------------------------

function normalizeInput(rawInput: unknown): unknown {
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
function firstResult(res: unknown): any {
  if (Array.isArray(res)) return res[0];
  const data = (res as any)?.data;
  return Array.isArray(data) ? data[0] : data;
}

/** A Zapier Table `labeled_string` cell reads back as `{ value, label }`. Every
 *  column read here is a plain string, but a defensive read costs nothing. */
function cellValue(cell: unknown): string {
  if (cell && typeof cell === "object" && "value" in (cell as any)) {
    return firstString((cell as any).value) ?? "";
  }
  return firstString(cell) ?? "";
}

function dashUuid(id: string): string {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (hex.length !== 32) return id.trim();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// --- Date arithmetic, in integers -----------------------------------------
//
// NEVER write `new Date` (or `Date.now()`) in the workflow body outside a
// `ctx.step`. The durable runtime replaces `Date` with a Proxy whose `construct`
// trap throws DeterminismViolation BEFORE inspecting its arguments, so even a
// deterministic `new Date(Date.UTC(y, m, d))` is rejected as hard as a clock
// read. It cost `drive-invoice-to-xero` 100% of its runs.

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

function shiftIsoDate(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return isoDateFromEpochMs((daysFromCivil(y, m, d) + days) * 86400000);
}

/** Xero's `where` predicate wants `DateTime(y,m,d)` with UNPADDED integers — a
 *  zero-padded `07` risks being read as octal. */
function xeroDateTimeLiteral(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `DateTime(${y},${m},${d})`;
}

// --- Xero / Table / Notion access ------------------------------------------

interface XeroContact {
  contactId: string;
  name: string;
  accountNumber: string;
}

/**
 * One page of contacts updated on or after `sinceIso`.
 *
 * `summaryOnly=true` keeps the payload small and STILL returns `AccountNumber`
 * and `ContactID`, which is all this workflow needs. (Xero omits the
 * `AccountNumber` key entirely when it is empty, so its absence on a given
 * contact is not evidence the parameter dropped it.)
 */
async function fetchContactPage(sinceIso: string, page: number): Promise<any[]> {
  const res = await sdk.runAction({
    appKey: XERO_APP_KEY,
    actionType: "write",
    actionKey: "_zap_raw_request",
    connection: XERO_CONNECTION,
    inputs: {
      method: "GET",
      url: `${XERO_API}/Contacts`,
      fail_on_errors: true,
      headers: { "Xero-Tenant-Id": XERO_ORGANIZATION, Accept: "application/json" },
      querystring: {
        where: `UpdatedDateUTC>=${xeroDateTimeLiteral(sinceIso)}`,
        order: "UpdatedDateUTC",
        summaryOnly: "true",
        page: String(page),
      },
    },
  });
  const body = firstResult(res)?.response?.body;
  if (typeof body !== "string") return [];
  return JSON.parse(body)?.Contacts ?? [];
}

/** The Company IDs row whose Notion Company ID matches this Account Number. */
async function findCompanyRow(accountNumber: string): Promise<any | null> {
  const hit = await sdk.listTableRecords({
    table: COMPANY_TABLE,
    keyMode: "names",
    filters: [{ fieldKey: TABLE_NOTION_COMPANY_ID, operator: "exact", value: accountNumber }],
    pageSize: 10,
  });
  const rows = [...(hit?.data ?? [])].sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
  return rows[0] ?? null;
}

/** Write the ContactID onto the Notion Company page. THIS is the authoritative
 *  write — Notion is the source of truth, and the mirror carries it to the Table. */
async function writeXeroIdToNotion(pageId: string, contactId: string): Promise<void> {
  const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
    connection: NOTION_CONNECTION,
    method: "PATCH",
    headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    body: JSON.stringify({
      properties: {
        [COMPANY_XERO_ID_PROP]: { rich_text: [{ text: { content: contactId } }] },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Notion write of ${COMPANY_XERO_ID_PROP} to ${pageId} failed (${res.status}): ${await res.text()}`,
    );
  }
}

/**
 * Warm the Table's own copy of the id, immediately after the Notion write.
 *
 * NOT a second source of truth — the mirror would set this anyway, from the
 * value we just wrote to Notion. It is done here only so the `already linked`
 * gate closes on THIS run rather than waiting on a webhook we do not control;
 * without it, a fire landing inside the mirror's latency window would re-issue
 * an identical (harmless but pointless) Notion PATCH. Free: Table writes cost
 * no tasks.
 *
 * Writing ONLY here is what the classic Zaps did, and it is precisely the bug
 * this workflow exists to fix — the value must reach Notion first.
 */
async function warmTableCache(recordId: string, contactId: string): Promise<void> {
  await sdk.updateTableRecords({
    table: COMPANY_TABLE,
    keyMode: "names",
    records: [{ id: recordId, data: { [TABLE_XERO_CONTACT_ID]: contactId } }],
  });
}

/**
 * The windowed read, as ONE step so the page walk is a single retry unit.
 *
 * Lives in a helper that takes `ctx` because of the publish-time analyzer: a
 * step in the workflow body whose callback reaches `sdk.runAction` through a
 * function call is refused as `malformed-run-action` ("Pass appKey, actionType,
 * and actionKey on the sdk.runAction call"). It refused this Zap's republish on
 * 2026-10-31, on a body unchanged since 2026-08-07; xero-invoice-alerts hit the
 * same rule on 2026-10-07 and was fixed the same way. The analyzer does not
 * follow `ctx` into a helper. The step id is unchanged.
 */
function fetchWindow(
  ctx: DurableContext,
  sinceIso: string,
): Promise<{ rows: any[]; pages: number; truncated: boolean }> {
  return ctx.step("fetch-contacts", async () => {
    const rows: any[] = [];
    let pages = 0;
    let truncated = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await fetchContactPage(sinceIso, page);
      pages = page;
      rows.push(...batch);
      if (batch.length < 100) break;
      if (page === MAX_PAGES) truncated = true;
    }
    return { rows, pages, truncated };
  });
}

// --- Per-item steps ----------------------------------------------------------

/**
 * A step whose id carries a loop index. The runtime needs the index (two steps
 * with one id in a run collide), but Zapier's publish-time analyzer, which
 * began refusing on 2026-09-03 after this Zap's last publish, rejects a
 * template-literal step id in the workflow body and does not follow `ctx` into
 * a helper. The ids are exactly the ones the body used before, so in-flight
 * runs replay against the same journal. Same helper as xero-invoice-alerts.
 */
function indexedStep<T>(ctx: DurableContext, id: string, run: () => Promise<T>): Promise<T> {
  return ctx.step(id, run);
}

type LinkOutcome =
  | { kind: "linked" | "dry-run"; pageId: string }
  | { kind: "skipped"; reason: string }
  | { kind: "conflict"; alreadyPointsAt: string }
  | { kind: "capped" };

/**
 * Link ONE contact: Table lookup, gates, then Notion write + Table warm.
 *
 * Shared by both modes. `tag` keeps step ids unique per contact within a run;
 * the sweep passes the zero-padded loop index (the same ids it always used, so
 * in-flight runs replay cleanly), the poller passes "single".
 */
async function linkContact(
  ctx: DurableContext,
  c: XeroContact,
  tag: string,
  dryRun: boolean,
  capReached: boolean,
): Promise<LinkOutcome> {
  const row = await indexedStep(ctx, `find-company-${tag}`, async () => findCompanyRow(c.accountNumber));

  // An Account Number that matches no known company. Almost always a typo, or a
  // Xero contact whose Account Number means something else entirely — either
  // way, not ours to act on.
  if (!row) return { kind: "skipped", reason: "no matching Notion company" };

  const data = (row.data ?? {}) as Record<string, unknown>;
  const storedContactId = cellValue(data[TABLE_XERO_CONTACT_ID]);
  const pageId = dashUuid(cellValue(data[TABLE_NOTION_PAGE_ID]));

  if (storedContactId === c.contactId) return { kind: "skipped", reason: "already linked" };

  // The Notion company already points at a DIFFERENT Xero contact. Never
  // overwrite that: it means either two Xero contacts claim the same company,
  // or the Account Number is wrong. Both need a human, and silently repointing
  // the link would hide it. The classic Zap's `f15 isnull` filter declined this
  // case too, but silently.
  if (storedContactId) {
    console.log(
      `WARNING: ${c.accountNumber} (${c.name}) — the Notion company already carries Xero contact ` +
        `${storedContactId}, but Xero contact ${c.contactId} also claims it via its Account Number. ` +
        `Changing NOTHING. Either two Xero contacts name the same company, or one Account Number is ` +
        `wrong; both need a human.`,
    );
    return { kind: "conflict", alreadyPointsAt: storedContactId };
  }

  if (!pageId) {
    console.log(
      `WARNING: ${c.accountNumber} matched a Company IDs row with no ${TABLE_NOTION_PAGE_ID}, so there ` +
        `is nothing to write to. Check that notion-companies-to-zapier-table is populating that column.`,
    );
    return { kind: "skipped", reason: `row has no ${TABLE_NOTION_PAGE_ID}` };
  }

  if (capReached) return { kind: "capped" };

  if (dryRun) {
    console.log(
      `dry run: would link ${c.accountNumber} (${c.name}) -> Notion page ${pageId}, ` +
        `${COMPANY_XERO_ID_PROP} = ${c.contactId}`,
    );
    return { kind: "dry-run", pageId };
  }

  // Notion FIRST — it is the source of truth, and the other durable's dedupe
  // guard reads it.
  await indexedStep(ctx, `write-notion-${tag}`, async () => {
    await writeXeroIdToNotion(pageId, c.contactId);
    return { pageId, contactId: c.contactId };
  });

  // Then warm the Table so the gate closes without waiting on the mirror. Free,
  // and it cannot diverge — it is the value just written to Notion.
  await indexedStep(ctx, `warm-table-${tag}`, async () => {
    await warmTableCache(String(row.id), c.contactId);
    return { recordId: String(row.id) };
  });

  console.log(`linked ${c.accountNumber} (${c.name}) -> Notion page ${pageId} = ${c.contactId}`);
  return { kind: "linked", pageId };
}

/** The contact a `updated_contact` poll delivered, or null when the payload is
 *  not one. The trigger hands over Xero's contact object as-is (ContactID,
 *  AccountNumber, Name, UpdatedDateUTC, ...); a `data` wrapper is tolerated. */
function polledContact(payload: any): { contactId: string; name: string; accountNumber: string | null; updated: string | null } | null {
  const c = payload?.ContactID ? payload : payload?.data?.ContactID ? payload.data : null;
  const contactId = firstString(c?.ContactID);
  if (!contactId) return null;
  return {
    contactId,
    name: firstString(c?.Name) ?? "",
    accountNumber: firstString(c?.AccountNumber),
    updated: firstString(c?.UpdatedDateUTC),
  };
}

const workflow = defineDurable<Record<string, unknown>, unknown>(
  "xero-contact-to-notion-company",
  async (ctx, rawInput) => {
    const payload = (InputSchema.parse(normalizeInput(rawInput)) ?? {}) as any;

    /** Compute the pass and report what it WOULD write, writing nothing. */
    const dryRun = payload?.dryRun === true || payload?.dry_run === true || payload?.dryRun === "true";

    // ---- Mode 1: the poller delivered one contact (the normal path) ---------
    const polled = polledContact(payload);
    if (polled) {
      // Most contacts carry no Account Number — that field is the deliberate
      // signal that a human wants this contact linked. Every edit to any
      // contact fires the poller, so this is the common exit.
      if (!polled.accountNumber) {
        console.log(`ignored ${polled.contactId} (${polled.name}): no Account Number`);
        return { mode: "poll", contactId: polled.contactId, outcome: "ignored", reason: "no Account Number" };
      }
      const c: XeroContact = { contactId: polled.contactId, name: polled.name, accountNumber: polled.accountNumber };
      const outcome = await linkContact(ctx, c, "single", dryRun, false);
      console.log(
        `xero-contact-to-notion-company (poll): ${c.accountNumber} (${c.name}, updated ${polled.updated}) -> ${outcome.kind}`,
      );
      return { mode: "poll", dryRun, contactId: c.contactId, name: c.name, accountNumber: c.accountNumber, ...outcome };
    }

    // ---- Mode 2: the windowed sweep, run BY HAND for recovery ---------------
    //
    // `trigger-workflow <id> --input '{"sweep":true}'` (add `"dryRun":true` to
    // write nothing). Re-reads every contact updated in the last OVERLAP_DAYS
    // and links any the poller missed — after an outage, or if Zapier's dedupe
    // ever swallows an update again (bug W6ZE93-VMEWP). This was the whole
    // workflow while it ran on a daily schedule (2026-08 .. 2026-11).
    //
    // It must be ASKED for. An empty or unrecognised payload throws rather than
    // defaulting to a sweep: the poller never sends one, so it is a real event
    // whose shape we failed to understand (repo rule: never silently drop).
    const sweep = payload?.sweep === true || payload?.sweep === "true" || dryRun;
    if (!sweep) {
      throw new Error(
        `xero-contact-to-notion-company: payload is neither a Xero contact (no ContactID) nor a ` +
          `{"sweep":true} instruction — refusing to guess. Got keys: ${JSON.stringify(Object.keys(payload ?? {}))}`,
      );
    }

    // The ONLY clock read, inside a step so it is fixed for every retry.
    const today = await ctx.step("today", async () => isoDateFromEpochMs(Date.now()));
    const sinceIso = shiftIsoDate(today, -OVERLAP_DAYS);

    // 1. One bounded Xero read, all inside ONE step so the page walk is a single
    //    retry unit.
    const fetched = await fetchWindow(ctx, sinceIso);

    // 2. Only contacts carrying an Account Number are candidates.
    const seen = new Set<string>();
    const candidates: XeroContact[] = [];
    for (const c of fetched.rows) {
      const contactId = firstString(c?.ContactID);
      const accountNumber = firstString(c?.AccountNumber);
      if (!contactId || !accountNumber || seen.has(contactId)) continue;
      seen.add(contactId);
      candidates.push({ contactId, name: firstString(c?.Name) ?? "", accountNumber });
    }
    // Deterministic order so per-item step names are stable across retries. The
    // batch itself is memoized by the step above, so an index can never re-map
    // onto a different contact on a retry.
    candidates.sort((a, b) => a.contactId.localeCompare(b.contactId));

    if (fetched.truncated) {
      console.log(
        `WARNING: hit the ${MAX_PAGES}-page cap, so this sweep did not cover its whole window. ` +
          `Re-run it, or raise MAX_PAGES.`,
      );
    }
    console.log(
      `xero-contact-to-notion-company (sweep): window UpdatedDateUTC>=${sinceIso} (today ${today}), ` +
        `${fetched.rows.length} contact(s) read, ${candidates.length} carrying an Account Number` +
        `${dryRun ? " — DRY RUN, nothing will be written" : ""}`,
    );

    // 3. Link each one.
    const linked: any[] = [];
    const skipped: any[] = [];
    const conflicts: any[] = [];
    let written = 0;

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const tag = String(i).padStart(3, "0");
      const base = { contactId: c.contactId, name: c.name, accountNumber: c.accountNumber };
      const outcome = await linkContact(ctx, c, tag, dryRun, written >= MAX_LINKS_PER_RUN);
      switch (outcome.kind) {
        case "linked":
        case "dry-run":
          if (outcome.kind === "linked") written++;
          linked.push({ ...base, pageId: outcome.pageId, outcome: outcome.kind });
          break;
        case "conflict":
          conflicts.push({ ...base, alreadyPointsAt: outcome.alreadyPointsAt });
          break;
        case "capped":
          skipped.push({ ...base, reason: "per-run link cap reached" });
          break;
        case "skipped":
          skipped.push({ ...base, reason: outcome.reason });
          break;
      }
    }

    console.log(
      `xero-contact-to-notion-company sweep done: ${linked.length} linked, ${skipped.length} skipped, ` +
        `${conflicts.length} conflict(s)`,
    );

    return {
      mode: "sweep",
      dryRun,
      windowFrom: sinceIso,
      windowTo: today,
      contactsRead: fetched.rows.length,
      xeroPagesRead: fetched.pages,
      coverageIncomplete: fetched.truncated,
      candidates: candidates.length,
      linked,
      skipped,
      conflicts,
    };
  },
);

export default workflow;
