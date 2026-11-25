// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/whatsapp-slack-bridge
//
// Shared bindings, helpers and Table access for the three WhatsApp <-> Slack
// durables. Published as `shared.ts` alongside each deployment's `workflow.ts`.
import type { DurableContext } from "@zapier/zapier-durable";
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

/**
 * Slack's raw message `text` (mrkdwn) -> what a WhatsApp reader should see.
 *
 * Slack wraps every link in angle brackets — `<https://x|https://x>` for a
 * pasted URL, `<https://x|label>` for a named link, `<mailto:a@b|a@b>` — and
 * HTML-escapes `&`, `<` and `>`. WhatsApp renders none of that, so a pasted
 * URL arrived as unclickable bracket soup. Bold/italic/strike/code markers
 * are the same in both and pass through untouched.
 */
export function slackToWhatsAppText(text: string): string {
  const converted = text.replace(/<([^<>]+)>/g, (_whole, inner: string) => {
    const bar = inner.indexOf("|");
    const target = bar === -1 ? inner : inner.slice(0, bar);
    const label = bar === -1 ? null : inner.slice(bar + 1);
    if (target.startsWith("@")) return `@${label ?? "someone"}`;
    if (target.startsWith("#")) return label ? `#${label}` : "#channel";
    if (target.startsWith("!")) {
      // <!here>, <!channel>, <!subteam^ID|@team>, <!date^…|fallback>
      if (label) return label;
      const special = target.slice(1).split("^")[0];
      return `@${special}`;
    }
    const url = target.startsWith("mailto:") ? target.slice("mailto:".length) : target;
    if (!label || label === url || label === target) return url;
    return `${label} (${url})`;
  });
  return converted.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
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

// --- Notion contact link ---------------------------------------------------
//
// The first time a WhatsApp contact's channel is in use, find their Notion
// Contacts page and put the channel's link on it (`WhatsApp Channel`). Two
// tiers, cheapest first:
//
//   1. Phone. The phone Table (free) maps every Notion `Primary Phone` to its
//      page, kept in sync by contact-emails-to-zapier-table. Most people who
//      message us first have no phone in Notion yet, which is why tier 2 exists.
//   2. Name, judged by Jev, approved by Dennis. Contacts whose name shares a
//      word with the WhatsApp profile name are fetched (one Notion query) and
//      Jev picks one of them, or none, in a single choice question. Nothing is
//      written yet: when Jev has a guess, Slack's Request Approval action asks
//      Dennis by DM (Approve / Reject), and the run parks at no cost on a
//      durable callback until he clicks. With no guess he gets a plain DM
//      listing the candidates, to link by hand.
//
// The outcome is cached on the WhatsApp contact row (`Notion Link`), so each
// person is resolved once; `pending` while a request is open stops later
// messages from asking again. Nothing is ever posted in the WhatsApp channel,
// where a human reply would go to the customer.

export const NOTION_CONNECTION = "notion_wf";
export const JEV_CONNECTION = "typesafe";
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";
const NOTION_CONTACTS_DS = "21991b07-11ac-81a6-a894-000be4a09a67";
const N_WHATSAPP_CHANNEL = "WhatsApp Channel";
const N_PRIMARY_PHONE = "Primary Phone";

/** "[Table] Contact Phone → Notion Page": phone digits -> Notion page id. */
export const CONTACT_PHONE_TABLE = "01M86DA512K8BP18BFMGW6GSYZ";
const P_PHONE = "Phone";
const P_TAIL = "Phone Tail";
const P_PAGE = "Page ID";
const P_SOURCE = "Source";

/** WhatsApp contacts Table: the linked page, and the state of the link —
 *  `phone`, `approved`, `pending` (an approval request is open), `declined`,
 *  `expired` (no click within 30 days) or `unmatched` (Jev had no guess).
 *  Clear `Notion Link` to make the next inbound message try again. */
export const C_NOTION_PAGE = "Notion Contact Page ID";
export const C_NOTION_LINK = "Notion Link";

/** Dennis's Slack user id: approval requests and notices go to him by DM. */
const LINK_DM_USER = "U07SZ8SA760";

/**
 * Slack's `request_approval` holds until someone clicks and expires an
 * unanswered request after 30 days; the callback outlives it by a day so the
 * expiry still arrives first. (Zapier's Human in the Loop app would allow an
 * edit before approving, but it can't run from a durable: it attaches the
 * review to a classic Zap run and rejects an SDK action run with "Run ID must
 * be a valid UUID", tried 2026-11-24.)
 */
const APPROVAL_CALLBACK_SECONDS = 31 * 24 * 60 * 60;

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";
/** Jev's pick is pre-filled in the request at or above this; below it the
 *  URL starts empty and the candidates are only listed. */
export const JEV_GUESS_MIN = 0.5;
/** Candidates shown to Jev, most name-word hits first. */
const JEV_MAX_CANDIDATES = 8;

/** A channel link that works without knowing the workspace's domain. */
export function slackChannelUrl(channelId: string): string {
  return `https://slack.com/app_redirect?channel=${channelId}`;
}

/** The phone Table's `Phone Tail`: the last 8 digits. */
export function phoneTail(phone: string): string {
  return phone.slice(-8);
}

/**
 * Does a phone Table row's number belong to this WhatsApp sender? Equal, or the
 * row was typed without its country code (a leading trunk `0` dropped): Notion
 * holds "0412555000" for a sender WhatsApp reports as "61412555000". At least 8
 * digits must line up, so a short fragment can't claim a stranger.
 */
export function phoneRowMatches(waPhone: string, rowPhone: string | null): boolean {
  if (!rowPhone) return false;
  if (rowPhone === waPhone) return true;
  const national = rowPhone.replace(/^0+/, "");
  return national.length >= 8 && national.length < waPhone.length && waPhone.endsWith(national);
}

/** Lowercased, accent-free words of a display name worth searching on. */
export function nameTokens(name: unknown): string[] {
  const s = firstString(name);
  if (!s) return [];
  const words = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t));
  return [...new Set(words)].slice(0, 4);
}

