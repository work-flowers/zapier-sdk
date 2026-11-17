// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/gcal-meetings-to-meeting-notes
//
// Pre-creates a Notion full-page meeting note, linked to its Google Calendar
// event, for every upcoming meeting on Dennis's work calendar. One source, two
// deployments (see zap.json):
//
//   - TRIGGER (Google Calendar "New Event"): notes a new one-off meeting as soon
//     as it is created, however far ahead; for a new recurring series, notes
//     only its first SERIES_FIRST_INSTANCES occurrences. See handleNewEvent.
//   - SWEEP (daily schedule): everything below. It is what eventually notes
//     every later occurrence of a series, one horizon-day at a time.
//
// The SWEEP reads the next HORIZON_DAYS of the primary calendar with
// recurring events expanded (one search task), keeps the events that are
// meetings (see classifySkip), drops any occurrence that already has a row in
// `[Table] Meeting Note IDs` (free), and for the rest calls Notion's
// `POST /v1/meeting_notes` with `calendar_event` (one task each). That endpoint
// is get-or-create: an event that already has a note gets it back
// (`created: false`) rather than a second one, so a retry, an overlap between
// runs or a note made by hand never duplicates. The note is filed and titled
// by Notion like the event's other notes. Each note's page id is then written
// to the Table, which is what makes the next run skip it for free.
//
// RECURRING SERIES: a series with no end date can only contribute the
// occurrences inside the HORIZON_DAYS window, because the search is bounded by
// time, so it can never fan out into years of notes. MAX_CREATES_PER_RUN is a
// second fence: past it the run stops creating and fails loudly, rather than
// quietly spending tasks on something unexpected (a mass import, a calendar
// shared by mistake). Occurrences beyond the cap are picked up by later runs,
// soonest first.
//
// AUTH: the meeting-notes endpoints accept only a personal access token or a
// Worker. Zapier's Notion connection is refused with 403 "This tool is not
// available to user_owned_guest_bot actors" (probed 2026-11-17 through API
// Request (Beta)), so the call goes through `sdk.fetch` on an *API by Zapier*
// connection that holds Dennis's PAT as a Bearer token. That keeps the token
// out of source; the notes are created as Dennis.
//
// Manual runs (`trigger-workflow`) take `now`, `from_days`, `to_days`,
// `max_creates` and `dryRun`; see the README.
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
const GCAL_APP_KEY = "GoogleCalendarCLIAPI";
const GCAL_CONNECTION = "gcal_wf";
/**
 * Google resolves `primary` to the connection's own calendar, so the source
 * needs no address. The Notion side does need the real calendar id; it is read
 * off the events themselves (see calendarIdFromEvents).
 */
const GCAL_CALENDAR = "primary";

const NOTION_PAT_CONNECTION = "notion_pat";
const NOTION_MEETING_NOTES_URL = "https://api.notion.com/v1/meeting_notes";
const NOTION_VERSION = "2026-03-11";
/**
 * Notion Calendar's id for the connected work Google account. It is Notion's
 * own id, not Google's: read it from `calendar.accountId` on any event that
 * Notion MCP's `notion-calendar-list-events` returns for that account.
 */
const NOTION_CALENDAR_ACCOUNT_ID = "9c2abc99-fa17-424f-8b9f-e427591bc44e";

/**
 * Shared with the meeting-note-db-updates Worker (which upserts a row for
 * every note it enriches), gcal-event-updated-to-meeting-note (which looks
 * notes up here on a reschedule) and notion-page-deleted-to-zapier-tables
 * (which flags a deleted note's row Archived). `Event ID` (f3) is the Google
 * OCCURRENCE id, never the iCalUID; see gcal-event-updated-to-meeting-note's
 * README for why that invariant matters.
 */
const MEETING_NOTE_IDS_TABLE = "01JZCVG73MBWWB0357CEPS4903";
const FIELD_PAGE_ID = "data__f2";
const FIELD_EVENT_ID = "data__f3";

/** Marker the calendar-blocking Zaps put on events mirrored from the SCW calendar. */
const MIRROR_MARKER = "[gcal-block]";

