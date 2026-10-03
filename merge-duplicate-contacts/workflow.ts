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

// Jev (TypeSafe's typed-judgement model), called through Zapier's authenticated
// fetch: the API key lives in an "API by Zapier" connection (Bearer auth), so it
// never appears in source. Consulted ONLY when the deterministic rules decline
// because the names don't match — see `jevVerdict`. Each call is a Zapier task,
// plus a fraction of a cent of TypeSafe usage.
const JEV_CONNECTION = "typesafe";
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
// `jev-latest` moves when TypeSafe ships a release. The thresholds below were
// checked against jev-1.13.0; the answering model is logged on every call.
const JEV_MODEL = "jev-latest";

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
// So: the copy semantics are code (a union cannot be "forgotten"), the merge is
// gated on corroborated identity rather than on the relation alone, and nothing
// is ever deleted — the source is left in place with a comment.
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

  return { patch, copied, skipped };
}

// --- Identity corroboration -------------------------------------------------

interface Verdict {
  merge: boolean;
  reason: string;
  /** True only for the "names don't match, no LinkedIn either way" decline —
   *  the one case Jev may overturn. A LinkedIn conflict is never eligible. */
  jevEligible?: boolean;
}

/**
 * Is this pair really one person?
 *
 * A set `Duplicate of` relation is NOT evidence on its own — it is what a Zap
 * or a mis-click writes. Positive signals are a name match or a shared LinkedIn
 * profile. Two different LinkedIn profiles is a hard disqualifier and beats a
 * name match, because that is the case a shared name produces: two real people.
 *
 * A shared email DOMAIN is deliberately not a signal. Colleagues share a work
 * domain (Sachin and Minnie Dua are both @knoxxfoods.com) and strangers share
 * consumer ones.
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
    merge: false,
    reason:
      `names are not equivalent ("${sName || "?"}" vs "${tName || "?"}") and no shared ` +
      `LinkedIn profile — a shared email address alone is not evidence of one person`,
    jevEligible: true,
  };
}

// --- Second opinion from Jev ---------------------------------------------------
//
// The name rule declines real duplicates whose names differ in ways token
// sorting can't see. Both such declines in the first two months were the same
// person: "Ustaz Syakir" vs "Syakir Samsaimon" (Ustaz is a Malay honorific, and
// each page's Note named the other), and "New Contact" vs "Alasdair Bell" (a
// placeholder name on a record with the identical personal-domain address).
// A person had already set `Duplicate of` both times.
//
// So when — and only when — the rules decline on names, Jev is asked whether
// the two records are one person and how strong the linking evidence is. Both
// must clear their bar to merge. Everything else stands as it was: a LinkedIn
// conflict is still a hard decline that Jev never sees, and a Jev failure falls
// back to the rules' decline.

/** Contact properties shown to Jev, by name. Only identity-bearing fields. */
const SUMMARY_FIELDS = [
  "Name",
  "First Name",
  "Last Name",
  "Primary Email",
  "Secondary Email",
  "Linkedin",
  "Job Title",
  "Company",
  "City",
  "Country",
  "Note",
  "Bio",
];
const SUMMARY_TEXT_CAP = 600;

/** Plain text of one Notion property value, for the types a Contact uses. */
function plainValue(prop: any): string | string[] | null {
  if (!prop) return null;
  const text = (rich: any[]) =>
    (rich ?? []).map((t: any) => firstString(t?.plain_text) ?? "").join("").trim();
  switch (prop.type) {
    case "title":
      return plainTitle(prop).trim() || null;
    case "rich_text":
      return text(prop.rich_text).slice(0, SUMMARY_TEXT_CAP) || null;
    case "email":
      return firstString(prop.email);
    case "url":
      return firstString(prop.url);
    case "phone_number":
      return firstString(prop.phone_number);
    case "select":
      return firstString(prop.select?.name);
    case "multi_select": {
      const names = (prop.multi_select ?? []).map((o: any) => firstString(o?.name)).filter(Boolean);
      return names.length ? (names as string[]) : null;
    }
    case "rollup": {
      const items = (prop.rollup?.array ?? [])
        .map((v: any) => {
          const inner = plainValue(v);
          return Array.isArray(inner) ? inner.join(", ") : inner;
        })
        .filter(Boolean);
      return items.length ? (items as string[]) : null;
    }
    default:
      return null;
  }
}

