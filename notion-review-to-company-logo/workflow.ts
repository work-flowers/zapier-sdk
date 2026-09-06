// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/notion-review-to-company-logo
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
const NOTION_CONNECTION = "notion_wf"; // work.flowers workspace connection
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

// --- Notion data sources ------------------------------------------------------
const REVIEWS_DS = "ff49c51a-79b1-4254-872a-d1934b8696f6";
const COMPANIES_DS = "21991b07-11ac-80b0-b787-000b3d3995f6";
const CONTACTS_DS = "21991b07-11ac-81a6-a894-000be4a09a67";

// --- Notion property names ----------------------------------------------------
const REVIEW_TITLE_PROP = "Headline";
const REVIEW_CONTACT_PROP = "Contact";
/** Rollup: Contact -> Related Company. Carries the company page id directly,
 *  which saves reading the contact page on the common path. */
const REVIEW_COMPANY_ROLLUP_PROP = "Company";
const CONTACT_COMPANY_PROP = "Related Company";
const COMPANY_TITLE_PROP = "Company Name";
const COMPANY_WEBSITE_PROP = "Website";

// --- logo.dev -----------------------------------------------------------------
/** Publishable key (`pk_`), carried over from the classic Zap. It is designed
 *  to sit in a client-side image URL and is already public: it is embedded in
 *  every review page icon this Zap has ever set. Not a secret. */
const LOGO_DEV_TOKEN = "pk_MgvuyiQuRe6IT_XWNAUgrA";

function logoUrl(domain: string): string {
  return `https://img.logo.dev/${domain}?token=${LOGO_DEV_TOKEN}`;
}

const InputSchema = z.unknown();

/** `defineDurable`'s input generic is constrained to an object type, so the
 *  loose runtime shapes (a bare page-id string, a double-encoded body) are
 *  handled by `normalizeInput` / `extractPageId` rather than by the type. */
type Input = Record<string, unknown>;

type Outcome = Record<string, unknown>;

// --- Helpers ------------------------------------------------------------------

function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline may deliver the body double-encoded; run-durable
  // delivers it single. Unwrap up to four times, and only when the string
  // actually looks like JSON.
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

function firstString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Notion page ids reach us in dashed and undashed spellings depending on the
 *  source (webhook payload vs REST response). Compare and store dashed. */
function dashUuid(id: string): string {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (hex.length !== 32) return id.trim();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function plainText(rich: unknown): string {
  if (!Array.isArray(rich)) return "";
  return rich
    .map((r: any) => firstString(r?.plain_text) || firstString(r?.text?.content))
    .join("")
    .trim();
}

function relationIds(prop: unknown): string[] {
  const rel = (prop as any)?.relation;
  if (!Array.isArray(rel)) return [];
  return rel
    .map((r: any) => firstString(r?.id))
    .filter((id) => id.length > 0)
    .map(dashUuid);
}

/**
 * Page ids out of a rollup of a RELATION property.
 *
 * `{ rollup: { type: "array", array: [{ type: "relation", relation: [{id}] }] } }`
 * — one array entry per related contact, each carrying that contact's own
 * relation values. Flattened in order, so entry 0 is the trigger's first
 * contact.
 */
function rollupRelationIds(prop: unknown): string[] {
  const arr = (prop as any)?.rollup?.array;
  if (!Array.isArray(arr)) return [];
  return arr.flatMap((entry: unknown) => relationIds(entry));
}

/**
 * Pull the Notion page id out of whatever the trigger delivered.
 *
 * Notion database automations post `{ data: { id, properties, ... } }`.
 * `run-durable` / `trigger-workflow` take a bare id or `{ pageId }` so a run
 * can be replayed by hand.
 */
function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
}

