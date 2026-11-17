// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/gcal-meetings-to-meeting-notes
//
// Owns the life of a Notion meeting note for every meeting on Dennis's work
// calendar: creates it, linked to its Google Calendar event, before the
// meeting, and moves it when the meeting is rescheduled. One source, two
// deployments (see zap.json):
//
//   - CALENDAR EVENT (Google Calendar "New or Updated Event"): an event that
//     already has a note is a possible RESCHEDULE (moves the note's Date and
//     title; this absorbed gcal-event-updated-to-meeting-note on 2026-11-17).
//     An event with no note is a possible CREATE: a new one-off meeting is
//     noted at once however far ahead, and a NEW recurring series gets notes
//     for its first SERIES_FIRST_INSTANCES occurrences. See handleCalendarEvent.
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
/**
 * The work.flowers Notion connection, used only by the reschedule path to read
 * and patch a note's page (ordinary page endpoints, which it can call). The
 * meeting-notes endpoint refuses it, hence notion_pat above.
 */
const NOTION_WF_CONNECTION = "notion_wf";
const NOTION_API = "https://api.notion.com/v1";
/** The meeting note's date property. The title property is found by type. */
const DATE_PROP = "Date";
/**
 * Notion errors that mean "this page is gone", as opposed to a transient
 * failure worth retrying. On a match the mapping row is flagged `Archived`
 * rather than deleted: the row is the only remaining record that the note ever
 * existed (and it also stops the create path from making the note again).
 */
const PAGE_GONE_PATTERN =
  /object_not_found|could not find (page|block|item)|is archived|has been (deleted|trashed)|in the trash/i;
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
/**
 * "New or Updated Event" fires on EVERY change to a series (an RSVP, a guest
 * added, Gemini touching it), and expanding a series costs a search task. A
 * master is treated as a NEW series only when Google's `created` and `updated`
 * are this close; any other series edit skips for free.
 */
const NEW_SERIES_WINDOW_MS = 15 * 60 * 1000;

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

/** True when both parse and land on the same instant. An unparseable side is "different". */
function sameInstant(a: unknown, b: unknown): boolean {
  const left = epochMsFromRfc3339(a);
  const right = epochMsFromRfc3339(b);
  if (left === null || right === null) return false;
  return left === right;
}

// --- Title date mention (reschedule path) ---------------------------------------
// A note is titled "<meeting> @<start>", where @<start> is a Notion DATE
// MENTION in the title's rich text. Moving `Date` leaves it on the old time, so
// a reschedule rewrites it too. Ported unchanged from
// gcal-event-updated-to-meeting-note (retired into this Zap).

/**
 * Rewrites the title's date mentions that point at the meeting's PREVIOUS
 * start, so a hand-typed date elsewhere in a title is left alone. A mention
 * with an end gets the new end only when that end matched the previous end.
 *
 * Returns the rich text to write (rebuilt in request shape) and how many
 * mentions moved, or `null` when nothing in the title needs to change: a
 * hand-edited title, a note with no time in it, or a step retry after the
 * write already landed (the mention then already shows the new start).
 */
export function rewriteTitleDateMentions(
  title: unknown,
  previous: { start: string | null; end: string | null },
  next: { start: string; end: string },
): { richText: Array<Record<string, unknown>>; moved: number } | null {
  const items = Array.isArray(title) ? (title as Array<Record<string, any>>) : [];
  let moved = 0;

  const richText = items.map((item) => {
    const annotations = item.annotations;
    if (item.type === "mention" && item.mention?.type === "date" && item.mention.date) {
      const date = item.mention.date as { start?: unknown; end?: unknown; time_zone?: unknown };
      if (previous.start && sameInstant(date.start, previous.start)) {
        moved++;
        const end =
          date.end == null
            ? null
            : previous.end && sameInstant(date.end, previous.end)
              ? next.end
              : date.end;
        return {
          type: "mention",
          mention: { type: "date", date: { start: next.start, end, time_zone: date.time_zone ?? null } },
          ...(annotations ? { annotations } : {}),
        };
      }
    }
    // Everything else goes back as it came, in request shape: the response's
    // `plain_text`/`href` are read-only and are dropped.
    const type = String(item.type);
    return { type, [type]: item[type], ...(annotations ? { annotations } : {}) };
  });

  return moved > 0 ? { richText, moved } : null;
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
    created: z.string().optional().nullable(),
    updated: z.string().optional().nullable(),
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

/** Dashed 8-4-4-4-12, the form Notion's page endpoints accept. */
function toDashedPageId(value: unknown): string | null {
  const raw = firstString(value)?.replace(/-/g, "");
  if (!raw || !/^[0-9a-fA-F]{32}$/.test(raw)) return null;
  return [raw.slice(0, 8), raw.slice(8, 12), raw.slice(12, 16), raw.slice(16, 20), raw.slice(20)].join("-").toLowerCase();
}

interface MappingRow {
  recordId: string;
  pageId: string;
  start: string | null;
  end: string | null;
}

/**
 * Free: the occurrence's meeting-note row, if it has one with a Page ID. An
 * `Archived` row (its note was deleted) still counts, so a note someone
 * deleted is not made again.
 */
async function findMeetingNoteRow(ctx: DurableContext, stepId: string, eventId: string): Promise<MappingRow | null> {
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
  const hit = (Array.isArray(rows) ? rows[0] : undefined) as
    | { record_id?: unknown; old?: { data?: Record<string, unknown> } }
    | undefined;
  const recordId = firstString(hit?.record_id);
  const data = hit?.old?.data ?? {};
  const pageId = toDashedPageId(data.f2);
  if (!recordId || !pageId) return null;
  return { recordId, pageId, start: firstString(data.f5), end: firstString(data.f6) };
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
    if (await findMeetingNoteRow(ctx, `${stepPrefix}-lookup-${i}`, eventId)) {
      alreadyHaveNote.push(eventId);
      continue;
    }
    notes.push(await noteForEvent(ctx, `${stepPrefix}-${i}`, calendarId, events[i]));
  }
  return { alreadyHaveNote, notes };
}

