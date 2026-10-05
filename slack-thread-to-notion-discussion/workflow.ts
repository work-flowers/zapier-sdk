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
// f4 = Notion Page ID, f5 = Notion Block ID (empty: page-level discussion;
// rows from the anchor-block era may carry a block id) — written via
// new__data__f4/f5 literals below.
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

// Slack expires an unanswered approval after 30 days; the callback outlives it
// by a day so the expiry (if Zapier reports one) still arrives first.
const APPROVAL_CALLBACK_SECONDS = 31 * 24 * 60 * 60;

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

/**
 * The approver's decision ("Approved", …) from a Request Approval action run —
 * either a getActionRun result or the body Zapier POSTs to the callbackUrl
 * (documented as the same shape; tolerate a `data` envelope either way).
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
  const status =
    first && typeof first === "object" ? (first as { status?: unknown }).status : undefined;
  return typeof status === "string" && status.length > 0 ? status : undefined;
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
    text: firstString(raw.raw_text) || firstString(raw.text),
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
 * The trigger's and thread_replies' `text` is Zapier's pre-processed copy: links
 * lose their <, | and > and formatting markers are dropped, so it cannot be
 * converted back. `raw_text` is Slack's original mrkdwn, but leaves mentions as
 * bare <@U123> ids — resolve each to its handle (what `text` showed) before the
 * markdown conversion. A failed lookup falls back to the id, never a red run.
 * Takes ctx because the step id carries the mention id (the publish analyzer
 * does not follow ctx into a helper, which is what permits a dynamic id).
 */
async function resolveMentions(
  ctx: DurableContext,
  stepPrefix: string,
  text: string,
): Promise<string> {
  const ids = [...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)>/g)].map((m) => m[1]))];
  let out = text;
  for (const id of ids) {
    const name = await ctx.step(`${stepPrefix}-mention-${id}`, async () => {
      try {
        const res = await sdk.runAction({
          appKey: SLACK_APP_KEY,
          actionType: "search",
          actionKey: "user_by_id",
          connection: SLACK_CONNECTION,
          inputs: { id },
        });
        const row = (res as { data?: Array<{ name?: unknown }> }).data?.[0];
        return firstString(row?.name);
      } catch {
        return "";
      }
    });
    out = out.split(`<@${id}>`).join(`<@${id}|${name || id}>`);
  }
  return out;
}

/**
 * Slack delivers emoji as :shortcode: syntax (e.g. ":ok_hand:"). Notion's
 * markdown parser treats :word: as a custom_emoji mention and then rejects it
 * with 400 validation_error ("Unsupported mention type in markdown:
 * custom_emoji") because custom_emoji mentions are not supported in comment
 * bodies. Strip the colon delimiters so the emoji name becomes plain text
 * (:ok_hand: → ok_hand), preserving meaning without triggering the parser.
 *
 * Slack's <url|label> links become [label](url), <url> a bare URL, and the
 * &amp; &lt; &gt; entities are decoded; channel/special mentions keep their label.
 * Slack *bold* / ~strike~ become **bold** / ~~strike~~ and • bullets become "- " lists;
 * code spans and blocks are passed through untouched.
 */
