// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/notion-page-deleted-to-zapier-tables
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
// Every write here is a Zapier Tables call (free, no connection). The one
// outbound fetch (company restore forward) needs no connection either.

/** Notion data sources whose deletions this workflow acts on. All dashed. */
const COMPANIES_DS = "21991b07-11ac-80b0-b787-000b3d3995f6";
const MEETING_NOTES_DS = "19891b07-11ac-8137-9d62-000b75fab86e";
const SETUP_CALLS_DS = "2d191b07-11ac-8058-97a3-000b7132e307"; // "[Ernest] Internal Setup Calls DB"
/** Contacts deletions are owned by contact-emails-to-zapier-table — skip. */
const CONTACTS_DS = "21991b07-11ac-81a6-a894-000be4a09a67";

/** [Table] Company IDs — mirror of Notion Companies, keyed on Notion Page ID. */
const COMPANY_TABLE = "01JM8PH8YM93A482M8BFZ6WKW6";
const COMPANY_KEY = "Notion Page ID"; // f14

/** [Table] Meeting Note IDs — event-id → page-id map. Rows are FLAGGED
 *  Archived, never deleted: a transient mistake must not destroy a mapping
 *  (same rule as gcal-event-updated-to-meeting-note). */
const MEETING_NOTE_TABLE = "01JZCVG73MBWWB0357CEPS4903";
const MEETING_NOTE_KEY = "Page ID"; // f2
const MEETING_NOTE_ARCHIVED = "Archived"; // f7

/** [Table] Notion Setup Session Mapping — event-id → page-id map. */
const SETUP_SESSION_TABLE = "01KEE5CTAZMJ8CR2608S2QWT5H";
const SETUP_SESSION_KEY = "Page ID"; // f2

/** notion-companies-to-zapier-table's catch URL. A restored company page fires
 *  no DB automation, so the mirror never hears about it — forwarding the ping
 *  makes it re-fetch the page and re-create the row this workflow deleted. */
const COMPANY_MIRROR_CATCH_URL =
  "https://hooks.zapier.com/hooks/catch/20495893/b25a7dfde826bff6/";

const InputSchema = z.unknown();

/** `defineDurable`'s input generic is constrained to an object type, so the
 *  loose runtime shapes (wrapper keys, a double-encoded body) are handled by
 *  `normalizeInput` / `extractEvent` rather than by the type. */
type Input = Record<string, unknown>;

// --- Helpers -----------------------------------------------------------------
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

function isEmptyPing(raw: unknown): boolean {
  if (raw === null || raw === undefined || raw === "") return true;
  if (typeof raw !== "object") return false;
  const WRAPPER_KEYS = new Set(["querystring", "headers", "params", "body", "query"]);
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!WRAPPER_KEYS.has(key)) return false;
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object" && Object.keys(value as object).length === 0) continue;
    return false; // a wrapper with something in it — treat as a real event
  }
  return true;
}

function firstString(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c.trim();
  }
  return "";
}