const DAY_MS = 86400000;
/** How far ahead notes are created. A series with no end date contributes at most this window. */
const HORIZON_DAYS = 7;
/** Hard ceiling on notes created in one run; past it the run fails loudly. */
const MAX_CREATES_PER_RUN = 40;
/**
 * The search returns at most one page. Ordered by start time, a truncated page
 * drops the far end of the window, which later runs reach, so it is logged
 * rather than fatal.
 */
const SEARCH_PAGE_WARN = 100;
/** A new recurring series gets notes for this many upcoming occurrences; the sweep does the rest. */
const SERIES_FIRST_INSTANCES = 3;
/** How far the trigger path searches to expand a new series into occurrences. */
const SERIES_SEARCH_DAYS = 31;

// --- Input -------------------------------------------------------------------
// On a scheduled run the payload is Schedule by Zapier's tick, whose `id` IS
// the fire time as an RFC 3339 timestamp: the deterministic "now".

const InputSchema = z
  .object({
    id: z.string().optional().nullable(),
    now: z.string().optional().nullable(),
    from_days: z.number().optional().nullable(),
    to_days: z.number().optional().nullable(),
    max_creates: z.number().optional().nullable(),
    dryRun: z.boolean().optional().nullable(),
    event_id: z.string().optional().nullable(),
  })
  .passthrough();

type Input = z.infer<typeof InputSchema>;

/** `run-durable` hands manual input through as a JSON string. */
function normalizeInput(rawInput: unknown): unknown {
  if (typeof rawInput === "string") return rawInput.trim() === "" ? {} : JSON.parse(rawInput);
  return rawInput ?? {};
}

// --- Deterministic time maths ------------------------------------------------
// No `new Date` in the body: the durable runtime's Date guard throws whatever
// the arguments. Same helpers as gcal-block-sweep.

