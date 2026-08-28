// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/scw-events-to-workflowers-block
//
// One half of the two-way calendar-blocking pair (the other half is
// workflowers-events-to-scw-busy; gcal-block-sweep is the shared horizon
// backstop). Triggers on `event_updated` for dchiuten@securecodewarrior.com
// and mirrors each timed, busy, non-declined occurrence onto the
// dennis@work.flowers calendar WITH ITS FULL TITLE, so SCW meetings block
// work.flowers time visibly. Updates move/rename the mirror; cancellations
// delete it. The GCal Sync Map table is both the loop guard and the
// update/delete target map.
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
// The SCW Google credential lives on the TRIGGER; the work.flowers credential
// is bound here because this workflow writes to the work.flowers calendar.
const GCAL_APP_KEY = "GoogleCalendarCLIAPI";
const DEST_CONNECTION = "gcal_wf";
const DEST_CALENDAR = "dennis@work.flowers";
const SOURCE_CALENDAR = "dchiuten@securecodewarrior.com";
const DIRECTION = "scw_to_wf";
const WORKFLOW_NAME = "scw-events-to-workflowers-block";

/**
 * `GCal Sync Map` — source occurrence id -> mirror event id, shared with
 * workflowers-events-to-scw-busy and gcal-block-sweep. Table ops are free, so
 * every loop-guard and change-detection read goes through here rather than a
 * task-consuming calendar search.
 *
 * Columns: `Source Event ID` (f1) · `Mirror Event ID` (f2) · `Direction` (f3)
 * · `Status` (f4, active|deleted) · `Start` (f5) · `End` (f6) · `Summary` (f7)
 * · `Source Updated` (f8).
 *
 * f1 is the Google **occurrence** id (`<seriesId>_<originalStartUTC>` for a
 * recurring instance) — never the series-wide iCalUID.
 */
const SYNC_MAP_TABLE = "01M13QPJ5GRJV33096MBNSN1Q5";

/**
 * Loop-guard marker embedded in every mirror this workflow creates on the
 * work.flowers calendar. workflowers-events-to-scw-busy skips any event whose
 * description contains it. (Mirrors in the other direction are bare "Busy"
 * blocks with no description — Dennis's choice — so that direction's belt is
 * the summary check below plus the table.)
 */
const SYNC_MARKER = "[gcal-block]";

/**
 * Mirror only occurrences starting within this window. `expand_recurring:
 * true` expands an open-ended weekly series ~14 years out (730 instances in
 * one observed poll), so an unguarded create path would burn ~700 tasks on a
 * single series. Occurrences rolling into the window later are picked up by
 * gcal-block-sweep. Keep in lockstep with the sweep's default window.
 */
const HORIZON_DAYS = 60;
const HORIZON_MS = HORIZON_DAYS * 86400000;

// --- Input -------------------------------------------------------------------
// The `event_updated` payload is the raw Google event resource. `start`/`end`
// carry `dateTime` for a timed event and `date` for an all-day one. A
// cancelled occurrence arrives as a sparse tombstone: `status: "cancelled"`,
// usually no summary/description/start.

const EventTimeSchema = z
  .object({
    dateTime: z.string().optional().nullable(),
    date: z.string().optional().nullable(),
    timeZone: z.string().optional().nullable(),
  })
  .partial()
  .passthrough();

const AttendeeSchema = z
  .object({
    email: z.string().optional().nullable(),
    self: z.boolean().optional().nullable(),
    responseStatus: z.string().optional().nullable(),
  })
  .partial()
  .passthrough();

const InputSchema = z
  .object({
    id: z.string().optional().nullable(),
    status: z.string().optional().nullable(),
    summary: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
    transparency: z.string().optional().nullable(),
    updated: z.string().optional().nullable(),
    recurringEventId: z.string().optional().nullable(),
    start: EventTimeSchema.optional().nullable(),
    end: EventTimeSchema.optional().nullable(),
    attendees: z.array(AttendeeSchema).optional().nullable(),
  })
  .passthrough();