function sanitizeForNotionMarkdown(text: string): string {
  // Park anything that must survive the passes below untouched (code, and Slack
  // links converted to Markdown) behind placeholders: the emoji strip and the
  // bold/strike conversion must never reach inside a URL or a code span.
  const parked: string[] = [];
  const park = (s: string): string => {
    parked.push(s);
    return `\u0000${parked.length - 1}\u0000`;
  };
  const codeParked = text
    .replace(/```[\s\S]*?```/g, park)
    .replace(/`[^`\n]+`/g, park);
  // Slack mrkdwn wraps links and mentions in <...>; convert to Markdown.
  const linked = codeParked.replace(/<([^<>\n]+)>/g, (whole, inner: string) => {
    const bar = inner.indexOf("|");
    const target = bar === -1 ? inner : inner.slice(0, bar);
    const label = bar === -1 ? "" : inner.slice(bar + 1);
    if (/^(https?:|mailto:|tel:)/i.test(target)) {
      const url = target.replace(/\)/g, "%29");
      if (!label || label === target) return park(url);
      return park(`[${label.replace(/[\[\]]/g, "\\$&")}](${url})`);
    }
    if (target.startsWith("#") || target.startsWith("@")) {
      // <#C123|channel>, <@U123|name>: show the human label when there is one.
      return label ? (target[0] === "#" ? `#${label}` : `@${label.replace(/^@/, "")}`) : whole;
    }
    if (target.startsWith("!")) {
      // <!here>, <!channel>, <!subteam^S1|@group>, <!date^...|fallback>
      const special = target.slice(1).split("^")[0];
      if (label) return label;
      if (special === "here" || special === "channel" || special === "everyone") {
        return `@${special}`;
      }
    }
    return whole;
  });
  const stripped = linked.replace(/:[a-zA-Z0-9_+\-]+:/g, (m) => m.slice(1, -1));
  // Slack emphasis: *bold* -> **bold**, ~strike~ -> ~~strike~~ (_italic_ and
  // > quotes are already valid Markdown). Slack only formats a span whose
  // delimiters hug non-space text at word edges, so a stray "2 * 3" is left be.
  const formatted = stripped
    .replace(
      /(^|[\s(])\*([^\s*](?:[^*\n]*[^\s*])?)\*(?=$|[\s.,!?;:)])/gm,
      "$1**$2**",
    )
    .replace(
      /(^|[\s(])~([^\s~](?:[^~\n]*[^\s~])?)~(?=$|[\s.,!?;:)])/gm,
      "$1~~$2~~",
    )
    .replace(/^([ \t]*)[•◦▪]\s+/gm, "$1- ");
  return formatted
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => parked[Number(i)])
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * POST /v1/comments with a custom display_name so the comment renders under the
 * Slack author's own name (verified live 2026-09-01 — Spike C). Must be called
 * inside a ctx.step.
 */
async function postNotionComment(
  parent:
    | { discussion_id: string }
    | { parent: { page_id: string } },
  markdown: string,
  displayName: string,
): Promise<NotionComment> {
  const body: Record<string, unknown> = {
    markdown: sanitizeForNotionMarkdown(markdown),
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

/**
 * A page id parsed from a URL may belong to another Notion workspace entirely
 * — our integration can't see it, and Notion returns 404 rather than a
 * permissions error. A pasted URL can also point at a database rather than a
 * page: Notion answers GET /v1/pages with a permanent 400 validation_error
 * ("Provided ID ... is a database, not a page"), which no retry can fix. Both
 * mean "not a linkable page" — return false and let the caller skip quietly.
 * Must be called inside a ctx.step.
 */
async function pageAccessible(pageId: string): Promise<boolean> {
  const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
    connection: NOTION_CONNECTION,
    method: "GET",
    headers: { "Notion-Version": NOTION_VERSION },
  });
  if (res.status === 404) return false;
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 400 && /is a database, not a page/i.test(body)) {
      return false;
    }
    throw new Error(`Notion page lookup failed (${res.status}): ${body}`);
  }
  return true;
}

/**
 * Title of a page we already know is accessible, for the approval prompt.
 * Falls back to "Notion page" when the title property is empty. Must be called
 * inside a ctx.step.
 */