function daysFromCivil(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

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

function isoFromEpochMs(epochMs: number): string {
  const days = Math.floor(epochMs / DAY_MS);
  const msOfDay = epochMs - days * DAY_MS;
  const { y, m, d } = civilFromDays(days);
  const hour = Math.floor(msOfDay / 3600000);
  const minute = Math.floor((msOfDay % 3600000) / 60000);
  const second = Math.floor((msOfDay % 60000) / 1000);
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}T${pad(hour)}:${pad(minute)}:${pad(second)}Z`;
}

function epochMsFromRfc3339(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|z|[+-]\d{2}:?\d{2})?$/.exec(
      value.trim(),
    );
  if (!m) return null;
  const [, ys, mos, ds, hs, mins, ss, frac, offset] = m;
  const month = Number(mos);
  const day = Number(ds);
  const hour = Number(hs);
  const minute = Number(mins);
  const second = ss ? Number(ss) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 60) return null;
  const ms = frac ? Number(frac.padEnd(3, "0").slice(0, 3)) : 0;
  let epoch = daysFromCivil(Number(ys), month, day) * DAY_MS + hour * 3600000 + minute * 60000 + second * 1000 + ms;
  if (offset && offset !== "Z" && offset !== "z") {
    const sign = offset[0] === "-" ? -1 : 1;
    const body = offset.slice(1).replace(":", "");
    epoch -= sign * (Number(body.slice(0, 2)) * 60 + Number(body.slice(2, 4))) * 60000;
  }
  return epoch;
}

// --- Events ------------------------------------------------------------------

function firstString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

const PersonSchema = z
  .object({
    email: z.string().optional().nullable(),
    self: z.boolean().optional().nullable(),
    resource: z.boolean().optional().nullable(),
    responseStatus: z.string().optional().nullable(),
  })
  .partial()
  .passthrough();

const EventTimeSchema = z
  .object({ dateTime: z.string().optional().nullable(), date: z.string().optional().nullable() })
  .partial()
  .passthrough();

const FoundEventSchema = z
  .object({
    id: z.string().optional().nullable(),
    iCalUID: z.string().optional().nullable(),
    recurringEventId: z.string().optional().nullable(),
    recurrence: z.array(z.string()).optional().nullable(),
    status: z.string().optional().nullable(),
    eventType: z.string().optional().nullable(),
    summary: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
    transparency: z.string().optional().nullable(),
    start: EventTimeSchema.optional().nullable(),
    end: EventTimeSchema.optional().nullable(),
    attendees: z.array(PersonSchema).optional().nullable(),
    organizer: PersonSchema.optional().nullable(),
    creator: PersonSchema.optional().nullable(),
  })
  .passthrough();

export type FoundEvent = z.infer<typeof FoundEventSchema>;

/**
 * Why an event gets no meeting note, or null when it should get one.
 *
 * A meeting is a timed, confirmed, busy event Dennis has not declined or left
 * unanswered, that either has at least one other (non-room) guest or is a
 * client meeting mirrored from the SCW calendar. Mirrors carry no guests (the
 * mirror is a bare copy), but they are real meetings and already got notes by
 * hand before this Zap. Solo blocks, webinars Dennis is the only listed guest
 * of, focus time, working location and out-of-office entries are not.
 */
export function classifySkip(event: FoundEvent): string | null {
  if (firstString(event.status) === "cancelled") return "cancelled";
  const type = firstString(event.eventType) ?? "default";
  if (type !== "default") return `event-type-${type}`;
  if (!firstString(event.start?.dateTime) || !firstString(event.end?.dateTime)) return "not-timed";
  if (firstString(event.transparency) === "transparent") return "free";

  const attendees = event.attendees ?? [];
  const selfStatus = firstString(attendees.find((a) => a?.self === true)?.responseStatus);
  if (selfStatus === "declined") return "declined";
  if (selfStatus === "needsAction") return "unanswered";

  const isMirror = (firstString(event.description) ?? "").startsWith(MIRROR_MARKER);
  const others = attendees.filter((a) => a?.self !== true && a?.resource !== true);
  if (others.length === 0 && !isMirror) return "no-other-guests";
  return null;
}

/**
 * The primary calendar's id, which Notion needs as `calendar.calendar_id`. On
 * Google it equals the account's address, and every event on that calendar
 * names it: as the attendee marked `self`, or as the organizer or creator
 * marked `self` on an event Dennis made. Read it from the data rather than
 * hardcoding it.
 */
export function calendarIdFromEvents(events: FoundEvent[]): string | null {
  for (const event of events) {
    const candidates = [...(event.attendees ?? []), event.organizer, event.creator];
    for (const person of candidates) {
      const email = firstString(person?.email);
      if (person?.self === true && email && !email.endsWith("calendar.google.com")) return email;
    }
  }
  return null;
}

// --- Steps -------------------------------------------------------------------
// Every step whose id carries a loop variable lives in a helper that takes
// `ctx`: the publish-time analyzer rejects a template-literal step id in the
// workflow body (`invalid-step-call`) but does not follow `ctx` into a helper.

/** Free: whether the occurrence already has a meeting-note row with a page id. */
async function hasMeetingNoteRow(ctx: DurableContext, stepId: string, eventId: string): Promise<boolean> {
  const result = await ctx.step(stepId, async () =>
    sdk.runAction({
      appKey: "TableCLIAPI",
      actionType: "search",
      actionKey: "find_record",
      inputs: {
        table_id: MEETING_NOTE_IDS_TABLE,
        filter_count: "2",
        use_stored_order: false,
        field_data_key: FIELD_EVENT_ID,
        operator: "exact",
        lookup_value: eventId,
        field_data_key_2: FIELD_PAGE_ID,
        operator_2: "isnull",
        lookup_value_2: false,
        _zap_search_multiple_results: "first",
        _zap_search_success_on_miss: true,
      },
    }),
  );
  const rows = (result as { data?: unknown }).data;
  return Array.isArray(rows) && rows.some((r) => firstString((r as { record_id?: unknown })?.record_id));
}

interface MeetingNoteResult {
  pageId: string;
  created: boolean;
}

/**
 * One task: Notion's get-or-create for the event's meeting note. Safe to
 * retry: with `calendar_event` the call returns the event's existing note
 * instead of making another, so a retry after a lost response cannot
 * duplicate. The returned block id is the note's page id (verified
 * 2026-11-17: the same id the meeting-notes query lists as the page).
 */
async function getOrCreateMeetingNote(
  ctx: DurableContext,
  stepId: string,
  calendarId: string,
  eventId: string,
): Promise<MeetingNoteResult> {
  return ctx.step(stepId, async () => {
    const res = await sdk.fetch(NOTION_MEETING_NOTES_URL, {
      connection: NOTION_PAT_CONNECTION,
      method: "POST",
      headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify({
        calendar_event: {
          calendar: { account_id: NOTION_CALENDAR_ACCOUNT_ID, calendar_id: calendarId },
          event_id: eventId,
        },
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Notion meeting_notes ${res.status} for event ${eventId}: ${text.slice(0, 500)}`);
    const body = JSON.parse(text) as { created?: unknown; meeting_note?: { id?: unknown } };
    const pageId = firstString(body.meeting_note?.id);
    if (!pageId) throw new Error(`Notion meeting_notes returned no meeting_note.id for event ${eventId}: ${text.slice(0, 500)}`);
    return { pageId, created: body.created === true };
  });
}