function extractPageId(raw: unknown): string {
  if (!raw) throw new Error("No input provided to workflow.");
  if (typeof raw === "string") return requireUuid(dashUuid(raw.trim()), raw);
  const o = raw as Record<string, any>;
  const candidate =
    o.pageId ||
    o.page_id ||
    (o.data && (o.data.id || o.data.page_id)) ||
    o.id ||
    (o.page && o.page.id) ||
    o["data.id"];
  const id = firstString(candidate).trim();
  if (!id) {
    throw new Error(`Could not find a Notion page id in the payload: ${JSON.stringify(raw).slice(0, 400)}`);
  }
  return requireUuid(dashUuid(id), raw);
}

/**
 * Refuse a page id that is not a uuid, BEFORE it reaches a `ctx.step`.
 *
 * Notion answers a malformed id with a 400 that can never succeed, and a
 * throw inside the step is retried five times and then reported only as
 * `Step "fetch-review-page" exhausted all retry attempts` — the validation
 * message, which says exactly what was wrong, is destroyed (see
 * `.claude/rules/durables-sdk.md`, "Retry design"). Caught here it fails
 * once, immediately, and names the payload.
 *
 * Found on 2026-09-06 by the `null` case of the empty-payload matrix: the CLI
 * delivered it as the four-character string `"null"`, which is not an object
 * so it is not a ping, and was taken for a page id.
 */
function requireUuid(id: string, raw: unknown): string {
  if (isUuid(id)) return id;
  throw new Error(
    `Payload carried content but no usable Notion page id (got "${id.slice(0, 60)}"): ` +
      `${JSON.stringify(raw).slice(0, 400)}`,
  );
}

/**
 * True when the payload carries no event at all — an empty POST or a bare GET
 * of the catch URL.
 *
 * A catch hook is a public URL: pasting it into a browser, curling it, or
 * hitting "test" while wiring up the Notion automation all deliver a body like
 * `{"querystring":{}}`. Those are pings, not events, and failing the run on
 * them means a Zapier error alert every time someone touches the URL.
 *
 * A payload that DOES carry content but no page id is a different thing: a
 * real event we failed to understand. That still throws, loudly.
 */
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

function previewOnlyFlag(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, any>;
  return o.previewOnly === true || o.previewOnly === "true";
}

/** Data source a page belongs to, when the API says so. Empty when it doesn't. */
function parentDataSource(page: any): string {
  return dashUuid(firstString(page?.parent?.data_source_id));
}

/**
 * Bare host out of a company's `Website`.
 *
 * Mirrors the classic Zap's Formatter step
 * (`^(?:https?:\/\/)?(?:www\.)?([^\/]+)`) and tightens it: the original cut at
 * the first slash only, so a scheme-less `work.flowers?utm=x` or a pasted
 * `host:8080` reached the logo URL intact. Real values in Companies today span
 * all three shapes — `securecodewarrior.com`, `https://mha.gov.sg/`,
 * `https://goldengate.vc`.
 */
