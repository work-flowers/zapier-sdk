// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/internal-user-ids-to-table-and-notion
//
// Shared core for the five internal user-ID durables. Each deployment ships this
// file plus a five-line `workflow.ts` that names its source (see the entry files
// `workflow.<source>.ts` in this directory).
//
// Why an entry file per deployment rather than one self-detecting workflow:
// `ctx` exposes no workflow identity and the trigger payload arrives unwrapped,
// so the only runtime discriminator would be payload shape — and Harvest's
// `new_user` and Zapier Manager's `team_member` both look like `{ id, email }`.
// Guessing wrong writes a Harvest ID into the Zapier column, so the source is
// stated explicitly instead.
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
const NOTION_APP_KEY = "NotionCLIAPI";
const NOTION_CONNECTION = "notion_wf";

/** Zapier Table "User IDs" — the internal cross-system identity map. Table ops
 *  are free (no tasks, no connection), so it stays the join hub. */
const USER_ID_TABLE = "01JM3J9SG5X6S8GBSSC8AS28AT";

/** Notion's native, Notion-managed People data source. Rows are workspace
 *  members and guests: we only ever *update* them — there is no API to create a
 *  member, so repo rule 5 (default templates on create) does not apply here. */
const PEOPLE_DS = "a0791b07-11ac-8364-9113-07ea21165718";

export type Source = "slack" | "harvest" | "linear" | "notion" | "zapier";

interface SourceSpec {
  /** Column on the Zapier Table. */
  tableColumn: string;
  /** Property on the Notion People data source. */
  peopleProperty: string;
  /** Pull `{ email, userId }` out of this source's trigger payload, or return a
   *  reason to skip. */
  extract: (p: any) => { email?: unknown; userId?: unknown; skip?: string };
}

const SOURCES: Record<Source, SourceSpec> = {
  // Slack `team_join`. The classic Zap stopped on `is_bot`; bots and Slackbot
  // have no place in an internal-people map.
  slack: {
    tableColumn: "Slack User ID",
    peopleProperty: "Slack User ID",
    extract: (p) => {
      if (p?.is_bot === true) return { skip: "slack user is a bot" };
      if (p?.deleted === true) return { skip: "slack user is deactivated" };
      return { email: p?.profile?.email ?? p?.email, userId: p?.id };
    },
  },
  // Harvest `new_user`. Zapier surfaces the Harvest user id as `record_id`;
  // fall back to `id` in case that changes.
  harvest: {
    tableColumn: "Harvest User ID",
    peopleProperty: "Harvest User ID",
    extract: (p) => ({ email: p?.email, userId: p?.record_id ?? p?.id }),
  },
  // Linear posts its own webhook at a Zapier catch-hook: `{ action, type,
  // data: { id, email, ... } }`. Guard on `type` so a non-User webhook (Issue,
  // Comment, ...) aimed at this URL is a clean no-op rather than a bad write.
  linear: {
    tableColumn: "Linear User ID",
    peopleProperty: "Linear User ID",
    extract: (p) => {
      const t = p?.type;
      if (typeof t === "string" && t.toLowerCase() !== "user") {
        return { skip: `linear webhook type is ${t}, not User` };
      }
      const d = p?.data ?? p;
      return { email: d?.email, userId: d?.id };
    },
  },
  // Notion `new_user` (private app App233228CLIAPI). The classic Zap filtered
  // `type == person` to drop bot/integration users.
  notion: {
    tableColumn: "Notion User ID",
    peopleProperty: "Notion User ID",
    extract: (p) => {
      if (p?.type != null && String(p.type).toLowerCase() !== "person") {
        return { skip: `notion user type is ${p.type}, not person` };
      }
      return { email: p?.person?.email ?? p?.email, userId: p?.id };
    },
  },
  // Zapier Manager `team_member` on the Work.Flowers team.
  zapier: {
    tableColumn: "Zapier ID",
    peopleProperty: "Zapier User ID",
    extract: (p) => ({ email: p?.email, userId: p?.id }),
  },
};

/** Table column -> People property, for the full-mirror pass. Kept in one place
 *  so adding a system means touching `SOURCES` only. */
const COLUMN_TO_PROPERTY: Record<string, string> = Object.fromEntries(
  Object.values(SOURCES).map((s) => [s.tableColumn, s.peopleProperty]),
);

/** Table columns caching the Notion join, written by this workflow. */
const NOTION_USER_ID_COLUMN = "Notion User ID";
const PEOPLE_PAGE_ID_COLUMN = "Notion People Page ID";

