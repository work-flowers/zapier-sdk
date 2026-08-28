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
// It is also the BACKFILL: run it by hand over the whole horizon —
//   trigger-workflow <id> --input '{"from_days":0,"to_days":30}'
// — to mirror every existing future event at cutover. Add '"dryRun":true' to
// see what it would create without writing, and
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

/** Keep in lockstep with HORIZON_DAYS in the two trigger Zaps. */
const HORIZON_DAYS = 30;
/** Default daily window: the week rolling into the horizon, with overlap. */
const DEFAULT_FROM_DAYS = HORIZON_DAYS - 7;
/** Search the calendars in slices this wide so no single search page overflows. */
const CHUNK_DAYS = 7;

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

/** Epoch milliseconds -> `YYYY-MM-DDTHH:MM:SSZ`. */
function isoFromEpochMs(epochMs: number): string {
  const days = Math.floor(epochMs / 86400000);
  const msOfDay = epochMs - days * 86400000;
  const { y, m, d } = civilFromDays(days);
  const hour = Math.floor(msOfDay / 3600000);
  const minute = Math.floor((msOfDay % 3600000) / 60000);
  const second = Math.floor((msOfDay % 60000) / 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(y, 4)}-${p(m)}-${p(d)}T${p(hour)}:${p(minute)}:${p(second)}Z`;
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
    daysFromCivil(year, month, day) * 86400000 +
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

function hasRow(result: unknown): { recordId: string; status: string | null } | null {
  const rows = Array.isArray(result) ? result : [];
  const hit = rows[0] as
    | { record_id?: unknown; old?: { data?: Record<string, unknown> } }
    | undefined;
  if (!hit) return null;
  const recordId = firstString(hit.record_id);
  if (!recordId) return null;
  return { recordId, status: firstString(hit.old?.data?.f4) };
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

    const fromDays = typeof input.from_days === "number" ? input.from_days : DEFAULT_FROM_DAYS;
    const toDays = typeof input.to_days === "number" ? input.to_days : HORIZON_DAYS;
    if (!(toDays > fromDays) || fromDays < 0 || toDays > 366) {
      throw new Error(`invalid window: from_days=${fromDays} to_days=${toDays}`);
    }
    const windowStartMs = nowMs + fromDays * 86400000;
    const windowEndMs = nowMs + toDays * 86400000;

    // Slice the window so a single search never has to page.
    const chunks: Array<{ afterMs: number; beforeMs: number }> = [];
    for (let cursor = windowStartMs; cursor < windowEndMs; cursor += CHUNK_DAYS * 86400000) {
      chunks.push({ afterMs: cursor, beforeMs: Math.min(cursor + CHUNK_DAYS * 86400000, windowEndMs) });
    }

    const summary: Record<string, unknown> = {
      dryRun,
      window: { from: isoFromEpochMs(windowStartMs), to: isoFromEpochMs(windowEndMs) },
    };

    for (const dir of DIRECTIONS) {
      const seen = new Set<string>();
      const events: FoundEvent[] = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        // event_v2 window semantics: `start_time` is "Start Time Before" (the
        // upper bound), `end_time` is "End Time After" (the lower bound).
        const found = await ctx.step(`${dir.direction}-search-${i}`, async () =>
          sdk.runAction({
            appKey: GCAL_APP_KEY,
            actionType: "search",
            actionKey: "event_v2",
            connection: dir.sourceConnection,
            inputs: {
              calendarid: dir.sourceCalendar,
              expand_recurring: true,
              ordering: "startTime",
              start_time: isoFromEpochMs(chunk.beforeMs),
              end_time: isoFromEpochMs(chunk.afterMs),
              _zap_search_success_on_miss: true,
            },
          }),
        );
        for (const raw of ((found as { data?: unknown[] }).data ?? [])) {
          const parsed = FoundEventSchema.safeParse(raw);
          if (!parsed.success) continue;
          const id = firstString(parsed.data.id);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          events.push(parsed.data);
        }
      }

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
        const mirrorGuard = await ctx.step(`${dir.direction}-${eventId}-guard`, async () =>
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
        if (hasRow((mirrorGuard as { data?: unknown }).data)) {
          skipped["created-by-sync"] = (skipped["created-by-sync"] ?? 0) + 1;
          continue;
        }

        const lookup = await ctx.step(`${dir.direction}-${eventId}-lookup`, async () =>
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
              lookup_value_2: dir.direction,
              _zap_search_multiple_results: "first",
              _zap_search_success_on_miss: true,
            },
          }),
        );
        const row = hasRow((lookup as { data?: unknown }).data);
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

        const made = await ctx.step(`${dir.direction}-${eventId}-create`, async () =>
          sdk.runAction({
            appKey: GCAL_APP_KEY,
            actionType: "write",
            actionKey: "detailed_event",
            connection: dir.destConnection,
            inputs: mirrorInputs,
          }),
        );
        const mirrorEventId = firstString((made as { data?: Array<{ id?: unknown }> }).data?.[0]?.id);
        if (!mirrorEventId) {
          throw new Error(`detailed_event returned no event id for ${eventId} — refusing to record a bad mapping`);
        }

        await ctx.step(`${dir.direction}-${eventId}-record`, async () =>
          sdk.runAction({
            appKey: "TableCLIAPI",
            actionType: "write",
            actionKey: "create_record",
            inputs: {
              table_id: SYNC_MAP_TABLE,
              new__data__f1: eventId,
              new__data__f2: mirrorEventId,
              new__data__f3: dir.direction,
              new__data__f4: "active",
              new__data__f5: startDateTime,
              new__data__f6: endDateTime,
              new__data__f7: sourceSummary,
              ...(updatedAt ? { new__data__f8: updatedAt } : {}),
            },
          }),
        );
        created.push({ eventId, start: startDateTime, summary: dir.mode === "busy" ? "Busy" : sourceSummary });
      }

      console.log(
        `${dir.direction}: ${events.length} events in window, ${created.length} ${dryRun ? "would be " : ""}mirrored, ${alreadyMapped.length} already mapped`,
      );
      summary[dir.direction] = {
        eventsInWindow: events.length,
        created,
        alreadyMapped: alreadyMapped.length,
        skipped,
      };
    }

    // One-off cutover cleanup, manual runs only: delete the frozen Notion
    // Calendar blocker events on the SCW calendar inside the window. They are
    // identified by Notion Calendar's own description text AND being
    // self-organized, so nothing hand-made or meeting-shaped can match.
    if (cleanupNotionBlocks) {
      const deleted: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const found = await ctx.step(`cleanup-search-${i}`, async () =>
          sdk.runAction({
            appKey: GCAL_APP_KEY,
            actionType: "search",
            actionKey: "event_v2",
            connection: SCW_CONNECTION,
            inputs: {
              calendarid: SCW_CALENDAR,
              expand_recurring: true,
              ordering: "startTime",
              start_time: isoFromEpochMs(chunk.beforeMs),
              end_time: isoFromEpochMs(chunk.afterMs),
              _zap_search_success_on_miss: true,
            },
          }),
        );
        for (const raw of ((found as { data?: unknown[] }).data ?? [])) {
          const parsed = FoundEventSchema.safeParse(raw);
          if (!parsed.success) continue;
          const id = firstString(parsed.data.id);
          const description = firstString(parsed.data.description) ?? "";
          if (!id || deleted.includes(id)) continue;
          if (!description.includes("Event blocked with")) continue;
          if (parsed.data.organizer?.self !== true) continue;
          if (!dryRun) {
            await ctx.step(`cleanup-${id}-delete`, async () =>
              sdk.runAction({
                appKey: GCAL_APP_KEY,
                actionType: "write",
                actionKey: "delete_event",
                connection: SCW_CONNECTION,
                inputs: { calendarid: SCW_CALENDAR, eventid: id, send_notifications: false },
              }),
            );
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