/**
 * Free: record the note against its occurrence. Find-or-create on Event ID,
 * then write the fields, the same upsert the Worker does, so whichever of the
 * two runs second updates the row instead of adding one.
 */
async function upsertMeetingNoteRow(
  ctx: DurableContext,
  stepPrefix: string,
  event: FoundEvent,
  eventId: string,
  pageId: string,
): Promise<void> {
  const fields: Record<string, unknown> = {
    new__data__f2: pageId,
    new__data__f3: eventId,
    new__data__f5: firstString(event.start?.dateTime),
    new__data__f6: firstString(event.end?.dateTime),
  };
  const summary = firstString(event.summary);
  const iCalUID = firstString(event.iCalUID);
  if (summary) fields.new__data__f8 = summary;
  if (iCalUID) fields.new__data__f9 = iCalUID;

  const found = await ctx.step(`${stepPrefix}-find-or-create`, async () =>
    sdk.runAction({
      appKey: "TableCLIAPI",
      actionType: "search_or_write",
      actionKey: "find_record",
      inputs: {
        table_id: MEETING_NOTE_IDS_TABLE,
        filter_count: "1",
        use_stored_order: false,
        field_data_key: FIELD_EVENT_ID,
        operator: "exact",
        lookup_value: eventId,
        ...fields,
        new__data__f7: false,
      },
    }),
  );
  const data = (found as { data?: unknown }).data;
  const first = Array.isArray(data) ? data[0] : data;
  const recordId = firstString((first as { record_id?: unknown; id?: unknown } | undefined)?.record_id)
    ?? firstString((first as { id?: unknown } | undefined)?.id);
  if (!recordId) throw new Error(`Meeting Note IDs upsert returned no record id for event ${eventId}`);

  await ctx.step(`${stepPrefix}-update`, async () =>
    sdk.runAction({
      appKey: "TableCLIAPI",
      actionType: "write",
      actionKey: "update_record",
      inputs: { table_id: MEETING_NOTE_IDS_TABLE, record_id: recordId, ...fields },
    }),
  );
}


/**
 * One task: `event_v2` over [afterMs, beforeMs] with recurring events
 * expanded, ordered by start. The field names are inverted: `start_time` is
 * "Start Time BEFORE" (upper bound) and `end_time` is "End Time AFTER" (lower
 * bound); verified on gcal-block-sweep 2026-08-28. An event already under way
 * (ends after `afterMs`) is included.
 */
