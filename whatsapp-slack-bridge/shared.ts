// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/whatsapp-slack-bridge
//
// Shared bindings, helpers and Table access for the three WhatsApp <-> Slack
// durables. Published as `shared.ts` alongside each deployment's `workflow.ts`.
import { createZapierSdk } from "@zapier/zapier-sdk";

export const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------

export const WHATSAPP_APP = "App228834CLIAPI";
export const SLACK_APP = "SlackCLIAPI";

/** Connection aliases resolved at publish time via `--connections`. */
export const WHATSAPP_CONNECTION = "whatsapp_wf";
export const SLACK_CONNECTION = "slack_wf";

/**
 * "Make File Public (Custom Action)" — an account-private Slack custom action.
 *
 * LOAD-BEARING and invisible: it is not in Slack's public action catalog, it
 * lives only in this Zapier account, and deleting it breaks every outbound file
 * reply with no warning here. It exists because WhatsApp's `send_media_message`
 * takes a `file_url` that Meta's servers fetch themselves, and Slack's
 * `url_private` is auth-gated, so the file has to be publicly shared first.
 * The classic "Slack Replies -> WhatsApp" Zap used this same action.
 *
 * Consequence worth knowing: a file replied from Slack stays publicly
 * reachable at an unguessable URL indefinitely. There is a sibling
 * `ae:395244` ("Revoke Public URL") but we do not call it — Meta may re-fetch
 * the media on re-delivery, and revoking too early would break the send.
 */
export const SLACK_MAKE_FILE_PUBLIC = "ae:395232";

// --- Zapier Tables ---------------------------------------------------------
// Table reads and writes cost no tasks, so every lookup and guard below is
// free. That is what lets the Slack workflow discard a non-WhatsApp message
// without billing anything.

export const CONTACTS_TABLE = "01JKFHWQ82EFBHNP6XYD0M7JHK";
export const MESSAGES_TABLE = "01KGH12QJKABVJ5H5A3Z5A4NW4";
export const USERS_TABLE = "01JM3J9SG5X6S8GBSSC8AS28AT";

// Contacts — "[Table] WhatsApp Contact Info and Opt-In".
export const C_PHONE = "WhatsApp Phone Number ID";
export const C_USERNAME = "WhatsApp Username";
export const C_FIRST_NAME = "First Name";
export const C_OPT_IN = "WhatsApp Marketing Opt-In";
export const C_OPT_OUT_DATE = "Opt-Out Date";
export const C_OPT_OUT_SOURCE = "Opt-Out Source";
export const C_CHANNEL = "Slack Channel ID";

// Message Logs — "[Table] WhatsApp Message Logs".
export const M_FROM = "From";
export const M_TO = "To";
export const M_CREATED = "Created";
export const M_STATUS = "Status";
export const M_BODY = "Body";
export const M_MESSAGE_ID = "Message ID";
export const M_MESSAGE_TS = "Message Ts";
export const M_DIRECTION = "Direction";

// Internal User IDs — "[Table] Internal User IDs".
export const U_SLACK_USER_ID = "Slack User ID";
export const U_FIRST_NAME = "First Name";

// --- Configuration ---------------------------------------------------------

/**
 * Our WhatsApp Business display number, digits only.
 *
 * Was a Zapier "Component variable" in the classic Zaps, invisible to review.
 * Confirmed from the Message Logs Table: outbound rows carry
 * From = 6580839785. An earlier number (15559393947) appears on 2026-05 rows,
 * which is exactly why `Direction` is now stored explicitly rather than
 * inferred by comparing From against this constant.
 */
export const BUSINESS_PHONE = "6580839785";

/** #zap-alerts — where send failures are reported in addition to in-thread. */
export const ALERT_CHANNEL = "C08HDR2RJ6Q";

/** Every per-contact Slack channel is named `whatsapp-<slug>`. */
export const CHANNEL_PREFIX = "whatsapp-";

