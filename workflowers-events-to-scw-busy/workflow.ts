// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/workflowers-events-to-scw-busy
//
// One half of the two-way calendar-blocking pair (the other half is
// scw-events-to-workflowers-block; gcal-block-sweep is the shared horizon
// backstop). Triggers on `event_updated` for dennis@work.flowers and mirrors
// each timed, busy, accepted-or-tentative occurrence onto the
// dchiuten@securecodewarrior.com calendar as a PRIVATE, BARE "Busy" BLOCK —
// no title, description, location or attendees leak to the SCW workspace.
// Updates move the block; cancellations delete it. A whole-series edit
// arrives as one series master and is expanded to the occurrences inside
// the 30-day horizon (see mirrorSeries). The GCal Sync Map table is
// both the loop guard and the update/delete target map. Replaces Notion
// Calendar's built-in event blocking, which SCW's IT has cut off.
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
// The work.flowers Google credential lives on the TRIGGER; the SCW credential
// is bound here because this workflow writes to the SCW calendar.
const GCAL_APP_KEY = "GoogleCalendarCLIAPI";
const DEST_CONNECTION = "gcal_scw";
const DEST_CALENDAR = "dchiuten@securecodewarrior.com";
const DIRECTION = "wf_to_scw";

/**
 * `GCal Sync Map` — source occurrence id -> mirror event id, shared with
 * scw-events-to-workflowers-block and gcal-block-sweep. Table ops are free, so
 * every loop-guard and change-detection read goes through here rather than a
 * task-consuming calendar search.
 *
 * Columns: `Source Event ID` (f1) · `Mirror Event ID` (f2) · `Direction` (f3)
 * · `Status` (f4, active|deleted) · `Start` (f5) · `End` (f6) · `Summary` (f7,
 * the SOURCE title, stored for debugging — the mirror itself is always "Busy")
 * · `Source Updated` (f8).
 *
 * f1 is the Google **occurrence** id (`<seriesId>_<originalStartUTC>` for a
 * recurring instance) — never the series-wide iCalUID.
 */
const SYNC_MAP_TABLE = "01M13QPJ5GRJV33096MBNSN1Q5";

/**
 * Loop-guard marker carried by every mirror scw-events-to-workflowers-block
 * creates on THIS workflow's trigger calendar. Any event whose description
 * contains it is the sync's own output and must never be mirrored back.
 * (This workflow's own mirrors on SCW are bare "Busy" blocks with no
 * description — Dennis's choice — so the reverse direction's belts are its
 * "Busy" summary check plus the table.)
 */
const SYNC_MARKER = "[gcal-block]";

/**
 * Mirror only occurrences starting within this window. A series edit is
 * expanded only this far ahead (see "Series expansion" below), and a one-off
 * event or edited occurrence further out is left for gcal-block-sweep, which
 * mirrors occurrences as they roll into the window. Keep in lockstep with the
 * sweep's default window.
 */
const HORIZON_DAYS = 30;
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
    recurrence: z.array(z.string()).optional().nullable(),
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

// --- One occurrence --------------------------------------------------------------

/** Step id for one occurrence: bare for a single delivered event, prefixed per occurrence when a series is expanded. */
function stepId(stepPrefix: string, name: string): string {
  return stepPrefix ? `${stepPrefix}-${name}` : name;
}

/**
 * Mirror ONE occurrence (a one-off event, an individually edited occurrence,
 * or one occurrence of an expanded series). `stepPrefix` keeps step ids unique
 * when a series expansion calls this once per occurrence; it lives in a helper
 * because the publish-time analyzer rejects a computed step id in the workflow
 * body. `horizonClockMs` overrides the horizon guard's clock with the series
 * edit's own `updated`, since an untouched occurrence can carry an older one.
 */