async function searchEvents(ctx: DurableContext, stepId: string, afterMs: number, beforeMs: number): Promise<FoundEvent[]> {
  const found = await ctx.step(stepId, async () =>
    sdk.runAction({
      appKey: GCAL_APP_KEY,
      actionType: "search",
      actionKey: "event_v2",
      connection: GCAL_CONNECTION,
      inputs: {
        calendarid: GCAL_CALENDAR,
        expand_recurring: true,
        ordering: "startTime",
        start_time: isoFromEpochMs(beforeMs),
        end_time: isoFromEpochMs(afterMs),
        _zap_search_success_on_miss: true,
      },
    }),
  );
  const seen = new Set<string>();
  const events: FoundEvent[] = [];
  for (const raw of ((found as { data?: unknown[] }).data ?? [])) {
    const parsed = FoundEventSchema.safeParse(raw);
    const id = parsed.success ? firstString(parsed.data.id) : null;
    if (parsed.success && id && !seen.has(id)) {
      seen.add(id);
      events.push(parsed.data);
    }
  }
  if (events.length >= SEARCH_PAGE_WARN) {
    console.log(`${stepId} returned ${events.length} events; the far end of the window may be truncated`);
  }
  return events;
}

interface NoteOutcome {
  eventId: string;
  pageId: string;
  summary: string | null;
  start: string | null;
  created: boolean;
}

/**
 * The paid part, shared by both paths: get-or-create the note (one task),
 * then record it in the Table (free). Callers have already checked the Table.
 */
async function noteForEvent(
  ctx: DurableContext,
  stepPrefix: string,
  calendarId: string,
  event: FoundEvent,
): Promise<NoteOutcome> {
  const eventId = firstString(event.id)!;
  const note = await getOrCreateMeetingNote(ctx, `${stepPrefix}-meeting-note`, calendarId, eventId);
  await upsertMeetingNoteRow(ctx, `${stepPrefix}-record`, event, eventId, note.pageId);
  return {
    eventId,
    pageId: note.pageId,
    summary: firstString(event.summary),
    start: firstString(event.start?.dateTime),
    created: note.created,
  };
}

/** Free check, then the paid create, for a list of occurrences; returns what happened to each. */
async function noteEach(
  ctx: DurableContext,
  stepPrefix: string,
  calendarId: string,
  events: FoundEvent[],
): Promise<{ alreadyHaveNote: string[]; notes: NoteOutcome[] }> {
  const alreadyHaveNote: string[] = [];
  const notes: NoteOutcome[] = [];
  for (let i = 0; i < events.length; i++) {
    const eventId = firstString(events[i].id)!;
    if (await hasMeetingNoteRow(ctx, `${stepPrefix}-lookup-${i}`, eventId)) {
      alreadyHaveNote.push(eventId);
      continue;
    }
    notes.push(await noteForEvent(ctx, `${stepPrefix}-${i}`, calendarId, events[i]));
  }
  return { alreadyHaveNote, notes };
}

// --- Per-event path ------------------------------------------------------------

/**
 * The trigger deployment hands over one raw Google event. The schedule tick
 * and manual inputs never carry a `start` object, so that is the switch.
 */
function isGoogleEventPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    !!v.start &&
    typeof v.start === "object" &&
    (v.kind === "calendar#event" || typeof v.iCalUID === "string" || typeof v.etag === "string")
  );
}

/** The occurrence ids of a series start with the master's id (`<master>_<startUTC>`). */
function isOccurrenceOf(event: FoundEvent, masterId: string): boolean {
  return firstString(event.recurringEventId) === masterId;
}

/**
 * Google Calendar "New Event" delivers three shapes:
 *
 *   - a ONE-OFF meeting: noted now, however far ahead it is, as long as it has
 *     not already ended;
 *   - a recurring MASTER (it carries `recurrence`): the series is expanded with
 *     one bounded search and its first SERIES_FIRST_INSTANCES upcoming
 *     occurrences are noted; the rest roll into the sweep's 7-day window one at
 *     a time, so an endless series never fans out;
 *   - a single OCCURRENCE of a series, delivered on its own (an edited
 *     instance): noted only if it starts within the sweep's horizon, because
 *     anything later is the sweep's job anyway.
 *
 * Everything goes through the same meeting filter, free Table check and
 * get-or-create as the sweep, so the two paths overlap harmlessly.
 */
