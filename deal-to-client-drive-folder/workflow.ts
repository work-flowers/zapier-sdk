// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/deal-to-client-drive-folder
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
const NOTION_CONNECTION = "notion_wf"; // work.flowers workspace connection
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

const DRIVE_APP_KEY = "GoogleDriveCLIAPI";
const DRIVE_CONNECTION = "gdrive_wf";

/** Logo.dev Brand API (api.logo.dev/v2). The `logo_dev` connection is an
 *  API by Zapier connection holding the SECRET key (`sk_…`) as a Bearer token,
 *  scoped to api.logo.dev — the publishable key on img.logo.dev cannot read
 *  brand profiles. */
const LOGO_DEV_CONNECTION = "logo_dev";
const LOGO_DEV_API = "https://api.logo.dev/v2";
/** Brand-asset downloads cap out at 800px; ask for the largest PNG. */
const LOGO_PNG_SIZE = 800;
const MAX_BANNERS = 3;
const BRAND_KIT_FOLDER_NAME = "Brand Kit";

/** Work.Flowers HQ shared drive, "Client Docs" folder. */
const SHARED_DRIVE_ID = "0AHY_MJFjT0WtUk9PVA";
const CLIENT_DOCS_FOLDER_ID = "109hgE0VmTpTFTGUXreEYCNf8xu-jSnc2";

// --- Notion property names ----------------------------------------------------
const DEAL_TITLE_PROP = "Deal Name";
const DEAL_COMPANY_PROP = "Company";

const COMPANY_TITLE_PROP = "Company Name";
const COMPANY_DRIVE_ID_PROP = "Google Drive Folder ID";
const COMPANY_WEBSITE_PROP = "Website";
// "Google Drive Folder" on Companies is a FORMULA that renders the URL from
// Google Drive Folder ID, so the id write below is the only write needed.

const InputSchema = z.unknown();
type Input = Record<string, unknown>;
type Outcome = Record<string, unknown>;

// --- Helpers ------------------------------------------------------------------

function normalizeInput(rawInput: unknown): unknown {
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

function extractPageId(raw: unknown): string {
  if (!raw) throw new Error("No input provided to workflow.");
  if (typeof raw === "string") return dashUuid(raw.trim());
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
  return dashUuid(id);
}

/** True when the payload carries no event at all — see repo CLAUDE.md,
 *  "A webhook-triggered durable must SKIP on an empty payload". */
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

/** Bare host out of a company's free-text `Website` (same rules as
 *  notion-review-to-company-logo): drop scheme, `www.`, path, userinfo, port. */
function extractDomain(website: string): string {
  const raw = website.trim();
  if (!raw) return "";
  const m = /^(?:https?:\/\/)?(?:www\.)?([^/?#]+)/i.exec(raw);
  let host = (m?.[1] ?? "").toLowerCase();
  host = host.split("@").pop() ?? "";
  host = host.split(":")[0] ?? "";
  return host.replace(/\.+$/, "");
}

function looksLikeHost(host: string): boolean {
  if (!host || host.length > 253) return false;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host);
}

/** A Notion `url` property, or a rich_text one if the schema ever changes. */
function urlProp(prop: unknown): string {
  const p = prop as any;
  return firstString(p?.url).trim() || plainText(p?.rich_text);
}

/** A logo.dev temporary asset URL re-requested as a PNG. The bare URL serves a
 *  JPEG (no transparency) whatever the source format, and SVG is not offered. */
function pngUrl(url: string, size?: number): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}format=png${size ? `&size=${size}` : ""}`;
}

type BrandFetch = { kind: "ready"; brand: any } | { kind: "pending" } | { kind: "not_found" };

/** GET /v2/brands?domain=… . A 404 or `status: "not_found"` is terminal and
 *  NOT an error — plenty of small clients are not in the index. A `202`
 *  (`status: "not_indexed"`, `metadata.pending`) means the lookup started a
 *  first crawl, which logo.dev says settles within `expires_in_seconds` (300).
 *  Every other non-2xx (bad key, plan gate, 5xx) throws. */
async function fetchBrand(domain: string): Promise<BrandFetch> {
  const url = `${LOGO_DEV_API}/brands?domain=${encodeURIComponent(domain)}&nosubscribe=true`;
  const res = await sdk.fetch(url, { connection: LOGO_DEV_CONNECTION });
  if (res.status === 404) return { kind: "not_found" };
  if (!res.ok) {
    throw new Error(`logo.dev brand lookup for ${domain} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const body = (await res.json()) as any;
  const status = firstString(body?.data?.status);
  if (status === "not_found") return { kind: "not_found" };
  if (res.status === 202 || status === "not_indexed" || body?.metadata?.pending) return { kind: "pending" };
  return { kind: "ready", brand: body?.data };
}