type Input = z.infer<typeof InputSchema>;

/** `run-durable` hands manual input through as a JSON string. */
function normalizeInput(rawInput: unknown): unknown {
  if (typeof rawInput === "string") return JSON.parse(rawInput);
  return rawInput;
}

// --- Deterministic time comparison --------------------------------------------
// `@zapier/zapier-durable` runs the body in GUARDED mode and its `Date` proxy
// asserts before reading arguments, so even `new Date(isoString)` throws.
// Integer maths only — same helpers as gcal-event-updated-to-meeting-note.

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

/**
 * Epoch milliseconds for an RFC 3339 timestamp, or null if it is not one.
 * Google emits local time plus offset (`2026-07-31T16:00:00+08:00`); Zapier
 * Tables normalises stored strings to `Z`. Both reduce to the same instant.
 */
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

/** True when both parse and land on the same instant. An unparseable side is "different". */
function sameInstant(a: unknown, b: unknown): boolean {
  const left = epochMsFromRfc3339(a);
  const right = epochMsFromRfc3339(b);
  if (left === null || right === null) return false;
  return left === right;
}

// --- Helpers -------------------------------------------------------------------

function firstString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

interface MappingRow {
  recordId: string;
  mirrorEventId: string | null;
  status: string | null;
  start: string | null;
  end: string | null;
  summary: string | null;
}

function extractRow(result: unknown): MappingRow | null {
  const rows = Array.isArray(result) ? result : [];
  const hit = rows[0] as
    | { record_id?: unknown; old?: { data?: Record<string, unknown> } }
    | undefined;
  if (!hit) return null;

  const recordId = firstString(hit.record_id);
  if (!recordId) return null;
  const data = hit.old?.data ?? {};
  return {
    recordId,
    mirrorEventId: firstString(data.f2),
    status: firstString(data.f4),
    start: firstString(data.f5),
    end: firstString(data.f6),
    summary: firstString(data.f7),
  };
}

/** Google's error text when the mirror event was hand-deleted out from under us. */
const MIRROR_GONE_PATTERN = /not\s*found|has been deleted|410|404/i;

// --- Workflow --------------------------------------------------------------------