function richText(prop: any): string | null {
  const parts = prop?.title ?? prop?.rich_text;
  if (!Array.isArray(parts)) return null;
  return firstString(parts.map((p: any) => p?.plain_text ?? "").join(""));
}

/** What Jev sees of a Notion contact. */
export interface NotionCandidate {
  id: string;
  name: string | null;
  preferred_name: string | null;
  first_name: string | null;
  last_name: string | null;
  job_title: string | null;
  city: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  whatsapp_channel: string | null;
}

export function candidateFromPage(page: any): NotionCandidate {
  const p = page?.properties ?? {};
  return {
    id: String(page?.id ?? ""),
    name: richText(p["Name"]),
    preferred_name: richText(p["Preferred Name"]),
    first_name: richText(p["First Name"]),
    last_name: richText(p["Last Name"]),
    job_title: richText(p["Job Title"]),
    city: firstString(p["City"]?.select?.name),
    primary_email: firstString(p["Primary Email"]?.email),
    primary_phone: firstString(p[N_PRIMARY_PHONE]?.phone_number),
    whatsapp_channel: firstString(p[N_WHATSAPP_CHANNEL]?.url),
  };
}

/** How many of the profile's name words a candidate carries. */
function nameHits(c: NotionCandidate, tokens: string[]): number {
  const hay = nameTokens([c.name, c.preferred_name, c.first_name, c.last_name].filter(Boolean).join(" "));
  return tokens.filter((t) => hay.some((h) => h.startsWith(t) || t.startsWith(h))).length;
}

/**
 * The phone Table row(s) for a WhatsApp sender, reduced to one page id. More
 * than one page holding the number is a duplicate for a person to sort out, so
 * it is reported, not guessed at.
 */
export async function findPhoneOwner(phone: string): Promise<{ pageId: string | null; ambiguous: string[] }> {
  const hit = await sdk.listTableRecords({
    table: CONTACT_PHONE_TABLE,
    keyMode: "names",
    filters: [{ fieldKey: P_TAIL, operator: "exact", value: phoneTail(phone) }],
    pageSize: 20,
  });
  const pages = new Set<string>();
  for (const row of (hit as any)?.data ?? []) {
    const rowPhone = firstString(row?.data?.[P_PHONE]);
    const page = firstString(row?.data?.[P_PAGE]);
    if (page && phoneRowMatches(phone, rowPhone)) pages.add(page.replace(/-/g, "").toLowerCase());
  }
  const ids = [...pages];
  return ids.length === 1 ? { pageId: ids[0], ambiguous: [] } : { pageId: null, ambiguous: ids };
}

