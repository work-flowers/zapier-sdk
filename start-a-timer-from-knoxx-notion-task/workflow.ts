// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/start-a-timer-from-knoxx-notion-task
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Harvest is the only connected app: Zapier Tables auth is automatic. The
// Knoxx Notion workspace is never called — everything needed is in the payload.
const HARVEST_APP_KEY = "HarvestCLIAPI";
const HARVEST_CONNECTION = "harvestcliapi_connection";

// Both are Harvest *custom actions* (the "ae:" prefix), authored in the Zapier
// UI, so their inputs/outputs are not introspectable from the SDK. The same two
// actions back start-a-timer-from-notion-task.
//   ae:586042  "Start Timer in Harvest"  — creates a running time entry
//   ae:595873  "Restart Timer"           — restarts an existing, stopped entry
const HARVEST_START_TIMER = "ae:586042";
const HARVEST_RESTART_TIMER = "ae:595873";

// Dennis Chiuten in Harvest (GET /v2/users/me). Every entry is logged as him —
// the workflow refuses to run for anyone else (NOTION_ACTOR_ID below).
const HARVEST_USER_ID = "5171104";
// Every Knoxx task is billed to one fixed project and task, as in the classic
// Zap — there is no per-project lookup on this side.
//   48185265  "Knoxx Foods - AI Ops Retainer" (client Knoxx Business Group)
//   26909407  "Build"
const HARVEST_PROJECT_ID = "48185265";
const HARVEST_TASK_ID = "26909407";

// Dennis's Notion user id. Notion user ids are global, so this is the same id
// as in the work.flowers workspace — confirmed in the Knoxx workspace's own
// GET /v1/users (dennis@work.flowers). The button is visible to the whole Knoxx
// workspace; only his clicks start a timer.
const NOTION_ACTOR_ID = "121d872b-594c-810b-ba5a-000206eeef1e";

// Zapier Table "Linear Issue to Harvest Time Entry Mapping" — one row per
// (task, day), shared with start-a-timer-from-notion-task. Columns:
//   f3 Time Entry ID   f4 Date (datetime)
//   f5 Knoxx Notion Page ID   (this workflow)
//   f6 Notion Task Page ID    (the work.flowers workflow — not written here)
const TIME_ENTRY_TABLE = "01K5060J1B1FHCJEWVVH597B71";

// Singapore has had no DST since 1982, so a fixed offset is exact. "Today" is
// Dennis's local day: the UTC day rolls over at 08:00 SGT. (The classic Zap
// used the UTC day, so it booked every pre-8am timer to yesterday.)
const TZ_LABEL = "Asia/Singapore";
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

// --- Pure helpers ----------------------------------------------------------
function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline can deliver input double-encoded (a JSON string of a
  // JSON string), while run-durable delivers it single-encoded. Parse until we
  // reach a non-string, or stop on parse failure.
  let v: unknown = rawInput;
  for (let i = 0; i < 4 && typeof v === "string"; i++) {
    const t = v.trim();
    if (t === "") return "";
    // run-durable delivers a JSON `null` input as the string "null".
    if (t === "null") return null;
    if (t[0] !== "{" && t[0] !== "[" && t[0] !== '"') break;
    try {
      v = JSON.parse(t);
    } catch {
      break;
    }
  }
  return v;
}

/** A touch of the catch URL (button setup, "test", a curl) rather than an
 *  event: no keys, or only known wrapper keys whose values are empty. */
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

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** Today's date in Dennis's timezone, as YYYY-MM-DD. Only called in a step. */
function localDate(nowMs: number): string {
  return new Date(nowMs + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The value to write to / search on the Table's `Date` column. Zapier Tables
 * coerces a bare "YYYY-MM-DD" in the account's timezone (it stores the previous
 * day at T16:00:00Z), so pin midnight UTC explicitly, as the work.flowers
 * workflow does. An `exact` search for one form never matches the other.
 */
function dateKey(date: string): string {
  return `${date}T00:00:00Z`;
}

type TaskEvent = {
  pageId: string;
  url: string | null;
  taskId: string | null;
  actorId: string | null;
};

function extractTaskEvent(raw: unknown): TaskEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, any>;
  const data = (o.data ?? {}) as Record<string, any>;

  const pageId = firstString(data.id);
  if (!pageId) return null;

  const props = (data.properties ?? {}) as Record<string, any>;

  // "Task ID" is a Notion unique_id property: { prefix, number }. `number` is
  // an integer in the API, not a string.
  const uid = props["Task ID"]?.unique_id;
  const prefix = firstString(uid?.prefix);
  const num = firstString(uid?.number);
  const taskId = num ? (prefix ? `${prefix}-${num}` : num) : null;

  return {
    pageId,
    url: firstString(data.url),
    taskId,
    actorId: firstString(o.source?.user_id),
  };
}

/** First row of a Tables search result, or null. `find_record` returns
 *  `{ data: [] }` when nothing matches — not a row of nulls. */
