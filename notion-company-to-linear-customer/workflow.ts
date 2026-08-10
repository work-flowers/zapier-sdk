// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/notion-company-to-linear-customer
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
const NOTION_CONNECTION = "notion_wf"; // work.flowers workspace connection
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

const LINEAR_APP_KEY = "LinearCLIAPI";
const LINEAR_CONNECTION = "linear_wf";

// --- Notion property names ----------------------------------------------------
const COMPANY_TITLE_PROP = "Company Name";
const COMPANY_WEBSITE_PROP = "Website";
const COMPANY_DEALS_PROP = "Deals";
const COMPANY_UID_PROP = "ID"; // unique_id, prefix COM
const COMPANY_LINEAR_ID_PROP = "Linear Customer ID";

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

/** The polling trigger delivers the changed page; hand-replays can pass a
 *  bare id. Same extraction as the webhook durables. */
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

/** First item of a runAction result ({ data: [...] } or a bare array). */
function firstResult(res: unknown): any {
  const rows = (res as any)?.data;
  if (Array.isArray(rows)) return rows[0];
  return Array.isArray(res) ? (res as any[])[0] : res;
}

/** Bare hostname out of a Website url — Linear wants domains, not URLs. */
function toDomain(url: string): string {
  const t = url.trim();
  if (!t) return "";
  try {
    return new URL(t.includes("://") ? t : `https://${t}`).hostname.replace(/^www\./, "");
  } catch {
    return t.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  }
}

/** Linear's createCustomer wraps its payload GraphQL-style. */
function extractCustomerId(res: unknown): string {
  const row = firstResult(res);
  return (
    firstString(row?.data?.customerCreate?.customer?.id) ||
    firstString(row?.customerCreate?.customer?.id) ||
    firstString(row?.customer?.id) ||
    firstString(row?.id)
  );
}

// --- Workflow -----------------------------------------------------------------

const workflow = defineDurable<Input, unknown>(
  "notion-company-to-linear-customer",
  async (ctx: DurableContext, rawInput: Input) => {
    const payload = normalizeInput(InputSchema.parse(rawInput));
    const companyPageId = extractPageId(payload);

    // 1. Never trust the trigger snapshot — re-read the company page.
    const companyPage = await ctx.step("fetch-company-page", async () => {
      const res = await sdk.fetch(`${NOTION_API}/pages/${companyPageId}`, {
        connection: NOTION_CONNECTION,
        headers: { "Notion-Version": NOTION_VERSION },
      });
      if (!res.ok) {
        throw new Error(`Notion get company ${companyPageId} failed (${res.status}): ${await res.text()}`);
      }
      return res.json();
    });

    if ((companyPage as any)?.archived || (companyPage as any)?.in_trash) {
      return { skipped: "company-page-archived", companyPageId } satisfies Outcome;
    }

    const props = (companyPage as any)?.properties ?? {};
    const companyName = plainText(props[COMPANY_TITLE_PROP]?.title);
    const website = firstString(props[COMPANY_WEBSITE_PROP]?.url).trim();
    const dealIds = relationIds(props[COMPANY_DEALS_PROP]);
    const existingCustomerId = plainText(props[COMPANY_LINEAR_ID_PROP]?.rich_text);
    const uid = props[COMPANY_UID_PROP]?.unique_id;
    const companyUid =
      uid?.number != null ? `${firstString(uid.prefix) ? `${uid.prefix}-` : ""}${uid.number}` : "";

    // 2. Same gates as the classic Zap: a company only becomes a Linear
    //    customer once a deal is linked, and only once.
    if (dealIds.length === 0) {
      return { skipped: "no-deal-linked", companyPageId, company: companyName } satisfies Outcome;
    }
    if (existingCustomerId) {
      return {
        skipped: "already-in-linear",
        companyPageId,
        company: companyName,
        linearCustomerId: existingCustomerId,
      } satisfies Outcome;
    }
    if (!companyName) {
      return { skipped: "company-has-no-name", companyPageId } satisfies Outcome;
    }

    // 3. Create the customer. The COM-n unique id rides along as the external
    //    id (the classic Zap read the same value from [Table] Company IDs).
    const domain = toDomain(website);
    const inputs: Record<string, unknown> = { name: companyName };
    if (domain) inputs.domains = [domain];
    if (companyUid) inputs.externalIds = [companyUid];

    const created = await ctx.step("create-linear-customer", async () =>
      sdk.runAction({
        appKey: LINEAR_APP_KEY,
        actionType: "write",
        actionKey: "createCustomer",
        connection: LINEAR_CONNECTION,
        inputs,
      }),
    );

    const customerId = extractCustomerId(created);
    if (!customerId) {
      throw new Error(
        `Created a Linear customer for "${companyName}" but could not read a customer id out of the ` +
          `result: ${JSON.stringify(firstResult(created)).slice(0, 300)}`,
      );
    }

    // 4. Write the id back so the guard has teeth on the next run.
    //    notion-companies-to-zapier-table mirrors it into [Table] Company IDs.
    await ctx.step("write-customer-id-to-notion", async () => {
      const res = await sdk.fetch(`${NOTION_API}/pages/${companyPageId}`, {
        connection: NOTION_CONNECTION,
        method: "PATCH",
        headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
        body: JSON.stringify({
          properties: {
            [COMPANY_LINEAR_ID_PROP]: { rich_text: [{ text: { content: customerId } }] },
          },
        }),
      });
      if (!res.ok) {
        throw new Error(
          `Notion write-back of ${COMPANY_LINEAR_ID_PROP} to ${companyPageId} failed (${res.status}): ${await res.text()}`,
        );
      }
      return res.json();
    });

    console.log(`created Linear customer "${companyName}" (${customerId})`);

    return {
      created: true,
      companyPageId,
      company: companyName,
      linearCustomerId: customerId,
      domain: domain || null,
      externalId: companyUid || null,
    } satisfies Outcome;
  },
);

export default workflow;
