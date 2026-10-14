// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/save-tagged-docs-sweep
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// Daily backstop for save-tagged-docs-to-notion. That Zap's Readwise trigger is
// deduped on the document id by the durable runtime (Zapier bug W6ZE93-VMEWP),
// so it fires once per document, ever. Reader's auto-tagging on save usually
// uses up that firing, and a `sendtonotion` tag added later never arrives. This
// sweep lists the tagged documents directly and creates whatever the shared
// dedup ledger is missing, with the same page shape as the trigger Zap. Retire
// it once Zapier ships the fix and a late tag is seen firing the trigger Zap.

// --- Bindings --------------------------------------------------------------
const NOTION_APP_KEY = "NotionCLIAPI";
const NOTION_CONNECTION = "notion_wf";

// work.flowers' own private "Readwise Reader (Unofficial)" app. Its
// `new_tagged_document` read returns the newest 100 documents carrying a tag,
// through the existing connection: no Readwise token stored anywhere. (The
// official Readwise app has no list/search action, and Zapier's relay won't
// attach its credentials to sdk.fetch.)
const READER_APP_KEY = "App233250CLIAPI";
const READER_CONNECTION = "reader";

// Same targets as save-tagged-docs-to-notion; keep the two in step.
const SOCIAL_CONTENT_DS = "14591b07-11ac-8187-934a-000b1a3a474d";
const AUTHOR_PERSON_ID = "121d872b-594c-810b-ba5a-000206eeef1e";
// Shared dedup ledger: Reader document id -> Notion page id. Columns:
// f1 = Document ID, f2 = Date Added, f3 = Notion Page ID.
const DEDUP_TABLE = "01KKNC03EA4Z5Y0KR8H6TP2A8K";
const TRIGGER_TAG = "sendtonotion";

// Only tags applied on or after 2026-08-29T00:00Z are considered. That is when
// the classic Zap was paused, and the ledger was verified complete from then
// on 2026-10-14. Older tags predate the ledger's coverage, so sweeping them
// would recreate pages the classic Zap already made.
const TAGGED_SINCE_MS = 1787961600000;

// Leave a tag this fresh to the trigger Zap, so a sweep that lands seconds
// after a tag doesn't race the live run. The next day's sweep picks it up.
const GRACE_MS = 30 * 60 * 1000;

// The schedule tick's payload is ignored. A manual run can pass
// `{"dryRun":true}` to list and classify without writing anything.
const InputSchema = z
  .object({ dryRun: z.boolean().optional() })
  .passthrough()
  .nullish();

// --- Pure helpers ----------------------------------------------------------
function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline can deliver input double-encoded; run-durable does not.
  let v: unknown = rawInput;
  for (let i = 0; i < 4 && typeof v === "string"; i++) {
    const t = v.trim();
    if (t === "") return null;
    if (t[0] !== "{" && t[0] !== '"') break;
    try {
      v = JSON.parse(t);
    } catch {
      break;
    }
  }
  return typeof v === "string" ? null : v;
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

/** The epoch-ms time TRIGGER_TAG was applied, or null if the document doesn't
 *  carry it. Reader delivers `tags` keyed by slug (`{ slug: { name, type,
 *  created } }`); a plain array of `{ name, created }` is accepted too. */
export function tagAppliedAt(tags: unknown): number | null {
  const entries: Array<[string, unknown]> = Array.isArray(tags)
    ? tags.map((t) => [String((t as any)?.name ?? ""), t])
    : tags && typeof tags === "object"
      ? Object.entries(tags as Record<string, unknown>)
      : [];
  for (const [slug, val] of entries) {
    const name = firstString((val as any)?.name, slug);
    if (name?.toLowerCase() !== TRIGGER_TAG) continue;
    const created = Number((val as any)?.created);
    return Number.isFinite(created) && created > 0 ? created : null;
  }
  return null;
}

/** Drop an `access_token` query parameter. Paywalled sources (Stratechery)
 *  put a personal access token in the Reader `source_url`, and it must not be
 *  copied into Notion. Anything unparseable is returned unchanged. */
export function stripAccessToken(raw: string): string {
  try {
    const url = new URL(raw);
    if (!url.searchParams.has("access_token")) return raw;
    url.searchParams.delete("access_token");
    return url.toString();
  } catch {
    return raw;
  }
}

interface TaggedDoc {
  id: string;
  title: string;
  sourceUrl: string;
  taggedAtMs: number;
}

/** A listed document, or a thrown error. A row with no id, or listed under the
 *  tag but without that tag's timestamp, means Reader's response shape has
 *  changed. That must surface as a red run, never be skipped. */
function extractDoc(raw: unknown): TaggedDoc {
  const d = (raw ?? {}) as Record<string, any>;
  const id = firstString(d.id);
  if (!id) throw new Error("Unrecognized Reader document: no id");
  const taggedAtMs = tagAppliedAt(d.tags);
  if (taggedAtMs === null) {
    throw new Error(
      `Unrecognized Reader document ${id}: listed under '${TRIGGER_TAG}' but no tag timestamp`,
    );
  }
  const sourceUrl = stripAccessToken(firstString(d.source_url, d.url) ?? "");
  return {
    id,
    title: firstString(d.title) ?? (sourceUrl || id),
    sourceUrl,
    taggedAtMs,
  };
}

// --- Per-document work -----------------------------------------------------
type Outcome =
  | { status: "already-processed"; documentId: string; notionPageId: string }
  | { status: "would-create"; documentId: string; title: string }
  | { status: "created"; documentId: string; title: string; notionPageId: string };