/**
 * WhatsApp's customer-service window. Outside it, only an approved template
 * may be sent, and a freeform send fails at Meta rather than at Zapier.
 */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Auto-reply for a message WhatsApp itself could not represent (`type:
 * "unsupported"` — polls, view-once, some interactive messages).
 *
 * Deliberately says nothing about "WhatsApp's API": that blames a system the
 * customer has no relationship with, and the limitation is ours to explain.
 */
export const UNSUPPORTED_REPLY =
  "Sorry — that message didn't come through on our end. " +
  "Could you resend it as text, a photo, or a file?";

/** Word-boundary opt-out keywords. `icontains` in the classic Zap meant "I
 *  don't want to unsubscribe" opted the sender out. */
const OPT_OUT_PATTERN = /\b(stop|unsubscribe)\b/i;

/** Monotonic status ranking. WhatsApp does not guarantee webhook ordering, so
 *  a late `delivered` must not overwrite `read`. `failed` is terminal. */
const STATUS_RANK: Record<string, number> = {
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
};

/**
 * Message-log columns that only ever get filled, never rewritten.
 *
 * These describe the message itself, and the writer closest to the event gets
 * them right. Both the sending workflows and the status workflow write the same
 * row, and status receipts arrive later and carry less.
 */
const FILL_ONLY_FIELDS = new Set<string>([M_CREATED, M_BODY, M_MESSAGE_TS]);

// --- Pure helpers ----------------------------------------------------------

/** Minimal structural view of the durable context these helpers need. */
export interface StepCtx {
  step<T>(name: string, run: () => Promise<T>): Promise<T>;
}

