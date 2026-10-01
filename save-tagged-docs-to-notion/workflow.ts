// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/save-tagged-docs-to-notion
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
const NOTION_APP_KEY = "NotionCLIAPI";
const NOTION_CONNECTION = "notion_wf";

// The "Social Content" data source in the work.flowers Notion workspace — where
// a tagged Reader article becomes an "Article Share" idea.
const SOCIAL_CONTENT_DS = "14591b07-11ac-8187-934a-000b1a3a474d";

// Dennis, as the `Author` people property (a Notion user id).
const AUTHOR_PERSON_ID = "121d872b-594c-810b-ba5a-000206eeef1e";

// Zapier Tables (free ops, no connection). Readwise Reader document id ->
// { Date Added, Notion Page ID }. This is the dedup ledger: a document already
// in here has already been turned into a Social Content page, so it is skipped.
// Columns: f1 = Document ID, f2 = Date Added, f3 = Notion Page ID.
const DEDUP_TABLE = "01KKNC03EA4Z5Y0KR8H6TP2A8K";

// The tag that opts a Reader document into this workflow. The trigger fires on
// ANY tag change to ANY document, so this is the real gate (the classic Zap's
// Filter step).
const TRIGGER_TAG = "sendtonotion";

// The Readwise Reader "Document Tags Updated" trigger delivers a document
// object; accept anything and extract defensively.
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

// The known Zapier wrapper keys a catch/poll payload can arrive under; a
// payload that has only these, all empty, carries no event (a UI "test" run or
// an empty poll tick).
const WRAPPER_KEYS = new Set(["querystring", "headers", "params", "body", "query"]);

/**
 * True when the payload carries nothing to act on: null / "" / {} / [], or an
 * object whose only keys are the empty wrapper keys above. This is the ONLY
 * shape allowed to skip silently — anything with real content but no usable
 * document id is an unrecognized event and must throw (see the workflow body).
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

interface ReaderDoc {
  id: string;
  title: string | null;
  sourceUrl: string | null;
  tags: string[];
}

/** Every tag name on the document, lowercased. Readwise delivers `tags` in more
 *  than one shape depending on the surface: an object keyed by slug
 *  (`{ slug: { name, type } }`), a plain array of strings or `{ name }` objects,
 *  or a comma/space-joined string. Cover all three. */
function extractTagNames(tags: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    const s = firstString(v);
    if (s) out.push(s.toLowerCase());
  };
  if (Array.isArray(tags)) {
    for (const t of tags) {
      if (t && typeof t === "object") push((t as any).name ?? (t as any).tag);
      else push(t);
    }
  } else if (tags && typeof tags === "object") {
    for (const [slug, val] of Object.entries(tags as Record<string, unknown>)) {
      if (val && typeof val === "object") push((val as any).name ?? slug);
      else push(slug);
    }
  } else if (typeof tags === "string") {
    for (const part of tags.split(/[,;]/)) push(part);
  }
  return out;
}

/** Pull the fields we need out of a Reader document payload. Returns null when
 *  there is no usable document id — the caller decides skip vs. throw. */
function extractDoc(raw: unknown): ReaderDoc | null {
  const o = (raw ?? {}) as Record<string, any>;
  // Unwrap a Zapier wrapper if the real object is nested.
  const d = (o.body ?? o.data ?? o) as Record<string, any>;
  const id = firstString(d.id, d.document_id, d.doc_id, d.reader_id);
  if (!id) return null;
  return {
    id,
    title: firstString(d.title, d.name),
    sourceUrl: firstString(d.source_url, d.url, d.source),
    tags: extractTagNames(d.tags ?? d.document_tags),
  };
}

