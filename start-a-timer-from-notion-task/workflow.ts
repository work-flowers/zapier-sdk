// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/start-a-timer-from-notion-task
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
// Harvest is the only connected app: Zapier Tables auth is automatic.
const HARVEST_APP_KEY = "HarvestCLIAPI";
const HARVEST_CONNECTION = "harvestcliapi_connection";

// Both are Harvest *custom actions* (the "ae:" prefix), authored in the Zapier
// UI, so their inputs/outputs are not introspectable from the SDK.
//   ae:586042  "Start Timer in Harvest"  — creates a running time entry
//   ae:595873  "Restart Timer"           — restarts an existing, stopped entry
const HARVEST_START_TIMER = "ae:586042";
const HARVEST_RESTART_TIMER = "ae:595873";

// Dennis Chiuten in Harvest (GET /v2/users/me). Every entry is logged as him —
// the workflow refuses to run for anyone else (NOTION_ACTOR_ID below).
const HARVEST_USER_ID = "5171104";
// Harvest task "Automations (Standard)" — the task every Notion-started timer
// is booked against.
const HARVEST_TASK_ID = "23938620";

// Dennis in the work.flowers Notion workspace. The Notion automation fires for
// whoever clicks the button; only his clicks start a timer.
const NOTION_ACTOR_ID = "121d872b-594c-810b-ba5a-000206eeef1e";

// Zapier Table "Linear Issue to Harvest Time Entry Mapping" — one row per
// (task, day), recording the Harvest time entry started for it. Columns:
//   f1 Issue ID, f2 Issue Identifier   (Linear-era, unused by this workflow)
//   f3 Time Entry ID   f4 Date (datetime)
//   f5 Knoxx Notion Page ID            (a different workspace — not written here)
//   f6 Notion Task Page ID
const TIME_ENTRY_TABLE = "01K5060J1B1FHCJEWVVH597B71";

// Zapier Table "Harvest Projects (New)" — maps a Notion Projects page to the
// Harvest project to bill against. Columns:
//   f1 project_id  f2 client_id  f3 is_active  f4 Name  f5 Project Page ID
const PROJECT_TABLE = "01K8A2KV9X1W95GAB6Y69D7G4C";

// Singapore has had no DST since 1982, so a fixed offset is exact — and it
// avoids depending on the durable runtime shipping a full ICU timezone
// database. "Today" must be Dennis's local day: the UTC day rolls over at
// 08:00 SGT, so a UTC date would book every pre-8am timer to yesterday.
const TZ_LABEL = "Asia/Singapore";
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

// The Notion DB automation posts `{ data: { id, url, properties }, source: {...} }`
// with properties in full Notion API form. Accept anything and extract
// defensively — an automation payload can arrive with a property omitted.
const InputSchema = z.unknown();

