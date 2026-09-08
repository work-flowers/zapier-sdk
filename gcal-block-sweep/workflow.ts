// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/gcal-block-sweep
//
// The horizon backstop for the two-way calendar-blocking pair
// (scw-events-to-workflowers-block / workflowers-events-to-scw-busy). Those
// Zaps deliberately refuse to CREATE a mirror for an occurrence starting more
// than HORIZON_DAYS out, because `expand_recurring: true` fires an open-ended
// weekly series ~14 years (≈730 instances) into the future and Zapier's
// polling dedupe means a skipped instance never re-fires on its own. This
// sweep runs daily, scans the sliver of calendar that just rolled INTO the
// horizon (default window: days 23..30 from now, generous overlap so a few
// missed days self-heal), and creates any mirror the map table says is
// missing. Rows that already exist are free Table reads, so a quiet day
// costs approximately nothing.
//
// It is also the RECONCILER for the coming week (days 0..7 by default), and
// since 2026-09-08 that is where every post-creation change propagates:
//
//   - Zapier's `event_updated` trigger never re-fires for an occurrence it
//     has already delivered — 300 runs across the three event_updated Zaps
//     in this repo, 300 distinct event ids, and a live reschedule that the
//     trigger's own poll returned first yet never produced a run. So a
//     moved or renamed occurrence, a decline, a switch to all-day or Free
//     never reaches the trigger Zaps' update/delete branches.
//   - A recurring series truncated or moved with "this and following" gets
//     an UNTIL on the old series instead of a cancellation per occurrence,
//     so even `event_cancelled` never hears about the vanished occurrences.
//
// Each run therefore compares every ACTIVE mapping row whose Start falls in
// the reconcile window against the source events the searches actually
// returned: source gone or cancelled -> delete the mirror, mark the row
// deleted; source no longer block-worthy (declined, Free, all-day) -> same;
// source moved or renamed -> update the mirror and refresh the row. A row
// previously marked deleted whose source is block-worthy again is revived by
// the create pass. Cost: one extra search per direction per day, plus one
// task per mirror actually changed.
//
// It is also the BACKFILL: run it by hand over the whole horizon —
//   trigger-workflow <id> --input '{"from_days":0,"to_days":30}'
// — to mirror every existing future event at cutover. Add '"dryRun":true' to
// see what it would create/update/delete without writing, and
// '"cleanup_notion_blocks":true' to also delete the orphaned "Event blocked
// with Notion Calendar" blocks on the SCW calendar (SCW IT cut Notion
// Calendar off, so those blocks are frozen and must go).
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
// Schedule by Zapier needs no connection; both Google credentials are bound
// as aliases because this workflow reads AND writes both calendars.
const GCAL_APP_KEY = "GoogleCalendarCLIAPI";
const WF_CONNECTION = "gcal_wf";
const WF_CALENDAR = "dennis@work.flowers";
const SCW_CONNECTION = "gcal_scw";
const SCW_CALENDAR = "dchiuten@securecodewarrior.com";

/** See scw-events-to-workflowers-block/workflow.ts for the column map. */
const SYNC_MAP_TABLE = "01M13QPJ5GRJV33096MBNSN1Q5";
const SYNC_MARKER = "[gcal-block]";

const DAY_MS = 86400000;

/** Keep in lockstep with HORIZON_DAYS in the two trigger Zaps. */
const HORIZON_DAYS = 30;
/** Default daily window: the week rolling into the horizon, with overlap. */
const DEFAULT_FROM_DAYS = HORIZON_DAYS - 7;
/** Search the calendars in slices this wide so no single search page overflows. */
const CHUNK_DAYS = 7;

/**
 * Reconcile the coming week by default (days 0..7). A change that this run
 * misses is caught by the next six, and a change further out is caught as it
 * rolls into the window. Manual runs may override or disable
 * (`reconcile_days: 0`).
 */
const DEFAULT_RECONCILE_DAYS = 7;

/**
 * `Start` (f5) is stored exactly as Google returned `start.dateTime`, which is
 * in the calendar's own zone — both calendars are Asia/Singapore, so the
 * stored strings carry `+08:00`. The per-day row lookup filters on the
 * `YYYY-MM-DD` prefix of that string, so the day boundary must be computed in
 * the same offset. (A row that lands on the wrong side of a boundary is not
 * lost: the window is a week wide and the sweep runs daily.)
 */
const TABLE_START_UTC_OFFSET_MINUTES = 8 * 60;