async function handleNewEvent(ctx: DurableContext, raw: unknown): Promise<Record<string, unknown>> {
  const parsed = FoundEventSchema.safeParse(raw);
  const eventId = parsed.success ? firstString(parsed.data.id) : null;
  if (!parsed.success || !eventId) {
    // A non-empty payload we cannot read is a real event we failed to
    // understand; the repo rule is to throw, never skip silently.
    throw new Error(`unrecognised Google event payload: ${JSON.stringify(raw).slice(0, 300)}`);
  }
  const event = parsed.data;

  const skip = classifySkip(event);
  if (skip) return { path: "event", skipped: skip, eventId };

  const calendarId = calendarIdFromEvents([event]);
  if (!calendarId) {
    throw new Error(`could not read the calendar id from event ${eventId}; the Google event payload may have changed`);
  }

  const nowMs = await ctx.step("read-clock", async () => Date.now());
  const startMs = epochMsFromRfc3339(firstString(event.start?.dateTime));
  const endMs = epochMsFromRfc3339(firstString(event.end?.dateTime));
  if (startMs === null || endMs === null) return { path: "event", skipped: "not-timed", eventId };

  const isMaster = (event.recurrence ?? []).length > 0;
  const isOccurrence = !isMaster && firstString(event.recurringEventId) !== null;

  if (isMaster) {
    // The master's start is the series' first occurrence. Search from
    // whichever is later, that or now, so a series created mid-way through
    // its life is noted from its next occurrence.
    const fromMs = Math.max(nowMs, startMs - 60000);
    const occurrences = (await searchEvents(ctx, "expand-series", fromMs, fromMs + SERIES_SEARCH_DAYS * DAY_MS))
      .filter((e) => isOccurrenceOf(e, eventId) && classifySkip(e) === null)
      .slice(0, SERIES_FIRST_INSTANCES);
    if (occurrences.length === 0) {
      return { path: "series", skipped: "no-upcoming-occurrences", eventId, searchedDays: SERIES_SEARCH_DAYS };
    }
    const { alreadyHaveNote, notes } = await noteEach(ctx, "series", calendarId, occurrences);
    return { path: "series", seriesId: eventId, summary: firstString(event.summary), alreadyHaveNote, notes };
  }

  if (endMs <= nowMs) return { path: "event", skipped: "already-over", eventId };
  if (isOccurrence && startMs > nowMs + HORIZON_DAYS * DAY_MS) {
    return { path: "occurrence", skipped: "beyond-horizon-left-to-sweep", eventId };
  }

  const { alreadyHaveNote, notes } = await noteEach(ctx, isOccurrence ? "occurrence" : "one-off", calendarId, [event]);
  return { path: isOccurrence ? "occurrence" : "one-off", alreadyHaveNote, notes };
}

// --- Workflow ----------------------------------------------------------------

