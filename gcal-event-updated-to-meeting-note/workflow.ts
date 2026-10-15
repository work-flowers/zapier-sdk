// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/gcal-event-updated-to-meeting-note
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// The Google Calendar credential lives on the classic hand-off Zap's trigger,
// not here: this workflow never calls Google, it only consumes the event the
// hand-off forwards. (It used to poll `event_updated` itself; that trigger
// never re-fires on durables — see the README.)
const NOTION_CONNECTION = "notion_wf";
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

/** The meeting note's date property. The title property is found by type. */
const DATE_PROP = "Date";

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

/** `run-durable` hands manual input through as a JSON string. A blank body is
 *  left as "" so `isEmptyPing` skips it rather than `JSON.parse` throwing. */
function normalizeInput(rawInput: unknown): unknown {
  if (typeof rawInput === "string") {
    return rawInput.trim() === "" ? "" : JSON.parse(rawInput);
  }
  return rawInput;
}

/**
 * A touch of the public catch URL with nothing in it — a browser visit, a curl
 * to check it is live, a "test" from the classic Zap's editor before it has
 * sample data. Skipped, never thrown (shared rules: webhook-trigger durables).
 */
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

/**
 * The classic hand-off Zap ("Updated Meeting → hand off to durable") POSTs a
 * FLAT JSON body, mapped field by field in a Webhooks by Zapier step:
 *
 *   source          "classic-handoff"
 *   id              `<event id>_<updated>` — the dedupe key, NOT the event id
 *   event_id        the Google occurrence id (the lookup key)
 *   updated, iCalUID, summary, status, start_dateTime, end_dateTime
 *
 * The top-level `id` is composite because the durable runtime drops any
 * catch-hook POST whose top-level `id` it has already seen (Zapier bug
 * W6ZE93-VMEWP) — forwarding the bare event id would bring back the exact bug
 * the hand-off exists to route around.
 *
 * This maps that body back onto the Google event shape the rest of the
 * workflow reads, so a raw Google event (a `run-durable` replay of an old run's
 * input) still works unchanged.
 */
const HANDOFF_SOURCE = "classic-handoff";

function fromHandoff(payload: unknown): unknown {
  const o = (payload ?? {}) as Record<string, unknown>;
  if (o.source !== HANDOFF_SOURCE) return payload;
  // Classic Webhooks steps send an unmapped/empty field as "" — collapse to null
  // so the schema's optional fields read as absent rather than as "".
  const s = (v: unknown): string | null => firstString(v);
  return {
    id: s(o.event_id),
    iCalUID: s(o.iCalUID),
    summary: s(o.summary),
    status: s(o.status),
    start: { dateTime: s(o.start_dateTime) },
    end: { dateTime: s(o.end_dateTime) },
  };
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

// --- Title date mention ----------------------------------------------------
//
// The Notion Worker titles a note "<meeting> @<start>", where @<start> is a
// Notion DATE MENTION inside the title's rich text, not plain text. Moving the
// `Date` property leaves it showing the old time, so on a reschedule the
// mention is rewritten too.

/**
 * Rewrites the title's date mentions that point at the meeting's PREVIOUS
 * start, so a hand-typed date elsewhere in a title is left alone. A mention
 * with an end gets the new end only when that end matched the previous end.
 *
 * Returns the rich text to write (rebuilt in request shape) and how many
 * mentions moved, or `null` when nothing in the title needs to change — a
 * hand-edited title, a note with no time in it, or a step retry after the
 * write already landed (the mention then already shows the new start).
 *
 * Pure, and exported so the one comparison that decides what gets written to
 * a title is testable without Notion.
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

// --- Workflow --------------------------------------------------------------

const workflow = defineDurable<Input, unknown>(
  "gcal-event-updated-to-meeting-note",
  async (ctx: DurableContext, rawInput: Input) => {
    const payload = normalizeInput(rawInput);
    if (isEmptyPing(payload)) {
      console.log("empty payload — treating as a ping of the catch URL, not an event");
      return { skipped: "empty-payload" };
    }

    const event = InputSchema.parse(fromHandoff(payload));

    const eventId = firstString(event.id);
    const iCalUID = firstString(event.iCalUID);
    const summary = firstString(event.summary);
    const startDateTime = firstString(event.start?.dateTime);
    const endDateTime = firstString(event.end?.dateTime);

    // Non-empty but no event id: a real delivery whose shape we failed to read
    // (a hand-off Zap with an unmapped field, say). Never a silent skip.
    if (!eventId) {
      throw new Error(
        `No Google event id in the payload: ${JSON.stringify(payload).slice(0, 300)}`,
      );
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

    // The only paid work: read the note, then write `Date` and (when its date
    // mention points at the old start) the title, in one PATCH. Read and write
    // share a step so a retry re-reads rather than writing a stale title.
    const update = await ctx.step("update-meeting-note-date", async () => {
      const headers = { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" };

      const got = await sdk.fetch(`${NOTION_API}/pages/${row.pageId}`, {
        connection: NOTION_CONNECTION,
        headers,
      });
      const gotText = await got.text();
      // A dead page is answered, not retried: caught INSIDE the step so it does
      // not spin the retry loop. Anything else throws and gets normal retries.
      // Only an ERROR body is matched: a live page's JSON can contain any of
      // these words in its own title.
      if (got.status === 404 || (!got.ok && PAGE_GONE_PATTERN.test(gotText))) {
        return { pageGone: true, message: gotText.slice(0, 300) };
      }
      if (!got.ok) {
        throw new Error(`Notion get page ${row.pageId} failed (${got.status}): ${gotText.slice(0, 300)}`);
      }
      const page = JSON.parse(gotText) as { in_trash?: boolean; archived?: boolean; properties?: Record<string, any> };
      if (page.in_trash || page.archived) {
        return { pageGone: true, message: "page is in the trash" };
      }

      const properties: Record<string, unknown> = {
        [DATE_PROP]: { date: { start: startDateTime, end: endDateTime } },
      };
      const titleEntry = Object.entries(page.properties ?? {}).find(([, p]) => p?.type === "title");
      const rewrite = titleEntry
        ? rewriteTitleDateMentions(
            titleEntry[1].title,
            { start: row.start, end: row.end },
            { start: startDateTime, end: endDateTime },
          )
        : null;
      if (titleEntry && rewrite) {
        properties[titleEntry[0]] = { title: rewrite.richText };
      }

      const patched = await sdk.fetch(`${NOTION_API}/pages/${row.pageId}`, {
        connection: NOTION_CONNECTION,
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties }),
      });
      if (!patched.ok) {
        const text = await patched.text();
        if (PAGE_GONE_PATTERN.test(text)) return { pageGone: true, message: text.slice(0, 300) };
        throw new Error(`Notion update page ${row.pageId} failed (${patched.status}): ${text.slice(0, 300)}`);
      }
      return { pageGone: false, titleMentionsMoved: rewrite?.moved ?? 0 };
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
      titleMentionsMoved: (update as { titleMentionsMoved?: number }).titleMentionsMoved ?? 0,
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