/** Uploads one public URL into a Drive folder; returns the file id. */
async function uploadToDrive(folderId: string, url: string, name: string, extension: string): Promise<string> {
  const res = await sdk.runAction({
    appKey: DRIVE_APP_KEY,
    actionType: "write",
    actionKey: "file",
    connection: DRIVE_CONNECTION,
    inputs: {
      drive: SHARED_DRIVE_ID,
      folder: folderId,
      file: url,
      new_name: name,
      new_extension: extension,
    },
  });
  return firstString(firstResult(res)?.id);
}

/** Social banners are an array, so their step ids carry an index — which the
 *  publish-time analyzer only allows outside the workflow body. */
async function uploadBanners(
  ctx: DurableContext,
  stepPrefix: string,
  folderId: string,
  company: string,
  banners: any[],
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < banners.length; i++) {
    const url = firstString(banners[i]?.url);
    if (!url) continue;
    const suffix = banners.length > 1 ? ` ${i + 1}` : "";
    ids.push(
      await ctx.step(`${stepPrefix}-${i}`, async () =>
        uploadToDrive(folderId, pngUrl(url), `${company} social banner${suffix}`, "png"),
      ),
    );
  }
  return ids;
}

/** Plain-text brand guide, converted to a Google Doc on upload. */
function brandGuideText(brand: any, domain: string): string {
  const lines: string[] = [];
  lines.push(`${firstString(brand?.name) || domain} — brand kit`);
  lines.push("");
  const description = firstString(brand?.description).trim();
  if (description) lines.push(description, "");
  const colors = Array.isArray(brand?.colors) ? brand.colors : [];
  if (colors.length) {
    lines.push("Colours");
    for (const c of colors) {
      const hex = firstString(c?.hex);
      if (hex) lines.push(`  ${hex.toUpperCase()}   rgb(${c?.r}, ${c?.g}, ${c?.b})`);
    }
    lines.push("");
  }
  const socials = brand?.socials && typeof brand.socials === "object" ? brand.socials : {};
  const socialLines = Object.entries(socials)
    .filter(([, v]) => typeof v === "string" && v)
    .map(([k, v]) => `  ${k}: ${v}`);
  if (socialLines.length) lines.push("Socials", ...socialLines, "");
  lines.push(`Source: logo.dev brand profile for ${domain}` +
    (firstString(brand?.indexed_at) ? `, indexed ${firstString(brand.indexed_at).slice(0, 10)}` : "") + ".");
  lines.push("Logos via Logo.dev — https://logo.dev");
  return lines.join("\n");
}

/** First item of a runAction result ({ data: [...] } or a bare array). */
function firstResult(res: unknown): any {
  const rows = (res as any)?.data;
  if (Array.isArray(rows)) return rows[0];
  return Array.isArray(res) ? (res as any[])[0] : res;
}

// --- Workflow -----------------------------------------------------------------