const workflow = defineDurable("gcal-meetings-to-meeting-notes", async (ctx: DurableContext, rawInput: Input) => {
  const normalized = normalizeInput(rawInput);
  if (isGoogleEventPayload(normalized)) {
    const result = await handleNewEvent(ctx, normalized);
    console.log(JSON.stringify(result));
    return result;
  }

  const input = InputSchema.parse(normalized);
  const dryRun = input.dryRun === true;

  // Manual replay of the trigger path for one event: `{"event_id": "<id>"}`.
  // One task to fetch the event, then exactly what the trigger would do.
  const replayId = firstString(input.event_id);
  if (replayId) {
    const fetched = await ctx.step("fetch-event", async () =>
      sdk.runAction({
        appKey: GCAL_APP_KEY,
        actionType: "search",
        actionKey: "event_by_id",
        connection: GCAL_CONNECTION,
        inputs: { calendarid: GCAL_CALENDAR, event_id: replayId, _zap_search_success_on_miss: true },
      }),
    );
    const event = ((fetched as { data?: unknown[] }).data ?? [])[0];
    if (!event) throw new Error(`event ${replayId} not found on the primary calendar`);
    const result = { replay: true, ...(await handleNewEvent(ctx, event)) };
    console.log(JSON.stringify(result));
    return result;
  }

  // "Now": a manual override, else the schedule tick's own timestamp, else
  // one guarded clock read (fixed for every retry of the run).
  const nowMs =
    epochMsFromRfc3339(firstString(input.now)) ??
    epochMsFromRfc3339(firstString(input.id)) ??
    (await ctx.step("read-sweep-clock", async () => Date.now()));

  const fromDays = typeof input.from_days === "number" ? input.from_days : 0;
  const toDays = typeof input.to_days === "number" ? input.to_days : HORIZON_DAYS;
  if (!(toDays > fromDays) || fromDays < 0 || toDays > 31) {
    throw new Error(`invalid window: from_days=${fromDays} to_days=${toDays} (0 <= from < to <= 31)`);
  }
  const maxCreates = typeof input.max_creates === "number" ? input.max_creates : MAX_CREATES_PER_RUN;
  if (!Number.isInteger(maxCreates) || maxCreates < 1 || maxCreates > 200) {
    throw new Error(`invalid max_creates=${maxCreates} (an integer 1..200)`);
  }

  const afterMs = nowMs + fromDays * DAY_MS;
  const beforeMs = nowMs + toDays * DAY_MS;
  const events = await searchEvents(ctx, "search-events", afterMs, beforeMs);

  const skipped: Record<string, number> = {};
  const candidates: FoundEvent[] = [];
  for (const event of events) {
    const reason = classifySkip(event);
    if (reason) skipped[reason] = (skipped[reason] ?? 0) + 1;
    else candidates.push(event);
  }

  const summary: Record<string, unknown> = {
    path: "sweep",
    dryRun,
    window: { from: isoFromEpochMs(afterMs), to: isoFromEpochMs(beforeMs) },
    events: events.length,
    skipped,
  };
  if (candidates.length === 0) return { ...summary, meetings: 0 };

  const calendarId = calendarIdFromEvents(events);
  if (!calendarId) {
    // Every meeting with a guest lists Dennis as the `self` attendee, so a
    // candidate with no readable calendar id means the payload changed shape.
    throw new Error(`could not read the calendar id from ${events.length} events; the Google event payload may have changed`);
  }

  const alreadyHaveNote: string[] = [];
  const toCreate: FoundEvent[] = [];
  for (let i = 0; i < candidates.length; i++) {
    if (await hasMeetingNoteRow(ctx, `lookup-${i}`, firstString(candidates[i].id)!)) {
      alreadyHaveNote.push(firstString(candidates[i].id)!);
    } else {
      toCreate.push(candidates[i]);
    }
  }

  if (dryRun) {
    return {
      ...summary,
      meetings: candidates.length,
      alreadyHaveNote: alreadyHaveNote.length,
      wouldCreate: toCreate.map((e) => ({ eventId: e.id, start: firstString(e.start?.dateTime), summary: firstString(e.summary) })),
      cap: maxCreates,
    };
  }

  const batch = toCreate.slice(0, maxCreates);
  const notes: NoteOutcome[] = [];
  for (let i = 0; i < batch.length; i++) {
    notes.push(await noteForEvent(ctx, `sweep-${i}`, calendarId, batch[i]));
  }

  const result = {
    ...summary,
    meetings: candidates.length,
    alreadyHaveNote: alreadyHaveNote.length,
    created: notes.filter((n) => n.created),
    linkedExisting: notes.filter((n) => !n.created),
  };
  console.log(JSON.stringify(result));

  const overflow = toCreate.length - batch.length;
  if (overflow > 0) {
    // Loud by design: a cap hit means far more meetings than any normal week,
    // so someone should look before the next run spends more tasks. The notes
    // already made are kept and recorded; later runs continue soonest-first.
    throw new Error(
      `cap reached: created ${batch.length} meeting notes (max_creates=${maxCreates}); ${overflow} more meetings in the window were left for later runs. Check the calendar for a mass import before raising the cap.`,
    );
  }
  return result;
});

export default workflow;
