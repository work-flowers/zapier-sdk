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
// It is also the RECONCILER for the coming week (days 0..7 by default): a
// recurring series that is truncated or moved with "this and following"
// gets an UNTIL on the old series instead of a cancellation per occurrence,
// so neither trigger Zap ever hears about the occurrences that vanished and
// their mirrors stand at the old time indefinitely (first seen 2026-09-08:
// the AI COE Weekly Long Sync moved from 11:30 to 09:30 and left four
// orphaned blocks). Each run compares the active mapping rows whose Start
// falls in the reconcile window against the source events the searches
// actually returned, deletes any mirror whose source occurrence is gone, and
// marks the row deleted. Cost: one extra search per direction per day.
//
// It is also the BACKFILL: run it by hand over the whole horizon —
//   trigger-workflow <id> --input '{"from_days":0,"to_days":30}'
// — to mirror every existing future event at cutover. Add '"dryRun":true' to
// see what it would create/delete without writing, and
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
 * Reconcile the coming week by default (days 0..7). A truncated series that
 * this run misses is caught by the next six, and an orphan further out is
 * caught as it rolls into the window. Manual runs may override or disable
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
 * returned 20 events.
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

/** Free: flip a mapping row to Status=deleted. */
async function markRowDeleted(ctx: DurableContext, stepId: string, recordId: string, sourceUpdated: string): Promise<void> {
  await ctx.step(stepId, async () =>
    sdk.runAction({
      appKey: "TableCLIAPI",
      actionType: "write",
      actionKey: "update_record",
      inputs: {
        table_id: SYNC_MAP_TABLE,
        record_id: recordId,
        new__data__f4: "deleted",
        new__data__f8: sourceUpdated,
      },
    }),
  );
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

      // --- Create: mirror anything in the window the map has never seen ------
      const skipped: Record<string, number> = {};
      const alreadyMapped: string[] = [];
      const created: Array<{ eventId: string; start: string | null; summary: string | null }> = [];

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
        if (row) {
          // Mapped (active or deliberately unmirrored) — the trigger Zaps own
          // updates and revivals; the sweep only fills never-seen gaps.
          alreadyMapped.push(eventId);
          continue;
        }

        const sourceSummary = firstString(event.summary) ?? "(no title)";
        const startDateTime = firstString(event.start?.dateTime)!;
        const endDateTime = firstString(event.end?.dateTime)!;
        const updatedAt = firstString(event.updated);

        if (dryRun) {
          created.push({ eventId, start: startDateTime, summary: dir.mode === "busy" ? "Busy" : sourceSummary });
          continue;
        }

        const mirrorInputs =
          dir.mode === "busy"
            ? {
                calendarid: dir.destCalendar,
                summary: "Busy",
                start__dateTime: startDateTime,
                end__dateTime: endDateTime,
                transparency: "opaque",
                visibility: "private",
                all_day: false,
                reminders__useDefault: false,
              }
            : {
                calendarid: dir.destCalendar,
                summary: sourceSummary,
                description: `${SYNC_MARKER} source:${eventId}\nMirrored from ${dir.sourceCalendar} by gcal-block-sweep. Edits here will be overwritten.`,
                start__dateTime: startDateTime,
                end__dateTime: endDateTime,
                transparency: "opaque",
                visibility: "default",
                all_day: false,
                reminders__useDefault: false,
              };

        const mirrorEventId = await createMirror(ctx, `${dir.direction}-${eventId}-create`, dir.destConnection, mirrorInputs);
        if (!mirrorEventId) {
          throw new Error(`detailed_event returned no event id for ${eventId} — refusing to record a bad mapping`);
        }

        await createRow(ctx, `${dir.direction}-${eventId}-record`, {
          new__data__f1: eventId,
          new__data__f2: mirrorEventId,
          new__data__f3: dir.direction,
          new__data__f4: "active",
          new__data__f5: startDateTime,
          new__data__f6: endDateTime,
          new__data__f7: sourceSummary,
          ...(updatedAt ? { new__data__f8: updatedAt } : {}),
        });
        created.push({ eventId, start: startDateTime, summary: dir.mode === "busy" ? "Busy" : sourceSummary });
      }

      console.log(
        `${dir.direction}: ${events.length} events in window, ${created.length} ${dryRun ? "would be " : ""}mirrored, ${alreadyMapped.length} already mapped`,
      );

      // --- Reconcile: unmirror anything the map still thinks is live but the
      // source calendar no longer has ------------------------------------------
      // A truncated series ("this and following" edits set an UNTIL on the old
      // series) produces no per-occurrence cancellation, so the trigger Zaps
      // never see the vanished occurrences. Any ACTIVE row whose Start is in
      // the reconcile window and whose source occurrence did not come back from
      // the search is an orphan. A row whose source was merely declined, made
      // free or moved still comes back and is left to the trigger Zaps. If the
      // trigger Zap has not yet processed a move that took the source outside
      // the window, this deletes the mirror one poll early and the trigger Zap
      // revives it — the row goes `deleted` -> `active` with a fresh mirror.
      const orphans: Array<{ sourceEventId: string; mirrorEventId: string; start: string | null; summary: string | null }> = [];
      let rowsChecked = 0;
      if (reconcileDays > 0 && reconcileUnsafe) {
        console.log(`${dir.direction}: reconciliation SKIPPED — ${reconcileUnsafe}`);
      } else if (reconcileDays > 0) {
        for (let d = 0; d < reconcileDays; d++) {
          const prefix = localDatePrefix(nowMs + d * DAY_MS, TABLE_START_UTC_OFFSET_MINUTES);
          const rows = await findActiveRowsStartingOn(ctx, `${dir.direction}-reconcile-rows-${d}`, dir.direction, prefix);
          for (const row of rows) {
            if (!row.sourceEventId || !row.mirrorEventId) continue;
            // The day prefix is a coarse filter; the search only covers
            // [now, now + reconcileDays), so hold rows to exactly that.
            const startMs = epochMsFromRfc3339(row.start);
            if (startMs === null || startMs < reconcileWindow.afterMs || startMs >= reconcileWindow.beforeMs) continue;
            rowsChecked += 1;
            const source = eventsById.get(row.sourceEventId);
            if (source && firstString(source.status) !== "cancelled") continue;
            if (orphans.some((o) => o.sourceEventId === row.sourceEventId)) continue;
            orphans.push({ sourceEventId: row.sourceEventId, mirrorEventId: row.mirrorEventId, start: row.start, summary: row.summary });
            if (dryRun) continue;
            await deleteEvent(ctx, `${dir.direction}-${row.sourceEventId}-unmirror`, dir.destConnection, dir.destCalendar, row.mirrorEventId);
            await markRowDeleted(ctx, `${dir.direction}-${row.sourceEventId}-mark-deleted`, row.recordId, nowIso);
          }
        }
        console.log(
          `${dir.direction}: reconciled ${rowsChecked} active rows in the coming ${reconcileDays}d, ${orphans.length} orphaned mirror(s) ${dryRun ? "would be " : ""}deleted`,
        );
      }

      summary[dir.direction] = {
        eventsInWindow: events.length,
        created,
        alreadyMapped: alreadyMapped.length,
        skipped,
        reconciled: reconcileDays > 0 ? { rowsChecked, orphans, skippedBecause: reconcileUnsafe } : null,
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