async function mirrorOccurrence(
  ctx: DurableContext,
  stepPrefix: string,
  event: Input,
  horizonClockMs: number | null,
): Promise<Record<string, unknown>> {
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

  // Loop guard (content): anything on the work.flowers calendar carrying the
  // sync marker is scw-events-to-workflowers-block's own output; anything
  // still carrying Notion Calendar's blocker description is a legacy block.
  // Neither is a real work.flowers commitment to mirror.
  if (description && (description.includes(SYNC_MARKER) || description.includes("Event blocked with"))) {
    return { skipped: "sync-artifact-not-mirrored", eventId };
  }

  // Loop guard (table): anything the sync itself created, in either
  // direction, has its event id recorded as a Mirror Event ID. Catches the
  // sparse cancelled tombstone of a mirror too, which carries no
  // summary/description for the guard above. Free.
  const mirrorGuard = await ctx.step(stepId(stepPrefix, "guard-created-by-sync"), async () =>
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
  const lookup = await ctx.step(stepId(stepPrefix, "find-mapping-row"), async () =>
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
  // or declined by Dennis after previously being mirrored. An invite Dennis
  // has not answered yet (needsAction) is not mirrored either; only accepted
  // and tentative ("maybe") invites block time. An event with no self
  // attendee (his own event, no guests) has no RSVP and is mirrored.
  const selfStatus = firstString(
    (event.attendees ?? []).find((a) => a?.self === true)?.responseStatus,
  );
  const selfDeclined = selfStatus === "declined";
  const selfUnanswered = selfStatus === "needsAction";
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
          : selfUnanswered
            ? "unanswered-by-self"
            : null;

  if (skipReason) {
    if (!activeMirrorId) {
      return { skipped: skipReason, eventId };
    }
    await ctx.step(stepId(stepPrefix, "delete-mirror"), async () => {
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
    await ctx.step(stepId(stepPrefix, "mark-row-deleted"), async () =>
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
  const updatedMs = horizonClockMs ?? epochMsFromRfc3339(updatedAt);
  if (!activeMirrorId && startMs !== null && updatedMs !== null && startMs - updatedMs > HORIZON_MS) {
    console.log(`occurrence starts ${Math.round((startMs - updatedMs) / 86400000)}d out — beyond the ${HORIZON_DAYS}d horizon; gcal-block-sweep will mirror it later`);
    return { skipped: "beyond-horizon", eventId, start: startDateTime };
  }

  // What the SCW calendar sees: a bare private Busy block. The SOURCE title
  // goes only into the table (f7), for Dennis's own debugging.
  const sourceSummary = summary ?? "(no title)";

  // Change guard: `event_updated` fires on every touch (someone else's RSVP,
  // a description tweak). The mirror carries no title or details, so only a
  // moved occurrence is worth the update task.
  if (
    activeMirrorId &&
    sameInstant(startDateTime, row!.start) &&
    sameInstant(endDateTime, row!.end)
  ) {
    return { skipped: "unchanged", eventId, mirrorEventId: activeMirrorId };
  }

  if (activeMirrorId) {
    // The one task an update run spends: move the block. Nothing else about
    // it may change, so times are the only fields sent. A hand-deleted
    // mirror falls through to recreation below instead of spinning retries.
    const update = await ctx.step(stepId(stepPrefix, "update-mirror"), async () => {
      try {
        return await sdk.runAction({
          appKey: GCAL_APP_KEY,
          actionType: "write",
          actionKey: "update_event",
          connection: DEST_CONNECTION,
          inputs: {
            calendarid: DEST_CALENDAR,
            eventid: activeMirrorId,
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
      await ctx.step(stepId(stepPrefix, "refresh-mapping-row"), async () =>
        sdk.runAction({
          appKey: "TableCLIAPI",
          actionType: "write",
          actionKey: "update_record",
          inputs: {
            table_id: SYNC_MAP_TABLE,
            record_id: row!.recordId,
            new__data__f5: startDateTime,
            new__data__f6: endDateTime,
            new__data__f7: sourceSummary,
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

  // Create the Busy block (also the recreate path for a hand-deleted mirror
  // and the revive path for a row previously marked deleted). No
  // description, location or attendees — nothing from the work.flowers
  // event leaks except the time span.
  const created = await ctx.step(stepId(stepPrefix, "create-mirror"), async () =>
    sdk.runAction({
      appKey: GCAL_APP_KEY,
      actionType: "write",
      actionKey: "detailed_event",
      connection: DEST_CONNECTION,
      inputs: {
        calendarid: DEST_CALENDAR,
        summary: "Busy",
        start__dateTime: startDateTime,
        end__dateTime: endDateTime,
        transparency: "opaque",
        visibility: "private",
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
    await ctx.step(stepId(stepPrefix, "revive-mapping-row"), async () =>
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
          new__data__f7: sourceSummary,
          ...(updatedAt ? { new__data__f8: updatedAt } : {}),
        },
      }),
    );
  } else {
    await ctx.step(stepId(stepPrefix, "create-mapping-row"), async () =>
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
          new__data__f7: sourceSummary,
          ...(updatedAt ? { new__data__f8: updatedAt } : {}),
        },
      }),
    );
  }

  return {
    created: true,
    eventId,
    mirrorEventId,
    start: startDateTime,
    end: endDateTime,
  };
}

// --- Series expansion ------------------------------------------------------------
// The trigger runs with `expand_recurring: false` (since 2026-10-31). With it
// on, every edit to a recurring series re-delivered EVERY expanded occurrence
// years ahead once Zapier fixed W6ZE93-VMEWP — one edit to a daily standup was
// thousands of runs, and on 2026-10-30 that burst exhausted the account's
// daily compute-spend limit, so every Zap in the account was refused until
// 00:00 UTC. Now a series edit arrives as ONE run carrying the series master
// (a `recurrence` array, no `recurringEventId`), and this workflow fetches
// only that series' occurrences inside the horizon. One-off events and
// individually edited occurrences (`<seriesId>_<startUTC>`, with
// `recurringEventId`) still arrive one by one and go straight to
// mirrorOccurrence.

/**
 * Dennis rolls off the SCW engagement at the end of 2026, and the sync with
 * it, so a series is never expanded past this instant. After it, a series edit
 * is a no-op.
 */
const ENGAGEMENT_END_MS = epochMsFromRfc3339("2027-01-01T00:00:00+08:00")!;

/** The calendar this workflow reads, and the alias that can read it (for the occurrence fetch). */
const SOURCE_CONNECTION = "gcal_wf";
const SOURCE_CALENDAR = "dennis@work.flowers";

const DAY_MS = 86400000;

/** Inverse of daysFromCivil (Hinnant's civil-from-days), same as gcal-block-sweep. */
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

/** A live series master: carries a recurrence rule and is not itself an occurrence. */
function isSeriesMaster(event: Input): boolean {
  return (
    Array.isArray(event.recurrence) &&
    event.recurrence.length > 0 &&
    !firstString(event.recurringEventId) &&
    firstString(event.status) !== "cancelled"
  );
}

/**
 * Expand a series master into its occurrences inside [edit time, edit time +
 * HORIZON_DAYS), capped at ENGAGEMENT_END_MS, and mirror each one. One Google
 * `events.instances` call through the source connection (1 task) replaces the
 * thousands of per-occurrence runs `expand_recurring: true` produced.
 */
async function mirrorSeries(ctx: DurableContext, event: Input): Promise<Record<string, unknown>> {
  const seriesId = firstString(event.id)!;
  const editedMs = epochMsFromRfc3339(firstString(event.updated));
  if (editedMs === null) {
    // No clock to bound the window by — a payload shape we do not understand.
    throw new Error(`series master ${seriesId} has no parseable \`updated\` — cannot bound the occurrence window`);
  }
  const fromMs = editedMs;
  const toMs = Math.min(editedMs + HORIZON_MS, ENGAGEMENT_END_MS);
  if (toMs <= fromMs) {
    return { skipped: "series-past-engagement-end", seriesId };
  }

  const fetched = await ctx.step("fetch-series-occurrences", async () => {
    const url =
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(SOURCE_CALENDAR)}` +
      `/events/${encodeURIComponent(seriesId)}/instances` +
      `?timeMin=${encodeURIComponent(isoFromEpochMs(fromMs))}&timeMax=${encodeURIComponent(isoFromEpochMs(toMs))}&maxResults=250`;
    const res = await sdk.fetch(url, { connection: SOURCE_CONNECTION });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`events.instances for ${seriesId} answered ${res.status}: ${text.slice(0, 300)}`);
    }
    const body = JSON.parse(text) as { items?: unknown[]; nextPageToken?: unknown };
    return { items: body.items ?? [], truncated: typeof body.nextPageToken === "string" };
  });
  if (fetched.truncated) {
    // 250 occurrences inside a 30-day window would be an every-few-hours
    // series; the sweep catches anything past the first page.
    console.log(`series ${seriesId}: more than 250 occurrences in the window — mirroring the first page only`);
  }

  const outcomes: Record<string, number> = {};
  for (let i = 0; i < fetched.items.length; i++) {
    const occurrence = InputSchema.safeParse(fetched.items[i]);
    if (!occurrence.success) {
      throw new Error(`events.instances item ${i} for ${seriesId} did not parse: ${occurrence.error.message}`);
    }
    const result = await mirrorOccurrence(ctx, `occ-${i}`, occurrence.data, editedMs);
    const outcome =
      typeof result.skipped === "string" ? `skipped:${result.skipped}` :
      typeof result.unmirrored === "string" ? `unmirrored:${result.unmirrored}` :
      result.created ? "created" : result.updated ? "updated" : "other";
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }
  console.log(`series ${seriesId}: ${fetched.items.length} occurrences in ${isoFromEpochMs(fromMs)}..${isoFromEpochMs(toMs)} — ${JSON.stringify(outcomes)}`);
  return {
    series: seriesId,
    window: { from: isoFromEpochMs(fromMs), to: isoFromEpochMs(toMs) },
    occurrences: fetched.items.length,
    outcomes,
  };
}

// --- Workflow --------------------------------------------------------------------

// The name MUST be a string literal here: Zapier's publish-time analyzer
// (`missing-run-function`) cannot see the handler when the first argument is
// an identifier, and refuses the publish.
const workflow = defineDurable<Input, unknown>(
  "workflowers-events-to-scw-busy",
  async (ctx: DurableContext, rawInput: Input) => {
    const event = InputSchema.parse(normalizeInput(rawInput));

    // A whole-series edit: expand only the occurrences inside the horizon.
    if (firstString(event.id) && isSeriesMaster(event)) {
      return mirrorSeries(ctx, event);
    }
    return mirrorOccurrence(ctx, "", event, null);
  },
);

export default workflow;
