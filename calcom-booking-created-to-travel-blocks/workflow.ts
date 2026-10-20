// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/calcom-booking-created-to-travel-blocks
//
// Cal.com `booking_created` for the in-person event type (slug `in-person`) →
// two private, busy travel blocks on dennis@work.flowers: 45 minutes before the
// meeting and 45 minutes after it. Cal.com's own before/after buffers only
// block Cal.com slots; these make the travel time visible on Google Calendar.
//
// Siblings: calcom-booking-cancelled-to-travel-blocks deletes the blocks and
// calcom-booking-rescheduled-to-travel-blocks moves them. All three find the
// blocks by the `cal-booking-uid:` line in the description, so keep the
// helpers below byte-identical across the three files.
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
const GCAL_APP_KEY = "GoogleCalendarCLIAPI";
const GCAL_CONNECTION = "gcal_wf";
const CALENDAR_ID = "dennis@work.flowers";
const IN_PERSON_SLUG = "in-person";

// --- Shared travel-block helpers (identical in all three calcom-* Zaps) --------

const TRAVEL_MINUTES = 45;
/** Asia/Singapore has no DST, so a fixed +08:00 offset is exact. */
const SGT_OFFSET_MINUTES = 8 * 60;
const UID_MARKER = "cal-booking-uid:";
const LEG_MARKER = "travel-leg:";
const GONE_PATTERN = /not\s*found|has been deleted|\b410\b|\b404\b/i;

type Leg = "outbound" | "return";

interface Booking {
  uid: string;
  slug: string;
  startMs: number;
  endMs: number;
  attendeeName: string;
  address: string;
}

interface TravelBlock {
  id: string;
  leg: Leg | null;
}

function normalizeInput(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  return JSON.parse(trimmed);
}

/** Empty = no keys, or only known wrapper keys that are themselves empty. */
function isEmptyPing(raw: unknown): boolean {
  if (raw === null || raw === undefined || raw === "") return true;
  if (typeof raw !== "object") return false;
  const WRAPPER_KEYS = new Set(["querystring", "headers", "params", "body", "query"]);
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!WRAPPER_KEYS.has(key)) return false;
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object" && Object.keys(value as object).length === 0) continue;
    return false;
  }
  return true;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function daysFromCivil(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** `YYYY-MM-DD` from epoch milliseconds. */
function isoDateFromEpochMs(ms: number): string {
  const z = Math.floor(ms / 86400000) + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Epoch ms from an ISO 8601 timestamp WITH an offset (`Z` or `±hh:mm`), or
 *  null. A timestamp without an offset is rejected rather than guessed at:
 *  guessing is exactly how an 8-hour shift happens. No `Date` — the
 *  durable runtime's determinism guard forbids it in the workflow body. */
function epochMsFromIso(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, tz] = m;
  let offsetMinutes = 0;
  if (tz !== "Z") {
    const sign = tz[0] === "-" ? -1 : 1;
    const digits = tz.slice(1).replace(":", "");
    offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  }
  const days = daysFromCivil(Number(y), Number(mo), Number(d));
  const minutes = days * 1440 + Number(h) * 60 + Number(mi) - offsetMinutes;
  return minutes * 60000 + Number(s ?? 0) * 1000;
}

/** `YYYY-MM-DDTHH:MM:SS+08:00` — the instant expressed in Singapore time. */
function sgtIso(ms: number): string {
  const local = ms + SGT_OFFSET_MINUTES * 60000;
  const minuteOfDay = Math.floor((((local % 86400000) + 86400000) % 86400000) / 60000);
  const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, "0");
  const mm = String(minuteOfDay % 60).padStart(2, "0");
  return `${isoDateFromEpochMs(local)}T${hh}:${mm}:00+08:00`;
}

/** Pull what the travel blocks need out of a Cal.com booking payload.
 *  Throws on a payload that is not empty but that we cannot read — a real
 *  event in a shape we failed to understand must never be skipped silently. */
function readBooking(payload: unknown): Booking {
  const p = (payload ?? {}) as Record<string, any>;
  const uid = str(p.uid);
  const slug = str(p.eventType?.slug);
  const startMs = epochMsFromIso(str(p.startTime));
  const endMs = epochMsFromIso(str(p.endTime));
  if (!uid || !slug || startMs === null || endMs === null || endMs <= startMs) {
    throw new Error(
      `Unrecognised Cal.com booking payload (uid=${JSON.stringify(p.uid)}, ` +
        `slug=${JSON.stringify(p.eventType?.slug)}, startTime=${JSON.stringify(p.startTime)}, ` +
        `endTime=${JSON.stringify(p.endTime)}) — top-level keys: ${Object.keys(p).join(", ")}`,
    );
  }
  const attendeeName =
    str(p.attendees?.[0]?.name) || str(p.responses?.name?.value) || "attendee";
  const address =
    str(p.location) || str(p.responses?.location?.value?.optionValue) || "not provided";
  return { uid, slug, startMs, endMs, attendeeName, address };
}

