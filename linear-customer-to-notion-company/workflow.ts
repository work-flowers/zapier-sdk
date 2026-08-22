// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/linear-customer-to-notion-company
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
const NOTION_APP_KEY = "NotionCLIAPI";
const NOTION_CONNECTION = "notion_wf"; // work.flowers workspace connection
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

/** Notion Companies. The data source id is what the query endpoint takes; the
 *  database id (21991b07-11ac-806d-99e8-f151552c7d3c) is what the classic Zap's
 *  find-or-create step used. */
const COMPANIES_DS = "21991b07-11ac-80b0-b787-000b3d3995f6";

const NAME_PROP = "Company Name";
const WEBSITE_PROP = "Website";
const LINEAR_ID_PROP = "Linear Customer ID";

const InputSchema = z.unknown();

type Outcome =
  | { skipped: string; customerId?: string; name?: string; domain?: string | null }
  | {
      customerId: string;
      domain: string;
      companyPageId: string;
      company: string;
      companyCreated: boolean;
      usedTemplate?: boolean;
    };

// --- Helpers -----------------------------------------------------------------
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

function firstResult(res: any): any {
  if (res && Array.isArray(res.data)) return res.data[0] ?? null;
  if (Array.isArray(res)) return res[0] ?? null;
  return res ?? null;
}

function plainText(rich: any): string {
  return (Array.isArray(rich) ? rich : []).map((t) => t?.plain_text ?? "").join("").trim();
}

/** Bare lowercase hostname: strips scheme, credentials, www., path and port.
 *  Linear stores customer domains bare already; Notion's Website property holds
 *  a full url, so both sides are reduced to this form before comparing. */
