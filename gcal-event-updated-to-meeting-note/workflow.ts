// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/gcal-event-updated-to-meeting-note
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// The Google Calendar credential lives on the TRIGGER, not here: this workflow
// never calls Google back, it only consumes the event the trigger delivers.
const NOTION_APP_KEY = "NotionCLIAPI";
const NOTION_CONNECTION = "notion_wf";

/** Notion Meeting Notes data source (in the "Meetings and Emails" database). */
const MEETING_NOTES_DS = "19891b07-11ac-8137-9d62-000b75fab86e";

/**
 * `[Table] Meeting Note IDs` — the Notion-page <-> calendar-event map.
 *
 * Written by the `meeting-note-db-updates` Notion Worker
 * (https://github.com/work-flowers/notion-worker-meeting-note-db-updates) when
 * it enriches a freshly created meeting note; read here to find the page a
 * calendar edit belongs to. Table ops consume no Zapier tasks, which is why the
 * lookup goes through here rather than a Notion search action.
 *
 * Columns: `Page ID` (f2) · `Event ID` (f3) · `Start` (f5) · `End` (f6) ·
 * `Archived` (f7) · `Event Title` (f8) · `iCal UID` (f9).
 *
 * `Event ID` (f3) is the Google **occurrence** id — `<seriesId>_<originalStartUTC>`
 * for a recurring instance, a bare opaque id for a one-off. That is the only id
 * that is unique per meeting note, so it is the lookup key.
 *
 * `iCal UID` (f9) is the RFC 5545 UID, which identifies the **series** and is
 * therefore shared by every occurrence. It is stored for provenance only and
 * must never be used as the lookup key: between 2026-05 and 2026-07 the Worker
 * wrote the iCalUID into f3, which both broke this lookup outright (the trigger
 * matches on the occurrence id, and `<id>@google.com` never equals `<id>`) and
 * collapsed every recurring series into a single row whose Page ID was
 * overwritten by each new occurrence. See the README.
 */
const MEETING_NOTE_IDS_TABLE = "01JZCVG73MBWWB0357CEPS4903";
const TABLE_FIELD_PAGE_ID = "data__f2";
const TABLE_FIELD_EVENT_ID = "data__f3";

/**
 * Notion errors that mean "this page is gone", as opposed to a transient
 * failure worth retrying. On a match the mapping row is flagged `Archived`
 * rather than deleted — the classic Zap deleted the row, but the row is the
 * only remaining record that the note ever existed, and the column is already
 * there for exactly this.
 */
const PAGE_GONE_PATTERN =
  /object_not_found|could not find (page|block|item)|is archived|has been (deleted|trashed)|in the trash/i;

// --- Input -----------------------------------------------------------------

/**
 * The Google Calendar `event_updated` payload is the raw Google event resource,
 * so this mirrors only the parts the workflow reads and tolerates everything
 * else. `start`/`end` carry `dateTime` for a timed event and `date` for an
 * all-day one; meeting notes only ever come from timed meetings, so a `date`-only
 * payload is a skip (`use_zapier_datetime_fields` on the Notion side expects a
 * datetime, and the classic Zap read `start.dateTime` for the same reason).
 */
const EventTimeSchema = z
  .object({
    dateTime: z.string().optional().nullable(),
    date: z.string().optional().nullable(),
    timeZone: z.string().optional().nullable(),
  })
  .partial()
  .passthrough();

const InputSchema = z
  .object({
    id: z.string().optional().nullable(),
    iCalUID: z.string().optional().nullable(),
    summary: z.string().optional().nullable(),
    status: z.string().optional().nullable(),
    recurringEventId: z.string().optional().nullable(),
    start: EventTimeSchema.optional().nullable(),
    end: EventTimeSchema.optional().nullable(),
  })
  .passthrough();

type Input = z.infer<typeof InputSchema>;

/** `run-durable` hands manual input through as a JSON string. */
function normalizeInput(rawInput: unknown): unknown {
  if (typeof rawInput === "string") return JSON.parse(rawInput);
  return rawInput;
}

// --- Deterministic time comparison -----------------------------------------
// `@zapier/zapier-durable` runs the workflow body in GUARDED mode and its `Date`
// proxy asserts in the `construct` trap BEFORE looking at its arguments, so even
// `new Date(isoString)` throws. Comparing two timestamps therefore uses integer
// maths only — same approach as `drive-invoice-to-xero`.

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
 *
 * Handles the two forms in play: Google returns a local time plus offset
 * (`2026-07-31T16:00:00+08:00`), Zapier Tables normalises to `Z`
 * (`2026-07-31T08:00:00Z`). Both must reduce to the same instant, which is the
 * whole point — a string compare would see a spurious change on every run.
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

  // No offset at all: treat as UTC. A naive local time would need a zone we do
  // not have, and both sources here always carry an offset or `Z`.
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

// --- Helpers ---------------------------------------------------------------

function firstString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

/** Dashed 8-4-4-4-12, which is the only form Notion's `page` input accepts. */
function toDashedPageId(value: unknown): string | null {
  const raw = firstString(value)?.replace(/-/g, "");
  if (!raw || !/^[0-9a-fA-F]{32}$/.test(raw)) return null;
  return [
    raw.slice(0, 8),
    raw.slice(8, 12),
    raw.slice(12, 16),
    raw.slice(16, 20),
    raw.slice(20),
  ]
    .join("-")
    .toLowerCase();
}