// --- Pure helpers ------------------------------------------------------------

/** The trigger pipeline can deliver input double-encoded (a JSON string of a
 *  JSON string) while `run-durable` delivers it single-encoded. Parse until we
 *  reach a non-string, or stop on parse failure. Lifted from
 *  contact-emails-to-zapier-table, where the same shape bit us. */
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

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/** Lowercased, validated email — or null. Every Table row and lookup is
 *  lowercase; mixed case leaves rows that later lookups can never match. */
function cleanEmail(v: unknown): string | null {
  const s = str(v)?.toLowerCase() ?? null;
  return s && EMAIL_RE.test(s) ? s : null;
}

/** First item of a runAction result ({ data: [...] } or a bare array).
 *  Same helper as luma-event-to-notion — the envelope varies by action. */
function firstResult(res: any): any {
  if (res && Array.isArray(res.data)) return res.data[0] ?? null;
  if (Array.isArray(res)) return res[0] ?? null;
  return res ?? null;
}

/** Plain text of a Notion rich_text / title property value. */
function notionPlainText(prop: any): string {
  const parts = prop?.rich_text ?? prop?.title;
  if (!Array.isArray(parts)) return "";
  return parts.map((x: any) => x?.plain_text ?? "").join("").trim();
}

// --- Workflow ----------------------------------------------------------------

/**
 * Durable port of the five classic "Add New <System> User ID" Zaps, with the
 * Notion People mirror added.
 *
 * For one internal person identified by email:
 *   1. Upsert their row in the "User IDs" Zapier Table, setting this source's
 *      ID column. (The classic Zaps did exactly this and stopped.)
 *   2. Mirror the ID onto their row in Notion's native People data source.
 *
 * The People join is `Table.Notion User ID -> People.Person`, cached on the
 * Table as `Notion People Page ID` so the steady-state path costs one free
 * Table read. The first time a person's People page is resolved, *every* ID
 * already on their Table row is pushed across — so someone who joined Slack
 * months before they were invited to Notion gets fully populated the moment the
 * Notion `new_user` event links them.
 *
 * A person with no matching People row (contractors, bots, service accounts,
 * anyone not yet in the Notion workspace) is a clean no-op on the Notion side:
 * the Table is still updated, and the link heals on a later run.
 */