/** Create one missing document's page and ledger row. Takes `ctx` as a
 *  parameter so the per-document step ids can carry the document id (the
 *  publish analyzer requires literal ids only in the workflow body). */
async function backfillDoc(
  ctx: DurableContext,
  doc: TaggedDoc,
  dryRun: boolean,
): Promise<Outcome> {
  const key = `doc-${doc.id}`;

  const existing = await ctx.step(`${key}-find-in-dedup-table`, async () =>
    sdk.listTableRecords({
      table: DEDUP_TABLE,
      keyMode: "names",
      filters: [{ fieldKey: "Document ID", operator: "exact", value: doc.id }],
      pageSize: 1,
    }),
  );
  const existingPageId = firstString(
    (existing as any)?.data?.[0]?.data?.["Notion Page ID"],
  );
  if (existingPageId) {
    return { status: "already-processed", documentId: doc.id, notionPageId: existingPageId };
  }
  if (dryRun) {
    return { status: "would-create", documentId: doc.id, title: doc.title };
  }

  // Same properties as save-tagged-docs-to-notion. `template_mode: "default"`
  // applies the data source's default template when there is one (repo rule
  // 5); the no-template error is caught inside the step and retried without.
  const inputs: Record<string, unknown> = {
    datasource: SOCIAL_CONTENT_DS,
    "properties|||Name|||title": `Article Share: ${doc.title}`,
    "properties|||Type|||select": "Article Share",
    "properties|||Status|||status": "Ideas 🧠",
    "properties|||Author|||people": [AUTHOR_PERSON_ID],
    "properties|||Channel|||multi_select": ["LI@dchiuten"],
    "properties|||sc_link_article|||url": doc.sourceUrl,
    "properties|||sc_title_article|||rich_text": doc.title,
    "properties|||sc_first_comment|||rich_text": `"${doc.title}": ${doc.sourceUrl}`,
    "properties|||Research note|||checkbox": true,
    use_zapier_datetime_fields: false,
  };
  const created = await ctx.step(`${key}-create-page`, async () => {
    try {
      return await sdk.runAction({
        appKey: NOTION_APP_KEY,
        actionType: "write",
        actionKey: "create_database_item",
        connection: NOTION_CONNECTION,
        inputs: { ...inputs, template_mode: "default" },
      });
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (!/no default template/i.test(msg)) throw err;
      return sdk.runAction({
        appKey: NOTION_APP_KEY,
        actionType: "write",
        actionKey: "create_database_item",
        connection: NOTION_CONNECTION,
        inputs,
      });
    }
  });
  const pageId = firstString(firstResult(created)?.id);
  if (!pageId) {
    throw new Error(`Social Content page creation for ${doc.id} returned no page id`);
  }

  // Unlike the trigger Zap, a failed ledger write is NOT swallowed here: a
  // page without a ledger row would be recreated by tomorrow's sweep, so it
  // has to surface as a red run.
  await ctx.step(`${key}-index-in-dedup-table`, async () =>
    sdk.createTableRecords({
      table: DEDUP_TABLE,
      keyMode: "names",
      records: [
        {
          data: {
            "Document ID": doc.id,
            "Date Added": new Date().toISOString(),
            "Notion Page ID": pageId,
          },
        },
      ],
    }),
  );

  return { status: "created", documentId: doc.id, title: doc.title, notionPageId: pageId };
}

// --- Workflow --------------------------------------------------------------
const workflow = defineDurable(
  "save-tagged-docs-sweep",
  async (ctx, rawInput: unknown) => {
    const input = InputSchema.parse(normalizeInput(rawInput)) ?? {};
    const dryRun = input.dryRun === true;

    // The run's clock, fixed for every retry (the determinism guard forbids a
    // clock read outside a step).
    const nowMs = await ctx.step("now", async () => Date.now());

    // One read task: the newest 100 documents tagged `sendtonotion`.
    const listed = await ctx.step("list-tagged-documents", async () =>
      sdk.runAction({
        appKey: READER_APP_KEY,
        actionType: "read",
        actionKey: "new_tagged_document",
        connection: READER_CONNECTION,
        inputs: { tag: TRIGGER_TAG },
      }),
    );
    const rows = (listed as { data?: unknown })?.data;
    if (!Array.isArray(rows)) {
      throw new Error("Unrecognized Reader response: no document list");
    }

    const seen = new Set<string>();
    const candidates: TaggedDoc[] = [];
    let tooOld = 0;
    let tooFresh = 0;
    for (const row of rows) {
      const doc = extractDoc(row);
      if (seen.has(doc.id)) continue;
      seen.add(doc.id);
      if (doc.taggedAtMs < TAGGED_SINCE_MS) {
        tooOld++;
      } else if (doc.taggedAtMs > nowMs - GRACE_MS) {
        tooFresh++;
      } else {
        candidates.push(doc);
      }
    }

    console.log(
      `Sweep: ${rows.length} tagged documents listed, ${candidates.length} in window ` +
        `(${tooOld} tagged before the floor, ${tooFresh} left to the trigger Zap)` +
        (dryRun ? " — dryRun, nothing will be written" : ""),
    );

    const results = await Promise.all(
      candidates.map((doc) => backfillDoc(ctx, doc, dryRun)),
    );
    const count = (s: Outcome["status"]) => results.filter((r) => r.status === s).length;

    return {
      dryRun,
      listed: rows.length,
      inWindow: candidates.length,
      createdCount: count("created"),
      alreadyProcessedCount: count("already-processed"),
      wouldCreateCount: count("would-create"),
      created: results.filter((r) => r.status !== "already-processed"),
    };
  },
);

export default workflow;
