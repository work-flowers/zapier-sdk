// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/goodreads-reviews-to-notion
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
const NOTION_APP_KEY = "NotionCLIAPI";
const NOTION_CONNECTION = "notion_wf";

// The "Social Content" data source in the work.flowers Notion workspace — the
// same one save-tagged-docs-to-notion writes to. A finished Goodreads read
// becomes a "Book Review" content idea.
const SOCIAL_CONTENT_DS = "14591b07-11ac-8187-934a-000b1a3a474d";

// Dennis, as the `Author` people property (a Notion user id).
const AUTHOR_PERSON_ID = "121d872b-594c-810b-ba5a-000206eeef1e";

// The RSS "New Item in Feed" trigger delivers one feed item; accept anything
// and extract defensively.
const InputSchema = z.unknown();

// --- Pure helpers ----------------------------------------------------------
function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline can deliver input double-encoded (a JSON string of a
  // JSON string), while run-durable delivers it single-encoded. Parse until we
  // reach a non-string, or stop on parse failure.
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

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

/** First item of a runAction result ({ data: [...] } or a bare array). */
function firstResult(res: any): any {
  if (res && Array.isArray(res.data)) return res.data[0] ?? null;
  if (Array.isArray(res)) return res[0] ?? null;
  return res ?? null;
}

// The known Zapier wrapper keys a poll/catch payload can arrive under; a
// payload with only these, all empty, carries no event (a UI "test" run or an
// empty poll tick).
const WRAPPER_KEYS = new Set(["querystring", "headers", "params", "body", "query"]);

/**
 * True when the payload carries nothing to act on: null / "" / {} / [], or an
 * object whose only keys are the empty wrapper keys above. This is the ONLY
 * shape allowed to skip silently — a payload with real content but no usable
 * book identity is an unrecognized event and must throw (see the body).
 */
function isEmptyish(payload: unknown): boolean {
  if (payload === null || payload === undefined) return true;
  if (typeof payload === "string") return payload.trim() === "";
  if (Array.isArray(payload)) return payload.length === 0;
  if (typeof payload !== "object") return false;
  const entries = Object.entries(payload as Record<string, unknown>);
  if (entries.length === 0) return true;
  return entries.every(([k, v]) => {
    if (!WRAPPER_KEYS.has(k)) return false;
    if (v === null || v === undefined || v === "") return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === "object") return Object.keys(v as object).length === 0;
    return false;
  });
}

interface Review {
  /** The book title, from the Goodreads feed item title. */
  title: string;
  /** The book's author, when the feed carries it. */
  author: string | null;
  /** The review/book link, used only to identify the item when a title is
   *  somehow absent. */
  link: string | null;
}

/** Pull the fields we need out of an RSS feed item. Goodreads' read-shelf feed
 *  puts the book title in `title` and the author in `raw.author_name` (with a
 *  flattened `author_name` sometimes present too). Returns null when there is
 *  no usable identity — the caller decides skip vs. throw. */
function extractReview(raw: unknown): Review | null {
  const o = (raw ?? {}) as Record<string, any>;
  // Unwrap a Zapier wrapper if the real item is nested.
  const d = (o.body ?? o.data ?? o) as Record<string, any>;
  const nested = (d.raw ?? {}) as Record<string, any>;
  const title = firstString(d.title, nested.title);
  const link = firstString(d.link, d.url, nested.link, d.guid, d.id);
  if (!title && !link) return null;
  return {
    title: title ?? (link as string),
    author: firstString(
      nested.author_name,
      d.author_name,
      d.author,
      nested.author,
    ),
    link,
  };
}

// --- Workflow --------------------------------------------------------------
// Goodreads "read" shelf RSS -> create a Social Content "Book Review" idea in
// Notion, one per finished book.
//
// No dedup ledger: the RSS "New Item in Feed" trigger delivers each feed item
// (by guid) exactly once, which is precisely the dedup this needs — a finished
// book fires once and never re-fires. That leaves the repo's default posture of
// "idempotent writes, accept rare duplicates": a whole-run replay could create
// a second page, which for a low-volume personal feed is an acceptable trade.
//
// A payload with real content but no book title or link IS an error — a feed
// schema change — and throws, per the repo's default unrecognized-payload
// posture (see .claude/rules/durables.md). An empty/test tick skips.
const workflow = defineDurable(
  "goodreads-reviews-to-notion",
  async (ctx, rawInput: unknown) => {
    const payload = InputSchema.parse(normalizeInput(rawInput));
    const review = extractReview(payload);

    if (!review) {
      if (isEmptyish(payload)) {
        console.log("skipping: empty payload (test tick / empty poll)");
        return { skipped: "empty-payload" };
      }
      throw new Error(
        "Unrecognized RSS payload: no book title or link could be extracted",
      );
    }

    const name = review.author
      ? `Book Review: ${review.title} by ${review.author}`
      : `Book Review: ${review.title}`;

    // Create the Social Content page. `template_mode: "default"` applies the
    // data source's default template when one exists (repo rule 5); Social
    // Content has none today, so the create is retried without it — caught
    // INSIDE the step so a template miss doesn't spin the step-retry loop.
    const props: Record<string, unknown> = {
      "properties|||Name|||title": name,
      "properties|||Type|||select": "Book Review",
      "properties|||Channel|||multi_select": ["LI@dchiuten"],
      "properties|||Author|||people": [AUTHOR_PERSON_ID],
    };

    const created = await ctx.step("create-social-content-page", async () => {
      const inputs = { datasource: SOCIAL_CONTENT_DS, ...props };
      try {
        const res = await sdk.runAction({
          appKey: NOTION_APP_KEY,
          actionType: "write",
          actionKey: "create_database_item",
          connection: NOTION_CONNECTION,
          inputs: { ...inputs, template_mode: "default" },
        });
        return { res, usedTemplate: true };
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        if (!/no default template/i.test(msg)) throw err;
        const res = await sdk.runAction({
          appKey: NOTION_APP_KEY,
          actionType: "write",
          actionKey: "create_database_item",
          connection: NOTION_CONNECTION,
          inputs,
        });
        return { res, usedTemplate: false };
      }
    });

    const pageId = firstString(firstResult(created?.res)?.id);
    if (!pageId) {
      throw new Error("Social Content page creation returned no page id");
    }

    return {
      title: review.title,
      author: review.author,
      link: review.link,
      notionPageId: pageId,
      usedTemplate: Boolean(created?.usedTemplate),
    };
  },
);

export default workflow;