async function pageTitle(pageId: string): Promise<string> {
  const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
    connection: NOTION_CONNECTION,
    method: "GET",
    headers: { "Notion-Version": NOTION_VERSION },
  });
  if (!res.ok) {
    throw new Error(
      `Notion page lookup failed (${res.status}): ${await res.text()}`,
    );
  }
  const json = (await res.json()) as {
    properties?: Record<
      string,
      { type?: string; title?: Array<{ plain_text?: string }> }
    >;
  };
  for (const prop of Object.values(json.properties ?? {})) {
    if (prop.type === "title") {
      const title = (prop.title ?? []).map((t) => t.plain_text ?? "").join("").trim();
      if (title) return title;
    }
  }
  return "Notion page";
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

  const body = await resolveMentions(ctx, "mirror", msg.text);
  const comment = await ctx.step("post-notion-comment", async () =>
    postNotionComment(
      { discussion_id: discussionId },
      body || "(empty message)",
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
  } else {
    // URL-provided page: a URL parses the same way regardless of which
    // workspace it points at, so verify our connection can actually see the
    // page before opening a discussion on it.
    const accessible = await ctx.step("check-page-access", async () =>
      pageAccessible(pageId!),
    );
    if (!accessible) {
      // Unlike a mistyped TKT-###, this isn't something the poster did wrong
      // — a link to another workspace's Notion (or to a database, which can't
      // host a page-level discussion) is a normal thing to paste in Slack. No
      // reply needed; just don't link the thread.
      console.log(
        `Notion page ${pageId} not linkable (external workspace or a database) — not linking ${msg.channelId}/${msg.threadTs}`,
      );
      return { handled: "page-not-linkable" };
    }
  }

  // Approval gate: a mention alone no longer links a thread. Slack's Request
  // Approval action holds until someone clicks (expires after 30 days), so it
  // must NOT go through sdk.runAction: that polls for at most 180s, then throws
  // ZAPIER_TIMEOUT_ERROR, and every step retry posted a NEW prompt into the
  // thread (2026-10-05, #deal-alfalah: four prompts, and the click landed on a
  // timed-out attempt so nothing linked). Instead the prompt is started once
  // with createActionRun, whose callbackUrl is a durable callback: Zapier POSTs
  // the finished run there and the run parks at no cost until then. There is
  // deliberately no pending row and no Decline button: an ignored request means
  // "do nothing", and mentioning a page again re-prompts. Anyone may approve.
  const title = await ctx.step("get-page-title", async () => pageTitle(pageId!));
  const [approvalDone, approvalCallbackUrl] = await ctx.createCallback({
    name: "approval-result",
    timeoutSeconds: APPROVAL_CALLBACK_SECONDS,
  });
  const approvalRunId = await ctx.step("start-approval", async () => {
    const started = await sdk.createActionRun({
      app: SLACK_APP_KEY,
      actionType: "write",
      action: "request_approval",
      connection: SLACK_CONNECTION,
      callbackUrl: approvalCallbackUrl,
      inputs: {
        request_message: `Link this thread to *<${notionPageUrl(pageId!)}|${title.replace(/[<>|]/g, "")}>*? Approving mirrors every reply here into Notion comments.`,
        send_as: "bot",
        approval_type: "channel",
        channel: msg.channelId,
        thread_ts: msg.threadTs,
        username: "Notion Sync",
        icon: ":notion:",
      },
    });
    return started.data.id;
  });
  const approvalOutcome = await approvalDone;
  if (approvalOutcome.status === "expired") {
    console.log(`approval ${approvalRunId} for ${msg.channelId}/${msg.threadTs} never answered — not linking`);
    return { handled: "approval-expired" };
  }
  // Read the decision from the action run itself; fall back to the callback
  // body once the run has aged out of Zapier's 7-day result retention.
  const decision = await ctx.step("read-approval", async () => {
    try {
      const run = await sdk.getActionRun({ run: approvalRunId });
      const fromRun = approvalDecision(run);
      if (fromRun) return fromRun;
    } catch (err) {
      console.log(`getActionRun ${approvalRunId} failed (${String(err)}) — using the callback body`);
    }
    return approvalDecision(approvalOutcome.value) ?? "unknown";
  });
  if (decision !== "Approved") {
    console.log(`approval for ${msg.channelId}/${msg.threadTs} returned ${decision} — not linking`);
    return { handled: "not-approved", decision };
  }

  // The run may have been parked for days; another approval (or mention) can
  // have linked this thread meanwhile. Re-check so we never open a second
  // discussion for the same thread.
  const linkedMeanwhile = await findThreadMapRow(
    ctx,
    "recheck-thread-map",
    msg.channelId,
    msg.threadTs,
  );
  if (linkedMeanwhile) {
    console.log(`thread ${msg.channelId}/${msg.threadTs} linked while awaiting approval — skipping`);
    return { skipped: "linked-while-awaiting-approval" };
  }

  // Open the discussion with a header comment linking back to Slack.
  // KNOWN LIMITATION (accepted while TKT-825 is paused, 2026-09-02): the API
  // cannot open a second page-level thread. A page-parented comment opens a
  // fresh page-level discussion only when the page has none open; otherwise it
  // joins the MOST RECENTLY CREATED open thread (verified live 2026-09-02
  // against the multi-thread alpha). Replies by discussion_id always land in
  // the captured discussion, so the sync stays consistent either way.
  const header = await ctx.step("create-discussion", async () =>
    postNotionComment(
      { parent: { page_id: pageId! } },
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
        new__data__f5: "",
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
    const body = await resolveMentions(ctx, `backfill-${m.ts}`, m.text);
    const comment = await ctx.step(`backfill-comment-${m.ts}`, async () =>
      postNotionComment(
        { discussion_id: header.discussionId },
        body || "(empty message)",
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
        } — replies here now sync to the page's discussion.`,
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