export function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline can deliver input double-encoded (a JSON string of a
  // JSON string), while run-durable delivers it single-encoded.
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

export function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** A Zapier Table `labeled_string` cell reads back as `{ value, label }`. */
export function labeledValue(cell: unknown): string | null {
  if (cell && typeof cell === "object" && "value" in (cell as any)) {
    return firstString((cell as any).value);
  }
  return firstString(cell);
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

/**
 * `YYYY-MM-DDTHH:MM:SSZ` from epoch milliseconds, by integer arithmetic.
 *
 * No `Date` anywhere: `@zapier/zapier-durable` proxies the `Date` constructor
 * and its `construct` trap asserts BEFORE inspecting arguments, so even a
 * perfectly deterministic `new Date(ms)` throws `DeterminismViolation` in the
 * workflow body. This helper is safe to call from anywhere.
 */
export function isoFromEpochMs(ms: number): string {
  const dayMs = 86400000;
  let days = Math.floor(ms / dayMs);
  let rem = ms - days * dayMs;
  if (rem < 0) {
    rem += dayMs;
    days -= 1;
  }
  const secOfDay = Math.floor(rem / 1000);
  const hh = Math.floor(secOfDay / 3600);
  const mm = Math.floor((secOfDay % 3600) / 60);
  const ss = secOfDay % 60;

  const z = days + 719468;
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

  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(y, 4)}-${p(m)}-${p(d)}T${p(hh)}:${p(mm)}:${p(ss)}Z`;
}

/**
 * Epoch milliseconds from an ISO-ish datetime string, or null.
 *
 * Hand-parsed rather than via `Date.parse` — `Date.parse` happens to be
 * unguarded today because the proxy's `get` trap only special-cases `now`, but
 * that is an implementation detail worth not depending on. A trailing offset
 * other than `Z` is honoured so a Table value written by another writer still
 * compares correctly.
 */
export function epochMsFromIso(v: unknown): number | null {
  const s = firstString(v);
  if (!s) return null;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      s,
    );
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const hh = Number(m[4] ?? 0);
  const mi = Number(m[5] ?? 0);
  const ss = Number(m[6] ?? 0);
  let ms = (daysFromCivil(y, mo, d) * 86400 + hh * 3600 + mi * 60 + ss) * 1000;
  const off = m[7];
  if (off && off !== "Z") {
    const sign = off[0] === "-" ? -1 : 1;
    const digits = off.slice(1).replace(":", "");
    ms -= sign * (Number(digits.slice(0, 2)) * 3600 + Number(digits.slice(2, 4)) * 60) * 1000;
  }
  return ms;
}

/**
 * WhatsApp wa_ids are already digits-only E.164 without the `+`. This only
 * repairs values read back out of the Table, where a `00` international prefix
 * was hand-entered (`00919819221961` -> `919819221961`).
 *
 * A number stored with no country code at all (the Table holds one `85109301`)
 * cannot be repaired by guessing, and is returned unchanged.
 */
export function normalizePhone(v: unknown): string | null {
  const s = firstString(v);
  if (!s) return null;
  let digits = s.replace(/[^0-9]/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  return digits === "" ? null : digits;
}

/** The leading word of a display name, for the `First Name` column. */
export function firstToken(v: unknown): string | null {
  const s = firstString(v);
  if (!s) return null;
  const tok = s.split(/\s+/)[0];
  return tok && tok !== "" ? tok : null;
}

/**
 * `whatsapp-<slug>` for a Slack channel name.
 *
 * Slack allows lowercase letters, digits, hyphens and underscores, max 80
 * chars. Falls back to the phone number when the WhatsApp profile name is
 * missing or slugs down to nothing (a name written entirely in a script that
 * strips to empty).
 */
export function channelNameFor(displayName: unknown, phone: string): string {
  const slug = (firstString(displayName) ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = slug !== "" ? slug : phone.replace(/[^0-9]/g, "");
  return (CHANNEL_PREFIX + base).slice(0, 80);
}

export function isOptOutMessage(text: unknown): boolean {
  const s = firstString(text);
  return s != null && OPT_OUT_PATTERN.test(s);
}

/** Does this Slack channel belong to the WhatsApp bridge, by name? */
export function isBridgeChannelName(name: unknown): boolean {
  const s = firstString(name);
  return s != null && s.toLowerCase().startsWith(CHANNEL_PREFIX);
}

/** Map a Slack file's mimetype onto a WhatsApp `media_type`. */
export function mediaTypeFor(mimetype: unknown, filetype: unknown): string {
  const mt = (firstString(mimetype) ?? "").toLowerCase();
  if (mt.startsWith("image/")) return "image";
  if (mt.startsWith("video/")) return "video";
  if (mt.startsWith("audio/")) return "audio";
  // Anything else rides as a document rather than being dropped, which is what
  // the classic Zap did to every non-PDF, non-image attachment.
  const ft = (firstString(filetype) ?? "").toLowerCase();
  if (ft === "png" || ft === "jpg" || ft === "jpeg" || ft === "gif" || ft === "webp") return "image";
  return "document";
}

/** WhatsApp accepts a caption on image/video/document, but NOT on audio. */
export function acceptsCaption(mediaType: string): boolean {
  return mediaType === "image" || mediaType === "video" || mediaType === "document";
}

/**
 * Human-readable stand-in for a message with no text of its own, so the Slack
 * channel shows what arrived instead of the classic Zap's "No Text".
 */
export function placeholderForType(type: string, payload: Record<string, any>): string {
  const node = (payload?.[type] ?? {}) as Record<string, any>;
  const name = firstString(node.filename, node.name);
  switch (type) {
    case "audio":
      return node.voice === true || node.voice === "true" ? "🎤 Voice note" : "🎵 Audio";
    case "image":
      return "🖼️ Image";
    case "video":
      return "🎬 Video";
    case "document":
      return name ? `📄 ${name}` : "📄 Document";
    case "sticker":
      return "🌟 Sticker";
    case "location":
      return "📍 Location";
    case "contacts":
      return "👤 Contact card";
    case "reaction":
      return firstString(node.emoji) ? `Reacted ${firstString(node.emoji)}` : "Reacted";
    case "unsupported":
      return "⚠️ Unsupported message type";
    default:
      return type ? `(${type} message)` : "(no text)";
  }
}

/** The file the WhatsApp trigger auto-downloaded for a media message, if any.
 *
 *  Read defensively: only `image.file` is proven from the classic Zap's
 *  mapping, and the per-type nodes are not individually documented. Trying
 *  several key spellings is cheaper than being wrong about one. */
export function inboundFileUrl(type: string, payload: Record<string, any>): string | null {
  const node = (payload?.[type] ?? {}) as Record<string, any>;
  return firstString(node.file, node.file_url, node.url, node.link);
}

// --- Table access ----------------------------------------------------------

async function rowsWhere(table: string, fieldKey: string, value: string): Promise<any[]> {
  const hit = await sdk.listTableRecords({
    table,
    keyMode: "names",
    filters: [{ fieldKey, operator: "exact", value }],
    pageSize: 200,
  });
  // Oldest ULID first, so concurrent runs independently agree on a winner.
  return [...((hit as any)?.data ?? [])].sort((a: any, b: any) =>
    String(a.id).localeCompare(String(b.id)),
  );
}

export async function findContactRows(phone: string): Promise<any[]> {
  return rowsWhere(CONTACTS_TABLE, C_PHONE, phone);
}

/** The contact whose conversation lives in this Slack channel, or null. */
export async function findContactByChannel(channelId: string): Promise<any | null> {
  const rows = await rowsWhere(CONTACTS_TABLE, C_CHANNEL, channelId);
  return rows[0] ?? null;
}

export async function findMessageRowsById(messageId: string): Promise<any[]> {
  return rowsWhere(MESSAGES_TABLE, M_MESSAGE_ID, messageId);
}

export async function findMessageRowsByTs(ts: string): Promise<any[]> {
  return rowsWhere(MESSAGES_TABLE, M_MESSAGE_TS, ts);
}

export async function findInternalUser(slackUserId: string): Promise<any | null> {
  const rows = await rowsWhere(USERS_TABLE, U_SLACK_USER_ID, slackUserId);
  return rows[0] ?? null;
}

/**
 * Find-or-create the contact row for a phone number, race-safely.
 *
 * The classic Zap's "Find or Create User Record" raced itself: the Table holds
 * 42 rows for 34 distinct phones, and 6591520097 acquired FIVE rows inside
 * 0.54 seconds when a burst of messages each created its own.
 *
 * Pre-existing duplicates are deliberately left alone — picking the earliest
 * ULID makes the choice deterministic, and `patch` heals the winner from live
 * trigger data. Only duplicates this run itself created are removed.
 */
export async function upsertContact(
  ctx: StepCtx,
  label: string,
  phone: string,
  create: Record<string, unknown>,
  patch: (existing: Record<string, any>) => Record<string, unknown>,
): Promise<any | null> {
  const rows = await ctx.step(`${label}-find-contact`, async () => findContactRows(phone));

  if (rows.length === 0) {
    await ctx.step(`${label}-create-contact`, async () =>
      sdk.createTableRecords({
        table: CONTACTS_TABLE,
        keyMode: "names",
        records: [{ data: { [C_PHONE]: phone, ...create } }],
      }),
    );
    const after = await ctx.step(`${label}-recheck-contact`, async () => findContactRows(phone));
    if (after.length > 1) {
      await ctx.step(`${label}-dedupe-contact`, async () =>
        sdk.deleteTableRecords({
          table: CONTACTS_TABLE,
          records: after.slice(1).map((r: any) => r.id),
        }),
      );
      console.log(`contact ${phone}: created and removed ${after.length - 1} racing duplicate(s)`);
    }
    return after[0] ?? null;
  }

  const winner = rows[0];
  if (rows.length > 1) {
    console.log(
      `contact ${phone}: ${rows.length} pre-existing rows, using earliest ULID ${winner.id}`,
    );
  }
  const changes = patch((winner?.data ?? {}) as Record<string, any>);
  if (Object.keys(changes).length > 0) {
    await ctx.step(`${label}-update-contact`, async () =>
      sdk.updateTableRecords({
        table: CONTACTS_TABLE,
        keyMode: "names",
        records: [{ id: String(winner.id), data: changes }],
      }),
    );
    return { ...winner, data: { ...(winner.data ?? {}), ...changes } };
  }
  return winner;
}

export interface MessageLogPatch {
  messageId: string;
  from?: string | null;
  to?: string | null;
  createdIso?: string | null;
  status?: string | null;
  body?: string | null;
  messageTs?: string | null;
  direction?: "inbound" | "outbound" | null;
}

/**
 * Find-or-create the log row for a WhatsApp message id, race-safely, applying
 * a monotonic status and never blanking a value that is already there.
 *
 * The merge matters because two workflows write the same row from opposite
 * directions: `whatsapp-message-status` can create it from a delivery receipt
 * before the sending workflow has logged the body. 27 of 89 existing rows have
 * a null Body for exactly that reason (plus template sends, which never logged
 * at all).
 */
export async function upsertMessageLog(
  ctx: StepCtx,
  label: string,
  p: MessageLogPatch,
): Promise<any | null> {
  const rows = await ctx.step(`${label}-find-log`, async () => findMessageRowsById(p.messageId));

  const fresh: Record<string, unknown> = { [M_MESSAGE_ID]: p.messageId };
  if (p.from) fresh[M_FROM] = p.from;
  if (p.to) fresh[M_TO] = p.to;
  if (p.createdIso) fresh[M_CREATED] = p.createdIso;
  if (p.status) fresh[M_STATUS] = p.status;
  if (p.body) fresh[M_BODY] = p.body;
  if (p.messageTs) fresh[M_MESSAGE_TS] = p.messageTs;
  if (p.direction) fresh[M_DIRECTION] = p.direction;

  if (rows.length === 0) {
    await ctx.step(`${label}-create-log`, async () =>
      sdk.createTableRecords({
        table: MESSAGES_TABLE,
        keyMode: "names",
        records: [{ data: fresh }],
      }),
    );
    const after = await ctx.step(`${label}-recheck-log`, async () =>
      findMessageRowsById(p.messageId),
    );
    if (after.length > 1) {
      await ctx.step(`${label}-dedupe-log`, async () =>
        sdk.deleteTableRecords({
          table: MESSAGES_TABLE,
          records: after.slice(1).map((r: any) => r.id),
        }),
      );
    }
    return after[0] ?? null;
  }

  const winner = rows[0];
  const stored = (winner?.data ?? {}) as Record<string, any>;
  const changes: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fresh)) {
    if (key === M_MESSAGE_ID) continue;

    if (key === M_STATUS) {
      const incoming = STATUS_RANK[String(value)] ?? 0;
      const current = STATUS_RANK[labeledValue(stored[M_STATUS]) ?? ""] ?? 0;
      if (incoming > current) changes[M_STATUS] = value;
      continue;
    }

    const existing = key === M_DIRECTION ? labeledValue(stored[key]) : firstString(stored[key]);

    if (FILL_ONLY_FIELDS.has(key)) {
      // Whoever wrote it first was closer to the event. A `read` receipt can
      // arrive hours after the send, so letting it restate Created would
      // rewrite the message's own timestamp; and a status receipt carries no
      // body, so it must never blank one.
      if (existing == null) changes[key] = value;
      continue;
    }

    // Correctable: fill a gap or fix drift, but never blank an existing value.
    if (existing == null || existing !== String(value)) changes[key] = value;
  }

  if (Object.keys(changes).length === 0) return winner;

  await ctx.step(`${label}-update-log`, async () =>
    sdk.updateTableRecords({
      table: MESSAGES_TABLE,
      keyMode: "names",
      records: [{ id: String(winner.id), data: changes }],
    }),
  );
  return { ...winner, data: { ...stored, ...changes } };
}

/**
 * Epoch ms of the customer's most recent inbound message, or null.
 *
 * Filters on From = the customer's number, which selects inbound rows without
 * relying on `Direction` being populated on historical rows.
 */
export async function lastInboundAtMs(phone: string): Promise<number | null> {
  const rows = await rowsWhere(MESSAGES_TABLE, M_FROM, phone);
  let latest: number | null = null;
  for (const r of rows) {
    const ms = epochMsFromIso((r?.data ?? {})[M_CREATED]);
    if (ms != null && (latest == null || ms > latest)) latest = ms;
  }
  return latest;
}

// --- App actions -----------------------------------------------------------

export interface SlackPost {
  channel: string;
  text: string;
  username?: string | null;
  threadTs?: string | null;
  fileUrl?: string | null;
}

/** Post into Slack as the WhatsApp bot. One app action, one step. */
export function postToSlack(ctx: StepCtx, label: string, post: SlackPost): Promise<any> {
  const inputs: Record<string, unknown> = {
    channel: post.channel,
    text: post.text,
    as_bot: "yes",
    add_app_to_channel: "yes",
    unfurl: "yes",
    link_names: "yes",
    icon: ":whatsapp:",
  };
  if (post.username) inputs.username = post.username;
  if (post.threadTs) inputs.thread_ts = post.threadTs;
  if (post.fileUrl) inputs.file = post.fileUrl;

  return ctx.step(label, async () =>
    sdk.runAction({
      appKey: SLACK_APP,
      actionType: "write",
      actionKey: "channel_message",
      connection: SLACK_CONNECTION,
      inputs,
    }),
  );
}

/** The Slack `ts` of a message this workflow just posted. */
export function postedTs(result: unknown): string | null {
  const row = (result as any)?.data?.[0];
  return firstString(row?.message?.ts, row?.ts);
}

/** The WhatsApp message id returned by a send. The classic Zap looked this up
 *  as `.id` while writing `messages[]id`, so the lookup ran with an empty
 *  value; both now come from one place. */
export function sentMessageId(result: unknown): string | null {
  const row = (result as any)?.data?.[0];
  return firstString(row?.messages?.[0]?.id, row?.["messages[]id"], row?.id);
}

export function sendWhatsAppText(
  ctx: StepCtx,
  label: string,
  recipient: string,
  text: string,
  contextMessageId?: string | null,
): Promise<any> {
  const inputs: Record<string, unknown> = { recipient, message_text: text };
  if (contextMessageId) inputs.context_message_id = contextMessageId;
  return ctx.step(label, async () =>
    sdk.runAction({
      appKey: WHATSAPP_APP,
      actionType: "write",
      actionKey: "send_freeform_message",
      connection: WHATSAPP_CONNECTION,
      inputs,
    }),
  );
}

export interface MediaSend {
  recipient: string;
  mediaType: string;
  fileUrl: string;
  caption?: string | null;
  filename?: string | null;
  contextMessageId?: string | null;
}

export function sendWhatsAppMedia(ctx: StepCtx, label: string, m: MediaSend): Promise<any> {
  const inputs: Record<string, unknown> = {
    recipient: m.recipient,
    media_type: m.mediaType,
    file_url: m.fileUrl,
  };
  // `caption` and `filename` are dynamic fields on this action: caption exists
  // for image/video/document but NOT audio, and filename only for document.
  if (m.caption && acceptsCaption(m.mediaType)) inputs.caption = m.caption;
  if (m.filename && m.mediaType === "document") inputs.filename = m.filename;
  if (m.contextMessageId) inputs.context_message_id = m.contextMessageId;

  return ctx.step(label, async () =>
    sdk.runAction({
      appKey: WHATSAPP_APP,
      actionType: "write",
      actionKey: "send_media_message",
      connection: WHATSAPP_CONNECTION,
      inputs,
    }),
  );
}

/** Publicly share a Slack file so Meta can fetch it, returning a URL. */
export async function publicUrlForSlackFile(
  ctx: StepCtx,
  label: string,
  fileId: string,
): Promise<string | null> {
  const res = await ctx.step(label, async () =>
    sdk.runAction({
      appKey: SLACK_APP,
      actionType: "write",
      actionKey: SLACK_MAKE_FILE_PUBLIC,
      connection: SLACK_CONNECTION,
      inputs: { fileId },
    }),
  );
  const row = (res as any)?.data?.[0];
  return firstString(
    row?.file_url,
    row?.permalink_public,
    row?.file?.permalink_public,
    row?.url_private_download,
  );
}