function blockDescription(booking: Booking, leg: Leg): string {
  const date = sgtIso(booking.startMs).slice(0, 10);
  const from = sgtIso(booking.startMs).slice(11, 16);
  const to = sgtIso(booking.endMs).slice(11, 16);
  const lead =
    leg === "outbound"
      ? `Travel time to an in-person meeting with ${booking.attendeeName}.`
      : `Travel time back from an in-person meeting with ${booking.attendeeName}.`;
  return [
    lead,
    `Meeting address: ${booking.address}`,
    `Meeting time: ${date}, ${from}–${to} (Singapore time)`,
    "",
    "Added automatically from Cal.com. It is deleted if the booking is cancelled and replaced if it is rescheduled.",
    "",
    `${UID_MARKER} ${booking.uid}`,
    `${LEG_MARKER} ${leg}`,
  ].join("\n");
}

/** Travel blocks on the calendar for one booking uid. Google's free-text search
 *  narrows the candidates; the exact `cal-booking-uid:` line decides. */
async function findTravelBlocks(ctx: DurableContext, stepId: string, uid: string): Promise<TravelBlock[]> {
  const found = await ctx.step(stepId, async () =>
    sdk.runAction({
      appKey: GCAL_APP_KEY,
      actionType: "search",
      actionKey: "event_v2",
      connection: GCAL_CONNECTION,
      inputs: {
        calendarid: CALENDAR_ID,
        search_term: uid,
        _zap_search_success_on_miss: true,
      },
    }),
  );
  const blocks: TravelBlock[] = [];
  for (const raw of ((found as { data?: unknown[] }).data ?? [])) {
    const event = (raw ?? {}) as Record<string, unknown>;
    const id = str(event.id);
    const lines = str(event.description).split(/\r?\n/).map((l) => l.trim());
    if (!id || str(event.status) === "cancelled") continue;
    if (!lines.includes(`${UID_MARKER} ${uid}`)) continue;
    const legLine = lines.find((l) => l.startsWith(LEG_MARKER)) ?? "";
    const leg = legLine.slice(LEG_MARKER.length).trim();
    blocks.push({ id, leg: leg === "outbound" || leg === "return" ? leg : null });
  }
  return blocks;
}

/** Delete each block. Already gone is the outcome we wanted. */
async function deleteTravelBlocks(ctx: DurableContext, stepPrefix: string, blocks: TravelBlock[]): Promise<string[]> {
  const deleted: string[] = [];
  for (const [i, block] of blocks.entries()) {
    await ctx.step(`${stepPrefix}-${i}`, async () => {
      try {
        return await sdk.runAction({
          appKey: GCAL_APP_KEY,
          actionType: "write",
          actionKey: "delete_event",
          connection: GCAL_CONNECTION,
          inputs: { calendarid: CALENDAR_ID, eventid: block.id, send_notifications: false },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (GONE_PATTERN.test(message)) return { alreadyGone: true };
        throw error;
      }
    });
    deleted.push(block.id);
  }
  return deleted;
}

/** Create whichever of the two legs is not already on the calendar. The check
 *  makes a duplicate trigger delivery harmless rather than doubling the blocks. */
async function createTravelBlocks(ctx: DurableContext, stepPrefix: string, booking: Booking): Promise<Record<Leg, string>> {
  const existing = await findTravelBlocks(ctx, `${stepPrefix}-find-existing`, booking.uid);
  const travelMs = TRAVEL_MINUTES * 60000;
  const legs: Array<{ leg: Leg; summary: string; startMs: number; endMs: number }> = [
    { leg: "outbound", summary: `Travel → ${booking.attendeeName}`, startMs: booking.startMs - travelMs, endMs: booking.startMs },
    { leg: "return", summary: `Travel back from ${booking.attendeeName}`, startMs: booking.endMs, endMs: booking.endMs + travelMs },
  ];
  const ids = {} as Record<Leg, string>;
  for (const spec of legs) {
    const already = existing.find((b) => b.leg === spec.leg);
    if (already) {
      ids[spec.leg] = already.id;
      continue;
    }
    const created = await ctx.step(`${stepPrefix}-create-${spec.leg}`, async () =>
      sdk.runAction({
        appKey: GCAL_APP_KEY,
        actionType: "write",
        actionKey: "detailed_event",
        connection: GCAL_CONNECTION,
        inputs: {
          calendarid: CALENDAR_ID,
          summary: spec.summary,
          description: blockDescription(booking, spec.leg),
          start__dateTime: sgtIso(spec.startMs),
          end__dateTime: sgtIso(spec.endMs),
          transparency: "opaque",
          visibility: "private",
          all_day: false,
          reminders__useDefault: false,
        },
      }),
    );
    const id = str((created as { data?: Array<{ id?: unknown }> }).data?.[0]?.id);
    if (!id) throw new Error(`detailed_event returned no event id for the ${spec.leg} leg of ${booking.uid}`);
    ids[spec.leg] = id;
  }
  return ids;
}

// --- Workflow --------------------------------------------------------------------

const workflow = defineDurable("calcom-booking-created-to-travel-blocks", async (ctx, rawInput) => {
  const payload = normalizeInput(rawInput);
  if (isEmptyPing(payload)) {
    console.log("empty payload — skipping");
    return { skipped: "empty-payload" };
  }

  const booking = readBooking(payload);
  if (booking.slug !== IN_PERSON_SLUG) {
    return { skipped: "not-in-person", uid: booking.uid, slug: booking.slug };
  }

  const blocks = await createTravelBlocks(ctx, "travel", booking);
  return { uid: booking.uid, attendee: booking.attendeeName, blocks };
});

export default workflow;