const workflow = defineDurable<Input, unknown>(
  "deal-to-client-drive-folder",
  async (ctx: DurableContext, rawInput: Input) => {
    const payload = normalizeInput(InputSchema.parse(rawInput));

    if (isEmptyPing(payload)) {
      console.log("empty payload — treating as a ping of the catch URL, not an event");
      return { skipped: "empty-payload" } satisfies Outcome;
    }

    const dealPageId = extractPageId(payload);

    // 1. Never trust the payload's property values — re-read the deal.
    const dealPage = await ctx.step("fetch-deal-page", async () => {
      const res = await sdk.fetch(`${NOTION_API}/pages/${dealPageId}`, {
        connection: NOTION_CONNECTION,
        headers: { "Notion-Version": NOTION_VERSION },
      });
      if (!res.ok) {
        throw new Error(`Notion get deal ${dealPageId} failed (${res.status}): ${await res.text()}`);
      }
      return res.json();
    });

    if ((dealPage as any)?.archived || (dealPage as any)?.in_trash) {
      return { skipped: "deal-page-archived", dealPageId } satisfies Outcome;
    }

    const dealProps = (dealPage as any)?.properties ?? {};
    const dealName = plainText(dealProps[DEAL_TITLE_PROP]?.title);
    const companyId = relationIds(dealProps[DEAL_COMPANY_PROP])[0] ?? null;

    if (!companyId) {
      return { skipped: "deal-has-no-company", dealPageId, deal: dealName } satisfies Outcome;
    }

    // 2. The company page carries both the folder guard and the name.
    const companyPage = await ctx.step("fetch-company-page", async () => {
      const res = await sdk.fetch(`${NOTION_API}/pages/${companyId}`, {
        connection: NOTION_CONNECTION,
        headers: { "Notion-Version": NOTION_VERSION },
      });
      if (!res.ok) {
        throw new Error(`Notion get company ${companyId} failed (${res.status}): ${await res.text()}`);
      }
      return res.json();
    });

    const companyProps = (companyPage as any)?.properties ?? {};
    const companyName = plainText(companyProps[COMPANY_TITLE_PROP]?.title);
    const existingFolderId = plainText(companyProps[COMPANY_DRIVE_ID_PROP]?.rich_text);

    // 3. Idempotence guard, carried over from the classic Zap's Table lookup.
    //    Read straight off the company page: [Table] Company IDs is fed FROM
    //    this property by notion-companies-to-zapier-table, so the page is the
    //    fresher of the two and it is already in hand.
    if (existingFolderId) {
      return {
        skipped: "folder-already-exists",
        companyId,
        company: companyName,
        driveFolderId: existingFolderId,
      } satisfies Outcome;
    }

    if (!companyName) {
      return { skipped: "company-has-no-name", companyId } satisfies Outcome;
    }

    // 4. Create the folder under Client Docs in the Work.Flowers HQ drive.
    const created = await ctx.step("create-drive-folder", async () =>
      sdk.runAction({
        appKey: DRIVE_APP_KEY,
        actionType: "write",
        actionKey: "folder",
        connection: DRIVE_CONNECTION,
        inputs: {
          drive: SHARED_DRIVE_ID,
          folder: CLIENT_DOCS_FOLDER_ID,
          title: companyName,
        },
      }),
    );

    const folderId = firstString(firstResult(created)?.id);
    if (!folderId) {
      throw new Error(
        `Created a Drive folder for "${companyName}" but could not read a folder id out of the ` +
          `result: ${JSON.stringify(firstResult(created)).slice(0, 300)}`,
      );
    }

    // 5. Write the id back so the guard has teeth on the next run. The
    //    "Google Drive Folder" formula renders the URL from it, and
    //    notion-companies-to-zapier-table mirrors it into [Table] Company IDs.
    await ctx.step("write-folder-id-to-notion", async () => {
      const res = await sdk.fetch(`${NOTION_API}/pages/${companyId}`, {
        connection: NOTION_CONNECTION,
        method: "PATCH",
        headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
        body: JSON.stringify({
          properties: {
            [COMPANY_DRIVE_ID_PROP]: { rich_text: [{ text: { content: folderId } }] },
          },
        }),
      });
      if (!res.ok) {
        throw new Error(
          `Notion write-back of ${COMPANY_DRIVE_ID_PROP} to ${companyId} failed (${res.status}): ${await res.text()}`,
        );
      }
      return res.json();
    });

    console.log(`created Drive folder "${companyName}" (${folderId}) from deal "${dealName}"`);

    // 6. Brand kit from logo.dev, into a "Brand Kit" sub-folder. Runs only on
    //    the folder-creating path, AFTER the write-back, so a brand-kit failure
    //    can never cause a duplicate client folder. Missing data (no Website,
    //    brand not in logo.dev's index) is an expected outcome and is reported
    //    in the result; a real API error throws (red run, Zapier alert) and the
    //    kit has to be added by hand — a re-trigger stops at the folder guard.
    const website = urlProp(companyProps[COMPANY_WEBSITE_PROP]);
    const domain = extractDomain(website);
    let brandKit: Record<string, unknown>;

    if (!website) {
      brandKit = { skipped: "no-website" };
    } else if (!looksLikeHost(domain)) {
      brandKit = { skipped: "unusable-website", website };
    } else {
      let lookup = await ctx.step("fetch-brand", async () => fetchBrand(domain));
      if (lookup.kind === "pending") {
        // First request for this domain started a crawl. Waits are free.
        console.log(`logo.dev is crawling ${domain} for the first time — waiting before one retry`);
        await ctx.wait("wait-for-brand-crawl", 240);
        lookup = await ctx.step("fetch-brand-after-crawl", async () => fetchBrand(domain));
      }

      if (lookup.kind !== "ready") {
        brandKit = { skipped: lookup.kind === "not_found" ? "brand-not-found" : "brand-still-indexing", domain };
      } else {
        const brand = lookup.brand;
        const logoUrl = firstString(brand?.logo?.url);
        const brandmarkUrl = firstString(brand?.brandmark?.url);
        const banners = (Array.isArray(brand?.social_banners) ? brand.social_banners : []).slice(0, MAX_BANNERS);

        const kitFolder = await ctx.step("create-brand-kit-folder", async () =>
          sdk.runAction({
            appKey: DRIVE_APP_KEY,
            actionType: "write",
            actionKey: "folder",
            connection: DRIVE_CONNECTION,
            inputs: { drive: SHARED_DRIVE_ID, folder: folderId, title: BRAND_KIT_FOLDER_NAME },
          }),
        );
        const kitFolderId = firstString(firstResult(kitFolder)?.id);
        if (!kitFolderId) {
          throw new Error(
            `Created the ${BRAND_KIT_FOLDER_NAME} folder in ${folderId} but could not read its id: ` +
              JSON.stringify(firstResult(kitFolder)).slice(0, 300),
          );
        }

        const files: Record<string, unknown> = {};
        if (logoUrl) {
          files.logo = await ctx.step("upload-logo", async () =>
            uploadToDrive(kitFolderId, pngUrl(logoUrl, LOGO_PNG_SIZE), `${companyName} logo`, "png"),
          );
        }
        if (brandmarkUrl) {
          files.brandmark = await ctx.step("upload-brandmark", async () =>
            uploadToDrive(kitFolderId, pngUrl(brandmarkUrl, LOGO_PNG_SIZE), `${companyName} brandmark`, "png"),
          );
        }
        files.banners = await uploadBanners(ctx, "upload-banner", kitFolderId, companyName, banners);
        files.guide = await ctx.step("write-brand-guide", async () =>
          firstString(
            firstResult(
              await sdk.runAction({
                appKey: DRIVE_APP_KEY,
                actionType: "write",
                actionKey: "newtxtfile",
                connection: DRIVE_CONNECTION,
                inputs: {
                  drive: SHARED_DRIVE_ID,
                  folder: kitFolderId,
                  title: `${companyName} brand guide`,
                  file: brandGuideText(brand, domain),
                  convert: true,
                },
              }),
            )?.id,
          ),
        );

        brandKit = { created: true, domain, brandKitFolderId: kitFolderId, files };
        console.log(`brand kit for ${domain} saved to ${BRAND_KIT_FOLDER_NAME} (${kitFolderId})`);
      }
    }

    if (brandKit.skipped) console.log(`no brand kit: ${String(brandKit.skipped)} (${domain || website || "no website"})`);

    return {
      created: true,
      companyId,
      company: companyName,
      dealPageId,
      deal: dealName,
      driveFolderId: folderId,
      brandKit,
    } satisfies Outcome;
  },
);

export default workflow;