/** The identity-bearing fields of a Contact, empty ones left out. */
function contactSummary(page: PageState): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const field of SUMMARY_FIELDS) {
    const value = plainValue(page.properties[field]);
    if (value !== null && value !== "") out[field] = value;
  }
  return out;
}

const JEV_QUESTIONS = {
  same_person: {
    type: "noul",
    instructions: "Do `record_a` and `record_b` describe the same real person?",
    criteria: {
      true: "The evidence ties both records to one individual: compatible names allowing for honorifics, nicknames, word order or a placeholder name, plus a strong shared identifier such as the same personal email address or a note linking them.",
      false:
        "They are different people, or nothing beyond a shared company, a shared common name, or a shared generic/role address connects them.",
    },
  },
  evidence: {
    type: "score",
    instructions: "How strong is the identifying evidence that links `record_a` and `record_b` to one person?",
    criteria: [
      "Nothing links them beyond coincidence",
      "Only weak signals such as a common name or the same employer",
      "One strong identifier, such as an identical personal email address or an explicit note",
      "Several independent strong identifiers agree",
    ],
  },
};

/** Both bars must clear. Checked against jev-1.13.0: the two real declines
 *  scored 0.96 / 2.4 and 0.88 / 2.0; a one-shared-address pair, two colleagues
 *  and two different Grace Tangs scored at most 0.35 / 1.0. */
const JEV_SAME_PERSON_MIN = 0.85;
const JEV_EVIDENCE_MIN = 2.0;

/** The merge decision from a Jev response body; a malformed one declines. */
function jevVerdict(body: any): Verdict {
  const p = body?.answers?.same_person?.noul;
  const e = body?.answers?.evidence?.score;
  if (typeof p !== "number" || typeof e !== "number") {
    return { merge: false, reason: "Jev returned no usable answer" };
  }
  const scores = `Jev ${body?.model ?? "?"}: same person ${p.toFixed(2)}, evidence ${e.toFixed(1)}/3`;
  if (p >= JEV_SAME_PERSON_MIN && e >= JEV_EVIDENCE_MIN) {
    return { merge: true, reason: `names differ, but the records are corroborated as one person (${scores})` };
  }
  return { merge: false, reason: `names differ and Jev did not corroborate one person (${scores})` };
}

/** Jev statuses worth a step retry: rate limits and server-side failures. */
function isRetryableJevStatus(status: number): boolean {
  return status === 429 || status >= 500;
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

    let verdict = corroborate(source, target);
    if (!verdict.merge && verdict.jevEligible) {
      const rulesReason = verdict.reason;
      const jev = await ctx.step("jev-same-person", async () => {
        const res = await sdk.fetch(JEV_URL, {
          connection: JEV_CONNECTION,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: JEV_MODEL,
            state: { record_a: contactSummary(source), record_b: contactSummary(target) },
            questions: JEV_QUESTIONS,
          }),
        });
        const body = await res.text();
        // Throw only where a retry can help; any other failure is returned and
        // falls back to the rules' decline below.
        if (isRetryableJevStatus(res.status)) {
          throw new Error(`Jev ${res.status}: ${body.slice(0, 500)}`);
        }
        return { status: res.status, body };
      });
      if (jev.status === 200) {
        const second = jevVerdict(JSON.parse(jev.body));
        console.log(second.reason);
        verdict = second.merge
          ? second
          : { merge: false, reason: `${rulesReason}; ${second.reason}` };
      } else {
        console.log(`Jev rejected the request (${jev.status}): ${jev.body.slice(0, 300)}`);
        verdict = { merge: false, reason: `${rulesReason} (Jev unavailable: ${jev.status})` };
      }
    }
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

    // Never delete. The source stays put with a comment saying what moved, so a
    // person archives it deliberately.
    const sourceOlder =
      source.createdTime !== null &&
      target.createdTime !== null &&
      source.createdTime < target.createdTime;
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
          (sourceOlder
            ? `NOTE: this record is OLDER than the one it was merged into — check the ` +
              `survivor is the one you want before archiving. `
            : "") +
          `Nothing was deleted; archive this record when you are happy with the result.`,
      ),
    );

    return {
      sourceId,
      targetId,
      merged: result.patched,
      reason: verdict.reason,
      copied: result.copied,
      skippedProperties: result.skipped,
      sourceOlderThanTarget: sourceOlder,
      commented,
      contactsDataSource: CONTACTS_DS,
    };
  },
);

export default workflow;
