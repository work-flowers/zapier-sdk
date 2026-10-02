// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/notion-button-to-skills-sync
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// GitHub's Zapier app has no "dispatch workflow" action, so the call goes
// through sdk.fetch with the GitHub connection's auth.
const GITHUB_CONNECTION = "github_wf";

// The hourly Notion -> skills sync in work-flowers/synced-skills. It declares
// `workflow_dispatch`, and its concurrency group queues a click that lands
// while a sync is already running rather than running two at once.
const DISPATCH_URL =
  "https://api.github.com/repos/work-flowers/synced-skills/actions/workflows/sync.yml/dispatches";
const DISPATCH_REF = "main";

// --- Pure helpers ----------------------------------------------------------
function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline can deliver input double-encoded (a JSON string of a
  // JSON string), while run-durable delivers it single-encoded. Parse until we
  // reach a non-string, or stop on parse failure.
  let v: unknown = rawInput;
  for (let i = 0; i < 4 && typeof v === "string"; i++) {
    const t = v.trim();
    if (t === "") return "";
    // run-durable delivers a JSON `null` input as the string "null".
    if (t === "null") return null;
    if (t[0] !== "{" && t[0] !== "[" && t[0] !== '"') break;
    try {
      v = JSON.parse(t);
    } catch {
      break;
    }
  }
  return v;
}

/** A touch of the catch URL (button setup, "test", a curl) rather than an
 *  event: no keys, or only known wrapper keys whose values are empty. */
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

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

type ButtonClick = { pageId: string; clickedBy: string | null };

/** The Notion button's "Send webhook" body: `{ source: {...}, data: <page> }`.
 *  Only the page id is needed — the sync itself always covers the whole DB. */
function extractClick(raw: unknown): ButtonClick | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, any>;
  const data = (o.data ?? {}) as Record<string, any>;
  if (data.object !== "page") return null;
  const pageId = firstString(data.id);
  if (!pageId) return null;
  return { pageId, clickedBy: firstString(o.source?.user_id) };
}

// --- Workflow --------------------------------------------------------------
const workflow = defineDurable(
  "notion-button-to-skills-sync",
  async (ctx, rawInput) => {
    const payload = normalizeInput(rawInput);
    if (isEmptyPing(payload)) {
      console.log("empty payload — treating as a ping of the catch URL, not an event");
      return { skipped: "empty-payload" };
    }

    const click = extractClick(payload);
    if (!click) {
      // Content that isn't a Notion page is a real event whose shape we
      // failed to understand — surface it rather than drop it.
      throw new Error(
        `Unrecognized payload (expected data.object "page" with data.id): ${JSON.stringify(payload).slice(0, 500)}`,
      );
    }

    // A successful dispatch answers 204 with no body. Anything else (401/403
    // auth, 404 wrong path, 422 bad ref) is a real rejection, so fail fast
    // with GitHub's message rather than retrying.
    await ctx.step("dispatch-sync", async () => {
      const res = await sdk.fetch(DISPATCH_URL, {
        connection: GITHUB_CONNECTION,
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ ref: DISPATCH_REF }),
      });
      if (res.status !== 204) {
        throw new Error(`GitHub workflow dispatch failed (${res.status}): ${await res.text()}`);
      }
      return { status: res.status };
    });

    console.log(`dispatched sync.yml on ${DISPATCH_REF} for page ${click.pageId}`);
    return { dispatched: true, pageId: click.pageId, clickedBy: click.clickedBy };
  },
);

export default workflow;