/** One Notion query: contacts whose Name or Preferred Name contains a name word. */
export async function findNameCandidates(tokens: string[], channelUrl: string): Promise<NotionCandidate[]> {
  if (tokens.length === 0) return [];
  const or = tokens.flatMap((t) => [
    { property: "Name", title: { contains: t } },
    { property: "Preferred Name", rich_text: { contains: t } },
  ]);
  const res = await sdk.fetch(`${NOTION_API}/data_sources/${NOTION_CONTACTS_DS}/query`, {
    method: "POST",
    connection: NOTION_CONNECTION,
    headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    body: JSON.stringify({ filter: { or }, page_size: 100 }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Notion candidate query failed (${res.status}): ${text.slice(0, 300)}`);
  const body = JSON.parse(text);
  return ((body?.results ?? []) as any[])
    .map(candidateFromPage)
    // Already linked to some other WhatsApp conversation: not this sender.
    .filter((c) => !c.whatsapp_channel || c.whatsapp_channel === channelUrl)
    .map((c) => ({ c, hits: nameHits(c, tokens) }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, JEV_MAX_CANDIDATES)
    .map((x) => x.c);
}

/** What Jev knows about the sender. */
export interface WhatsAppSender {
  profile_name: string | null;
  phone: string;
  first_message: string | null;
}

/**
 * The single choice question: which candidate, if any, is the sender. Options
 * `c0`..`cN` point at `candidates[i]` in the state; `none` covers a name that
 * fits nobody, or fits several equally (a bare common first name).
 */
export function jevLinkQuestions(count: number): Record<string, unknown> {
  const criteria: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    criteria[`c${i}`] =
      `The WhatsApp sender is the CRM contact \`candidates[${i}]\`: the profile name is that contact's name or a ` +
      `recognisable form of it (a first name alone, a nickname, a shortened or extended given name, initials with ` +
      `the surname, a different word order, an added honorific), it fits this contact clearly better than every ` +
      `other candidate, and nothing about the sender contradicts the contact.`;
  }
  criteria.none =
    "None of the candidates: the profile name fits none of them; or it fits more than one about equally (for " +
    "example a first name alone that several candidates share); or something about the sender contradicts every " +
    "candidate whose name fits (a different surname, a WhatsApp number from another country than the contact's " +
    "own phone or city, a first message that names someone else).";
  return {
    match: {
      type: "choice",
      instructions:
        "`whatsapp` is a person who has just messaged our business on WhatsApp for the first time; we know only " +
        "their WhatsApp profile name, phone number and first message. `candidates` are contacts from our CRM " +
        "whose names share a word with that profile name. Which candidate is this person?",
      criteria,
    },
  };
}

/** Jev's pick, or null when it chose none or wasn't sure enough. */
export function pickJevMatch(
  answer: { choice?: unknown; probabilities?: Record<string, unknown> } | null | undefined,
  candidates: NotionCandidate[],
  min = JEV_GUESS_MIN,
): { candidate: NotionCandidate; p: number } | null {
  const choice = typeof answer?.choice === "string" ? answer.choice : null;
  const m = choice ? /^c(\d+)$/.exec(choice) : null;
  if (!m) return null;
  const candidate = candidates[Number(m[1])];
  const p = Number(answer?.probabilities?.[choice as string] ?? 0);
  return candidate && p >= min ? { candidate, p } : null;
}

export async function askJevForMatch(
  sender: WhatsAppSender,
  candidates: NotionCandidate[],
): Promise<{ choice: string | null; probabilities: Record<string, number>; model: string | null }> {
  for (let attempt = 0; ; attempt++) {
    const res = await sdk.fetch(JEV_URL, {
      method: "POST",
      connection: JEV_CONNECTION,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: JEV_MODEL,
        state: {
          whatsapp: { ...sender, phone: `+${sender.phone}` },
          // Drop the link field: it is either empty or this very channel.
          candidates: candidates.map(({ id: _id, whatsapp_channel: _w, ...rest }) => rest),
        },
        questions: jevLinkQuestions(candidates.length),
      }),
    });
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
      continue;
    }
    if (res.status !== 200) throw new Error(`Jev rejected the link question (${res.status}): ${text.slice(0, 300)}`);
    const body = JSON.parse(text);
    const a = body?.answers?.match ?? {};
    return {
      choice: typeof a.choice === "string" ? a.choice : null,
      probabilities: (a.probabilities ?? {}) as Record<string, number>,
      model: firstString(body?.model),
    };
  }
}