function toDomain(value: unknown): string {
  let s = String(value ?? "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.replace(/^[^/@]*@/, "");
  s = s.split("/")[0].split("?")[0].split("#")[0].split(":")[0];
  s = s.replace(/^www\./, "");
  return s;
}

/** Linear delivers `domains` as an array; the classic Zap's template flattened
 *  it to a comma-joined string, so tolerate both. */
function extractDomains(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : String(value ?? "").split(/[,;\s]+/);
  const out: string[] = [];
  for (const p of parts) {
    const d = toDomain(p);
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

type LinearCustomer = { id: string; name: string; domains: string[] };

function extractCustomer(raw: unknown): LinearCustomer {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Unusable trigger payload: ${JSON.stringify(raw).slice(0, 300)}`);
  }
  const o = raw as Record<string, any>;
  const src = (o.data && typeof o.data === "object" ? o.data : o) as Record<string, any>;
  const id = String(src.id ?? o.id ?? "").trim();
  if (!id) {
    throw new Error(
      `Could not find a Linear customer id in the trigger payload: ${JSON.stringify(raw).slice(0, 300)}`,
    );
  }
  return {
    id,
    name: String(src.name ?? o.name ?? "").trim(),
    domains: extractDomains(src.domains ?? o.domains),
  };
}

type CompanyMatch = { pageId: string; name: string; linearCustomerId: string };

/** First Companies page whose Website resolves to `domain`. Notion's `url`
 *  filter has no host-aware operator, so the `contains` query is a coarse
 *  prefilter and the hostname comparison is redone here exactly. */
async function findCompanyByDomain(domain: string): Promise<CompanyMatch | null> {
  const res = await sdk.fetch(`${NOTION_API}/data_sources/${COMPANIES_DS}/query`, {
    connection: NOTION_CONNECTION,
    method: "POST",
    headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    body: JSON.stringify({
      filter: { property: WEBSITE_PROP, url: { contains: domain } },
      page_size: 50,
    }),
  });
  if (!res.ok) {
    throw new Error(`Notion Companies query for "${domain}" failed (${res.status}): ${await res.text()}`);
  }
  const body: any = await res.json();
  const pages: any[] = Array.isArray(body?.results) ? body.results : [];
  // Oldest page wins, so repeated events converge on the same company.
  pages.sort((a, b) => String(a.created_time ?? "").localeCompare(String(b.created_time ?? "")));
  for (const page of pages) {
    const props = page.properties || {};
    if (toDomain(props[WEBSITE_PROP]?.url) !== domain) continue;
    return {
      pageId: String(page.id),
      name: plainText(props[NAME_PROP]?.title),
      linearCustomerId: plainText(props[LINEAR_ID_PROP]?.rich_text),
    };
  }
  return null;
}

// --- Workflow ----------------------------------------------------------------
const workflow = defineDurable({
  name: "linear-customer-to-notion-company",
  description:
    "When a customer is created in Linear, match it to a Notion Companies record by domain (creating the company if there is none) and write the Linear customer id onto that page. notion-companies-to-zapier-table mirrors the id into [Table] Company IDs.",
  inputSchema: InputSchema,
  run: async (ctx, rawInput) => {
    const customer = extractCustomer(normalizeInput(rawInput));

    // The classic Zap keyed its [Table] Company IDs lookup on the domain, so a
    // domainless customer had nothing to match on — and creating a Notion
    // company with a blank Website would make a duplicate of the next one.
    if (!customer.domains.length) {
      console.log(`Linear customer ${customer.id} ("${customer.name}") has no domain — nothing to match on`);
      return { skipped: "customer-has-no-domain", customerId: customer.id, name: customer.name } satisfies Outcome;
    }

    // 1. Find the company. Every domain on the customer is tried, in order.
    const found = await ctx.step("find-notion-company", async () => {
      for (const domain of customer.domains) {
        const match = await findCompanyByDomain(domain);
        if (match) return { domain, match };
      }
      return { domain: customer.domains[0], match: null };
    });

    const domain = found.domain;
    let companyPageId = found.match?.pageId ?? null;
    let companyName = found.match?.name ?? "";
    let companyCreated = false;
    let usedTemplate: boolean | undefined = undefined;

    // 2. Already carrying this customer id? Then this event is the echo of
    //    notion-company-to-linear-customer's own write. Stop, so the two
    //    workflows converge instead of writing at each other.
    if (found.match && found.match.linearCustomerId === customer.id) {
      console.log(`company ${companyPageId} already carries Linear customer ${customer.id}`);
      return {
        skipped: "already-linked",
        customerId: customer.id,
        name: companyName,
        domain,
      } satisfies Outcome;
    }

    // 3. No company for this domain — create one. `template_mode: "default"`
    //    applies the data source's default template so an automation-created
    //    company looks hand-made (repo rule 5); a data source without one
    //    throws a specific error, caught INSIDE the step so a template miss
    //    doesn't spin the step-retry loop.
    if (!companyPageId) {
      if (!customer.name) {
        return {
          skipped: "customer-has-no-name",
          customerId: customer.id,
          domain,
        } satisfies Outcome;
      }
      const created = await ctx.step("create-notion-company", async () => {
        const inputs: Record<string, unknown> = {
          datasource: COMPANIES_DS,
          [`properties|||${NAME_PROP}|||title`]: customer.name,
          [`properties|||${WEBSITE_PROP}|||url`]: `https://${domain}`,
        };
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
      companyPageId = firstResult(created?.res)?.id ?? null;
      if (!companyPageId) {
        throw new Error(
          `Created a Notion company for "${customer.name}" (${domain}) but could not read a page id ` +
            `out of the result: ${JSON.stringify(firstResult(created?.res)).slice(0, 300)}`,
        );
      }
      companyName = customer.name;
      companyCreated = true;
      usedTemplate = created.usedTemplate;
    }

    // 4. Write the Linear customer id onto the page. The classic Zap wrote the
    //    DOMAIN into this field ([Table] Company IDs f7) instead of the id,
    //    which is why existing rows carry hostnames; this writes the real id.
    await ctx.step("write-customer-id-to-notion", async () => {
      const res = await sdk.fetch(`${NOTION_API}/pages/${companyPageId}`, {
        connection: NOTION_CONNECTION,
        method: "PATCH",
        headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
        body: JSON.stringify({
          properties: { [LINEAR_ID_PROP]: { rich_text: [{ text: { content: customer.id } }] } },
        }),
      });
      if (!res.ok) {
        throw new Error(
          `Notion write-back of ${LINEAR_ID_PROP} to ${companyPageId} failed (${res.status}): ${await res.text()}`,
        );
      }
      return res.json();
    });

    console.log(
      `Linear customer ${customer.id} -> Notion company ${companyPageId} ` +
        `("${companyName}", ${domain})${companyCreated ? " [created]" : ""}`,
    );

    return {
      customerId: customer.id,
      domain,
      companyPageId,
      company: companyName,
      companyCreated,
      ...(usedTemplate === undefined ? {} : { usedTemplate }),
    } satisfies Outcome;
  },
});

export default workflow;
