// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/slack-thread-to-notion-discussion
// First-publish retry: run 33483876845 died before reaching this Zap, and the
// pending-create path only fires on a SOURCE change — hence this comment.
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
// thread_map: one row per linked Slack thread <-> Notion discussion.
const THREAD_MAP_TABLE = "01M1DXXXH3E7K7JWDJYA1R50CF";
const TM_CHANNEL = "f1"; // Slack Channel ID
const TM_THREAD_TS = "f2"; // Slack Thread Ts
const TM_DISCUSSION = "f3"; // Notion Discussion ID
// f4 = Notion Page ID, f5 = Notion Block ID (per-thread anchor block) —
// written via new__data__f4/f5 literals below.
const TM_STATE = "f6"; // active / resolved / deleted

// message_map: one row per mirrored message; drives dedupe + echo suppression.
// f1 = Slack Ts, f2 = Slack Channel ID, f3 = Notion Comment ID,
// f4 = Thread Map ID, f5 = Origin (slack / notion).
const MESSAGE_MAP_TABLE = "01M1DXY3QEF60HX7HW8XYVE5AF";
const MM_SLACK_TS = "f1";
const MM_CHANNEL = "f2";

// --- Notion Tasks -------------------------------------------------------------
const TASKS_DS = "27a91b07-11ac-81ed-973f-000ba6da1441";
const TICKET_PROP = "Ticket ID"; // unique_id property behind TKT-###

// A thread longer than this backfills only its newest messages (logged loudly —
// never a silent cap). Guards the first-link run against a monster thread.
const BACKFILL_CAP = 50;

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

/** Empty or wrapper-only payloads are pings, not events. */
function isEmptyPing(payload: unknown): boolean {
  if (payload === null || payload === undefined || payload === "") return true;
  if (typeof payload !== "object") return false;
  const obj = payload as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return true;
  const wrappers = ["querystring", "headers", "params", "body", "query"];
  return keys.every(
    (k) => wrappers.includes(k) && isEmptyPing(obj[k]),
  );
}

type SlackMessage = {
  ts: string;
  threadTs: string; // ts of the thread root (== ts for a top-level message)
  channelId: string;
  channelName: string;
  text: string;
  permalink: string;
  isBot: boolean;
  authorName: string;
};

/** Normalize a Slack trigger/read payload row into the fields we act on. */
function parseSlackMessage(raw: Record<string, unknown>): SlackMessage | null {
  const ts = firstString(raw.ts);
  if (!ts) return null;
  const channel = raw.channel as Record<string, unknown> | string | undefined;
  const channelId =
    typeof channel === "string" ? channel : firstString(channel?.id);
  if (!channelId) return null;
  const user = raw.user as Record<string, unknown> | string | undefined;
  const profile =
    typeof user === "object" && user
      ? ((user.profile ?? {}) as Record<string, unknown>)
      : {};
  const first = firstString(profile.first_name);
  const last = firstString(profile.last_name);
  const fallbackName =
    typeof user === "object" && user ? firstString(user.name) : "";
  return {
    ts,
    threadTs: firstString(raw.thread_ts) || ts,
    channelId,
    channelName:
      typeof channel === "object" && channel ? firstString(channel.name) : "",
    text: firstString(raw.text),
    permalink: firstString(raw.permalink),
    isBot: typeof user === "object" && user ? user.is_bot === true : false,
    authorName:
      [first, last].filter(Boolean).join(" ") || fallbackName || "Unknown",
  };
}

/** TKT-825 (case-insensitive) → 825. */
function extractTicketNumber(text: string): number | null {
  const m = /\bTKT-(\d+)\b/i.exec(text);
  return m ? Number(m[1]) : null;
}

