// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/merge-duplicate-contacts
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
const NOTION_CONNECTION = "notion_wf";
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

const CONTACTS_DS = "21991b07-11ac-81a6-a894-000be4a09a67";

// --- Why this workflow exists ----------------------------------------------
//
// It replaces the "Contact Merger" Notion Custom Agent, which merged Contacts
// whenever `Duplicate of` was set. Three things about that agent were wrong in
// ways prose instructions could not fix:
//
//   1. It fired on ANY edit to `Duplicate of`, including writes from Zaps that
//      used the property as a review flag. On 2026-07-28 a one-address collision
//      between Sachin Kolekar (Knoxx Foods) and Lionel Sim (The AI Capitol) —
//      unrelated people — made it merge the two records.
//   2. Its `Secondary email` step SET the multi-select instead of appending, so
//      the target lost addresses it already had. Sachin lost his own.
//   3. It deleted the source without approval. Leo Selie and a duplicate Lionel
//      page went to the trash that way before anyone noticed.
//
// So: the copy semantics are code (a union cannot be "forgotten"), and nothing
// is ever deleted. `Duplicate of` is now set only by a person (no Zap writes it;
// they write `Possible duplicate of`), so it is taken as the decision: the one
// thing that still blocks a merge is evidence AGAINST it, two different
// LinkedIn profiles. Until 2026-10-21 a name mismatch also declined unless Jev
// corroborated the pair; that second-guessed a person's call and declined Anna
// Gibaeva's duplicate on an evidence score of 1.99 against a 2.0 bar. After a merge the source is moved to Notion's trash (the
// API's "archive"; restorable for 30 days) — never permanently deleted, and
// never when `archiveBlocker` says a person should decide. Since 2026-10-21; it
// was left in place with a comment before.
//
// Relations this workflow must NEVER copy. `Duplicate of` and `Duplicated by`
// are what trigger it, so copying them is a self-trigger by construction. The
// `Possible duplicate` pair is a review queue: propagating one contact's
// unresolved questions onto another manufactures the next false positive.
const NEVER_COPY = new Set([
  "Duplicate of",
  "Duplicated by",
  "Possible duplicate of",
  "Possible duplicates",
]);

// Notion computes these; a PATCH containing them is rejected.
const READ_ONLY_TYPES = new Set([
  "formula",
  "rollup",
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
  "unique_id",
  "button",
  "verification",
]);

// Marker that makes this workflow's comments idempotent. A Zap can re-write
// `Duplicate of` many times in a few minutes, and each write re-triggers us.
//
// The marker carries the OUTCOME, not just the pair. A per-pair marker looked
// right and was wrong: a "declined" comment then suppressed the later "merged"
// comment for the same pair, so a merge that happened after someone fixed the
// names left no record of what was copied and no ready-to-archive signal.
// Caught by the 2026-07-28 pre-publish test.
const COMMENT_MARKER = "[merge-duplicate-contacts";
type CommentKind = "declined" | "mutual" | "merged";
function commentTag(kind: CommentKind): string {
  return `${COMMENT_MARKER}:${kind}]`;
}

const InputSchema = z.unknown();

// --- Pure helpers ----------------------------------------------------------

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) if (typeof v === "string" && v.trim() !== "") return v;
  return null;
}

/** Notion page ids reach us in both hyphenated and bare spellings. */
function sameId(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.replace(/-/g, "").toLowerCase() === b.replace(/-/g, "").toLowerCase();
}

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

/** Tokens lowercased, punctuation stripped, SORTED — so "Sim Lionel" and
 *  "Lionel Sim" compare equal. "" for anything under two tokens, which is too
 *  weak to merge two records on. Mirrors the helper in the Luma workflows. */
function normalizeNameKey(name: string): string {
  const tokens = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .sort();
  return tokens.length >= 2 ? tokens.join(" ") : "";
}

/** A LinkedIn profile slug, so `linkedin.com/in/foo/` and
 *  `http://www.linkedin.com/in/foo` compare equal. "" when not a profile URL. */
