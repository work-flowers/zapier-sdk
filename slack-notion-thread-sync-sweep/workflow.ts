// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/slack-notion-thread-sync-sweep
// First-publish retry: run 33483876845 died on this Zap's publish, and the
// pending-create path only fires on a SOURCE change — hence this comment.
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";

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
const TM_PAGE = "f4";
const TM_BLOCK = "f5"; // per-thread anchor block the discussion lives on
const TM_STATE = "f6";

const MESSAGE_MAP_TABLE = "01M1DXY3QEF60HX7HW8XYVE5AF";
const MM_SLACK_TS = "f1";
const MM_CHANNEL = "f2";

// Per-thread backstop cap per sweep run: enough to drain a normal day of missed
// deliveries without letting one runaway thread eat the run. Logged when hit —
// never a silent cap; the next sweep continues where this one stopped.
const BACKSTOP_CAP = 25;

// --- Helpers -------------------------------------------------------------------

function firstString(v: unknown): string {
  return typeof v === "string" && v.length > 0 ? v : "";
}

type ThreadRow = {
  recordId: string;
  channelId: string;
  threadTs: string;
  discussionId: string;
  pageId: string;
  blockId: string; // anchor block; falls back to pageId for legacy rows
  state: string;
};

/** list_records rows come back as {id, data} (CLI shape) or {record_id, old.data}
 *  (find_record shape) — accept both rather than trusting one. */
function parseThreadRow(raw: Record<string, unknown>): ThreadRow | null {
  const recordId = firstString(raw.id) || firstString(raw.record_id);
  const data = ((raw.data ??
    (raw.old as Record<string, unknown> | undefined)?.data ??
    {}) as Record<string, unknown>);
  if (!recordId) return null;
  // list_records may key data by field NAME instead of field id — accept both.
  const get = (fieldId: string, fieldName: string) =>
    firstString(data[fieldId]) || firstString(data[fieldName]);
  return {
    recordId,
    channelId: get(TM_CHANNEL, "Slack Channel ID"),
    threadTs: get(TM_THREAD_TS, "Slack Thread Ts"),
    discussionId: get(TM_DISCUSSION, "Notion Discussion ID"),
    pageId: get(TM_PAGE, "Notion Page ID"),
    blockId: get(TM_BLOCK, "Notion Block ID"),
    state: get(TM_STATE, "State"),
  };
}

type SlackMessage = {
  ts: string;
  channelId: string;
  text: string;
  isBot: boolean;
  authorName: string;
};

function parseSlackMessage(raw: Record<string, unknown>): SlackMessage | null {
  const ts = firstString(raw.ts);
  if (!ts) return null;
  const channel = raw.channel as Record<string, unknown> | string | undefined;
  const user = raw.user as Record<string, unknown> | string | undefined;
  const profile =
    typeof user === "object" && user
      ? ((user.profile ?? {}) as Record<string, unknown>)
      : {};
  const name =
    [firstString(profile.first_name), firstString(profile.last_name)]
      .filter(Boolean)
      .join(" ") ||
    (typeof user === "object" && user ? firstString(user.name) : "") ||
    "Unknown";
  return {
    ts,
    channelId: typeof channel === "string" ? channel : firstString(channel?.id),
    text: firstString(raw.text),
    isBot: typeof user === "object" && user ? user.is_bot === true : false,
    authorName: name,
  };
}

// --- Workflow -------------------------------------------------------------------