// --- Per-event path ------------------------------------------------------------

/**
 * The calendar-event deployment hands over one raw Google event. The schedule
 * tick and manual inputs never carry a `start` object, so that is the switch.
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

/** An occurrence names its series' master id in `recurringEventId`. */
function isOccurrenceOf(event: FoundEvent, masterId: string): boolean {
  return firstString(event.recurringEventId) === masterId;
}

/** A master whose `created` and `updated` are close: a series just made, not an edit to an old one. */
export function isNewSeries(event: FoundEvent): boolean {
  const created = epochMsFromRfc3339(firstString(event.created));
  const updated = epochMsFromRfc3339(firstString(event.updated));
  if (created === null || updated === null) return false;
  return Math.abs(updated - created) <= NEW_SERIES_WINDOW_MS;
}

/**
 * RESCHEDULE: the event already has a note. Ported from
 * gcal-event-updated-to-meeting-note: if the start or end moved (compared as
 * instants, since Google sends `+08:00` and the Table stores `Z`), read the
 * note and write `Date` plus any title date mention at the old start, in one
 * PATCH on notion_wf (2 tasks). A deleted note flags its row `Archived`.
 */
async function rescheduleNote(
  ctx: DurableContext,
  event: FoundEvent,
  eventId: string,
  row: MappingRow,
  startDateTime: string,
  endDateTime: string,
): Promise<Record<string, unknown>> {
  if (sameInstant(startDateTime, row.start) && sameInstant(endDateTime, row.end)) {
    return { path: "reschedule", skipped: "times-unchanged", eventId, pageId: row.pageId };
  }

  // Read and write share a step so a retry re-reads rather than writing a
  // stale title. A dead page is answered inside the step, not retried.
  const update = await ctx.step("update-meeting-note-date", async () => {
    const headers = { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" };
    const got = await sdk.fetch(`${NOTION_API}/pages/${row.pageId}`, { connection: NOTION_WF_CONNECTION, headers });
    const gotText = await got.text();
    // Only an ERROR body is matched: a live page's JSON can contain any of
    // these words in its own title.
    if (got.status === 404 || (!got.ok && PAGE_GONE_PATTERN.test(gotText))) {
      return { pageGone: true, titleMentionsMoved: 0 };
    }
    if (!got.ok) throw new Error(`Notion get page ${row.pageId} failed (${got.status}): ${gotText.slice(0, 300)}`);
    const page = JSON.parse(gotText) as { in_trash?: boolean; archived?: boolean; properties?: Record<string, any> };
    if (page.in_trash || page.archived) return { pageGone: true, titleMentionsMoved: 0 };

    const properties: Record<string, unknown> = { [DATE_PROP]: { date: { start: startDateTime, end: endDateTime } } };
    const titleEntry = Object.entries(page.properties ?? {}).find(([, prop]) => prop?.type === "title");
    const rewrite = titleEntry
      ? rewriteTitleDateMentions(titleEntry[1].title, { start: row.start, end: row.end }, { start: startDateTime, end: endDateTime })
      : null;
    if (titleEntry && rewrite) properties[titleEntry[0]] = { title: rewrite.richText };

    const patched = await sdk.fetch(`${NOTION_API}/pages/${row.pageId}`, {
      connection: NOTION_WF_CONNECTION,
      method: "PATCH",
      headers,
      body: JSON.stringify({ properties }),
    });
    if (!patched.ok) {
      const text = await patched.text();
      if (PAGE_GONE_PATTERN.test(text)) return { pageGone: true, titleMentionsMoved: 0 };
      throw new Error(`Notion update page ${row.pageId} failed (${patched.status}): ${text.slice(0, 300)}`);
    }
    return { pageGone: false, titleMentionsMoved: rewrite?.moved ?? 0 };
  });

  if (update.pageGone) {
    await ctx.step("flag-mapping-row-archived", async () =>
      sdk.runAction({
        appKey: "TableCLIAPI",
        actionType: "write",
        actionKey: "update_record",
        inputs: { table_id: MEETING_NOTE_IDS_TABLE, record_id: row.recordId, new__data__f7: true },
      }),
    );
    return { path: "reschedule", skipped: "meeting-note-page-gone", eventId, pageId: row.pageId };
  }

  // Keep the row's Start/End current so the times-unchanged guard stays right
  // on the next edit. Free.
  const summary = firstString(event.summary);
  const iCalUID = firstString(event.iCalUID);
  await ctx.step("refresh-mapping-row", async () =>
    sdk.runAction({
      appKey: "TableCLIAPI",
      actionType: "write",
      actionKey: "update_record",
      inputs: {
        table_id: MEETING_NOTE_IDS_TABLE,
        record_id: row.recordId,
        new__data__f5: startDateTime,
        new__data__f6: endDateTime,
        ...(summary ? { new__data__f8: summary } : {}),
        ...(iCalUID ? { new__data__f9: iCalUID } : {}),
      },
    }),
  );
  return {
    path: "reschedule",
    updated: true,
    titleMentionsMoved: update.titleMentionsMoved,
    eventId,
    pageId: row.pageId,
    previous: { start: row.start, end: row.end },
    current: { start: startDateTime, end: endDateTime },
  };
}

/**
 * One raw Google event from "New or Updated Event" (`expand_recurring: false`,
 * so a whole-series change arrives as the series master).
 *
 *   1. Cancelled or all-day: skip.
 *   2. One free Table lookup on the occurrence id.
 *   3. A row exists: RESCHEDULE (rescheduleNote). This runs for any event with
 *      a note, meeting filter or not, exactly as the retired Zap did.
 *   4. No row: CREATE, for events that pass the meeting filter:
 *        - a one-off: noted if it has not ended, however far ahead;
 *        - a single occurrence: noted only within the sweep's 7-day horizon;
 *        - a series master: only when the series is new (isNewSeries), its
 *          first SERIES_FIRST_INSTANCES upcoming occurrences, found with one
 *          bounded search. The sweep reaches the rest one day at a time.
 *
 * `replay` (the manual `{event_id}` input) lifts the new-series guard, so a
 * missed series can be noted by hand.
 */
async function handleCalendarEvent(ctx: DurableContext, raw: unknown, replay: boolean): Promise<Record<string, unknown>> {
  const parsed = FoundEventSchema.safeParse(raw);
  const eventId = parsed.success ? firstString(parsed.data.id) : null;
  if (!parsed.success || !eventId) {
    // A non-empty payload we cannot read is a real event we failed to
    // understand; the repo rule is to throw, never skip silently.
    throw new Error(`unrecognised Google event payload: ${JSON.stringify(raw).slice(0, 300)}`);
  }
  const event = parsed.data;

  if (firstString(event.status) === "cancelled") return { path: "event", skipped: "event-cancelled", eventId };
  const startDateTime = firstString(event.start?.dateTime);
  const endDateTime = firstString(event.end?.dateTime);
  if (!startDateTime || !endDateTime) return { path: "event", skipped: "not-a-timed-event", eventId };

  const row = await findMeetingNoteRow(ctx, "find-meeting-note-row", eventId);
  if (row) return rescheduleNote(ctx, event, eventId, row, startDateTime, endDateTime);

  // --- CREATE: the event has no note yet ---
  const skip = classifySkip(event);
  if (skip) return { path: "create", skipped: skip, eventId };

  const isMaster = (event.recurrence ?? []).length > 0;
  if (isMaster && !replay && !isNewSeries(event)) {
    // An RSVP, a guest added, an edit to an old series: the sweep notes its
    // occurrences as they come within 7 days. Skipping here avoids a search
    // task on every series edit.
    return { path: "create", skipped: "series-edit-not-new", eventId };
  }

  const calendarId = calendarIdFromEvents([event]);
  if (!calendarId) {
    throw new Error(`could not read the calendar id from event ${eventId}; the Google event payload may have changed`);
  }

  const nowMs = await ctx.step("read-clock", async () => Date.now());
  const startMs = epochMsFromRfc3339(startDateTime)!;
  const endMs = epochMsFromRfc3339(endDateTime)!;

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

  if (endMs <= nowMs) return { path: "create", skipped: "already-over", eventId };
  const isOccurrence = firstString(event.recurringEventId) !== null;
  if (isOccurrence && startMs > nowMs + HORIZON_DAYS * DAY_MS) {
    return { path: "occurrence", skipped: "beyond-horizon-left-to-sweep", eventId };
  }

  // The Table lookup above already found no row, so straight to the create.
  const note = await noteForEvent(ctx, isOccurrence ? "occurrence" : "one-off", calendarId, event);
  return { path: isOccurrence ? "occurrence" : "one-off", note };
}

// --- Workflow ----------------------------------------------------------------

const workflow = defineDurable("gcal-meetings-to-meeting-notes", async (ctx: DurableContext, rawInput: Input) => {
  const normalized = normalizeInput(rawInput);
  if (isGoogleEventPayload(normalized)) {
    const result = await handleCalendarEvent(ctx, normalized, false);
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
    const result = { replay: true, ...(await handleCalendarEvent(ctx, event, true)) };
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
    if (await findMeetingNoteRow(ctx, `lookup-${i}`, firstString(candidates[i].id)!)) {
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
