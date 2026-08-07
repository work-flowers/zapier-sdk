// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/xero-contact-to-notion-company
import { defineDurable } from "@zapier/zapier-durable";
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
//  2. IT IS SCHEDULE-DRIVEN, NOT POLLING. A durable trigger has no
//     polling-interval field, so migrating `updated_contact` as a polling
//     durable would have cost ~1,440 Xero calls/day — WORSE than the 96/day the
//     classic Zap cost at its 15-minute override. Five Xero pollers on this
//     tenant exhausted Xero's 5,000-calls/day-per-tenant limit on 2026-08-06.
//     A schedule trigger costs Xero nothing and puts the rate under our control:
//     ~24 calls/day.

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

// --- Window and limits -----------------------------------------------------

/** Days of `UpdatedDateUTC` re-read each fire, and the self-heal depth: the Zap
 *  can be down this long without missing a link. */
const OVERLAP_DAYS = 7;

/** Xero returns 100 contacts per page; each page is one API call, so the walk is
 *  hard-bounded rather than running until it sees a short page. Observed volume
 *  is ~12 contacts per 13 days, so one page is the norm by a wide margin. */
const MAX_PAGES = 3;

/** Blast-radius cap on Notion writes per fire. Nothing is lost when it trips —
 *  the next fire re-reads the same window. */
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

const workflow = defineDurable<Record<string, unknown>, unknown>(
  "xero-contact-to-notion-company",
  async (ctx, rawInput) => {
    const payload = (InputSchema.parse(normalizeInput(rawInput)) ?? {}) as any;

    /** Compute the whole pass and report what it WOULD write, writing nothing.
     *  `trigger-workflow <id> --input '{"dryRun":true}'`. Mandatory before any
     *  publish here: the sibling Zap that wiped a column had been "validated" by
     *  a run that died before reaching its extraction code. */
    const dryRun = payload?.dryRun === true || payload?.dry_run === true || payload?.dryRun === "true";

    // The ONLY clock read, inside a step so it is fixed for every retry.
    const today = await ctx.step("today", async () => isoDateFromEpochMs(Date.now()));
    const sinceIso = shiftIsoDate(today, -OVERLAP_DAYS);

    // 1. One bounded Xero read, all inside ONE step so the page walk is a single
    //    retry unit.
    const fetched = await ctx.step("fetch-contacts", async () => {
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

    // 2. Only contacts carrying an Account Number are candidates — that field is
    //    the deliberate signal that a human wants this contact linked.
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
        `WARNING: hit the ${MAX_PAGES}-page cap, so this run did not cover its whole window. ` +
          `Nothing is lost — the next fire re-reads it — but if this repeats, raise MAX_PAGES.`,
      );
    }
    console.log(
      `xero-contact-to-notion-company: window UpdatedDateUTC>=${sinceIso} (today ${today}), ` +
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

      const row = await ctx.step(`find-company-${tag}`, async () => findCompanyRow(c.accountNumber));

      if (!row) {
        // An Account Number that matches no known company. Almost always a
        // typo, or a Xero contact whose Account Number means something else
        // entirely — either way, not ours to act on.
        skipped.push({ contactId: c.contactId, name: c.name, accountNumber: c.accountNumber, reason: "no matching Notion company" });
        continue;
      }

      const data = (row.data ?? {}) as Record<string, unknown>;
      const storedContactId = cellValue(data[TABLE_XERO_CONTACT_ID]);
      const pageId = dashUuid(cellValue(data[TABLE_NOTION_PAGE_ID]));

      if (storedContactId === c.contactId) {
        skipped.push({ contactId: c.contactId, name: c.name, accountNumber: c.accountNumber, reason: "already linked" });
        continue;
      }

      // The Notion company already points at a DIFFERENT Xero contact. Never
      // overwrite that: it means either two Xero contacts claim the same
      // company, or the Account Number is wrong. Both need a human, and
      // silently repointing the link would hide it. The classic Zap's
      // `f15 isnull` filter declined this case too, but silently.
      if (storedContactId) {
        conflicts.push({
          contactId: c.contactId,
          name: c.name,
          accountNumber: c.accountNumber,
          alreadyPointsAt: storedContactId,
        });
        console.log(
          `WARNING: ${c.accountNumber} (${c.name}) — the Notion company already carries Xero contact ` +
            `${storedContactId}, but Xero contact ${c.contactId} also claims it via its Account Number. ` +
            `Changing NOTHING. Either two Xero contacts name the same company, or one Account Number is ` +
            `wrong; both need a human.`,
        );
        continue;
      }

      if (!pageId) {
        skipped.push({ contactId: c.contactId, name: c.name, accountNumber: c.accountNumber, reason: `row has no ${TABLE_NOTION_PAGE_ID}` });
        console.log(
          `WARNING: ${c.accountNumber} matched a Company IDs row with no ${TABLE_NOTION_PAGE_ID}, so there ` +
            `is nothing to write to. Check that notion-companies-to-zapier-table is populating that column.`,
        );
        continue;
      }

      if (written >= MAX_LINKS_PER_RUN) {
        skipped.push({ contactId: c.contactId, name: c.name, accountNumber: c.accountNumber, reason: "per-run link cap reached" });
        continue;
      }

      if (dryRun) {
        console.log(
          `dry run: would link ${c.accountNumber} (${c.name}) -> Notion page ${pageId}, ` +
            `${COMPANY_XERO_ID_PROP} = ${c.contactId}`,
        );
        linked.push({ contactId: c.contactId, name: c.name, accountNumber: c.accountNumber, pageId, outcome: "dry-run" });
        continue;
      }

      // Notion FIRST — it is the source of truth, and the other durable's
      // dedupe guard reads it.
      await ctx.step(`write-notion-${tag}`, async () => {
        await writeXeroIdToNotion(pageId, c.contactId);
        return { pageId, contactId: c.contactId };
      });

      // Then warm the Table so the gate closes without waiting on the mirror.
      // Free, and it cannot diverge — it is the value just written to Notion.
      await ctx.step(`warm-table-${tag}`, async () => {
        await warmTableCache(String(row.id), c.contactId);
        return { recordId: String(row.id) };
      });

      written++;
      linked.push({ contactId: c.contactId, name: c.name, accountNumber: c.accountNumber, pageId, outcome: "linked" });
      console.log(`linked ${c.accountNumber} (${c.name}) -> Notion page ${pageId} = ${c.contactId}`);
    }

    console.log(
      `xero-contact-to-notion-company done: ${linked.length} linked, ${skipped.length} skipped, ` +
        `${conflicts.length} conflict(s)`,
    );

    return {
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