/**
 * Reconciliation trusts a search chunk to be COMPLETE — an event missing from
 * the results is read as "the source is gone", and its mirror is deleted. A
 * truncated results page would read as a mass cancellation, so a chunk that
 * comes back this full is treated as untrustworthy and reconciliation is
 * skipped for that direction, loudly. The busiest week observed so far
 * returned 43 events across the merged windows.
 */
const RECONCILE_MAX_EVENTS_PER_CHUNK = 100;

/** Google's error text when the mirror event was already deleted by hand. */
const MIRROR_GONE_PATTERN = /not\s*found|has been deleted|410|404/i;

interface Direction {
  direction: string;
  sourceConnection: string;
  sourceCalendar: string;
  destConnection: string;
  destCalendar: string;
  /** "title" mirrors the source summary + marker; "busy" mirrors a bare private block. */
  mode: "title" | "busy";
}

const DIRECTIONS: Direction[] = [
  {
    direction: "scw_to_wf",
    sourceConnection: SCW_CONNECTION,
    sourceCalendar: SCW_CALENDAR,
    destConnection: WF_CONNECTION,
    destCalendar: WF_CALENDAR,
    mode: "title",
  },
  {
    direction: "wf_to_scw",
    sourceConnection: WF_CONNECTION,
    sourceCalendar: WF_CALENDAR,
    destConnection: SCW_CONNECTION,
    destCalendar: SCW_CALENDAR,
    mode: "busy",
  },
];

// --- Input -------------------------------------------------------------------
// On a scheduled run the payload is Schedule by Zapier's tick, whose `id` IS
// the fire time as an RFC 3339 timestamp — the deterministic "now". A manual
// run may override the window and flags.

const InputSchema = z
  .object({
    id: z.string().optional().nullable(),
    now: z.string().optional().nullable(),
    from_days: z.number().optional().nullable(),
    to_days: z.number().optional().nullable(),
    reconcile_days: z.number().optional().nullable(),
    dryRun: z.boolean().optional().nullable(),
    cleanup_notion_blocks: z.boolean().optional().nullable(),
  })
  .passthrough();

type Input = z.infer<typeof InputSchema>;

/** `run-durable` hands manual input through as a JSON string. */
function normalizeInput(rawInput: unknown): unknown {
  if (typeof rawInput === "string") return JSON.parse(rawInput);
  return rawInput;
}

// --- Deterministic calendar maths ----------------------------------------------
// No `new Date` anywhere in the body (the durable runtime's Date guard throws
// regardless of arguments). Integer maths, same family of helpers as
// drive-invoice-to-xero and gcal-event-updated-to-meeting-note.