function linkedinSlug(url: string | null): string {
  const m = (url ?? "").toLowerCase().match(/linkedin\.com\/in\/([^/?#]+)/);
  return m?.[1] ?? "";
}

function plainTitle(prop: any): string {
  return (prop?.title ?? [])
    .map((t: any) => firstString(t?.plain_text))
    .filter(Boolean)
    .join(" ");
}

/** Is a property value empty, i.e. safe to fill from the source? */
/**
 * The target's Secondary Email options with the source's Primary Email
 * appended, or null when nothing needs to change: no source address, the
 * target's Primary is empty (the fill rule copies it there instead), or the
 * target already carries it as Primary or Secondary. Case-insensitive, and
 * never drops an existing option.
 */
function secondaryWithSourcePrimary(
  sourcePrimary: string | null,
  targetPrimary: string | null,
  targetSecondaries: Array<{ name?: string }> | null,
): Array<{ name: string }> | null {
  if (!sourcePrimary || !targetPrimary) return null;
  const key = sourcePrimary.trim().toLowerCase();
  if (targetPrimary.trim().toLowerCase() === key) return null;
  const current = (targetSecondaries ?? [])
    .map((o) => firstString(o?.name))
    .filter((n): n is string => n !== null);
  if (current.some((n) => n.trim().toLowerCase() === key)) return null;
  return [...current, sourcePrimary.trim()].map((name) => ({ name }));
}

function isEmptyValue(prop: any): boolean {
  if (!prop) return true;
  switch (prop.type) {
    case "title":
      return plainTitle(prop).trim() === "";
    case "rich_text":
      return (prop.rich_text ?? []).length === 0;
    case "number":
      return prop.number === null || prop.number === undefined;
    case "select":
      return !prop.select;
    case "status":
      return !prop.status;
    case "date":
      return !prop.date;
    case "checkbox":
      return prop.checkbox !== true;
    case "url":
      return !firstString(prop.url);
    case "email":
      return !firstString(prop.email);
    case "phone_number":
      return !firstString(prop.phone_number);
    case "multi_select":
      return (prop.multi_select ?? []).length === 0;
    case "people":
      return (prop.people ?? []).length === 0;
    case "relation":
      return (prop.relation ?? []).length === 0;
    case "files":
      return (prop.files ?? []).length === 0;
    default:
      return true;
  }
}

// --- Notion reads ----------------------------------------------------------

interface PageState {
  id: string;
  gone: boolean;
  properties: Record<string, any>;
  createdTime: string | null;
}

/**
 * Read a page. Throws on 429/5xx so the enclosing `ctx.step` retries — a
 * transient blip must never be mistaken for "this property is empty", because
 * that is what turns a union into a replacement.
 */
async function readPage(pageId: string): Promise<PageState | null> {
  const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
    connection: NOTION_CONNECTION,
    headers: { "Notion-Version": NOTION_VERSION },
  });
  if (res.status === 429 || res.status >= 500) {
    throw new Error(`Notion ${res.status} reading page ${pageId} — retrying`);
  }
  if (res.status === 404) {
    return { id: pageId, gone: true, properties: {}, createdTime: null };
  }
  if (!res.ok) return null;
  const body: any = await res.json();
  if (body?.object !== "page") return null;
  return {
    id: firstString(body?.id) ?? pageId,
    gone:
      body?.in_trash === true ||
      body?.archived === true ||
      body?.is_archived === true,
    properties: body?.properties ?? {},
    createdTime: firstString(body?.created_time),
  };
}

/**
 * A relation property in a page read is capped at 25 entries and flagged
 * `has_more`. Paging it is not optional: a union computed from a truncated list
 * would DROP the entries beyond the cap on write — the exact class of bug this
 * workflow exists to prevent. Returns null if the full list can't be read, and
 * callers then skip the property rather than write a partial union.
 */
async function readFullRelation(
  pageId: string,
  propertyId: string,
): Promise<string[] | null> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 40; guard++) {
    const url =
      `${NOTION_API}/pages/${pageId}/properties/${propertyId}?page_size=100` +
      (cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : "");
    const res = await sdk.fetch(url, {
      connection: NOTION_CONNECTION,
      headers: { "Notion-Version": NOTION_VERSION },
    });
    if (res.status === 429 || res.status >= 500) {
      throw new Error(`Notion ${res.status} paging relation ${propertyId} — retrying`);
    }
    if (!res.ok) return null;
    const body: any = await res.json();
    for (const item of body?.results ?? []) {
      const id = firstString(item?.relation?.id);
      if (id && !ids.some((x) => sameId(x, id))) ids.push(id);
    }
    if (body?.has_more !== true) return ids;
    cursor = firstString(body?.next_cursor);
    if (!cursor) return ids;
  }
  return ids;
}

