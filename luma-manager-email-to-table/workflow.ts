// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/luma-manager-email-to-table
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { createZapierSdk as createExperimentalSdk } from "@zapier/zapier-sdk/experimental";

const sdk = createZapierSdk();
// listWorkflows / triggerWorkflow live on the experimental surface and use the
// durable's ambient account credentials (no connection). `any` because the
// experimental method shapes shift release to release.
const workflows = createExperimentalSdk() as any;

// --- Bindings --------------------------------------------------------------
// The Gmail credential lives on the TRIGGER (zap.json trigger.authentication_id);
// this code never calls Gmail.
//
// The private "Luma Calendar API" integration (work-flowers/zapier-luma-hosted),
// bound to the Notion Singapore calendar's API key. Its two polling triggers are
// also exposed as READ actions, which is how the backfill below lists one
// event and its guests on demand.
const LUMA_APP_KEY = "App247901CLIAPI";
const LUMA_CONNECTION = "luma_notionsg";

// Events Dennis manages. Read by the two workflows below, which skip any event
// not listed here. Columns: Luma Event ID, Event Name, Source, Email Date,
// Gmail Message ID, Backfill Status.
const MANAGED_EVENTS_TABLE = "01M4ZRWQAHCB41XGGJ263S9BDH";

// Backfill targets, resolved by NAME at run time: this Zap shipped in the same
// PR that created them, so their workflow ids did not exist to hardcode.
// Resolution refuses on anything but exactly one match.
const EVENT_WORKFLOW_NAME = "luma-hosted-event-to-notion";
const GUEST_WORKFLOW_NAME = "luma-hosted-guest-to-event-attendance";

/** Luma sends these from <sender>@user.luma-mail.com, @calendar.luma-mail.com
 *  or noreply@luma-mail.com. */
const LUMA_SENDER_RE = /(^|[@.])luma-mail\.com$/i;

/** How far back the backfill looks for the event. The integration's triggers
 *  default to 2 days; a host invite for an event that ended last week should
 *  still pick up its check-ins. */
const BACKFILL_LOOKBACK_DAYS = 30;

/** Guests are fired in batches so the guest workflow's Notion writes don't all
 *  land in the same second (Notion allows ~3 requests/s per integration). */
const GUEST_BATCH_SIZE = 10;
const GUEST_BATCH_PAUSE_SECONDS = 30;

/** Time for the event workflow to create the Event page before guests start
 *  resolving it. The guest workflow waits and falls back on its own too. */
const EVENT_PAGE_HEAD_START_SECONDS = 120;

// --- Pure helpers ----------------------------------------------------------
export function normalizeInput(rawInput: unknown): unknown {
  let v: unknown = rawInput;
  for (let i = 0; i < 4 && typeof v === "string"; i++) {
    const t = v.trim();
    if (t[0] !== "{" && t[0] !== "[" && t[0] !== '"') break;
    try {
      v = JSON.parse(t);
    } catch {
      break;
    }
  }
  return v;
}