interface MappingRow {
  recordId: string;
  pageId: string;
  start: string | null;
  end: string | null;
}

function extractRow(result: unknown): MappingRow | null {
  const rows = Array.isArray(result) ? result : [];
  const hit = rows[0] as
    | { record_id?: unknown; old?: { data?: Record<string, unknown> } }
    | undefined;
  if (!hit) return null;

  const recordId = firstString(hit.record_id);
  const data = hit.old?.data ?? {};
  const pageId = toDashedPageId(data.f2);
  if (!recordId || !pageId) return null;

  return {
    recordId,
    pageId,
    start: firstString(data.f5),
    end: firstString(data.f6),
  };
}

// --- Workflow --------------------------------------------------------------

const workflow = defineDurable<Input, unknown>(
  "gcal-event-updated-to-meeting-note",
  async (ctx: DurableContext, rawInput: Input) => {
    const event = InputSchema.parse(normalizeInput(rawInput));

    const eventId = firstString(event.id);
    const iCalUID = firstString(event.iCalUID);
    const summary = firstString(event.summary);
    const startDateTime = firstString(event.start?.dateTime);
    const endDateTime = firstString(event.end?.dateTime);

    if (!eventId) {
      return { skipped: "no-event-id" };
    }

    // A cancelled occurrence still arrives on `event_updated`. Rewriting the
    // note's Date from it would be wrong, and its start/end are usually absent
    // anyway — bail explicitly rather than relying on that.
    if (firstString(event.status) === "cancelled") {
      return { skipped: "event-cancelled", eventId };
    }

    // All-day / date-only events never have meeting notes.
    if (!startDateTime || !endDateTime) {
      return { skipped: "not-a-timed-event", eventId };
    }

    // Free: Zapier Tables ops consume no tasks. `_zap_search_success_on_miss`
    // makes a miss an empty array instead of a thrown step.
    const lookup = await ctx.step("find-meeting-note-row", async () =>
      sdk.runAction({
        appKey: "TableCLIAPI",
        actionType: "search",
        actionKey: "find_record",
        inputs: {
          table_id: MEETING_NOTE_IDS_TABLE,
          filter_count: "2",
          use_stored_order: false,
          field_data_key: TABLE_FIELD_EVENT_ID,
          operator: "exact",
          lookup_value: eventId,
          field_data_key_2: TABLE_FIELD_PAGE_ID,
          operator_2: "isnull",
          lookup_value_2: false,
          _zap_search_multiple_results: "first",
          _zap_search_success_on_miss: true,
        },
      }),
    );

    const row = extractRow((lookup as { data?: unknown }).data);
    if (!row) {
      // Overwhelmingly the normal outcome: a calendar edit on a meeting that
      // has no note (nothing scheduled a note, or the note is not written yet).
      return { skipped: "no-meeting-note-for-event", eventId };
    }

    // The classic Zap compared the event against the row's stored Start/End to
    // avoid rewriting Notion on every unrelated calendar edit (a renamed title,
    // an RSVP). Same guard, but instant-for-instant rather than by Zapier's
    // date filters, so an offset change alone is not read as a reschedule.
    if (sameInstant(startDateTime, row.start) && sameInstant(endDateTime, row.end)) {
      return {
        skipped: "times-unchanged",
        eventId,
        pageId: row.pageId,
        start: startDateTime,
        end: endDateTime,
      };
    }

    // The one task this workflow spends.
    const update = await ctx.step("update-meeting-note-date", async () => {
      try {
        return await sdk.runAction({
          appKey: NOTION_APP_KEY,
          actionType: "write",
          actionKey: "update_database_item",
          connection: NOTION_CONNECTION,
          inputs: {
            datasource: MEETING_NOTES_DS,
            page: row.pageId,
            use_zapier_datetime_fields: true,
            "properties|||Date|||date__start": startDateTime,
            "properties|||Date|||date__end": endDateTime,
          },
        });
      } catch (error) {
        // Caught INSIDE the step so a dead page does not spin the retry loop.
        // Anything else rethrows and gets the step's normal retries.
        const message = error instanceof Error ? error.message : String(error);
        if (PAGE_GONE_PATTERN.test(message)) {
          return { pageGone: true, message };
        }
        throw error;
      }
    });

    if ((update as { pageGone?: boolean })?.pageGone) {
      await ctx.step("flag-mapping-row-archived", async () =>
        sdk.runAction({
          appKey: "TableCLIAPI",
          actionType: "write",
          actionKey: "update_record",
          inputs: {
            table_id: MEETING_NOTE_IDS_TABLE,
            record_id: row.recordId,
            new__data__f7: true,
          },
        }),
      );
      return {
        skipped: "meeting-note-page-gone",
        eventId,
        pageId: row.pageId,
        recordId: row.recordId,
      };
    }

    // Keep the map honest so the "times-unchanged" guard above stays correct on
    // the next edit. Free, and it also backfills `iCal UID` on rows written
    // before that column existed.
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
      updated: true,
      eventId,
      iCalUID,
      pageId: row.pageId,
      recordId: row.recordId,
      previous: { start: row.start, end: row.end },
      current: { start: startDateTime, end: endDateTime },
    };
  },
);

export default workflow;