/** Days since the Unix epoch for a `YYYY-MM-DD` triple (Hinnant's days-from-civil). */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Inverse of daysFromCivil (Hinnant's civil-from-days). */
function civilFromDays(days: number): { y: number; m: number; d: number } {
  const zz = days + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: y + (m <= 2 ? 1 : 0), m, d };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Epoch milliseconds -> `YYYY-MM-DDTHH:MM:SSZ`. */
function isoFromEpochMs(epochMs: number): string {
  const days = Math.floor(epochMs / DAY_MS);
  const msOfDay = epochMs - days * DAY_MS;
  const { y, m, d } = civilFromDays(days);
  const hour = Math.floor(msOfDay / 3600000);
  const minute = Math.floor((msOfDay % 3600000) / 60000);
  const second = Math.floor((msOfDay % 60000) / 1000);
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}T${pad(hour)}:${pad(minute)}:${pad(second)}Z`;
}

/** Epoch milliseconds -> the `YYYY-MM-DD` that instant falls on at the given UTC offset. */
function localDatePrefix(epochMs: number, offsetMinutes: number): string {
  const days = Math.floor((epochMs + offsetMinutes * 60000) / DAY_MS);
  const { y, m, d } = civilFromDays(days);
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/** Epoch milliseconds for an RFC 3339 timestamp, or null if it is not one. */
function epochMsFromRfc3339(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|z|[+-]\d{2}:?\d{2})?$/.exec(
      value.trim(),
    );
  if (!m) return null;

  const [, ys, mos, ds, hs, mins, ss, frac, offset] = m;
  const year = Number(ys);
  const month = Number(mos);
  const day = Number(ds);
  const hour = Number(hs);
  const minute = Number(mins);
  const second = ss ? Number(ss) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 60) return null;

  const ms = frac ? Number(frac.padEnd(3, "0").slice(0, 3)) : 0;
  let epoch =
    daysFromCivil(year, month, day) * DAY_MS +
    hour * 3600000 +
    minute * 60000 +
    second * 1000 +
    ms;

  if (offset && offset !== "Z" && offset !== "z") {
    const sign = offset[0] === "-" ? -1 : 1;
    const body = offset.slice(1).replace(":", "");
    const offsetMinutes = Number(body.slice(0, 2)) * 60 + Number(body.slice(2, 4));
    epoch -= sign * offsetMinutes * 60000;
  }
  return epoch;
}

/** True when both parse and land on the same instant. An unparseable side is "different". */
function sameInstant(a: unknown, b: unknown): boolean {
  const left = epochMsFromRfc3339(a);
  const right = epochMsFromRfc3339(b);
  if (left === null || right === null) return false;
  return left === right;
}

interface Interval {
  afterMs: number;
  beforeMs: number;
}

/** Merge overlapping/touching intervals, then slice the result into CHUNK_DAYS-wide search windows. */
function chunkIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((iv) => iv.beforeMs > iv.afterMs)
    .sort((a, b) => a.afterMs - b.afterMs);
  const merged: Interval[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.afterMs <= last.beforeMs) {
      last.beforeMs = Math.max(last.beforeMs, iv.beforeMs);
    } else {
      merged.push({ ...iv });
    }
  }
  const chunks: Interval[] = [];
  for (const iv of merged) {
    for (let cursor = iv.afterMs; cursor < iv.beforeMs; cursor += CHUNK_DAYS * DAY_MS) {
      chunks.push({ afterMs: cursor, beforeMs: Math.min(cursor + CHUNK_DAYS * DAY_MS, iv.beforeMs) });
    }
  }
  return chunks;
}

// --- Helpers -------------------------------------------------------------------

function firstString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

const EventTimeSchema = z
  .object({ dateTime: z.string().optional().nullable(), date: z.string().optional().nullable() })
  .partial()
  .passthrough();

const FoundEventSchema = z
  .object({
    id: z.string().optional().nullable(),
    status: z.string().optional().nullable(),
    summary: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
    transparency: z.string().optional().nullable(),
    updated: z.string().optional().nullable(),
    start: EventTimeSchema.optional().nullable(),
    end: EventTimeSchema.optional().nullable(),
    attendees: z
      .array(
        z
          .object({
            self: z.boolean().optional().nullable(),
            responseStatus: z.string().optional().nullable(),
          })
          .partial()
          .passthrough(),
      )
      .optional()
      .nullable(),
    organizer: z
      .object({ self: z.boolean().optional().nullable() })
      .partial()
      .passthrough()
      .optional()
      .nullable(),
  })
  .passthrough();

type FoundEvent = z.infer<typeof FoundEventSchema>;

interface MappingRow {
  recordId: string;
  sourceEventId: string | null;
  mirrorEventId: string | null;
  status: string | null;
  start: string | null;
  end: string | null;
  summary: string | null;
}

function parseRows(result: unknown): MappingRow[] {
  const rows = Array.isArray(result) ? result : [];
  const out: MappingRow[] = [];
  for (const raw of rows) {
    const hit = raw as { record_id?: unknown; old?: { data?: Record<string, unknown> } } | null;
    const recordId = firstString(hit?.record_id);
    if (!recordId) continue;
    const data = hit?.old?.data ?? {};
    out.push({
      recordId,
      sourceEventId: firstString(data.f1),
      mirrorEventId: firstString(data.f2),
      status: firstString(data.f4),
      start: firstString(data.f5),
      end: firstString(data.f6),
      summary: firstString(data.f7),
    });
  }
  return out;
}

function hasRow(result: unknown): MappingRow | null {
  return parseRows(result)[0] ?? null;
}

/** Why a found event is not worth a block, or null when it should be mirrored. */
function classifySkip(event: FoundEvent, mode: "title" | "busy"): string | null {
  if (firstString(event.status) === "cancelled") return "cancelled";
  if (!firstString(event.start?.dateTime) || !firstString(event.end?.dateTime)) return "not-timed";
  if (firstString(event.transparency) === "transparent") return "free";
  const declined = (event.attendees ?? []).some(
    (a) => a?.self === true && firstString(a.responseStatus) === "declined",
  );
  if (declined) return "declined";
  const description = firstString(event.description);
  if (description && (description.includes(SYNC_MARKER) || description.includes("Event blocked with"))) {
    return "sync-artifact";
  }
  // A bare "Busy" on the SCW calendar is a wf->scw mirror or a legacy Notion
  // Calendar block; only the scw_to_wf ("title") direction reads that calendar.
  if (mode === "title" && firstString(event.summary) === "Busy") return "busy-block";
  return null;
}

/** What the mirror of `event` should look like in this direction. */
function mirrorSpec(dir: Direction, eventId: string, event: FoundEvent) {
  const sourceSummary = firstString(event.summary) ?? "(no title)";
  const startDateTime = firstString(event.start?.dateTime)!;
  const endDateTime = firstString(event.end?.dateTime)!;
  const mirrorSummary = dir.mode === "busy" ? "Busy" : sourceSummary;
  const description =
    dir.mode === "busy"
      ? null
      : `${SYNC_MARKER} source:${eventId}\nMirrored from ${dir.sourceCalendar} by gcal-block-sweep. Edits here will be overwritten.`;
  return { sourceSummary, startDateTime, endDateTime, mirrorSummary, description };
}

type MirrorSpec = ReturnType<typeof mirrorSpec>;

function createInputs(dir: Direction, spec: MirrorSpec): Record<string, unknown> {
  return {
    calendarid: dir.destCalendar,
    summary: spec.mirrorSummary,
    ...(spec.description ? { description: spec.description } : {}),
    start__dateTime: spec.startDateTime,
    end__dateTime: spec.endDateTime,
    transparency: "opaque",
    visibility: dir.mode === "busy" ? "private" : "default",
    all_day: false,
    reminders__useDefault: false,
  };
}

function updateInputs(dir: Direction, mirrorEventId: string, spec: MirrorSpec): Record<string, unknown> {
  return {
    calendarid: dir.destCalendar,
    eventid: mirrorEventId,
    summary: spec.mirrorSummary,
    ...(spec.description ? { description: spec.description } : {}),
    start__dateTime: spec.startDateTime,
    end__dateTime: spec.endDateTime,
    send_notifications: false,
  };
}

/** The row fields that describe a live mirror of `spec`. */
function rowFields(spec: MirrorSpec, mirrorEventId: string, sourceUpdated: string | null): Record<string, unknown> {
  return {
    new__data__f2: mirrorEventId,
    new__data__f4: "active",
    new__data__f5: spec.startDateTime,
    new__data__f6: spec.endDateTime,
    new__data__f7: spec.sourceSummary,
    ...(sourceUpdated ? { new__data__f8: sourceUpdated } : {}),
  };
}

// --- Steps ---------------------------------------------------------------------
// Every step whose id carries a loop variable lives here, in a helper that
// takes `ctx`: the publish-time analyzer rejects a template-literal step id in
// the workflow body itself (`invalid-step-call`) but does not follow `ctx`
// into a helper. The runtime still needs the ids unique per run.

/** `event_v2` over one window. Semantics are inverted from the field names:
 *  `start_time` is "Start Time BEFORE" (upper bound), `end_time` is "End Time
 *  AFTER" (lower bound). Verified by probe 2026-08-28. */
async function searchEvents(
  ctx: DurableContext,
  stepId: string,
  connection: string,
  calendarId: string,
  window: Interval,
): Promise<FoundEvent[]> {
  const found = await ctx.step(stepId, async () =>
    sdk.runAction({
      appKey: GCAL_APP_KEY,
      actionType: "search",
      actionKey: "event_v2",
      connection,
      inputs: {
        calendarid: calendarId,
        expand_recurring: true,
        ordering: "startTime",
        start_time: isoFromEpochMs(window.beforeMs),
        end_time: isoFromEpochMs(window.afterMs),
        _zap_search_success_on_miss: true,
      },
    }),
  );
  const events: FoundEvent[] = [];
  for (const raw of ((found as { data?: unknown[] }).data ?? [])) {
    const parsed = FoundEventSchema.safeParse(raw);
    if (parsed.success) events.push(parsed.data);
  }
  return events;
}

/**
 * One task: fetch a single occurrence by id from the source calendar. Used only
 * when an ACTIVE row's source did not come back from the window search, to tell
 * "moved outside the searched window" (a confirmed event comes back, at its new
 * time) from "gone" (not found, or a cancelled tombstone — a truncated series'
 * vanished occurrences read back as `status: cancelled` with a sparse body).
 */
async function getEventById(
  ctx: DurableContext,
  stepId: string,
  connection: string,
  calendarId: string,
  eventId: string,
): Promise<FoundEvent | null> {
  const found = await ctx.step(stepId, async () =>
    sdk.runAction({
      appKey: GCAL_APP_KEY,
      actionType: "search",
      actionKey: "event_by_id",
      connection,
      inputs: { calendarid: calendarId, event_id: eventId, _zap_search_success_on_miss: true },
    }),
  );
  const raw = ((found as { data?: unknown[] }).data ?? [])[0];
  if (!raw) return null;
  const parsed = FoundEventSchema.safeParse(raw);
  if (!parsed.success || firstString(parsed.data.id) !== eventId) return null;
  return parsed.data;
}

/** Free: the row whose Mirror Event ID is `eventId`, i.e. the sync's own output. */
async function findRowByMirrorId(ctx: DurableContext, stepId: string, eventId: string): Promise<MappingRow | null> {
  const result = await ctx.step(stepId, async () =>
    sdk.runAction({
      appKey: "TableCLIAPI",
      actionType: "search",
      actionKey: "find_record",
      inputs: {
        table_id: SYNC_MAP_TABLE,
        filter_count: "1",
        use_stored_order: false,
        field_data_key: "data__f2",
        operator: "exact",
        lookup_value: eventId,
        _zap_search_multiple_results: "first",
        _zap_search_success_on_miss: true,
      },
    }),
  );
  return hasRow((result as { data?: unknown }).data);
}

/** Free: the mapping row for a source occurrence in one direction. */
async function findRowBySourceId(
  ctx: DurableContext,
  stepId: string,
  eventId: string,
  direction: string,
): Promise<MappingRow | null> {
  const result = await ctx.step(stepId, async () =>
    sdk.runAction({
      appKey: "TableCLIAPI",
      actionType: "search",
      actionKey: "find_record",
      inputs: {
        table_id: SYNC_MAP_TABLE,
        filter_count: "2",
        use_stored_order: false,
        field_data_key: "data__f1",
        operator: "exact",
        lookup_value: eventId,
        field_data_key_2: "data__f3",
        operator_2: "exact",
        lookup_value_2: direction,
        _zap_search_multiple_results: "first",
        _zap_search_success_on_miss: true,
      },
    }),
  );
  return hasRow((result as { data?: unknown }).data);
}

/** Free: every ACTIVE row in one direction whose Start begins with `datePrefix` (`YYYY-MM-DD`). */
async function findActiveRowsStartingOn(
  ctx: DurableContext,
  stepId: string,
  direction: string,
  datePrefix: string,
): Promise<MappingRow[]> {
  const result = await ctx.step(stepId, async () =>
    sdk.runAction({
      appKey: "TableCLIAPI",
      actionType: "search",
      actionKey: "find_record",
      inputs: {
        table_id: SYNC_MAP_TABLE,
        filter_count: "3",
        use_stored_order: false,
        field_data_key: "data__f3",
        operator: "exact",
        lookup_value: direction,
        field_data_key_2: "data__f4",
        operator_2: "exact",
        lookup_value_2: "active",
        field_data_key_3: "data__f5",
        operator_3: "startswith",
        lookup_value_3: datePrefix,
        _zap_search_multiple_results: "all",
        _zap_search_success_on_miss: true,
      },
    }),
  );
  return parseRows((result as { data?: unknown }).data);
}

/** One task: create the mirror on the destination calendar; returns its event id. */
async function createMirror(
  ctx: DurableContext,
  stepId: string,
  connection: string,
  inputs: Record<string, unknown>,
): Promise<string | null> {
  const made = await ctx.step(stepId, async () =>
    sdk.runAction({
      appKey: GCAL_APP_KEY,
      actionType: "write",
      actionKey: "detailed_event",
      connection,
      inputs,
    }),
  );
  return firstString((made as { data?: Array<{ id?: unknown }> }).data?.[0]?.id);
}

/** One task: move/rename an existing mirror. A hand-deleted mirror reports `mirrorGone` instead of spinning retries. */
async function updateMirror(
  ctx: DurableContext,
  stepId: string,
  connection: string,
  inputs: Record<string, unknown>,
): Promise<{ mirrorGone: boolean }> {
  return ctx.step(stepId, async () => {
    try {
      await sdk.runAction({
        appKey: GCAL_APP_KEY,
        actionType: "write",
        actionKey: "update_event",
        connection,
        inputs,
      });
      return { mirrorGone: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (MIRROR_GONE_PATTERN.test(message)) return { mirrorGone: true };
      throw error;
    }
  });
}

/** Free: record a new mapping row. */
async function createRow(ctx: DurableContext, stepId: string, fields: Record<string, unknown>): Promise<void> {
  await ctx.step(stepId, async () =>
    sdk.runAction({
      appKey: "TableCLIAPI",
      actionType: "write",
      actionKey: "create_record",
      inputs: { table_id: SYNC_MAP_TABLE, ...fields },
    }),
  );
}

/** Free: overwrite fields on an existing mapping row. */
async function updateRow(ctx: DurableContext, stepId: string, recordId: string, fields: Record<string, unknown>): Promise<void> {
  await ctx.step(stepId, async () =>
    sdk.runAction({
      appKey: "TableCLIAPI",
      actionType: "write",
      actionKey: "update_record",
      inputs: { table_id: SYNC_MAP_TABLE, record_id: recordId, ...fields },
    }),
  );
}

/** One task: delete an event; "already gone" is the outcome we wanted, anything else retries. */
async function deleteEvent(
  ctx: DurableContext,
  stepId: string,
  connection: string,
  calendarId: string,
  eventId: string,
): Promise<{ alreadyGone: boolean }> {
  return ctx.step(stepId, async () => {
    try {
      await sdk.runAction({
        appKey: GCAL_APP_KEY,
        actionType: "write",
        actionKey: "delete_event",
        connection,
        inputs: { calendarid: calendarId, eventid: eventId, send_notifications: false },
      });
      return { alreadyGone: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (MIRROR_GONE_PATTERN.test(message)) return { alreadyGone: true };
      throw error;
    }
  });
}

// --- Workflow --------------------------------------------------------------------

const workflow = defineDurable<Input, unknown>(
  "gcal-block-sweep",
  async (ctx: DurableContext, rawInput: Input) => {
    const input = InputSchema.parse(normalizeInput(rawInput));
    const dryRun = input.dryRun === true;
    const cleanupNotionBlocks = input.cleanup_notion_blocks === true;

    // "Now": an explicit manual override, else the schedule tick's own
    // timestamp, else one guarded clock read (fixed for every retry).
    const nowMs =
      epochMsFromRfc3339(firstString(input.now)) ??
      epochMsFromRfc3339(firstString(input.id)) ??
      (await ctx.step("read-clock", async () => Date.now()));
    const nowIso = isoFromEpochMs(nowMs);

    const fromDays = typeof input.from_days === "number" ? input.from_days : DEFAULT_FROM_DAYS;
    const toDays = typeof input.to_days === "number" ? input.to_days : HORIZON_DAYS;
    if (!(toDays > fromDays) || fromDays < 0 || toDays > 366) {
      throw new Error(`invalid window: from_days=${fromDays} to_days=${toDays}`);
    }
    const reconcileDays = typeof input.reconcile_days === "number" ? input.reconcile_days : DEFAULT_RECONCILE_DAYS;
    if (reconcileDays < 0 || reconcileDays > 366 || !Number.isInteger(reconcileDays)) {
      throw new Error(`invalid reconcile_days=${reconcileDays}`);
    }

    const createWindow: Interval = { afterMs: nowMs + fromDays * DAY_MS, beforeMs: nowMs + toDays * DAY_MS };
    const reconcileWindow: Interval = { afterMs: nowMs, beforeMs: nowMs + reconcileDays * DAY_MS };

    // One search plan covers both windows (merged where they overlap, so a
    // backfill from day 0 does not search the coming week twice).
    const chunks = chunkIntervals([createWindow, reconcileWindow]);
    const overlapsReconcile = (c: Interval) =>
      reconcileDays > 0 && c.afterMs < reconcileWindow.beforeMs && c.beforeMs > reconcileWindow.afterMs;

    const summary: Record<string, unknown> = {
      dryRun,
      window: { from: isoFromEpochMs(createWindow.afterMs), to: isoFromEpochMs(createWindow.beforeMs) },
      reconcileWindow:
        reconcileDays > 0
          ? { from: isoFromEpochMs(reconcileWindow.afterMs), to: isoFromEpochMs(reconcileWindow.beforeMs) }
          : null,
    };

    for (const dir of DIRECTIONS) {
      const eventsById = new Map<string, FoundEvent>();
      let reconcileUnsafe: string | null = null;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const found = await searchEvents(ctx, `${dir.direction}-search-${i}`, dir.sourceConnection, dir.sourceCalendar, chunk);
        if (overlapsReconcile(chunk) && found.length >= RECONCILE_MAX_EVENTS_PER_CHUNK) {
          reconcileUnsafe = `chunk ${i} returned ${found.length} events (>= ${RECONCILE_MAX_EVENTS_PER_CHUNK}); a truncated page would read as a mass cancellation`;
        }
        for (const event of found) {
          const id = firstString(event.id);
          if (id && !eventsById.has(id)) eventsById.set(id, event);
        }
      }
      const events = [...eventsById.values()];

      // --- Create / revive: mirror anything block-worthy in the window that
      // has no ACTIVE row ------------------------------------------------------
      const skipped: Record<string, number> = {};
      const alreadyMapped: string[] = [];
      const created: Array<{ eventId: string; start: string | null; summary: string | null }> = [];
      const revived: Array<{ eventId: string; start: string | null; summary: string | null }> = [];

      for (const event of events) {
        const eventId = firstString(event.id)!;
        const skip = classifySkip(event, dir.mode);
        if (skip) {
          skipped[skip] = (skipped[skip] ?? 0) + 1;
          continue;
        }

        // Free table reads: is this the sync's own output, or already mapped?
        if (await findRowByMirrorId(ctx, `${dir.direction}-${eventId}-guard`, eventId)) {
          skipped["created-by-sync"] = (skipped["created-by-sync"] ?? 0) + 1;
          continue;
        }
        const row = await findRowBySourceId(ctx, `${dir.direction}-${eventId}-lookup`, eventId, dir.direction);
        if (row && row.status === "active") {
          // Live mirror on record — the reconcile pass below owns its accuracy.
          alreadyMapped.push(eventId);
          continue;
        }
        // No row, or a row previously marked deleted (source was cancelled,
        // declined, made Free or all-day at the time) whose source is
        // block-worthy again: create a fresh mirror and (re)record it. The
        // trigger Zaps' own revive path never runs, because event_updated does
        // not re-fire for an occurrence it has already delivered.
        const spec = mirrorSpec(dir, eventId, event);
        const updatedAt = firstString(event.updated);
        const entry = { eventId, start: spec.startDateTime, summary: spec.mirrorSummary };

        if (dryRun) {
          (row ? revived : created).push(entry);
          continue;
        }

        const mirrorEventId = await createMirror(ctx, `${dir.direction}-${eventId}-create`, dir.destConnection, createInputs(dir, spec));
        if (!mirrorEventId) {
          throw new Error(`detailed_event returned no event id for ${eventId} — refusing to record a bad mapping`);
        }

        if (row) {
          await updateRow(ctx, `${dir.direction}-${eventId}-revive-row`, row.recordId, rowFields(spec, mirrorEventId, updatedAt));
          revived.push(entry);
        } else {
          await createRow(ctx, `${dir.direction}-${eventId}-record`, {
            new__data__f1: eventId,
            new__data__f3: dir.direction,
            ...rowFields(spec, mirrorEventId, updatedAt),
          });
          created.push(entry);
        }
      }

      console.log(
        `${dir.direction}: ${events.length} events in window, ${created.length} ${dryRun ? "would be " : ""}mirrored, ${revived.length} revived, ${alreadyMapped.length} already mapped`,
      );

      // --- Reconcile: bring every ACTIVE row in the coming week into line with
      // its source -----------------------------------------------------------
      // The trigger Zaps only ever see an occurrence once (see the header), so
      // everything that happens to it afterwards is caught here: gone or
      // cancelled -> unmirror; no longer block-worthy (declined, Free,
      // all-day) -> unmirror; moved or renamed -> update the mirror. A source
      // that did not come back from the searches is fetched by id before it is
      // declared gone, so an occurrence moved beyond the searched windows is
      // updated to its new time rather than deleted.
      type Change = { sourceEventId: string; mirrorEventId: string; start: string | null; summary: string | null };
      const orphans: Change[] = [];
      const unmirrored: Array<Change & { reason: string }> = [];
      const updated: Array<Change & { to: { start: string; end: string; summary: string } }> = [];
      let rowsChecked = 0;
      if (reconcileDays > 0 && reconcileUnsafe) {
        console.log(`${dir.direction}: reconciliation SKIPPED — ${reconcileUnsafe}`);
      } else if (reconcileDays > 0) {
        const seenRows = new Set<string>();
        for (let d = 0; d < reconcileDays; d++) {
          const prefix = localDatePrefix(nowMs + d * DAY_MS, TABLE_START_UTC_OFFSET_MINUTES);
          const rows = await findActiveRowsStartingOn(ctx, `${dir.direction}-reconcile-rows-${d}`, dir.direction, prefix);
          for (const row of rows) {
            if (!row.sourceEventId || !row.mirrorEventId) continue;
            if (seenRows.has(row.recordId)) continue;
            seenRows.add(row.recordId);
            // The day prefix is a coarse filter; the search only covers
            // [now, now + reconcileDays), so hold rows to exactly that.
            const startMs = epochMsFromRfc3339(row.start);
            if (startMs === null || startMs < reconcileWindow.afterMs || startMs >= reconcileWindow.beforeMs) continue;
            rowsChecked += 1;

            const change: Change = { sourceEventId: row.sourceEventId, mirrorEventId: row.mirrorEventId, start: row.start, summary: row.summary };
            let source = eventsById.get(row.sourceEventId) ?? null;
            if (!source) {
              // Not in any searched window: either moved further out than the
              // searches reach, or gone. One task to tell them apart — deleting
              // a block for a meeting that merely moved to next month would be
              // wrong, and this branch is rare.
              source = await getEventById(ctx, `${dir.direction}-${row.sourceEventId}-lookup-by-id`, dir.sourceConnection, dir.sourceCalendar, row.sourceEventId);
            }
            const skip = source ? classifySkip(source, dir.mode) : "gone";

            if (skip) {
              if (skip === "gone" || skip === "cancelled") orphans.push(change);
              else unmirrored.push({ ...change, reason: skip });
              if (dryRun) continue;
              await deleteEvent(ctx, `${dir.direction}-${row.sourceEventId}-unmirror`, dir.destConnection, dir.destCalendar, row.mirrorEventId);
              await updateRow(ctx, `${dir.direction}-${row.sourceEventId}-mark-deleted`, row.recordId, {
                new__data__f4: "deleted",
                new__data__f8: firstString(source?.updated) ?? nowIso,
              });
              continue;
            }

            const spec = mirrorSpec(dir, row.sourceEventId, source!);
            const unchanged =
              sameInstant(spec.startDateTime, row.start) &&
              sameInstant(spec.endDateTime, row.end) &&
              (dir.mode === "busy" || spec.sourceSummary === row.summary);
            if (unchanged) continue;

            updated.push({ ...change, to: { start: spec.startDateTime, end: spec.endDateTime, summary: spec.mirrorSummary } });
            if (dryRun) continue;

            const updatedAt = firstString(source!.updated);
            const result = await updateMirror(ctx, `${dir.direction}-${row.sourceEventId}-update`, dir.destConnection, updateInputs(dir, row.mirrorEventId, spec));
            let mirrorEventId = row.mirrorEventId;
            if (result.mirrorGone) {
              // Hand-deleted on the destination: recreate rather than leave the
              // row pointing at nothing.
              const recreated = await createMirror(ctx, `${dir.direction}-${row.sourceEventId}-recreate`, dir.destConnection, createInputs(dir, spec));
              if (!recreated) {
                throw new Error(`detailed_event returned no event id recreating the mirror of ${row.sourceEventId} — refusing to record a bad mapping`);
              }
              mirrorEventId = recreated;
            }
            await updateRow(ctx, `${dir.direction}-${row.sourceEventId}-refresh-row`, row.recordId, rowFields(spec, mirrorEventId, updatedAt));
          }
        }
        console.log(
          `${dir.direction}: reconciled ${rowsChecked} active rows in the coming ${reconcileDays}d — ${orphans.length} orphaned, ${unmirrored.length} no longer block-worthy, ${updated.length} moved/renamed${dryRun ? " (dry run, nothing written)" : ""}`,
        );
      }

      summary[dir.direction] = {
        eventsInWindow: events.length,
        created,
        revived,
        alreadyMapped: alreadyMapped.length,
        skipped,
        reconciled: reconcileDays > 0 ? { rowsChecked, orphans, unmirrored, updated, skippedBecause: reconcileUnsafe } : null,
      };
    }

    // One-off cutover cleanup, manual runs only: delete the frozen Notion
    // Calendar blocker events on the SCW calendar inside the window. They are
    // identified by Notion Calendar's own description text AND being
    // self-organized, so nothing hand-made or meeting-shaped can match.
    if (cleanupNotionBlocks) {
      const deleted: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const found = await searchEvents(ctx, `cleanup-search-${i}`, SCW_CONNECTION, SCW_CALENDAR, chunks[i]);
        for (const event of found) {
          const id = firstString(event.id);
          const description = firstString(event.description) ?? "";
          if (!id || deleted.includes(id)) continue;
          if (!description.includes("Event blocked with")) continue;
          if (event.organizer?.self !== true) continue;
          if (!dryRun) {
            await deleteEvent(ctx, `cleanup-${id}-delete`, SCW_CONNECTION, SCW_CALENDAR, id);
          }
          deleted.push(id);
        }
      }
      console.log(`cleanup: ${deleted.length} Notion Calendar blocks ${dryRun ? "would be " : ""}deleted`);
      summary.cleanupNotionBlocks = { count: deleted.length, ids: deleted };
    }

    return summary;
  },
);

export default workflow;
