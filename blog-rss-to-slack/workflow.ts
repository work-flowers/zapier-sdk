// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/blog-rss-to-slack
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
const SLACK_APP_KEY = "SlackCLIAPI";
const SLACK_CONNECTION = "slack_wf"; // Slack @dennis (Work.Flowers)

/** #marketing */
const SLACK_CHANNEL = "C08GV0YNBK9";

/** The blog feed also emits an entry when a new tag or author page appears —
 *  those are index pages, not posts, and must not be announced. */
const EXCLUDED_LINK_SUBSTRINGS = [
  "https://www.work.flowers/blog/tags",
  "https://www.work.flowers/blog/authors",
];

// --- Types --------------------------------------------------------------------

type Input = Record<string, unknown>;
type Outcome = Record<string, unknown>;

// --- Helpers ------------------------------------------------------------------

function normalizeInput(rawInput: unknown): unknown {
  let v: unknown = rawInput;
  for (let i = 0; i < 4 && typeof v === "string"; i += 1) {
    const s = v.trim();
    if (!s.startsWith("{") && !s.startsWith("[") && !s.startsWith('"')) break;
    try {
      v = JSON.parse(s);
    } catch {
      break;
    }
  }
  return v;
}

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

function previewOnlyFlag(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, any>;
  return o.previewOnly === true || o.previewOnly === "true";
}

function firstString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** The feed item's link, wherever the trigger pipeline put it. */
function extractLink(payload: unknown): string {
  const visit = (v: unknown, depth: number): string => {
    if (!v || typeof v !== "object" || depth > 3) return "";
    const o = v as Record<string, any>;
    const direct = firstString(o.link) || firstString(o.url);
    if (direct) return direct;
    for (const key of ["data", "body", "item", "payload"]) {
      const nested = visit(o[key], depth + 1);
      if (nested) return nested;
    }
    return "";
  };
  return visit(payload, 0);
}

// --- Workflow -------------------------------------------------------------------

const workflow = defineDurable<Input, Outcome>(
  "blog-rss-to-slack",
  async (ctx, rawInput) => {
    const payload = normalizeInput(rawInput);

    if (isEmptyPing(payload)) {
      console.log("empty payload — treating as a ping, not a feed item");
      return { skipped: "empty-payload" };
    }

    const link = extractLink(payload);
    if (!link) {
      throw new Error(
        `payload carried content but no link — shape not understood: ${JSON.stringify(payload).slice(0, 500)}`,
      );
    }

    for (const excluded of EXCLUDED_LINK_SUBSTRINGS) {
      if (link.toLowerCase().includes(excluded.toLowerCase())) {
        console.log(`feed entry is a tag/author index page, not a post: ${link}`);
        return { skipped: "tag-or-author-page", link };
      }
    }

    const text = `New <${link}|blog post> published`;

    if (previewOnlyFlag(payload)) {
      return { previewOnly: true, link, text };
    }

    const message = await ctx.step("post-to-marketing", async () =>
      sdk.runAction({
        appKey: SLACK_APP_KEY,
        actionType: "write",
        actionKey: "channel_message",
        connection: SLACK_CONNECTION,
        inputs: {
          channel: SLACK_CHANNEL,
          text,
          as_bot: "yes",
          username: "BlogBot",
          icon: ":blogger:",
          unfurl: "yes",
          link_names: "yes",
          add_app_to_channel: "yes",
          reply_broadcast: "no",
        },
      }),
    );

    return { posted: true, link, ts: firstString((message as any)?.data?.[0]?.ts) };
  },
);

export default workflow;