/** Empty = no keys, or only wrapper keys with nothing in them. */
export function isEmptyPing(raw: unknown): boolean {
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

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

export type ManagerSource = "host-invite" | "created";

export interface ManagerEmail {
  eventId: string;
  eventName: string | null;
  source: ManagerSource;
  messageId: string | null;
  date: string | null;
}

/**
 * The two Luma emails that make Dennis a manager of an event, both observed in
 * his inbox:
 *   - "Please join me as a host for <event>" — a host (incl. hidden host) invite.
 *     Body: "You have manage access to this event." The access is immediate.
 *   - "<event> is live on Luma" — sent to the creator of an event.
 * Both carry `https://luma.com/event/manage/evt-…`, which is where the id comes
 * from (the subject only has the name, and names are not unique).
 *
 * Returns { skip } for a recognisable email that is not one of these (another
 * Luma notice the Gmail query let through), and { error } for one that IS one of
 * these but has no event id, which the workflow throws on: that is Luma changing
 * the email, and it must surface rather than silently stop recording events.
 */
export function parseManagerEmail(
  raw: unknown,
): { email: ManagerEmail } | { skip: string } | { error: string } {
  const m = (raw ?? {}) as Record<string, any>;
  const subject = firstString(m.subject) ?? "";
  const from = (firstString(m.from?.email, m.from_email, m.from) ?? "").toLowerCase();
  if (!subject && !from) {
    return { error: `Unrecognised payload: no subject or sender. Keys: ${Object.keys(m).slice(0, 20).join(", ")}` };
  }
  const fromAddress = from.match(/[^\s<>"]+@[^\s<>"]+/)?.[0] ?? from;
  if (!LUMA_SENDER_RE.test(fromAddress.split("@")[1] ?? "")) {
    return { skip: `not from Luma: ${fromAddress}` };
  }

  let source: ManagerSource;
  let eventName: string | null;
  const invite = subject.match(/^Please join me as a host for (.+)$/i);
  const live = subject.match(/^(.+) is live on Luma$/i);
  if (invite) {
    source = "host-invite";
    eventName = invite[1].trim();
  } else if (live) {
    source = "created";
    eventName = live[1].trim();
  } else {
    return { skip: `not a manager email: "${subject}"` };
  }

  const body = [firstString(m.body_plain), firstString(m.body_html), firstString(m.raw?.snippet)]
    .filter(Boolean)
    .join("\n");
  const id =
    body.match(/luma\.com\/event\/manage\/(evt-[A-Za-z0-9]+)/)?.[1] ??
    body.match(/lu\.ma\/event\/manage\/(evt-[A-Za-z0-9]+)/)?.[1] ??
    null;
  if (!id) {
    return { error: `Luma ${source} email "${subject}" has no luma.com/event/manage/evt-… link` };
  }
  return {
    email: {
      eventId: id,
      eventName,
      source,
      messageId: firstString(m.message_id, m.id),
      date: firstString(m.date),
    },
  };
}

/** Guests worth sending to the guest workflow: anyone past `invited`, or who
 *  checked in. Mirrors isInvitedOnly() in the guest workflow, so the backfill
 *  doesn't spend a run per bulk invitee only for it to be skipped. */
export function isBackfillGuest(g: Record<string, any>): boolean {
  const status = (firstString(g?.approval_status) ?? "").toLowerCase();
  const checkedIn = firstString(g?.checked_in_at, g?.joined_at) !== null;
  return status !== "invited" || checkedIn;
}

/** Fields of a guest item the guest workflow never reads. Dropped so the step
 *  journal stays small on a large event. */
const DROP_GUEST_KEYS = ["check_in_qr_code", "eth_address", "solana_address", "attribution_params"];

function slimGuest(g: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(g)) if (!DROP_GUEST_KEYS.includes(k)) out[k] = v;
  return out;
}

/**
 * Fire the guest workflow once per guest, in batches. A helper taking `ctx`
 * because the step ids carry an index, which the publish-time analyzer only
 * accepts outside the workflow body (see durables-sdk.md).
 */
async function fireGuests(
  ctx: any,
  guestWorkflowId: string,
  guests: Array<Record<string, any>>,
): Promise<number> {
  let fired = 0;
  for (let i = 0; i < guests.length; i++) {
    if (i > 0 && i % GUEST_BATCH_SIZE === 0) {
      await ctx.wait(`guest-batch-pause-${i / GUEST_BATCH_SIZE}`, GUEST_BATCH_PAUSE_SECONDS);
    }
    const input = { ...guests[i], source: "backfill" };
    await ctx.step(`fire-guest-${i}`, async () => {
      const res = await workflows.triggerWorkflow({ workflow: guestWorkflowId, input });
      return { triggerId: res?.data?.id ?? null };
    });
    fired++;
  }
  return fired;
}