/** Normalize a page/data-source id to the dashed-UUID form the Tables store. */
function dashUuid(id: string): string {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return id;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type Event = {
  type: string; // "page.deleted" | "page.undeleted" | anything else
  pageId: string;
  dataSourceId: string;
};

/** Pull the Notion integration-webhook event out of the payload. The
 *  subscription shape is `{ type, entity: { id }, data: { parent: { data_source_id } } }`;
 *  wrapper keys and a stringified body are tolerated. */
function extractEvent(raw: unknown): Event {
  const o = (raw ?? {}) as Record<string, any>;
  const body = (typeof o.body === "object" && o.body) || o;
  return {
    type: firstString(body.type, o.type),
    pageId: dashUuid(
      firstString(body.entity?.id, o.entity?.id, body.data?.id, o.data?.id),
    ),
    dataSourceId: dashUuid(
      firstString(
        body.data?.parent?.data_source_id,
        o.data?.parent?.data_source_id,
        body.entity?.parent?.data_source_id,
      ),
    ),
  };
}

async function findRows(table: string, keyField: string, pageId: string) {
  const res = await sdk.listTableRecords({
    table,
    keyMode: "names",
    filters: [{ fieldKey: keyField, operator: "exact", value: pageId }],
    pageSize: 100,
  });
  return res.data ?? [];
}

// --- Workflow ------------------------------------------------------------------
const workflow = defineDurable<Input, unknown>(
  "notion-page-deleted-to-zapier-tables",
  async (ctx: DurableContext, rawInput: Input) => {
    const payload = normalizeInput(InputSchema.parse(rawInput));

    if (isEmptyPing(payload)) {
      console.log("empty payload — treating as a ping of the catch URL, not an event");
      return { skipped: "empty-payload" };
    }

    // Notion's subscription-verification ping carries only a token. Skip
    // cleanly; the token stays readable in this run's input.
    if (
      payload &&
      typeof payload === "object" &&
      typeof (payload as any).verification_token === "string"
    ) {
      console.log("subscription verification ping — token is in this run's input");
      return { skipped: "verification-ping" };
    }

    const event = extractEvent(payload);
    if (!event.pageId) {
      // Content we don't understand must fail loudly — this is a real event
      // whose shape we failed to parse, and silencing it hides the bug.
      throw new Error(
        "No page id in webhook payload: " + JSON.stringify(payload).slice(0, 300),
      );
    }

    // --- Restores. The classic Zap ignored these; two are handled here
    // because they are cheap and losing them is real data loss. ------------
    if (event.type === "page.undeleted") {
      if (event.dataSourceId === MEETING_NOTES_DS) {
        const restored = await ctx.step("unarchive-meeting-note-rows", async () => {
          const rows = await findRows(MEETING_NOTE_TABLE, MEETING_NOTE_KEY, event.pageId);
          const flagged = rows.filter((r: any) => r.data?.[MEETING_NOTE_ARCHIVED] === true);
          if (flagged.length) {
            await sdk.updateTableRecords({
              table: MEETING_NOTE_TABLE,
              keyMode: "names",
              records: flagged.map((r: any) => ({
                id: r.id,
                data: { [MEETING_NOTE_ARCHIVED]: false },
              })),
            });
          }
          return flagged.length;
        });
        return { action: "meeting-note-unarchived", pageId: event.pageId, rows: restored };
      }
      if (event.dataSourceId === COMPANIES_DS) {
        // The mirror recreates the row from the page's current state, but only
        // when pinged — and a restore fires no DB automation. Forward the ping.
        await ctx.step("forward-company-restore-to-mirror", async () => {
          const res = await sdk.fetch(COMPANY_MIRROR_CATCH_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data: { id: event.pageId } }),
          });
          if (!res.ok) {
            throw new Error(`Mirror forward failed (${res.status}): ${await res.text()}`);
          }
          return { forwarded: true };
        });
        return { action: "company-restore-forwarded", pageId: event.pageId };
      }
      console.log(
        `page.undeleted for data source ${event.dataSourceId || "(unknown)"} — nothing to restore here`,
      );
      return { skipped: "undeleted-unhandled-data-source", pageId: event.pageId };
    }

    if (event.type !== "page.deleted") {
      console.log(`event type ${event.type || "(none)"} — not a deletion, skipping`);
      return { skipped: "not-a-deletion", type: event.type, pageId: event.pageId };
    }

    // --- Deletions, branched on the page's parent data source. -------------
    switch (event.dataSourceId) {
      case COMPANIES_DS: {
        const deleted = await ctx.step("delete-company-rows", async () => {
          const rows = await findRows(COMPANY_TABLE, COMPANY_KEY, event.pageId);
          if (rows.length) {
            await sdk.deleteTableRecords({
              table: COMPANY_TABLE,
              records: rows.map((r: any) => r.id),
            });
          }
          return rows.length;
        });
        return { action: "company-rows-deleted", pageId: event.pageId, rows: deleted };
      }

      case MEETING_NOTES_DS: {
        const flagged = await ctx.step("archive-meeting-note-rows", async () => {
          const rows = await findRows(MEETING_NOTE_TABLE, MEETING_NOTE_KEY, event.pageId);
          const live = rows.filter((r: any) => r.data?.[MEETING_NOTE_ARCHIVED] !== true);
          if (live.length) {
            await sdk.updateTableRecords({
              table: MEETING_NOTE_TABLE,
              keyMode: "names",
              records: live.map((r: any) => ({
                id: r.id,
                data: { [MEETING_NOTE_ARCHIVED]: true },
              })),
            });
          }
          return live.length;
        });
        return { action: "meeting-note-rows-archived", pageId: event.pageId, rows: flagged };
      }

      case SETUP_CALLS_DS: {
        const deleted = await ctx.step("delete-setup-session-rows", async () => {
          const rows = await findRows(SETUP_SESSION_TABLE, SETUP_SESSION_KEY, event.pageId);
          if (rows.length) {
            await sdk.deleteTableRecords({
              table: SETUP_SESSION_TABLE,
              records: rows.map((r: any) => r.id),
            });
          }
          return rows.length;
        });
        return { action: "setup-session-rows-deleted", pageId: event.pageId, rows: deleted };
      }

      case CONTACTS_DS:
        // Owned by contact-emails-to-zapier-table (merge hand-over vs genuine
        // delete needs the email-table context that lives there).
        console.log("Contacts deletion — owned by contact-emails-to-zapier-table, skipping");
        return { skipped: "contacts-owned-elsewhere", pageId: event.pageId };

      default:
        // Deals, Proposals, … — nothing maps them into a Table. Not an error:
        // the subscription covers data sources we deliberately don't track.
        console.log(
          `deletion in untracked data source ${event.dataSourceId || "(unknown)"} — skipping`,
        );
        return {
          skipped: "untracked-data-source",
          dataSourceId: event.dataSourceId,
          pageId: event.pageId,
        };
    }
  },
);

export default workflow;