// --- Pure helpers ----------------------------------------------------------
function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline can deliver input double-encoded (a JSON string of a
  // JSON string), while run-durable delivers it single-encoded. Parse until we
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
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** Today's date in Dennis's timezone, as YYYY-MM-DD. */
function localDate(nowMs: number): string {
  return new Date(nowMs + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The value to write to / search on the Table's `Date` column.
 *
 * Zapier Tables coerces a bare "YYYY-MM-DD" into a datetime using the
 * *account's* timezone, so writing "2026-07-27" stores 2026-07-26T16:00:00Z.
 * Reads coerce identically, so bare-in/bare-out does round-trip — but it makes
 * every row record the wrong UTC day and disagrees with the 100 Linear-era rows
 * already in the table, which all store T00:00:00Z. Pin it explicitly instead.
 */
function dateKey(date: string): string {
  return `${date}T00:00:00Z`;
}

type TaskEvent = {
  pageId: string;
  url: string | null;
  ticket: string | null;
  projectPageId: string | null;
  actorId: string | null;
};

function extractTaskEvent(raw: unknown): TaskEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, any>;
  const data = (o.data ?? o) as Record<string, any>;

  const pageId = firstString(data.id, data.page_id, o.id);
  if (!pageId) return null;

  const props = (data.properties ?? {}) as Record<string, any>;

  // "Ticket ID" is a Notion unique_id property: { prefix: "TKT", number: 216 }.
  // `number` is an integer in the API, not a string.
  const uid = props["Ticket ID"]?.unique_id ?? props["Ticket ID"];
  const prefix = firstString(uid?.prefix);
  const num = firstString(uid?.number);
  const ticket = num ? (prefix ? `${prefix}-${num}` : num) : null;

  // "Project" is a relation; a task belongs to at most one project.
  const relation = props["Project"]?.relation;
  const projectPageId = Array.isArray(relation)
    ? firstString(relation[0]?.id)
    : null;

  return {
    pageId,
    url: firstString(data.url, o.url),
    ticket,
    projectPageId,
    actorId: firstString(o.source?.user_id, o.user_id),
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

/** The Harvest time entry id from a custom-action response. The custom action
 *  is UI-authored, so this contract is inferred from the classic Zap's
 *  `result__id` reference; check the alternatives before giving up. */
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
const workflow = defineDurable<Record<string, unknown>, unknown>(
  "start-a-timer-from-notion-task",
  async (ctx, rawInput) => {
    const task = extractTaskEvent(InputSchema.parse(normalizeInput(rawInput)));
    if (!task) {
      console.log("skipping: no task page in payload (empty/test delivery)");
      return { skipped: true, reason: "no task page in payload" };
    }

    // The button is visible to the whole workspace; only Dennis's clicks bill
    // time, because every entry is written against his Harvest user id.
    if (task.actorId?.toLowerCase() !== NOTION_ACTOR_ID) {
      console.log(`skipping ${task.pageId}: triggered by ${task.actorId}`);
      return { skipped: true, reason: "triggered by another user" };
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
          field_data_key_2: "data__f6",
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
      console.log(`restarted Harvest time entry ${existing} for ${task.ticket}`);
      return {
        action: "restarted",
        date,
        ticket: task.ticket,
        pageId: task.pageId,
        timeEntryId: existing,
      };
    }

    // First timer of the day for this task: resolve the Harvest project.
    if (!task.projectPageId) {
      console.log(`skipping ${task.ticket ?? task.pageId}: no Project relation`);
      return {
        skipped: true,
        reason: "task has no Project relation",
        pageId: task.pageId,
      };
    }

    const projectId = await ctx.step("find-harvest-project", async () => {
      const res = await sdk.runAction({
        appKey: "TableCLIAPI",
        actionType: "search",
        actionKey: "find_record",
        inputs: {
          table_id: PROJECT_TABLE,
          filter_count: "2",
          use_stored_order: false,
          field_data_key: "data__f5",
          operator: "exact",
          lookup_value: task.projectPageId,
          field_data_key_2: "data__f3",
          operator_2: "exact",
          lookup_value_2: true,
        },
      });
      return firstString(firstRow(res)?.data?.f1);
    });

    // A permanent condition, not a transient one — return rather than throw, so
    // the durable's step-retry loop doesn't spin on it.
    if (!projectId) {
      console.log(
        `skipping ${task.ticket ?? task.pageId}: no active Harvest project mapped to ${task.projectPageId}`,
      );
      return {
        skipped: true,
        reason: "no active Harvest project for this Notion project",
        pageId: task.pageId,
        projectPageId: task.projectPageId,
      };
    }

    const notes = task.ticket ?? task.pageId;
    const started = await ctx.step("start-timer", async () =>
      sdk.runAction({
        appKey: HARVEST_APP_KEY,
        actionType: "write",
        actionKey: HARVEST_START_TIMER,
        connection: HARVEST_CONNECTION,
        inputs: {
          taskId: HARVEST_TASK_ID,
          projectId,
          userId: HARVEST_USER_ID,
          notes,
          externalReferenceId: notes,
          externalReferenceGroupId: "Notion",
          externalReferencePermalink: task.url ?? "",
          externalReferenceService: "notion.app",
          externalReferenceServiceIconUrl:
            "https://img.logo.dev/notion.so?token=pk_MgvuyiQuRe6IT_XWNAUgrA",
          spentDate: date,
        },
      }),
    );

    const timeEntryId = timeEntryIdFrom(started);
    if (!timeEntryId) {
      // The timer IS running — we just can't index it, so tomorrow's click
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
          new__data__f6: task.pageId,
        },
      }),
    );

    console.log(`started Harvest time entry ${timeEntryId} for ${notes}`);
    return {
      action: "started",
      date,
      timezone: TZ_LABEL,
      ticket: task.ticket,
      pageId: task.pageId,
      projectId,
      timeEntryId,
    };
  },
);

export default workflow;