export function defineUserIdSync(source: Source) {
  const spec = SOURCES[source];

  return defineDurable<unknown, unknown>(
    `internal-user-ids-${source}`,
    async (ctx, rawInput) => {
      const payload = normalizeInput(rawInput) as any;
      const { email: rawEmail, userId: rawUserId, skip } = spec.extract(payload);

      if (skip) {
        console.log(`skipping: ${skip}`);
        return { skipped: true, reason: skip, source };
      }

      const email = cleanEmail(rawEmail);
      const userId = str(rawUserId);
      // An empty/malformed payload (e.g. a manual "test" run from the Zapier
      // UI) exits as a clean no-op, not a failed run.
      if (!email || !userId) {
        const reason = !email ? "no valid email in payload" : "no user id in payload";
        console.log(`skipping: ${reason}`);
        return { skipped: true, reason, source };
      }

      // --- 1. Upsert the Zapier Table row ---------------------------------
      const hit = await ctx.step("find-table-row", async () =>
        sdk.listTableRecords({
          table: USER_ID_TABLE,
          keyMode: "names",
          filters: [{ fieldKey: "Email", operator: "exact", value: email }],
          pageSize: 1,
        }),
      );
      let row = hit?.data?.[0] ?? null;

      if (!row) {
        const created = await ctx.step("create-table-row", async () =>
          sdk.createTableRecords({
            table: USER_ID_TABLE,
            keyMode: "names",
            // Only Email + this source's ID. `Active`, `First Name` etc. have
            // no source Zap and are curated by hand — don't invent values.
            records: [{ data: { Email: email, [spec.tableColumn]: userId } }],
          }),
        );
        row = firstResult(created);
      } else if (str(row.data?.[spec.tableColumn]) !== userId) {
        await ctx.step("update-table-row", async () =>
          sdk.updateTableRecords({
            table: USER_ID_TABLE,
            keyMode: "names",
            records: [{ id: row!.id, data: { [spec.tableColumn]: userId } }],
          }),
        );
      }

      const rowData: Record<string, unknown> = { ...(row?.data ?? {}) };
      rowData[spec.tableColumn] = userId;

      // --- 2. Resolve the Notion People page ------------------------------
      // Cheapest first: the id cached on the Table row. Then the Person
      // relation, via the Notion user id (which this source may have just
      // supplied).
      let peoplePageId = str(rowData[PEOPLE_PAGE_ID_COLUMN]);
      const notionUserId =
        source === "notion" ? userId : str(rowData[NOTION_USER_ID_COLUMN]);
      const freshlyLinked = !peoplePageId;

      if (!peoplePageId && notionUserId) {
        const found = await ctx.step("find-people-page", async () =>
          sdk.runAction({
            appKey: NOTION_APP_KEY,
            actionType: "search",
            actionKey: "query_database_advanced",
            connection: NOTION_CONNECTION,
            inputs: {
              datasource: PEOPLE_DS,
              query_json: JSON.stringify({
                filter: { property: "Person", people: { contains: notionUserId } },
                page_size: 1,
              }),
            },
          }),
        );
        peoplePageId = str(firstResult(found)?.id);
      }

      if (!peoplePageId) {
        // No Notion People row for this person yet. The Table is already
        // correct; the mirror heals once they appear in the workspace and the
        // Notion `new_user` durable links them.
        const reason = notionUserId
          ? "no People row matches this Notion user"
          : "no Notion user id known for this email";
        console.log(`table updated; skipping People mirror: ${reason}`);
        return { source, email, userId, tableRowId: row?.id ?? null, peopleSynced: false, reason };
      }

      // --- 3. Mirror onto the People page ---------------------------------
      // On a fresh link, push every ID the Table already knows — this is what
      // backfills someone who predates their Notion account. Afterwards only
      // this source's column needs writing.
      const columnsToMirror = freshlyLinked
        ? Object.keys(COLUMN_TO_PROPERTY)
        : [spec.tableColumn];

      const desired: Record<string, string> = {};
      for (const column of columnsToMirror) {
        const value = str(rowData[column]);
        if (value) desired[COLUMN_TO_PROPERTY[column]] = value;
      }
      if (notionUserId) desired[COLUMN_TO_PROPERTY[NOTION_USER_ID_COLUMN]] = notionUserId;

      // Read the page first so an unchanged value costs no write. Notion's
      // update action is not free, and these triggers can re-fire on replay.
      const current = await ctx.step("read-people-page", async () =>
        sdk.runAction({
          appKey: NOTION_APP_KEY,
          actionType: "search",
          actionKey: "get_page_or_database_item_by_id",
          connection: NOTION_CONNECTION,
          inputs: { page_id: peoplePageId },
        }),
      );
      const currentProps = firstResult(current)?.properties ?? {};

      const changed: Record<string, string> = {};
      for (const [property, value] of Object.entries(desired)) {
        if (notionPlainText(currentProps[property]) !== value) changed[property] = value;
      }

      if (Object.keys(changed).length > 0) {
        await ctx.step("update-people-page", async () =>
          sdk.runAction({
            appKey: NOTION_APP_KEY,
            actionType: "write",
            actionKey: "update_database_item",
            connection: NOTION_CONNECTION,
            inputs: {
              datasource: PEOPLE_DS,
              page: peoplePageId,
              ...Object.fromEntries(
                Object.entries(changed).map(([p, v]) => [`properties|||${p}|||rich_text`, v]),
              ),
            },
          }),
        );
      }

      // --- 4. Cache the join back onto the Table row ----------------------
      const cache: Record<string, string> = {};
      if (str(rowData[PEOPLE_PAGE_ID_COLUMN]) !== peoplePageId) {
        cache[PEOPLE_PAGE_ID_COLUMN] = peoplePageId;
      }
      if (notionUserId && str(rowData[NOTION_USER_ID_COLUMN]) !== notionUserId) {
        cache[NOTION_USER_ID_COLUMN] = notionUserId;
      }
      if (Object.keys(cache).length > 0 && row?.id) {
        await ctx.step("cache-people-link", async () =>
          sdk.updateTableRecords({
            table: USER_ID_TABLE,
            keyMode: "names",
            records: [{ id: row!.id, data: cache }],
          }),
        );
      }

      return {
        source,
        email,
        userId,
        tableRowId: row?.id ?? null,
        peoplePageId,
        peopleSynced: true,
        freshlyLinked,
        propertiesWritten: Object.keys(changed),
      };
    },
  );
}
