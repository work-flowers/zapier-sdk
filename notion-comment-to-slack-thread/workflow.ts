// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/notion-comment-to-slack-thread
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
const SLACK_APP_KEY = "SlackCLIAPI";
const SLACK_CONNECTION = "slack_wf";
const NOTION_CONNECTION = "notion_wf";
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

// --- Zapier Tables ------------------------------------------------------------
const THREAD_MAP_TABLE = "01M1DXXXH3E7K7JWDJYA1R50CF";
const TM_CHANNEL = "f1";
const TM_THREAD_TS = "f2";
const TM_DISCUSSION = "f3";
const TM_STATE = "f6";

const MESSAGE_MAP_TABLE = "01M1DXY3QEF60HX7HW8XYVE5AF";
const MM_COMMENT = "f3";

// Internal User IDs — Notion user id -> name (and other systems' ids).
const USER_IDS_TABLE = "01JM3J9SG5X6S8GBSSC8AS28AT";
const UID_SLACK_USER = "f3";
const UID_NOTION_USER = "f6";
const UID_FIRST_NAME = "f13";
const UID_LAST_NAME = "f14";

const InputSchema = z.unknown();
type Input = Record<string, unknown>;

// --- Helpers -------------------------------------------------------------------

function normalizeInput(rawInput: unknown): unknown {
  if (typeof rawInput === "string") {
    try {
      return JSON.parse(rawInput);
    } catch {
      return rawInput;
    }
  }
  return rawInput;
}

function firstString(v: unknown): string {
  return typeof v === "string" && v.length > 0 ? v : "";
}

function isEmptyPing(payload: unknown): boolean {
  if (payload === null || payload === undefined || payload === "") return true;
  if (typeof payload !== "object") return false;
  const obj = payload as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return true;
  const wrappers = ["querystring", "headers", "params", "body", "query"];
  return keys.every((k) => wrappers.includes(k) && isEmptyPing(obj[k]));
}

type TableRow = { recordId: string; data: Record<string, unknown> };

function extractRow(result: unknown): TableRow | null {
  const rows = Array.isArray(result) ? result : [];
  const hit = rows[0] as
    | { record_id?: unknown; old?: { data?: Record<string, unknown> } }
    | undefined;
  if (!hit) return null;
  const recordId = firstString(hit.record_id);
  if (!recordId) return null;
  return { recordId, data: hit.old?.data ?? {} };
}

function plainText(richText: unknown): string {
  if (!Array.isArray(richText)) return "";
  return richText
    .map((t) => firstString((t as Record<string, unknown>).plain_text))
    .join("");
}

// --- Workflow -------------------------------------------------------------------

