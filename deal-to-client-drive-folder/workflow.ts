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

/** Work.Flowers HQ shared drive, "Client Docs" folder. */
const SHARED_DRIVE_ID = "0AHY_MJFjT0WtUk9PVA";
const CLIENT_DOCS_FOLDER_ID = "109hgE0VmTpTFTGUXreEYCNf8xu-jSnc2";

// --- Notion property names ----------------------------------------------------
const DEAL_TITLE_PROP = "Deal Name";
const DEAL_COMPANY_PROP = "Company";

const COMPANY_TITLE_PROP = "Company Name";
const COMPANY_DRIVE_ID_PROP = "Google Drive Folder ID";
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

    return {
      created: true,
      companyId,
      company: companyName,
      dealPageId,
      deal: dealName,
      driveFolderId: folderId,
    } satisfies Outcome;
  },
);

export default workflow;