const workflow = defineDurable<Input, unknown>(
  WORKFLOW_NAME,
  async (ctx: DurableContext, rawInput: Input) => {
    const event = InputSchema.parse(normalizeInput(rawInput));

    const eventId = firstString(event.id);
    if (!eventId) {
      console.log("payload has no event id — nothing to mirror");
      return { skipped: "no-event-id" };
    }

    const summary = firstString(event.summary);
    const description = firstString(event.description);
    const startDateTime = firstString(event.start?.dateTime);
    const endDateTime = firstString(event.end?.dateTime);
    const updatedAt = firstString(event.updated);
    const cancelled = firstString(event.status) === "cancelled";

    // Loop guard (content): a bare "Busy" block on the SCW calendar is either
    // our own wf->scw mirror or a legacy Notion Calendar block — never mirror
    // it back. Same for anything still carrying Notion Calendar's blocker
    // description ("Event blocked with <a ...>Notion Calendar</a>").
    if (!cancelled && summary === "Busy") {
      return { skipped: "busy-block-not-mirrored", eventId };
    }
    if (description && (description.includes(SYNC_MARKER) || description.includes("Event blocked with"))) {
      return { skipped: "sync-artifact-not-mirrored", eventId };
    }

    // Loop guard (table): anything the sync itself created, in either
    // direction, has its event id recorded as a Mirror Event ID. Catches the
    // sparse cancelled tombstone of a mirror too, which carries no
    // summary/description for the guards above. Free.
    const mirrorGuard = await ctx.step("guard-created-by-sync", async () =>
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
    if (extractRow((mirrorGuard as { data?: unknown }).data)) {
      return { skipped: "created-by-sync", eventId };
    }

    // The mapping row for this source occurrence, if the sync has seen it before.
    const lookup = await ctx.step("find-mapping-row", async () =>
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
          lookup_value_2: DIRECTION,
          _zap_search_multiple_results: "first",
          _zap_search_success_on_miss: true,
        },
      }),
    );
    const row = extractRow((lookup as { data?: unknown }).data);
    const activeMirrorId = row && row.status === "active" ? row.mirrorEventId : null;

    // Delete the mirror when the source is gone or stops deserving a block:
    // cancelled, turned all-day (start.date instead of dateTime), marked Free,
    // or declined by Dennis after previously being mirrored.
    const selfDeclined = (event.attendees ?? []).some(
      (a) => a?.self === true && firstString(a.responseStatus) === "declined",
    );
    const transparent = firstString(event.transparency) === "transparent";
    const notTimed = !startDateTime || !endDateTime;
    const skipReason = cancelled
      ? "event-cancelled"
      : notTimed
        ? "not-a-timed-event"
        : transparent
          ? "event-is-free"
          : selfDeclined
            ? "declined-by-self"
            : null;

    if (skipReason) {
      if (!activeMirrorId) {
        return { skipped: skipReason, eventId };
      }
      await ctx.step("delete-mirror", async () => {
        try {
          return await sdk.runAction({
            appKey: GCAL_APP_KEY,
            actionType: "write",
            actionKey: "delete_event",
            connection: DEST_CONNECTION,
            inputs: {
              calendarid: DEST_CALENDAR,
              eventid: activeMirrorId,
              send_notifications: false,
            },
          });
        } catch (error) {
          // Already gone is the outcome we wanted; anything else retries.
          const message = error instanceof Error ? error.message : String(error);
          if (MIRROR_GONE_PATTERN.test(message)) return { alreadyGone: true };
          throw error;
        }
      });
      await ctx.step("mark-row-deleted", async () =>
        sdk.runAction({
          appKey: "TableCLIAPI",
          actionType: "write",
          actionKey: "update_record",
          inputs: {
            table_id: SYNC_MAP_TABLE,
            record_id: row!.recordId,
            new__data__f4: "deleted",
            ...(updatedAt ? { new__data__f8: updatedAt } : {}),
          },
        }),
      );
      return { unmirrored: skipReason, eventId, mirrorEventId: activeMirrorId };
    }

    // Horizon guard: never CREATE a mirror for an occurrence starting more
    // than HORIZON_DAYS after the edit that delivered it (`updated` is the
    // freshest clock the payload carries; a run happens within minutes of it).
    // An occurrence that already HAS a mirror is updated regardless, so a
    // reschedule past the horizon keeps its block accurate.
    const startMs = epochMsFromRfc3339(startDateTime);
    const updatedMs = epochMsFromRfc3339(updatedAt);
    if (!activeMirrorId && startMs !== null && updatedMs !== null && startMs - updatedMs > HORIZON_MS) {
      console.log(`occurrence starts ${Math.round((startMs - updatedMs) / 86400000)}d out — beyond the ${HORIZON_DAYS}d horizon; gcal-block-sweep will mirror it later`);
      return { skipped: "beyond-horizon", eventId, start: startDateTime };
    }

    const mirrorSummary = summary ?? "(no title)";
    const mirrorDescription = `${SYNC_MARKER} source:${eventId}\nMirrored from ${SOURCE_CALENDAR} by ${WORKFLOW_NAME}. Edits here will be overwritten.`;

    // Change guard: `event_updated` fires on every touch (someone else's RSVP,
    // a description tweak, Gemini attaching notes). Only a moved or renamed
    // occurrence is worth the update task.
    if (
      activeMirrorId &&
      sameInstant(startDateTime, row!.start) &&
      sameInstant(endDateTime, row!.end) &&
      mirrorSummary === row!.summary
    ) {
      return { skipped: "unchanged", eventId, mirrorEventId: activeMirrorId };
    }

    if (activeMirrorId) {
      // The one task an update run spends. A hand-deleted mirror falls
      // through to recreation below instead of spinning the retry loop.
      const update = await ctx.step("update-mirror", async () => {
        try {
          return await sdk.runAction({
            appKey: GCAL_APP_KEY,
            actionType: "write",
            actionKey: "update_event",
            connection: DEST_CONNECTION,
            inputs: {
              calendarid: DEST_CALENDAR,
              eventid: activeMirrorId,
              summary: mirrorSummary,
              description: mirrorDescription,
              start__dateTime: startDateTime,
              end__dateTime: endDateTime,
              send_notifications: false,
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (MIRROR_GONE_PATTERN.test(message)) return { mirrorGone: true };
          throw error;
        }
      });

      if (!(update as { mirrorGone?: boolean })?.mirrorGone) {
        await ctx.step("refresh-mapping-row", async () =>
          sdk.runAction({
            appKey: "TableCLIAPI",
            actionType: "write",
            actionKey: "update_record",
            inputs: {
              table_id: SYNC_MAP_TABLE,
              record_id: row!.recordId,
              new__data__f5: startDateTime,
              new__data__f6: endDateTime,
              new__data__f7: mirrorSummary,
              ...(updatedAt ? { new__data__f8: updatedAt } : {}),
            },
          }),
        );
        return {
          updated: true,
          eventId,
          mirrorEventId: activeMirrorId,
          start: startDateTime,
          end: endDateTime,
        };
      }
      console.log(`mirror ${activeMirrorId} was deleted by hand — recreating`);
    }

    // Create the mirror (also the recreate path for a hand-deleted mirror and
    // the revive path for a row previously marked deleted).
    const created = await ctx.step("create-mirror", async () =>
      sdk.runAction({
        appKey: GCAL_APP_KEY,
        actionType: "write",
        actionKey: "detailed_event",
        connection: DEST_CONNECTION,
        inputs: {
          calendarid: DEST_CALENDAR,
          summary: mirrorSummary,
          description: mirrorDescription,
          start__dateTime: startDateTime,
          end__dateTime: endDateTime,
          transparency: "opaque",
          visibility: "default",
          all_day: false,
          reminders__useDefault: false,
        },
      }),
    );
    const mirrorEventId = firstString(
      (created as { data?: Array<{ id?: unknown }> }).data?.[0]?.id,
    );
    if (!mirrorEventId) {
      throw new Error("detailed_event returned no event id — mirror state unknown, refusing to record a bad mapping");
    }

    if (row) {
      await ctx.step("revive-mapping-row", async () =>
        sdk.runAction({
          appKey: "TableCLIAPI",
          actionType: "write",
          actionKey: "update_record",
          inputs: {
            table_id: SYNC_MAP_TABLE,
            record_id: row.recordId,
            new__data__f2: mirrorEventId,
            new__data__f4: "active",
            new__data__f5: startDateTime,
            new__data__f6: endDateTime,
            new__data__f7: mirrorSummary,
            ...(updatedAt ? { new__data__f8: updatedAt } : {}),
          },
        }),
      );
    } else {
      await ctx.step("create-mapping-row", async () =>
        sdk.runAction({
          appKey: "TableCLIAPI",
          actionType: "write",
          actionKey: "create_record",
          inputs: {
            table_id: SYNC_MAP_TABLE,
            new__data__f1: eventId,
            new__data__f2: mirrorEventId,
            new__data__f3: DIRECTION,
            new__data__f4: "active",
            new__data__f5: startDateTime,
            new__data__f6: endDateTime,
            new__data__f7: mirrorSummary,
            ...(updatedAt ? { new__data__f8: updatedAt } : {}),
          },
        }),
      );
    }

    return {
      created: true,
      eventId,
      mirrorEventId,
      summary: mirrorSummary,
      start: startDateTime,
      end: endDateTime,
    };
  },
);

export default workflow;