/**
 * Write the channel link (and, when asked, the phone) onto a Notion contact.
 * `gone` when the page is in the trash; anything else unexpected throws.
 */
export async function writeNotionLink(
  pageId: string,
  channelUrl: string,
  fillPhone: string | null,
): Promise<"written" | "gone"> {
  const properties: Record<string, unknown> = { [N_WHATSAPP_CHANNEL]: { url: channelUrl } };
  if (fillPhone) properties[N_PRIMARY_PHONE] = { phone_number: `+${fillPhone}` };
  const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
    method: "PATCH",
    connection: NOTION_CONNECTION,
    headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    body: JSON.stringify({ properties }),
  });
  if (res.ok) return "written";
  const text = await res.text();
  if (res.status === 404 || (res.status === 400 && /archived|in_trash|trash/i.test(text))) return "gone";
  throw new Error(`Notion rejected the link write to ${pageId} (${res.status}): ${text.slice(0, 300)}`);
}

function notionPageUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, "")}`;
}

/** A candidate as one line of Slack mrkdwn: linked name, then title / email. */
function describeCandidate(c: NotionCandidate): string {
  const bits = [c.job_title, c.primary_email].filter(Boolean).join(", ");
  return `<${notionPageUrl(c.id)}|${(c.name ?? c.id).replace(/[<>|]/g, "")}>${bits ? ` (${bits.replace(/[<>|]/g, "")})` : ""}`;
}

/**
 * The approver's decision ("Approved" / "Declined") from a Request Approval
 * action run: either a getActionRun result or the body Zapier POSTs to the
 * callbackUrl (the same shape, tolerating a `data` envelope either way). Same
 * reader as slack-thread-to-notion-discussion's.
 */
export function approvalDecision(run: unknown): string | undefined {
  let r: unknown = run;
  for (let i = 0; i < 2 && r && typeof r === "object" && "data" in r; i++) {
    r = (r as { data?: unknown }).data;
  }
  if (Array.isArray(r)) r = { results: r };
  if (!r || typeof r !== "object") return undefined;
  const results = (r as { results?: unknown }).results;
  const first = Array.isArray(results) ? results[0] : undefined;
  const status = first && typeof first === "object" ? (first as { status?: unknown }).status : undefined;
  return typeof status === "string" && status.length > 0 ? status : undefined;
}

export interface LinkArgs {
  contactRowId: string;
  phone: string;
  profileName: string | null;
  firstMessage: string | null;
  channelId: string;
}

export interface LinkResult {
  status: "phone" | "approved" | "declined" | "expired" | "unmatched";
  pageId: string | null;
  p?: number;
  candidates?: number;
  phoneFilled?: boolean;
}

/**
 * Resolve this WhatsApp contact's Notion page and link the channel onto it.
 *
 * Costs: phone match 1 task (the write). Name path: the query and Jev (2),
 * then either the approval request (1) plus the write on approval (1), or a
 * notice DM (1) when Jev has no guess. No usable name word: the notice only.
 * Runs once per WhatsApp contact: the result is cached on its Table row.
 */
export async function linkNotionContact(ctx: DurableContext, a: LinkArgs): Promise<LinkResult> {
  const channelUrl = slackChannelUrl(a.channelId);
  const who = `${(a.profileName ?? "no profile name").replace(/[<>|*]/g, "")} +${a.phone}`;

  // 1. Phone, from the free Table.
  const owner = await ctx.step("notion-link-phone-lookup", async () => findPhoneOwner(a.phone));
  if (owner.ambiguous.length > 1) {
    console.log(`phone ${a.phone} is on ${owner.ambiguous.length} Notion contacts; falling back to the name`);
  }
  if (owner.pageId) {
    const pageId = owner.pageId;
    const wrote = await ctx.step("notion-link-write-phone", async () => writeNotionLink(pageId, channelUrl, null));
    if (wrote === "written") return cacheLink(ctx, "notion-link-cache-phone", a.contactRowId, { status: "phone", pageId });
    console.log(`phone owner ${pageId} is in the trash; falling back to the name`);
  }

  // 2. Name candidates, and Jev's guess among them.
  const tokens = nameTokens(a.profileName);
  const candidates = tokens.length
    ? await ctx.step("notion-link-candidates", async () => findNameCandidates(tokens, channelUrl))
    : [];
  let guess: { candidate: NotionCandidate; p: number } | null = null;
  let jevNote = "";
  if (candidates.length > 0) {
    const sender: WhatsAppSender = { profile_name: a.profileName, phone: a.phone, first_message: a.firstMessage };
    const answer = await ctx.step("notion-link-jev", async () => askJevForMatch(sender, candidates));
    guess = pickJevMatch(answer, candidates);
    const top = answer.choice ? `${answer.choice} p=${Number(answer.probabilities[answer.choice] ?? 0).toFixed(2)}` : "no answer";
    jevNote = `Jev: ${top} over ${candidates.length} candidate(s).`;
    console.log(`Jev link for ${who}: ${top} over ${candidates.length} candidate(s)`);
  }
  const others = (exclude: string | null) =>
    candidates.filter((c) => c.id !== exclude).slice(0, 4).map(describeCandidate).join("; ");

  // 2a. No guess: nothing to approve. Tell Dennis, with the candidates.
  if (!guess) {
    const list = candidates.length
      ? ` ${jevNote} Candidates: ${others(null)}.`
      : tokens.length
        ? " No contact's name shares a word with their profile name."
        : " Their WhatsApp profile name has no word to search on.";
    await dmDennis(
      ctx,
      "notion-link-dm-unmatched",
      `:grey_question: No Notion contact matched for <#${a.channelId}> (${who}).${list} ` +
        `To link them, set *WhatsApp Channel* on their contact to ${channelUrl}`,
    );
    return cacheLink(ctx, "notion-link-cache-unmatched", a.contactRowId, {
      status: "unmatched",
      pageId: null,
      candidates: candidates.length,
    });
  }

  // 2b. A guess: ask Dennis to approve it before anything is written. Mark the
  //     row pending first, so messages arriving while the request is open don't
  //     ask again. Started with createActionRun, never runAction: runAction
  //     polls for at most 180s and then throws, and a retried step re-posts
  //     the request (slack-thread-to-notion-discussion learned this the hard
  //     way). The run parks on the callback, free, until Dennis clicks.
  const target = guess.candidate;
  const p = guess.p;
  const fill = target.primary_phone ? null : a.phone;
  await ctx.step("notion-link-mark-pending", async () =>
    sdk.updateTableRecords({
      table: CONTACTS_TABLE,
      keyMode: "names",
      records: [{ id: a.contactRowId, data: { [C_NOTION_LINK]: "pending", [C_NOTION_PAGE]: target.id } }],
    }),
  );
  const [approvalDone, approvalCallbackUrl] = await ctx.createCallback<unknown>({
    name: "notion-link-approval",
    timeoutSeconds: APPROVAL_CALLBACK_SECONDS,
  });
  const otherList = others(target.id);
  const approvalRunId = await ctx.step("notion-link-request-approval", async () => {
    const started = await sdk.createActionRun({
      app: SLACK_APP,
      actionType: "write",
      action: "request_approval",
      connection: SLACK_CONNECTION,
      callbackUrl: approvalCallbackUrl,
      inputs: {
        request_message:
          `:link: Is the WhatsApp sender in <#${a.channelId}> (${who}) the Notion contact ${describeCandidate(target)}? ` +
          `Jev thinks so (p=${p.toFixed(2)} over ${candidates.length} candidate(s)). ` +
          `*Approve* sets their *WhatsApp Channel*` +
          (fill ? ` and fills their empty *Primary Phone* with +${a.phone}` : "") +
          `. *Reject* leaves Notion alone; to link someone else, set *WhatsApp Channel* on them to ${channelUrl}` +
          (otherList ? `. Other candidates: ${otherList}.` : "."),
        approval_type: "direct",
        user: LINK_DM_USER,
        send_as: "bot",
        username: "WhatsApp Bridge",
        icon: ":whatsapp:",
        approve_label: "Link",
        decline_inclusion: "yes",
        decline_label: "Reject",
      },
    });
    return started.data.id;
  });

  const outcome = await approvalDone;
  if (outcome.status === "expired") {
    console.log(`approval ${approvalRunId} for ${who} expired unanswered; nothing written`);
    return cacheLink(ctx, "notion-link-cache-expired", a.contactRowId, {
      status: "expired",
      pageId: null,
      p,
      candidates: candidates.length,
    });
  }
  // Read the decision from the action run itself; fall back to the callback
  // body once the run is past Zapier's 7-day result retention.
  const decision = await ctx.step("notion-link-read-approval", async () => {
    try {
      const fromRun = approvalDecision(await sdk.getActionRun({ run: approvalRunId }));
      if (fromRun) return fromRun;
    } catch (err) {
      console.log(`getActionRun ${approvalRunId} failed (${String(err)}); using the callback body`);
    }
    return approvalDecision(outcome.value) ?? "unknown";
  });
  if (decision !== "Approved") {
    console.log(`approval ${approvalRunId} for ${who}: ${decision}; nothing written`);
    return cacheLink(ctx, "notion-link-cache-declined", a.contactRowId, {
      status: "declined",
      pageId: null,
      p,
      candidates: candidates.length,
    });
  }

  const wrote = await ctx.step("notion-link-write-approved", async () => writeNotionLink(target.id, channelUrl, fill));
  if (wrote === "gone") {
    // Trashed while the request was open. Say so rather than caching a link
    // to a page that isn't there.
    await dmDennis(
      ctx,
      "notion-link-dm-gone",
      `:warning: You approved linking <#${a.channelId}> to ${describeCandidate(target)}, but that contact is now in the trash, so nothing was written. ` +
        `Set *WhatsApp Channel* on the right contact to ${channelUrl}`,
    );
    return cacheLink(ctx, "notion-link-cache-gone", a.contactRowId, {
      status: "unmatched",
      pageId: null,
      p,
      candidates: candidates.length,
    });
  }
  if (fill) {
    // Index the number now rather than waiting on the Notion automation, so the
    // next lookup is free and immediate. Check first: the automation may
    // already have done it.
    await ctx.step("notion-link-index-phone", async () => {
      const existing = await findPhoneOwner(fill);
      if (existing.pageId || existing.ambiguous.length) return "exists";
      await sdk.createTableRecords({
        table: CONTACT_PHONE_TABLE,
        keyMode: "names",
        records: [{ data: { [P_PHONE]: fill, [P_TAIL]: phoneTail(fill), [P_PAGE]: target.id, [P_SOURCE]: "whatsapp-slack-bridge" } }],
      });
      return "created";
    });
  }
  return cacheLink(ctx, "notion-link-cache-approved", a.contactRowId, {
    status: "approved",
    pageId: target.id,
    p,
    candidates: candidates.length,
    phoneFilled: fill != null,
  });
}

/** Record the outcome on the WhatsApp contact row, so this contact is never
 *  resolved again (until someone clears `Notion Link`). */
async function cacheLink(ctx: StepCtx, label: string, rowId: string, result: LinkResult): Promise<LinkResult> {
  await ctx.step(label, async () =>
    sdk.updateTableRecords({
      table: CONTACTS_TABLE,
      keyMode: "names",
      records: [{ id: rowId, data: { [C_NOTION_LINK]: result.status, [C_NOTION_PAGE]: result.pageId ?? "" } }],
    }),
  );
  return result;
}

function dmDennis(ctx: StepCtx, label: string, text: string): Promise<any> {
  return ctx.step(label, async () =>
    sdk.runAction({
      appKey: SLACK_APP,
      actionType: "write",
      actionKey: "direct_message",
      connection: SLACK_CONNECTION,
      inputs: {
        channel: LINK_DM_USER,
        text,
        send_multi: "no",
        as_bot: "yes",
        add_edit_link: "no",
        unfurl: "no",
        link_names: "yes",
      },
    }),
  );
}