function firstRow(res: unknown): Record<string, any> | null {
  const rows = (res as any)?.data;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  // Searches return the row under `old`; writes return it under `new`.
  return (rows[0]?.old ?? rows[0]?.new ?? rows[0]) as Record<string, any>;
}

/** The Harvest time entry id from the custom action's response. The classic
 *  Zap read it as `result.id`; check the alternatives before giving up. */
function timeEntryIdFrom(res: unknown): string | null {
  const row = (res as any)?.data?.[0];
  return firstString(
    row?.result?.id,
    row?.result?.time_entry?.id,
    row?.id,
    (res as any)?.id,
  );
}

// --- Workflow --------------------------------------------------------------
const workflow = defineDurable(
  "start-a-timer-from-knoxx-notion-task",
  async (ctx, rawInput) => {
    const payload = normalizeInput(rawInput);
    if (isEmptyPing(payload)) {
      console.log("empty payload — treating as a ping of the catch URL, not an event");
      return { skipped: "empty-payload" };
    }

    const task = extractTaskEvent(payload);
    if (!task) {
      // Content we can't read a page id from is a real event whose shape we
      // failed to understand — surface it rather than drop it.
      throw new Error(
        `Unrecognized payload (no data.id): ${JSON.stringify(payload).slice(0, 500)}`,
      );
    }

    // Every entry is written against Dennis's Harvest user id, so a click by
    // anyone else would bill time to him.
    if (task.actorId?.toLowerCase() !== NOTION_ACTOR_ID) {
      console.log(`skipping ${task.pageId}: triggered by ${task.actorId}`);
      return { skipped: "other-user", pageId: task.pageId, actorId: task.actorId };
    }

    // Pinned in a step so a retry that crosses midnight keeps the first day.
    const date = await ctx.step("today", async () => localDate(Date.now()));

    // Has a timer already been started for this task today?
    const existing = await ctx.step("find-time-entry", async () => {
      const res = await sdk.runAction({
        appKey: "TableCLIAPI",
        actionType: "search",
        actionKey: "find_record",
        inputs: {
          table_id: TIME_ENTRY_TABLE,
          filter_count: "2",
          use_stored_order: false,
          field_data_key: "data__f4",
          operator: "exact",
          lookup_value: dateKey(date),
          field_data_key_2: "data__f5",
          operator_2: "exact",
          lookup_value_2: task.pageId,
        },
      });
      return firstString(firstRow(res)?.data?.f3);
    });

    if (existing) {
      await ctx.step("restart-timer", async () =>
        sdk.runAction({
          appKey: HARVEST_APP_KEY,
          actionType: "write",
          actionKey: HARVEST_RESTART_TIMER,
          connection: HARVEST_CONNECTION,
          inputs: { timeEntryId: existing },
        }),
      );
      console.log(`restarted Harvest time entry ${existing} for ${task.taskId}`);
      return {
        action: "restarted",
        date,
        taskId: task.taskId,
        pageId: task.pageId,
        timeEntryId: existing,
      };
    }

    const notes = task.taskId ?? task.pageId;
    const started = await ctx.step("start-timer", async () =>
      sdk.runAction({
        appKey: HARVEST_APP_KEY,
        actionType: "write",
        actionKey: HARVEST_START_TIMER,
        connection: HARVEST_CONNECTION,
        inputs: {
          taskId: HARVEST_TASK_ID,
          projectId: HARVEST_PROJECT_ID,
          userId: HARVEST_USER_ID,
          notes,
          externalReferenceId: notes,
          externalReferenceGroupId: "Knoxx",
          externalReferencePermalink: task.url ?? "",
          externalReferenceService: "notion.com",
          externalReferenceServiceIconUrl:
            "https://img.logo.dev/notion.com?token=pk_MgvuyiQuRe6IT_XWNAUgrA",
          spentDate: date,
        },
      }),
    );

    const timeEntryId = timeEntryIdFrom(started);
    if (!timeEntryId) {
      // The timer IS running — we just can't index it, so the next click today
      // would start a duplicate. Fail loudly rather than record a broken row.
      throw new Error(
        `Harvest start-timer returned no time entry id: ${JSON.stringify(started).slice(0, 500)}`,
      );
    }

    await ctx.step("record-time-entry", async () =>
      sdk.runAction({
        appKey: "TableCLIAPI",
        actionType: "write",
        actionKey: "create_record",
        inputs: {
          table_id: TIME_ENTRY_TABLE,
          new__data__f3: timeEntryId,
          new__data__f4: dateKey(date),
          new__data__f5: task.pageId,
        },
      }),
    );

    console.log(`started Harvest time entry ${timeEntryId} for ${notes}`);
    return {
      action: "started",
      date,
      timezone: TZ_LABEL,
      taskId: task.taskId,
      pageId: task.pageId,
      timeEntryId,
    };
  },
);

export default workflow;