/** Relation ids for a property, paging when the page read was truncated. */
async function relationIds(
  page: PageState,
  name: string,
): Promise<string[] | null> {
  const prop = page.properties[name];
  if (!prop || prop.type !== "relation") return [];
  if (prop.has_more === true) {
    const propertyId = firstString(prop.id);
    if (!propertyId) return null;
    return await readFullRelation(page.id, propertyId);
  }
  const ids: string[] = [];
  for (const rel of prop.relation ?? []) {
    const id = firstString(rel?.id);
    if (id && !ids.some((x) => sameId(x, id))) ids.push(id);
  }
  return ids;
}

// --- Notion writes ---------------------------------------------------------

/** Raw PATCH. Used instead of Zapier's `update_database_item` because this
 *  workflow touches arbitrary properties, and that action's cached schema omits
 *  recently-added ones — a `properties|||New Prop|||relation` key that does not
 *  exist yet fails at run time. */
async function patchPage(
  pageId: string,
  properties: Record<string, unknown>,
): Promise<void> {
  const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
    method: "PATCH",
    connection: NOTION_CONNECTION,
    headers: {
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion ${res.status} patching ${pageId}: ${text.slice(0, 400)}`);
  }
}

/**
 * Notion's answer to trashing a page that is already in the trash: a 400
 * "Can't edit block that is archived". The end state is the one we asked for,
 * so it reads as success — a retried archive step must not fail the run after
 * the trash already landed. Narrow on purpose: status AND message.
 */
function isAlreadyTrashed(status: number, body: string): boolean {
  return status === 400 && /archived/i.test(body);
}

/**
 * Why the merged source must NOT be trashed automatically, or null when it can
 * be. Each case is one a person should look at first:
 *   - unknown/has body content: page content is not merged (properties only),
 *     and the trash empties itself after 30 days;
 *   - source older than target: `Duplicate of` may point the wrong way round,
 *     so the record being thrown away could be the one to keep.
 */
function archiveBlocker(opts: { hasContent: boolean | null; sourceOlder: boolean }): string | null {
  if (opts.hasContent === null) return "could not check whether it has page content";
  if (opts.hasContent) return "it has page content, which the merge does not copy";
  if (opts.sourceOlder) return "it is OLDER than the record it was merged into, so check the survivor is the one you want";
  return null;
}

/** Does the page have any body blocks? Null when the read fails for a
 *  non-transient reason; 429/5xx throw so the enclosing step retries. */
async function hasPageContent(pageId: string): Promise<boolean | null> {
  const res = await sdk.fetch(`${NOTION_API}/blocks/${pageId}/children?page_size=1`, {
    connection: NOTION_CONNECTION,
    headers: { "Notion-Version": NOTION_VERSION },
  });
  if (res.status === 429 || res.status >= 500) {
    throw new Error(`Notion ${res.status} reading content of ${pageId} — retrying`);
  }
  if (!res.ok) return null;
  const body: any = await res.json();
  return (body?.results ?? []).length > 0;
}

/** Move a page to the trash. Returns the response for the caller to judge;
 *  only 429/5xx throw, so a real rejection reaches the run error intact
 *  instead of becoming "exhausted all retry attempts". */
async function trashPage(pageId: string): Promise<{ status: number; body: string }> {
  const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
    method: "PATCH",
    connection: NOTION_CONNECTION,
    headers: {
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ in_trash: true }),
  });
  const body = res.ok ? "" : await res.text();
  if (res.status === 429 || res.status >= 500) {
    throw new Error(`Notion ${res.status} trashing ${pageId}: ${body.slice(0, 300)} — retrying`);
  }
  return { status: res.status, body };
}

/** Has this workflow already posted this OUTCOME about this pair? */
async function hasPriorComment(
  pageId: string,
  targetId: string,
  kind: CommentKind,
): Promise<boolean> {
  const res = await sdk.fetch(
    `${NOTION_API}/comments?block_id=${pageId}&page_size=100`,
    {
      connection: NOTION_CONNECTION,
      headers: { "Notion-Version": NOTION_VERSION },
    },
  );
  if (!res.ok) return false;
  const body: any = await res.json();
  const bare = targetId.replace(/-/g, "");
  const tag = commentTag(kind);
  for (const c of body?.results ?? []) {
    const text = (c?.rich_text ?? [])
      .map((t: any) => t?.plain_text ?? "")
      .join("");
    if (text.includes(tag) && text.replace(/-/g, "").includes(bare)) return true;
  }
  return false;
}

/** Comment once per (source, target, outcome). */
async function commentOnce(
  pageId: string,
  targetId: string,
  kind: CommentKind,
  message: string,
): Promise<boolean> {
  if (await hasPriorComment(pageId, targetId, kind)) return false;
  const res = await sdk.fetch(`${NOTION_API}/comments`, {
    method: "POST",
    connection: NOTION_CONNECTION,
    headers: {
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { page_id: pageId },
      rich_text: [{ text: { content: `${commentTag(kind)} ${message}` } }],
    }),
  });
  return res.ok;
}

// --- The merge -------------------------------------------------------------

interface MergePlan {
  /** Notion `properties` patch for the target. */
  patch: Record<string, unknown>;
  /** Property names copied, with how. */
  copied: Array<{ property: string; how: string }>;
  /** Properties deliberately not copied, with why. */
  skipped: Array<{ property: string; why: string }>;
}

/**
 * Build the target's patch from the source.
 *
 * Two rules, both learned the hard way:
 *   - text-like values FILL an empty target field and never overwrite one
 *   - every multi-value field is a UNION of the target's current value and the
 *     source's; a write that removes an existing entry is always a bug
 */
async function planMerge(
  source: PageState,
  target: PageState,
): Promise<MergePlan> {
  const patch: Record<string, unknown> = {};
  const copied: Array<{ property: string; how: string }> = [];
  const skipped: Array<{ property: string; why: string }> = [];

  for (const [name, sProp] of Object.entries(source.properties)) {
    const type = (sProp as any)?.type;
    if (NEVER_COPY.has(name)) {
      skipped.push({ property: name, why: "never copied (trigger / review queue)" });
      continue;
    }
    if (READ_ONLY_TYPES.has(type)) continue;
    if (isEmptyValue(sProp)) continue;

    const tProp = target.properties[name];
    // A property the target's schema doesn't have at all — same data source, so
    // this should not happen; skip rather than invent it.
    if (tProp === undefined) {
      skipped.push({ property: name, why: "absent on target" });
      continue;
    }

    switch (type) {
      case "title":
      case "rich_text":
      case "number":
      case "select":
      case "status":
      case "date":
      case "url":
      case "email":
      case "phone_number":
      case "files": {
        if (!isEmptyValue(tProp)) {
          skipped.push({ property: name, why: "target already set" });
          continue;
        }
        patch[name] = { [type]: (sProp as any)[type] };
        copied.push({ property: name, how: "filled empty target field" });
        break;
      }

      case "checkbox": {
        if (tProp.checkbox === true) continue;
        patch[name] = { checkbox: true };
        copied.push({ property: name, how: "OR'd to true" });
        break;
      }

      case "multi_select": {
        const existing: any[] = tProp.multi_select ?? [];
        const names = new Set(existing.map((o: any) => o?.name));
        const additions = (sProp as any).multi_select.filter(
          (o: any) => o?.name && !names.has(o.name),
        );
        if (additions.length === 0) continue;
        patch[name] = {
          multi_select: [...existing, ...additions].map((o: any) => ({
            name: o.name,
          })),
        };
        copied.push({
          property: name,
          how: `union, +${additions.length} value(s)`,
        });
        break;
      }

      case "people": {
        const existing: any[] = tProp.people ?? [];
        const ids = new Set(existing.map((p: any) => p?.id));
        const additions = (sProp as any).people.filter(
          (p: any) => p?.id && !ids.has(p.id),
        );
        if (additions.length === 0) continue;
        patch[name] = {
          people: [...existing, ...additions].map((p: any) => ({ id: p.id })),
        };
        copied.push({ property: name, how: `union, +${additions.length} person` });
        break;
      }

      case "relation": {
        // Both sides must be read in FULL — a truncated target list would be
        // silently pruned by the write.
        const tIds = await relationIds(target, name);
        const sIds = await relationIds(source, name);
        if (tIds === null || sIds === null) {
          skipped.push({
            property: name,
            why: "relation truncated and could not be paged — refusing a partial union",
          });
          continue;
        }
        const union = [...tIds];
        for (const id of sIds) {
          if (!union.some((x) => sameId(x, id)) && !sameId(id, target.id)) {
            union.push(id);
          }
        }
        if (union.length === tIds.length) continue;
        patch[name] = { relation: union.map((id) => ({ id })) };
        copied.push({
          property: name,
          how: `union, +${union.length - tIds.length} link(s)`,
        });
        break;
      }

      default:
        skipped.push({ property: name, why: `unhandled type "${type}"` });
    }
  }

  // The source's Primary Email is a scalar the target already has a value for,
  // so the fill rule above skips it — and the address would vanish with the
  // trashed source. Carry it over as a Secondary instead. Found 2026-10-21:
  // Anna Gibaeva's merge dropped annagibaeva05@gmail.com.
  const secondaries = secondaryWithSourcePrimary(
    firstString(source.properties["Primary Email"]?.email),
    firstString(target.properties["Primary Email"]?.email),
    (patch["Secondary Email"] as any)?.multi_select ?? target.properties["Secondary Email"]?.multi_select ?? null,
  );
  if (secondaries) {
    patch["Secondary Email"] = { multi_select: secondaries };
    copied.push({ property: "Primary Email", how: "added to Secondary Email" });
  }

  return { patch, copied, skipped };
}

// --- Identity corroboration -------------------------------------------------

interface Verdict {
  merge: boolean;
  reason: string;
}

/**
 * Should this person-set `Duplicate of` be carried out?
 *
 * Yes, unless the records contradict it: two different LinkedIn profiles mean
 * two real people, which is what a mis-click between same-name contacts looks
 * like. Everything else merges, and the reason records what agreed.
 */
function corroborate(source: PageState, target: PageState): Verdict {
  const sName = normalizeNameKey(plainTitle(source.properties["Name"]));
  const tName = normalizeNameKey(plainTitle(target.properties["Name"]));
  const sLi = linkedinSlug(firstString(source.properties["Linkedin"]?.url));
  const tLi = linkedinSlug(firstString(target.properties["Linkedin"]?.url));

  if (sLi && tLi && sLi !== tLi) {
    return {
      merge: false,
      reason: `different LinkedIn profiles (${sLi} vs ${tLi}) — these are two different people`,
    };
  }
  if (sLi && tLi && sLi === tLi) {
    return { merge: true, reason: `same LinkedIn profile (${sLi})` };
  }
  if (sName && tName && sName === tName) {
    return { merge: true, reason: `equivalent names ("${sName}")` };
  }
  return {
    merge: true,
    reason: `set by a person; names differ ("${sName || "?"}" vs "${tName || "?"}") and no LinkedIn conflict`,
  };
}

// --- Workflow --------------------------------------------------------------
// Trigger: Notion DB automation on Contacts, "Duplicate of edited" -> catch
// hook. Replaces the "Contact Merger" Custom Agent.
// `rawInput` is typed `unknown` on purpose: the trigger pipeline can deliver
// the payload as a (sometimes double-encoded) JSON string, so `normalizeInput`
// does the parsing. `defineDurable`'s input generic is left to its default —
// the runtime constrains it to a plain object, which the plausible
// `defineDurable<unknown, unknown>` form violates and fails to type-check.
const workflow = defineDurable(
  "merge-duplicate-contacts",
  async (ctx, rawInput: unknown) => {
    const parsed: any = InputSchema.parse(normalizeInput(rawInput));
    const data = parsed?.data ?? parsed;
    const sourceId = firstString(data?.id, data?.page_id, data?.pageId);
    if (!sourceId) {
      console.log("skipping: no page id in payload (empty/test delivery)");
      return { skipped: true, reason: "no page id in payload" };
    }

    const source = await ctx.step("read-source", async () => readPage(sourceId));
    if (!source) {
      throw new Error(`could not read source page ${sourceId} — retrying`);
    }
    if (source.gone) {
      return { sourceId, skipped: true, reason: "source is in the trash" };
    }

    const dupLinks = await ctx.step("read-duplicate-of", async () => {
      const ids = await relationIds(source, "Duplicate of");
      if (ids === null) throw new Error("could not read Duplicate of — retrying");
      return ids;
    });

    // Structural non-starters. Silent by design: these are noise, not decisions
    // a person needs to see.
    if (dupLinks.length === 0) {
      return { sourceId, skipped: true, reason: "Duplicate of is empty" };
    }
    if (dupLinks.length > 1) {
      return {
        sourceId,
        skipped: true,
        reason: `Duplicate of has ${dupLinks.length} targets; expected one`,
      };
    }
    const targetId = dupLinks[0];
    if (sameId(targetId, sourceId)) {
      return { sourceId, skipped: true, reason: "Duplicate of points at itself" };
    }

    const target = await ctx.step("read-target", async () => readPage(targetId));
    if (!target) {
      throw new Error(`could not read target page ${targetId} — retrying`);
    }
    if (target.gone) {
      return { sourceId, targetId, skipped: true, reason: "target is in the trash" };
    }

    // A mutual marking is machine-made and has no survivor. Comment, because a
    // genuine pair stuck this way would otherwise rot invisibly.
    const targetDupLinks = await ctx.step("read-target-duplicate-of", async () => {
      const ids = await relationIds(target, "Duplicate of");
      if (ids === null) throw new Error("could not read target Duplicate of — retrying");
      return ids;
    });
    if (targetDupLinks.some((id) => sameId(id, sourceId))) {
      const commented = await ctx.step("comment-mutual", async () =>
        commentOnce(
          sourceId,
          targetId,
          "mutual",
          `Not merged: this record and ${targetId} each have "Duplicate of" pointing at ` +
            `the other, which is machine-made and has no survivor. Clear one side to ` +
            `choose which record should be kept.`,
        ),
      );
      return {
        sourceId,
        targetId,
        skipped: true,
        reason: "mutual Duplicate of",
        commented,
      };
    }

    const verdict = corroborate(source, target);
    if (!verdict.merge) {
      const commented = await ctx.step("comment-declined", async () =>
        commentOnce(
          sourceId,
          targetId,
          "declined",
          `Not merged into ${targetId}: ${verdict.reason}. If these really are the same ` +
            `person, merge them by hand; if not, clear "Duplicate of".`,
        ),
      );
      return {
        sourceId,
        targetId,
        merged: false,
        reason: verdict.reason,
        commented,
      };
    }

    // The read and the write live in ONE step so a retry re-reads both pages
    // rather than patching from state that has since moved.
    const result = await ctx.step("merge-into-target", async () => {
      const freshSource = await readPage(sourceId);
      const freshTarget = await readPage(targetId);
      if (!freshSource || !freshTarget) {
        throw new Error("could not re-read both pages before patching — retrying");
      }
      if (freshSource.gone || freshTarget.gone) {
        return { patched: false, copied: [], skipped: [], reason: "a page went to the trash" };
      }
      const plan = await planMerge(freshSource, freshTarget);
      if (Object.keys(plan.patch).length === 0) {
        return { patched: false, copied: plan.copied, skipped: plan.skipped, reason: "nothing to copy" };
      }
      await patchPage(targetId, plan.patch);
      return { patched: true, copied: plan.copied, skipped: plan.skipped, reason: null };
    });

    // Never delete. The source is moved to the trash (restorable for 30 days)
    // unless archiveBlocker says a person should look first, in which case it
    // stays put. Either way the comment says what moved. Trashing also hands the
    // source's email Table rows to the survivor: contact-emails-to-zapier-table
    // reads `Duplicate of` off the trashed page.
    const sourceOlder =
      source.createdTime !== null &&
      target.createdTime !== null &&
      source.createdTime < target.createdTime;
    const sourceGone = result.reason === "a page went to the trash";
    const hasContent = sourceGone
      ? null
      : await ctx.step("check-source-content", async () => hasPageContent(sourceId));
    const blocker = sourceGone ? "a page went to the trash during the merge" : archiveBlocker({ hasContent, sourceOlder });
    const commented = await ctx.step("comment-merged", async () =>
      commentOnce(
        sourceId,
        targetId,
        "merged",
        (result.copied.length > 0
          ? `Merged into ${targetId} (${verdict.reason}). Copied: ` +
            `${result.copied.map((c) => `${c.property} (${c.how})`).join(", ")}. `
          : `Already merged into ${targetId} (${verdict.reason}) — the target had ` +
            `nothing left to take from this record. `) +
          (blocker
            ? `Left in place: ${blocker}. Archive this record by hand when you are happy with the result.`
            : `Moved this record to the trash; restore it from there within 30 days if the merge was wrong.`),
      ),
    );

    let archived = false;
    if (!blocker) {
      const trash = await ctx.step("archive-source", async () => trashPage(sourceId));
      if (trash.status >= 300 && !isAlreadyTrashed(trash.status, trash.body)) {
        throw new Error(
          `Merged into ${targetId}, but trashing source ${sourceId} failed (${trash.status}): ${trash.body.slice(0, 300)}`,
        );
      }
      archived = true;
    }

    return {
      sourceId,
      targetId,
      merged: result.patched,
      reason: verdict.reason,
      copied: result.copied,
      skippedProperties: result.skipped,
      sourceOlderThanTarget: sourceOlder,
      archived,
      archiveBlockedBy: blocker,
      commented,
      contactsDataSource: CONTACTS_DS,
    };
  },
);

export default workflow;