const workflow = defineDurable<Record<string, unknown>, unknown>(
  "slack-notion-thread-sync-sweep",
  async (ctx: DurableContext) => {
    // 1. Every mapped thread. Table reads are free.
    const listed = await ctx.step("list-thread-map", async () =>
      sdk.runAction({
        appKey: "TableCLIAPI",
        actionType: "read",
        actionKey: "list_records",
        inputs: { table_id: THREAD_MAP_TABLE },
      }),
    );
    const allRows = (((listed as { data?: unknown[] }).data ?? []) as Array<
      Record<string, unknown>
    >)
      .map(parseThreadRow)
      .filter((r): r is ThreadRow => r !== null);
    const active = allRows.filter((r) => r.state === "active");
    console.log(`thread_map: ${allRows.length} rows, ${active.length} active`);

    const summary: Array<Record<string, unknown>> = [];

    for (const row of active) {
      if (!row.channelId || !row.threadTs || !row.discussionId || !row.pageId) {
        // A corrupt mapping must surface, not silently rot.
        throw new Error(
          `thread_map row ${row.recordId} is missing fields — mapping is corrupt`,
        );
      }

      // 2a. Resolve check: a discussion that vanished from the comments list
      // was resolved (or deleted — the API cannot tell them apart). Discussions
      // are opened on a per-thread anchor block, so query that block; legacy
      // rows without one fall back to the page id.
      const stillOpen = await ctx.step(`check-discussion-${row.recordId}`, async () => {
        const res = await sdk.fetch(
          `${NOTION_API}/comments?block_id=${row.blockId || row.pageId}&page_size=100`,
          {
            connection: NOTION_CONNECTION,
            headers: { "Notion-Version": NOTION_VERSION },
          },
        );
        if (!res.ok) {
          throw new Error(
            `Notion list comments for ${row.pageId} failed (${res.status}): ${await res.text()}`,
          );
        }
        const json = (await res.json()) as {
          results?: Array<{ discussion_id?: string }>;
        };
        return (json.results ?? []).some(
          (c) => firstString(c.discussion_id) === row.discussionId,
        );
      });

      if (!stillOpen) {
        await ctx.step(`mark-resolved-${row.recordId}`, async () =>
          sdk.runAction({
            appKey: "TableCLIAPI",
            actionType: "write",
            actionKey: "update_record",
            inputs: {
              table_id: THREAD_MAP_TABLE,
              record_id: row.recordId,
              new__data__f6: "resolved",
            },
          }),
        );
        await ctx.step(`post-resolved-note-${row.recordId}`, async () =>
          sdk.runAction({
            appKey: SLACK_APP_KEY,
            actionType: "write",
            actionKey: "channel_message",
            connection: SLACK_CONNECTION,
            inputs: {
              channel: row.channelId,
              thread_ts: row.threadTs,
              text: `:white_check_mark: The linked <https://www.notion.so/${row.pageId.replace(/-/g, "")}|Notion discussion> was resolved — this thread is no longer syncing.`,
              as_bot: "yes",
              username: "Notion Sync",
              unfurl: "no",
              link_names: "no",
              reply_broadcast: "no",
            },
          }),
        );
        summary.push({ thread: row.threadTs, resolved: true });
        continue;
      }

      // 2b. Reply backstop: diff the full Slack thread against message_map and
      // mirror anything the event path missed. Idempotent — the event durable
      // and this sweep converge on the same slack_ts-keyed rows.
      const thread = await ctx.step(`fetch-thread-${row.recordId}`, async () =>
        sdk.runAction({
          appKey: SLACK_APP_KEY,
          actionType: "read_bulk",
          actionKey: "thread_replies",
          connection: SLACK_CONNECTION,
          inputs: {
            channel: row.channelId,
            thread_ts: row.threadTs,
            listen_for_bots: "no",
          },
        }),
      );
      const messages = (((thread as { data?: unknown[] }).data ?? []) as Array<
        Record<string, unknown>
      >)
        .map(parseSlackMessage)
        .filter((m): m is SlackMessage => m !== null && !m.isBot);
      messages.sort((a, b) => Number(a.ts) - Number(b.ts));

      let mirrored = 0;
      for (const m of messages) {
        if (mirrored >= BACKSTOP_CAP) {
          console.log(
            `thread ${row.threadTs}: backstop cap (${BACKSTOP_CAP}) hit — remaining messages sync on the next sweep`,
          );
          break;
        }
        const seen = await ctx.step(`find-map-${row.recordId}-${m.ts}`, async () => {
          const res = await sdk.runAction({
            appKey: "TableCLIAPI",
            actionType: "search",
            actionKey: "find_record",
            inputs: {
              table_id: MESSAGE_MAP_TABLE,
              filter_count: "2",
              use_stored_order: false,
              field_data_key: MM_SLACK_TS,
              operator: "exact",
              lookup_value: m.ts,
              field_data_key_2: MM_CHANNEL,
              operator_2: "exact",
              lookup_value_2: row.channelId,
              _zap_search_multiple_results: "first",
              _zap_search_success_on_miss: true,
            },
          });
          const rows = (res as { data?: unknown[] }).data;
          return Array.isArray(rows) && rows.length > 0 && !!(rows[0] as Record<string, unknown>).record_id;
        });
        if (seen) continue;

        const commentId = await ctx.step(
          `backstop-comment-${row.recordId}-${m.ts}`,
          async () => {
            const res = await sdk.fetch(`${NOTION_API}/comments`, {
              connection: NOTION_CONNECTION,
              method: "POST",
              headers: {
                "Notion-Version": NOTION_VERSION,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                discussion_id: row.discussionId,
                markdown: m.text || "(empty message)",
                display_name: {
                  type: "custom",
                  custom: { name: `${m.authorName} (via Slack)` },
                },
              }),
            });
            if (!res.ok) {
              throw new Error(
                `Notion create comment failed (${res.status}): ${await res.text()}`,
              );
            }
            const json = (await res.json()) as Record<string, unknown>;
            return firstString(json.id);
          },
        );
        await ctx.step(`backstop-map-${row.recordId}-${m.ts}`, async () =>
          sdk.runAction({
            appKey: "TableCLIAPI",
            actionType: "write",
            actionKey: "create_record",
            inputs: {
              table_id: MESSAGE_MAP_TABLE,
              new__data__f1: m.ts,
              new__data__f2: row.channelId,
              new__data__f3: commentId,
              new__data__f4: row.recordId,
              new__data__f5: "slack",
            },
          }),
        );
        mirrored += 1;
      }

      summary.push({ thread: row.threadTs, resolved: false, backfilled: mirrored });
    }

    return { threads: active.length, summary };
  },
);

export default workflow;