// --- Workflow --------------------------------------------------------------
// Readwise Reader "Document Tags Updated" -> create a Social Content "Article
// Share" idea in Notion, deduped through a free Zapier Table so a document is
// only ever turned into a page once.
//
// The trigger has no tag filter, so it fires on EVERY tag change to EVERY
// document. `sendtonotion` is the gate (the classic Zap's Filter step): a
// document without it is a recognized event we intentionally ignore, not an
// error. A payload with real content but no extractable document id IS an
// error — a vendor schema change — and throws, per the repo's default
// unrecognized-payload posture (see .claude/rules/durables.md).
const workflow = defineDurable(
  "save-tagged-docs-to-notion",
  async (ctx, rawInput: unknown) => {
    const payload = InputSchema.parse(normalizeInput(rawInput));
    const doc = extractDoc(payload);

    if (!doc) {
      // No usable id. An empty/test tick is a clean no-op; anything with real
      // content is an unrecognized event that must surface, so throw.
      if (isEmptyish(payload)) {
        console.log("skipping: empty payload (test tick / empty poll)");
        return { skipped: "empty-payload" };
      }
      throw new Error(
        "Unrecognized Reader payload: no document id could be extracted",
      );
    }

    // The gate: only act on documents tagged `sendtonotion`.
    if (!doc.tags.includes(TRIGGER_TAG)) {
      console.log(`skipping ${doc.id}: not tagged ${TRIGGER_TAG}`);
      return { skipped: "not-tagged", documentId: doc.id };
    }

    // Dedup: has this document already been turned into a page? The free Table
    // is the ledger; a hit means the page exists, so stop.
    const existing = await ctx.step("find-in-dedup-table", async () =>
      sdk.listTableRecords({
        table: DEDUP_TABLE,
        keyMode: "names",
        filters: [{ fieldKey: "Document ID", operator: "exact", value: doc.id }],
        pageSize: 1,
      }),
    );
    const existingPageId = firstString(
      existing?.data?.[0]?.data?.["Notion Page ID"],
    );
    if (existingPageId) {
      console.log(`skipping ${doc.id}: already in dedup table -> ${existingPageId}`);
      return {
        skipped: "already-processed",
        documentId: doc.id,
        notionPageId: existingPageId,
      };
    }

    const title = doc.title ?? doc.sourceUrl ?? doc.id;
    const sourceUrl = doc.sourceUrl ?? "";

    // Create the Social Content page. `template_mode: "default"` applies the
    // data source's default template when one exists (repo rule 5); if none is
    // configured, that one error is caught and the create retried without it,
    // INSIDE the step so a template miss doesn't spin the step-retry loop.
    const props: Record<string, unknown> = {
      "properties|||Name|||title": `Article Share: ${title}`,
      "properties|||Type|||select": "Article Share",
      "properties|||Status|||status": "Ideas 🧠",
      "properties|||Author|||people": [AUTHOR_PERSON_ID],
      "properties|||Channel|||multi_select": ["LI@dchiuten"],
      "properties|||sc_link_article|||url": sourceUrl,
      "properties|||sc_title_article|||rich_text": title,
      "properties|||sc_first_comment|||rich_text": `"${title}": ${sourceUrl}`,
      "properties|||Research note|||checkbox": true,
      use_zapier_datetime_fields: false,
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

    // Fix the timestamp in its own step so it is stable across retries (the
    // determinism guard forbids `new Date` in the workflow body; inside a step
    // it is fine and memoized on success).
    const dateAdded = await ctx.step("now", async () => new Date().toISOString());

    // Record the document in the dedup ledger so it is never reprocessed.
    await ctx.step("index-in-dedup-table", async () => {
      try {
        await sdk.createTableRecords({
          table: DEDUP_TABLE,
          keyMode: "names",
          records: [
            {
              data: {
                "Document ID": doc.id,
                "Date Added": dateAdded,
                "Notion Page ID": pageId,
              },
            },
          ],
        });
        return { logged: "created" as const };
      } catch (err) {
        return { logged: "error" as const, error: String((err as Error)?.message ?? err) };
      }
    });

    return {
      documentId: doc.id,
      title,
      sourceUrl: doc.sourceUrl,
      notionPageId: pageId,
      usedTemplate: Boolean(created?.usedTemplate),
    };
  },
);

export default workflow;