// --- Workflow ----------------------------------------------------------------
// Why a backfill: the integration's triggers emit every event and guest on the
// Notion Singapore calendar, and the two workflows skip anything not in
// MANAGED_EVENTS_TABLE. An event usually exists — with guests — before Dennis
// is added as a host, so the triggers have already delivered (and the
// workflows skipped) it. Durables never re-deliver an id, so without this the
// event and every guest who registered before the invite would be lost.
// sdk.triggerWorkflow is NOT subject to the trigger dedupe (verified
// 2026-10-15: two fires with the same top-level id both ran).
const workflow = defineDurable("luma-manager-email-to-table", async (ctx, rawInput: unknown) => {
  const payload = normalizeInput(rawInput);
  if (isEmptyPing(payload)) {
    console.log("skipping: empty payload (manual test or ping)");
    return { skipped: "empty-payload" };
  }
  const parsed = parseManagerEmail(payload);
  if ("error" in parsed) throw new Error(parsed.error);
  if ("skip" in parsed) {
    console.log(`skipping: ${parsed.skip}`);
    return { skipped: parsed.skip };
  }
  const email = parsed.email;

  // 1. Record the event as managed (idempotent on the event id).
  const existing = await ctx.step("find-managed-row", async () =>
    sdk.listTableRecords({
      table: MANAGED_EVENTS_TABLE,
      keyMode: "names",
      filters: [{ fieldKey: "Luma Event ID", operator: "exact", value: email.eventId }],
      pageSize: 1,
    }),
  );
  const existingRow = existing?.data?.[0] ?? null;
  const priorStatus = firstString(existingRow?.data?.["Backfill Status"]) ?? "";
  if (existingRow && /^(done|not-on-calendar)/.test(priorStatus)) {
    // A second email for the same event (re-invite, or invite + "is live").
    console.log(`${email.eventId} already recorded (${priorStatus})`);
    return { lumaEventId: email.eventId, alreadyRecorded: true, backfillStatus: priorStatus };
  }

  let recordId: string | null = firstString(existingRow?.id);
  if (!recordId) {
    const created = await ctx.step("record-managed-event", async () =>
      sdk.createTableRecords({
        table: MANAGED_EVENTS_TABLE,
        keyMode: "names",
        records: [
          {
            data: {
              "Luma Event ID": email.eventId,
              "Event Name": email.eventName ?? "",
              Source: email.source,
              "Email Date": email.date ?? "",
              "Gmail Message ID": email.messageId ?? "",
              "Backfill Status": "pending",
            },
          },
        ],
      }),
    );
    recordId = firstString((created as any)?.data?.[0]?.id);
  }
  const rowId = recordId;

  // 2. Is it on the Notion Singapore calendar at all? Host invites for other
  // calendars (workFlowers, Zapier, Lenny's…) land here too; the key can't see
  // those, so there is nothing to backfill and the row is kept for the record.
  const eventRead = await ctx.step("read-event", async () =>
    sdk.runAction({
      appKey: LUMA_APP_KEY,
      actionType: "read",
      actionKey: "new_event",
      connection: LUMA_CONNECTION,
      inputs: { event_ids: [email.eventId], lookback_days: BACKFILL_LOOKBACK_DAYS },
    }),
  );
  const event = (eventRead as any)?.data?.[0] ?? null;
  if (!event) {
    if (rowId) {
      await ctx.step("mark-not-on-calendar", async () =>
        sdk.updateTableRecords({
          table: MANAGED_EVENTS_TABLE,
          keyMode: "names",
          records: [{ id: rowId, data: { "Backfill Status": "not-on-calendar" } }],
        }),
      );
    }
    return { lumaEventId: email.eventId, eventName: email.eventName, backfill: "not-on-calendar" };
  }

  // 3. Resolve the two target workflows by name.
  const targets = await ctx.step("resolve-target-workflows", async () => {
    const found: Record<string, string[]> = { [EVENT_WORKFLOW_NAME]: [], [GUEST_WORKFLOW_NAME]: [] };
    for await (const w of workflows.listWorkflows().items()) {
      if (w?.name in found) found[w.name].push(w.id);
    }
    for (const [name, ids] of Object.entries(found)) {
      if (ids.length !== 1) {
        throw new Error(`Expected exactly one workflow named ${name}, found ${ids.length}`);
      }
    }
    return { eventWorkflowId: found[EVENT_WORKFLOW_NAME][0], guestWorkflowId: found[GUEST_WORKFLOW_NAME][0] };
  });

  // 4. The event first, then give it a head start on creating the Event page.
  await ctx.step("fire-event", async () => {
    const res = await workflows.triggerWorkflow({
      workflow: targets.eventWorkflowId,
      input: { ...event, source: "backfill" },
    });
    return { triggerId: res?.data?.id ?? null };
  });
  await ctx.wait("let-event-page-land", EVENT_PAGE_HEAD_START_SECONDS);

  // 5. Every guest past `invited`.
  const guests = await ctx.step("read-guests", async () => {
    const res: any = await sdk.runAction({
      appKey: LUMA_APP_KEY,
      actionType: "read",
      actionKey: "new_or_updated_guest",
      connection: LUMA_CONNECTION,
      inputs: { event_ids: [email.eventId], lookback_days: BACKFILL_LOOKBACK_DAYS },
    });
    const all: Array<Record<string, any>> = Array.isArray(res?.data) ? res.data : [];
    return { total: all.length, items: all.filter(isBackfillGuest).map(slimGuest) };
  });

  const fired = await fireGuests(ctx, targets.guestWorkflowId, guests.items);
  const status = `done: ${fired} guests fired, ${guests.total - guests.items.length} invited skipped`;
  if (rowId) {
    await ctx.step("mark-backfilled", async () =>
      sdk.updateTableRecords({
        table: MANAGED_EVENTS_TABLE,
        keyMode: "names",
        records: [{ id: rowId, data: { "Backfill Status": status } }],
      }),
    );
  }

  return {
    lumaEventId: email.eventId,
    eventName: firstString(event?.name) ?? email.eventName,
    source: email.source,
    guestsTotal: guests.total,
    guestsFired: fired,
    backfill: status,
  };
});

export default workflow;