function extractDomain(website: string): string {
  const raw = website.trim();
  if (!raw) return "";
  const m = /^(?:https?:\/\/)?(?:www\.)?([^/?#]+)/i.exec(raw);
  let host = (m?.[1] ?? "").toLowerCase();
  host = host.split("@").pop() ?? ""; // drop pasted userinfo
  host = host.split(":")[0] ?? ""; // drop a port
  return host.replace(/\.+$/, ""); // drop a trailing dot
}

/**
 * Whether a string is plausibly a registrable hostname.
 *
 * `Website` is a free-text URL property, so it also holds things like "TBC".
 * A non-host value would otherwise be pasted straight into the logo.dev URL
 * and set as a real page icon, which renders as a broken image.
 */
function looksLikeHost(host: string): boolean {
  if (!host || host.length > 253) return false;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host);
}

/** The page's icon URL when it is an external image; "" for emoji, custom
 *  emoji, uploaded files, or no icon at all. */
function externalIconUrl(page: any): string {
  const icon = page?.icon;
  if (!icon || typeof icon !== "object") return "";
  if (icon.type !== "external") return "";
  return firstString(icon.external?.url);
}

async function getNotionPage(pageId: string): Promise<unknown> {
  const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
    connection: NOTION_CONNECTION,
    headers: { "Notion-Version": NOTION_VERSION },
  });
  if (!res.ok) {
    throw new Error(`Notion get page ${pageId} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

// --- Workflow -----------------------------------------------------------------

const workflow = defineDurable(
  "notion-review-to-company-logo",
  async (ctx: DurableContext, rawInput: Input) => {
    const payload = normalizeInput(InputSchema.parse(rawInput));

    // Someone pinged the catch URL rather than sending an event. Nothing to do,
    // and nothing worth alerting on.
    if (isEmptyPing(payload)) {
      console.log("empty payload — treating as a ping of the catch URL, not an event");
      return { skipped: "empty-payload" } satisfies Outcome;
    }

    const reviewPageId = extractPageId(payload);
    const previewOnly = previewOnlyFlag(payload);

    // 1. Never trust the payload's property values — the automation delivers a
    //    snapshot that may already be stale, and the `Company` rollup it needs
    //    is not reliably included. Re-read the page.
    const reviewPage = (await ctx.step("fetch-review-page", async () =>
      getNotionPage(reviewPageId),
    )) as any;

    if (reviewPage?.archived || reviewPage?.in_trash) {
      return { skipped: "review-page-archived", reviewPageId } satisfies Outcome;
    }

    const reviewProps = (reviewPage?.properties ?? {}) as Record<string, unknown>;

    // 2. Confirm this really is a Customer Review. The catch URL is public and
    //    a page from another data source would otherwise have its icon
    //    rewritten from an unrelated company's logo — Deals carries a `Contact`
    //    relation too. An event we cannot place is a real event we failed to
    //    understand, so it throws rather than skipping.
    const parentDs = parentDataSource(reviewPage);
    if (parentDs && parentDs !== REVIEWS_DS) {
      throw new Error(
        `page ${reviewPageId} belongs to data source ${parentDs}, not Customer Reviews (${REVIEWS_DS})`,
      );
    }
    if (!(REVIEW_CONTACT_PROP in reviewProps)) {
      throw new Error(
        `page ${reviewPageId} has no "${REVIEW_CONTACT_PROP}" property — not a Customer Review shape: ` +
          `${Object.keys(reviewProps).join(", ").slice(0, 200)}`,
      );
    }

    const headline = plainText((reviewProps[REVIEW_TITLE_PROP] as any)?.title);
    const contactIds = relationIds(reviewProps[REVIEW_CONTACT_PROP]);

    // 3. No linked contact means no company and no logo — the classic Zap's
    //    filter stopped here too. A review often lands before it is linked, so
    //    this is an ordinary state, not a fault.
    if (contactIds.length === 0) {
      console.log(`review ${reviewPageId} has no ${REVIEW_CONTACT_PROP} — nothing to resolve a company from`);
      return { skipped: "no-contact", reviewPageId, headline } satisfies Outcome;
    }
    const contactId = contactIds[0]!;

    // 4. Resolve the company. The `Company` rollup on the review already holds
    //    the company page id (it rolls up the contact's `Related Company`), so
    //    the common path costs no extra read; the contact page is fetched only
    //    when the rollup comes back empty. The classic Zap instead SEARCHED
    //    Companies for a `Clay Contacts` relation containing the contact —
    //    a property that no longer exists on Companies, so that search could
    //    no longer match anything.
    let companyId = rollupRelationIds(reviewProps[REVIEW_COMPANY_ROLLUP_PROP])[0] ?? null;
    let companySource = "review-company-rollup";

    if (!companyId) {
      const contactPage = (await ctx.step("fetch-contact-page", async () =>
        getNotionPage(contactId),
      )) as any;
      const contactDs = parentDataSource(contactPage);
      if (contactDs && contactDs !== CONTACTS_DS) {
        throw new Error(`contact ${contactId} belongs to data source ${contactDs}, not Contacts (${CONTACTS_DS})`);
      }
      companyId = relationIds((contactPage?.properties ?? {})[CONTACT_COMPANY_PROP])[0] ?? null;
      companySource = "contact-related-company";
    }

    if (!companyId) {
      console.log(`review ${reviewPageId}: contact ${contactId} has no ${CONTACT_COMPANY_PROP}`);
      return { skipped: "no-company", reviewPageId, headline, contactId } satisfies Outcome;
    }

    // 5. Read the company's `Website` and reduce it to a bare host.
    const companyPage = (await ctx.step("fetch-company-page", async () =>
      getNotionPage(companyId!),
    )) as any;
    const companyDs = parentDataSource(companyPage);
    if (companyDs && companyDs !== COMPANIES_DS) {
      throw new Error(`company ${companyId} belongs to data source ${companyDs}, not Companies (${COMPANIES_DS})`);
    }
    const companyProps = (companyPage?.properties ?? {}) as Record<string, unknown>;
    const companyName = plainText((companyProps[COMPANY_TITLE_PROP] as any)?.title);
    const website = firstString((companyProps[COMPANY_WEBSITE_PROP] as any)?.url).trim();

    if (!website) {
      console.log(`review ${reviewPageId}: company ${companyName || companyId} has no ${COMPANY_WEBSITE_PROP}`);
      return { skipped: "no-website", reviewPageId, headline, companyId, companyName } satisfies Outcome;
    }

    const domain = extractDomain(website);
    if (!looksLikeHost(domain)) {
      console.log(
        `review ${reviewPageId}: ${COMPANY_WEBSITE_PROP} "${website}" on ${companyName || companyId} ` +
          `is not a hostname — no logo URL built`,
      );
      return { skipped: "unusable-website", reviewPageId, companyId, companyName, website } satisfies Outcome;
    }

    const iconUrl = logoUrl(domain);
    const currentIcon = externalIconUrl(reviewPage);

    // 6. Set the page icon. `update_page` cannot write an icon and the classic
    //    Zap used a per-account Custom Action for it, so PATCH the page
    //    directly — the same route luma-event-to-notion takes for covers.
    //
    //    The icon is set UNCONDITIONALLY, matching the classic Zap: a re-run
    //    replaces a hand-picked custom emoji or uploaded logo with the
    //    logo.dev image (Dennis's call, 2026-09-06). The one write skipped is a
    //    byte-identical one, which would leave the page exactly as it is.
    if (currentIcon === iconUrl) {
      return {
        skipped: "icon-already-current",
        reviewPageId,
        headline,
        companyId,
        companyName,
        domain,
        iconUrl,
      } satisfies Outcome;
    }

    if (previewOnly) {
      return {
        previewOnly: true,
        reviewPageId,
        headline,
        contactId,
        companyId,
        companyName,
        companySource,
        website,
        domain,
        iconUrl,
        previousIcon: (reviewPage?.icon ?? null) as unknown,
      } satisfies Outcome;
    }

    await ctx.step("set-review-icon", async () => {
      const res = await sdk.fetch(`${NOTION_API}/pages/${reviewPageId}`, {
        connection: NOTION_CONNECTION,
        method: "PATCH",
        headers: {
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ icon: { type: "external", external: { url: iconUrl } } }),
      });
      if (!res.ok) {
        // The icon IS this workflow's entire output, so a failed PATCH fails
        // the run rather than being reported as a best-effort miss.
        throw new Error(
          `Notion icon PATCH on ${reviewPageId} failed (${res.status}): ${(await res.text()).slice(0, 300)}`,
        );
      }
      return { ok: true };
    });

    return {
      iconSet: true,
      reviewPageId,
      headline,
      contactId,
      companyId,
      companyName,
      companySource,
      website,
      domain,
      iconUrl,
      replacedIconType: firstString((reviewPage?.icon as any)?.type) || "none",
    } satisfies Outcome;
  },
);

export default workflow;