/** A Notion page URL in the text → dashed page id. */
function extractNotionPageId(text: string): string | null {
  const m =
    /(?:notion\.so|notion\.site|app\.notion\.com)\/[^\s<>|"']*?([0-9a-f]{32})/i.exec(
      text,
    );
  if (!m) return null;
  const h = m[1].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Canonical Notion page URL from a dashed page id. */
function notionPageUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, "")}`;
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

async function findThreadMapRow(
  ctx: DurableContext,
  stepName: string,
  channelId: string,
  threadTs: string,
): Promise<TableRow | null> {
  const res = await ctx.step(stepName, async () =>
    sdk.runAction({
      appKey: "TableCLIAPI",
      actionType: "search",
      actionKey: "find_record",
      inputs: {
        table_id: THREAD_MAP_TABLE,
        filter_count: "2",
        use_stored_order: false,
        field_data_key: TM_THREAD_TS,
        operator: "exact",
        lookup_value: threadTs,
        field_data_key_2: TM_CHANNEL,
        operator_2: "exact",
        lookup_value_2: channelId,
        _zap_search_multiple_results: "first",
        _zap_search_success_on_miss: true,
      },
    }),
  );
  return extractRow((res as { data?: unknown }).data);
}

async function findMessageMapRow(
  ctx: DurableContext,
  stepName: string,
  channelId: string,
  slackTs: string,
): Promise<TableRow | null> {
  const res = await ctx.step(stepName, async () =>
    sdk.runAction({
      appKey: "TableCLIAPI",
      actionType: "search",
      actionKey: "find_record",
      inputs: {
        table_id: MESSAGE_MAP_TABLE,
        filter_count: "2",
        use_stored_order: false,
        field_data_key: MM_SLACK_TS,
        operator: "exact",
        lookup_value: slackTs,
        field_data_key_2: MM_CHANNEL,
        operator_2: "exact",
        lookup_value_2: channelId,
        _zap_search_multiple_results: "first",
        _zap_search_success_on_miss: true,
      },
    }),
  );
  return extractRow((res as { data?: unknown }).data);
}

type NotionComment = { commentId: string; discussionId: string };

/**
 * POST /v1/comments with a custom display_name so the comment renders under the
 * Slack author's own name (verified live 2026-09-01 — Spike C). Must be called
 * inside a ctx.step.
 */
async function postNotionComment(
  parent:
    | { discussion_id: string }
    | { parent: { block_id: string } },
  markdown: string,
  displayName: string,
): Promise<NotionComment> {
  const body: Record<string, unknown> = {
    markdown,
    display_name: { type: "custom", custom: { name: displayName } },
  };
  Object.assign(body, parent);
  const res = await sdk.fetch(`${NOTION_API}/comments`, {
    connection: NOTION_CONNECTION,
    method: "POST",
    headers: {
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `Notion create comment failed (${res.status}): ${await res.text()}`,
    );
  }
  const json = (await res.json()) as Record<string, unknown>;
  return {
    commentId: firstString(json.id),
    discussionId: firstString(json.discussion_id),
  };
}

async function writeMessageMapRow(
  ctx: DurableContext,
  stepName: string,
  msg: { ts: string; channelId: string },
  commentId: string,
  threadMapId: string,
): Promise<void> {
  await ctx.step(stepName, async () =>
    sdk.runAction({
      appKey: "TableCLIAPI",
      actionType: "write",
      actionKey: "create_record",
      inputs: {
        table_id: MESSAGE_MAP_TABLE,
        new__data__f1: msg.ts,
        new__data__f2: msg.channelId,
        new__data__f3: commentId,
        new__data__f4: threadMapId,
        new__data__f5: "slack",
      },
    }),
  );
}

// --- Workflow -------------------------------------------------------------------

const workflow = defineDurable<Input, unknown>(
  "slack-thread-to-notion-discussion",
  async (ctx: DurableContext, rawInput: Input) => {
    const payload = InputSchema.parse(normalizeInput(rawInput)) as
      | Record<string, unknown>
      | null;

    if (isEmptyPing(payload)) {
      console.log("empty payload — ping, not a message event");
      return { skipped: "empty-payload" };
    }

    const msg = parseSlackMessage(payload as Record<string, unknown>);
    if (!msg) {
      // Non-empty payload we can't read a message out of: a schema change or a
      // bug, never silently dropped (repo invariant — throw is the mechanism).
      throw new Error(
        `unrecognized Slack payload — no ts/channel. Keys: ${Object.keys(payload as object).join(", ")}`,
      );
    }

    // Echo suppression layer 1 + noise: our own Notion->Slack posts are sent
    // as_bot, and system/bot chatter never syncs.
    if (msg.isBot) {
      console.log(`bot message ${msg.channelId}/${msg.ts} — skipping`);
      return { skipped: "bot-message", ts: msg.ts };
    }

    // 1. Already-linked thread? (Table reads are free.)
    const threadRow = await findThreadMapRow(
      ctx,
      "find-thread-map",
      msg.channelId,
      msg.threadTs,
    );

    if (threadRow) {
      const state = firstString(threadRow.data[TM_STATE]);
      if (state !== "active") {
        console.log(
          `thread ${msg.channelId}/${msg.threadTs} is ${state || "unknown"} — not syncing`,
        );
        return { skipped: `thread-${state || "unknown"}`, ts: msg.ts };
      }
      return syncReply(ctx, msg, threadRow);
    }

    // 2. Not linked: does this message opt the thread in?
    const ticketNumber = extractTicketNumber(msg.text);
    const pageIdFromUrl = ticketNumber === null ? extractNotionPageId(msg.text) : null;
    if (ticketNumber === null && !pageIdFromUrl) {
      console.log(
        `message ${msg.channelId}/${msg.ts} in unlinked thread, no TKT-id/page URL — ignoring`,
      );
      return { skipped: "not-opted-in", ts: msg.ts };
    }

    return linkThread(ctx, msg, ticketNumber, pageIdFromUrl);
  },
);

// --- Branch: reply into an existing discussion -----------------------------------

async function syncReply(
  ctx: DurableContext,
  msg: SlackMessage,
  threadRow: TableRow,
): Promise<unknown> {
  // Echo suppression layer 2 / replay dedupe.
  const existing = await findMessageMapRow(
    ctx,
    "find-message-map",
    msg.channelId,
    msg.ts,
  );
  if (existing) {
    console.log(`message ${msg.channelId}/${msg.ts} already mirrored — skipping`);
    return { skipped: "already-mirrored", ts: msg.ts };
  }

  const discussionId = firstString(threadRow.data[TM_DISCUSSION]);
  if (!discussionId) {
    throw new Error(
      `thread_map row ${threadRow.recordId} has no discussion id — mapping is corrupt`,
    );
  }

  const comment = await ctx.step("post-notion-comment", async () =>
    postNotionComment(
      { discussion_id: discussionId },
      msg.text || "(empty message)",
      `${msg.authorName} (via Slack)`,
    ),
  );

  await writeMessageMapRow(
    ctx,
    "write-message-map",
    msg,
    comment.commentId,
    threadRow.recordId,
  );

  return { mirrored: true, ts: msg.ts, commentId: comment.commentId };
}

// --- Branch: first link — create the discussion and backfill ----------------------

async function linkThread(
  ctx: DurableContext,
  msg: SlackMessage,
  ticketNumber: number | null,
  pageIdFromUrl: string | null,
): Promise<unknown> {
  // Resolve the Notion page.
  let pageId = pageIdFromUrl;
  if (ticketNumber !== null) {
    pageId = await ctx.step("resolve-ticket", async () => {
      const res = await sdk.fetch(`${NOTION_API}/data_sources/${TASKS_DS}/query`, {
        connection: NOTION_CONNECTION,
        method: "POST",
        headers: {
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filter: { property: TICKET_PROP, unique_id: { equals: ticketNumber } },
          page_size: 1,
        }),
      });
      if (!res.ok) {
        throw new Error(
          `Tasks query for TKT-${ticketNumber} failed (${res.status}): ${await res.text()}`,
        );
      }
      const json = (await res.json()) as { results?: Array<{ id?: string }> };
      return firstString(json.results?.[0]?.id) || null;
    });

    if (!pageId) {
      // A ticket id that doesn't resolve is a typo or a deleted task. Tell the
      // person in the thread — visible where they are, never a silent drop.
      await ctx.step("post-not-found-note", async () =>
        sdk.runAction({
          appKey: SLACK_APP_KEY,
          actionType: "write",
          actionKey: "channel_message",
          connection: SLACK_CONNECTION,
          inputs: {
            channel: msg.channelId,
            thread_ts: msg.threadTs,
            text: `:warning: Couldn't find TKT-${ticketNumber} in Notion Tasks — thread not linked.`,
            as_bot: "yes",
            username: "Notion Sync",
            unfurl: "no",
            link_names: "no",
            reply_broadcast: "no",
          },
        }),
      );
      return { handled: "ticket-not-found", ticketNumber };
    }
  }

  // Each linked thread needs its OWN discussion, and page-parented comments all
  // join the page's single open page-level discussion (verified live
  // 2026-09-01: two page-parent comments shared one discussion_id, while each
  // block-parent comment opened a fresh one). So: append a small anchor block
  // per thread — it doubles as the in-page marker — and open the discussion on
  // that block.
  const anchorBlockId = await ctx.step("append-anchor-block", async () => {
    const linkText = msg.permalink
      ? {
          type: "text",
          text: { content: "open in Slack", link: { url: msg.permalink } },
        }
      : { type: "text", text: { content: `${msg.channelId}/${msg.threadTs}` } };
    const res = await sdk.fetch(`${NOTION_API}/blocks/${pageId}/children`, {
      connection: NOTION_CONNECTION,
      method: "PATCH",
      headers: {
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        children: [
          {
            object: "block",
            type: "callout",
            callout: {
              icon: { type: "emoji", emoji: "💬" },
              rich_text: [
                { type: "text", text: { content: "Slack thread: " } },
                linkText,
              ],
            },
          },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(
        `Notion append anchor block failed (${res.status}): ${await res.text()}`,
      );
    }
    const json = (await res.json()) as { results?: Array<{ id?: string }> };
    const id = firstString(json.results?.[0]?.id);
    if (!id) throw new Error("Notion append anchor block returned no block id");
    return id;
  });

  // Open the discussion on the anchor block with a header comment.
  const header = await ctx.step("create-discussion", async () =>
    postNotionComment(
      { parent: { block_id: anchorBlockId } },
      msg.permalink
        ? `Linked Slack thread: [open in Slack](${msg.permalink})`
        : `Linked Slack thread ${msg.channelId}/${msg.threadTs}`,
      "Notion Sync",
    ),
  );

  const threadMapId = await ctx.step("write-thread-map", async () => {
    const res = await sdk.runAction({
      appKey: "TableCLIAPI",
      actionType: "write",
      actionKey: "create_record",
      inputs: {
        table_id: THREAD_MAP_TABLE,
        new__data__f1: msg.channelId,
        new__data__f2: msg.threadTs,
        new__data__f3: header.discussionId,
        new__data__f4: pageId,
        new__data__f5: anchorBlockId,
        new__data__f6: "active",
      },
    });
    const row = (res as { data?: Array<{ id?: unknown; record_id?: unknown }> })
      .data?.[0];
    return firstString(row?.id) || firstString(row?.record_id);
  });

  // Backfill the whole thread (includes the root and the triggering message,
  // in order). Bot messages are excluded at the read.
  const thread = await ctx.step("fetch-thread", async () =>
    sdk.runAction({
      appKey: SLACK_APP_KEY,
      actionType: "read_bulk",
      actionKey: "thread_replies",
      connection: SLACK_CONNECTION,
      inputs: {
        channel: msg.channelId,
        thread_ts: msg.threadTs,
        listen_for_bots: "no",
      },
    }),
  );

  const rawRows = ((thread as { data?: unknown[] }).data ?? []) as Array<
    Record<string, unknown>
  >;
  const messages = rawRows
    .map(parseSlackMessage)
    .filter((m): m is SlackMessage => m !== null && !m.isBot);
  messages.sort((a, b) => Number(a.ts) - Number(b.ts));

  let toMirror = messages;
  if (messages.length > BACKFILL_CAP) {
    console.log(
      `thread has ${messages.length} messages — backfilling only the newest ${BACKFILL_CAP} (older ones NOT mirrored)`,
    );
    toMirror = messages.slice(-BACKFILL_CAP);
  }

  let mirrored = 0;
  for (const m of toMirror) {
    const comment = await ctx.step(`backfill-comment-${m.ts}`, async () =>
      postNotionComment(
        { discussion_id: header.discussionId },
        m.text || "(empty message)",
        `${m.authorName} (via Slack)`,
      ),
    );
    await writeMessageMapRow(
      ctx,
      `backfill-map-${m.ts}`,
      m,
      comment.commentId,
      threadMapId,
    );
    mirrored += 1;
  }

  // Confirm in the thread so the linker knows it worked.
  await ctx.step("post-linked-note", async () =>
    sdk.runAction({
      appKey: SLACK_APP_KEY,
      actionType: "write",
      actionKey: "channel_message",
      connection: SLACK_CONNECTION,
      inputs: {
        channel: msg.channelId,
        thread_ts: msg.threadTs,
        text: `:link: Thread linked to ${
          ticketNumber !== null
            ? `<${notionPageUrl(pageId!)}|TKT-${ticketNumber}>`
            : `<${notionPageUrl(pageId!)}|Notion>`
        } — replies here now sync to the task's discussion.`,
        as_bot: "yes",
        username: "Notion Sync",
        unfurl: "no",
        link_names: "no",
        reply_broadcast: "no",
      },
    }),
  );

  return {
    linked: true,
    pageId,
    discussionId: header.discussionId,
    backfilled: mirrored,
  };
}

export default workflow;