const workflow = defineDurable<Input, unknown>(
  "notion-comment-to-slack-thread",
  async (ctx: DurableContext, rawInput: Input) => {
    const payload = InputSchema.parse(normalizeInput(rawInput)) as
      | Record<string, unknown>
      | null;

    if (isEmptyPing(payload)) {
      console.log("empty payload — ping, not a comment event");
      return { skipped: "empty-payload" };
    }

    const comment = payload as Record<string, unknown>;
    const commentId = firstString(comment.id);
    const discussionId = firstString(comment.discussion_id);
    if (!commentId || !discussionId) {
      // Non-empty payload we can't read a comment out of — vendor schema change
      // or bug. Throw (repo default mechanism), never a silent skip.
      throw new Error(
        `unrecognized Notion comment payload — keys: ${Object.keys(comment).join(", ")}`,
      );
    }

    // Echo suppression layer 1: comments this sync created (via the same
    // notion_wf connection) are authored by the connection's own bot user.
    const createdBy = firstString(
      (comment.created_by as Record<string, unknown> | undefined)?.id,
    );
    const me = await ctx.step("whoami", async () => {
      const res = await sdk.fetch(`${NOTION_API}/users/me`, {
        connection: NOTION_CONNECTION,
        headers: { "Notion-Version": NOTION_VERSION },
      });
      if (!res.ok) {
        throw new Error(`Notion users/me failed (${res.status}): ${await res.text()}`);
      }
      const json = (await res.json()) as Record<string, unknown>;
      return firstString(json.id);
    });
    if (createdBy && createdBy === me) {
      console.log(`comment ${commentId} was created by this integration — skipping`);
      return { skipped: "own-comment", commentId };
    }

    // Only comments on linked discussions mirror; everything else is normal
    // Notion activity, not an error.
    const threadRow = await ctx.step("find-thread-map", async () => {
      const res = await sdk.runAction({
        appKey: "TableCLIAPI",
        actionType: "search",
        actionKey: "find_record",
        inputs: {
          table_id: THREAD_MAP_TABLE,
          filter_count: "1",
          use_stored_order: false,
          field_data_key: TM_DISCUSSION,
          operator: "exact",
          lookup_value: discussionId,
          _zap_search_multiple_results: "first",
          _zap_search_success_on_miss: true,
        },
      });
      return extractRow((res as { data?: unknown }).data);
    });
    if (!threadRow) {
      console.log(`discussion ${discussionId} is not linked — ignoring`);
      return { skipped: "unlinked-discussion", commentId };
    }
    const state = firstString(threadRow.data[TM_STATE]);
    if (state !== "active") {
      console.log(`thread for discussion ${discussionId} is ${state} — not syncing`);
      return { skipped: `thread-${state || "unknown"}`, commentId };
    }

    // Echo suppression layer 2 / replay dedupe.
    const existing = await ctx.step("find-message-map", async () => {
      const res = await sdk.runAction({
        appKey: "TableCLIAPI",
        actionType: "search",
        actionKey: "find_record",
        inputs: {
          table_id: MESSAGE_MAP_TABLE,
          filter_count: "1",
          use_stored_order: false,
          field_data_key: MM_COMMENT,
          operator: "exact",
          lookup_value: commentId,
          _zap_search_multiple_results: "first",
          _zap_search_success_on_miss: true,
        },
      });
      return extractRow((res as { data?: unknown }).data);
    });
    if (existing) {
      console.log(`comment ${commentId} already mirrored — skipping`);
      return { skipped: "already-mirrored", commentId };
    }

    // Resolve the author's name and avatar. The Internal User IDs table maps
    // the Notion user id to the name AND their Slack user id; the avatar is
    // the author's own SLACK profile picture (users.info), so the mirrored
    // message looks like them. Fallbacks: Notion users API for the name and,
    // when there is no Slack mapping, the Notion avatar.
    let authorName = "";
    let authorAvatar = "";
    if (createdBy) {
      const userRow = await ctx.step("find-author", async () => {
        const res = await sdk.runAction({
          appKey: "TableCLIAPI",
          actionType: "search",
          actionKey: "find_record",
          inputs: {
            table_id: USER_IDS_TABLE,
            filter_count: "1",
            use_stored_order: false,
            field_data_key: UID_NOTION_USER,
            operator: "exact",
            lookup_value: createdBy,
            _zap_search_multiple_results: "first",
            _zap_search_success_on_miss: true,
          },
        });
        return extractRow((res as { data?: unknown }).data);
      });
      const slackUserId = userRow ? firstString(userRow.data[UID_SLACK_USER]) : "";
      if (userRow) {
        authorName = [
          firstString(userRow.data[UID_FIRST_NAME]),
          firstString(userRow.data[UID_LAST_NAME]),
        ]
          .filter(Boolean)
          .join(" ");
      }
      if (slackUserId) {
        authorAvatar = await ctx.step("fetch-slack-avatar", async () => {
          const res = await sdk.fetch(
            `https://slack.com/api/users.info?user=${slackUserId}`,
            { connection: SLACK_CONNECTION },
          );
          if (!res.ok) return "";
          const json = (await res.json()) as {
            ok?: boolean;
            user?: { profile?: { image_192?: string; image_512?: string } };
          };
          if (json.ok !== true) return "";
          return (
            firstString(json.user?.profile?.image_192) ||
            firstString(json.user?.profile?.image_512)
          );
        });
      }
      if (!authorName || !authorAvatar) {
        const notionUser = await ctx.step("fetch-author", async () => {
          const res = await sdk.fetch(`${NOTION_API}/users/${createdBy}`, {
            connection: NOTION_CONNECTION,
            headers: { "Notion-Version": NOTION_VERSION },
          });
          if (!res.ok) return { name: "", avatarUrl: "" };
          const json = (await res.json()) as Record<string, unknown>;
          return {
            name: firstString(json.name),
            avatarUrl: firstString(json.avatar_url),
          };
        });
        if (!authorName) authorName = notionUser.name;
        if (!authorAvatar) authorAvatar = notionUser.avatarUrl;
      }
    }
    if (!authorName) authorName = "Notion user";

    const text = plainText(comment.rich_text) || "(empty comment)";
    const channelId = firstString(threadRow.data[TM_CHANNEL]);
    const threadTs = firstString(threadRow.data[TM_THREAD_TS]);
    if (!channelId || !threadTs) {
      throw new Error(
        `thread_map row ${threadRow.recordId} is missing channel/thread ts — mapping is corrupt`,
      );
    }

    const posted = await ctx.step("post-slack-reply", async () =>
      sdk.runAction({
        appKey: SLACK_APP_KEY,
        actionType: "write",
        actionKey: "channel_message",
        connection: SLACK_CONNECTION,
        inputs: {
          channel: channelId,
          thread_ts: threadTs,
          text,
          as_bot: "yes",
          username: `${authorName} (via Notion)`,
          // Author's avatar (Slack profile pic; Notion fallback) as the bot
          // icon; omitted (Zapier default) when neither exists.
          ...(authorAvatar ? { icon: authorAvatar } : {}),
          unfurl: "no",
          link_names: "no",
          reply_broadcast: "no",
        },
      }),
    );
    const slackTs = firstString(
      ((posted as { data?: Array<Record<string, unknown>> }).data ?? [])[0]?.ts,
    );

    await ctx.step("write-message-map", async () =>
      sdk.runAction({
        appKey: "TableCLIAPI",
        actionType: "write",
        actionKey: "create_record",
        inputs: {
          table_id: MESSAGE_MAP_TABLE,
          new__data__f1: slackTs,
          new__data__f2: channelId,
          new__data__f3: commentId,
          new__data__f4: threadRow.recordId,
          new__data__f5: "notion",
        },
      }),
    );

    return { mirrored: true, commentId, slackTs };
  },
);

export default workflow;
