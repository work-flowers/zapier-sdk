// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/xero-contact-from-notion-deal
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
const NOTION_CONNECTION = "notion_wf"; // work.flowers workspace connection
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

const XERO_APP_KEY = "XeroCLIAPI";
const XERO_CONNECTION = "xero_wf";

/** Xero organisation ("tenant") — work.flowers. */
const XERO_ORGANIZATION = "62699a8c-3351-40e8-9265-bdca5e037b03";

// --- Notion data sources ------------------------------------------------------
const COMPANIES_DS = "21991b07-11ac-80b0-b787-000b3d3995f6";
const DEALS_DS = "21a91b07-11ac-808d-9657-000b1390d20b";

// --- Notion property names ----------------------------------------------------
const COMPANY_TITLE_PROP = "Company Name";
const COMPANY_DEALS_PROP = "Deals";
const COMPANY_BILLING_PROP = "Primary Billing Contact";
const COMPANY_XERO_ID_PROP = "Xero Contact ID";
const COMPANY_UID_PROP = "ID";

const DEAL_TITLE_PROP = "Deal Name";
const DEAL_COMPANY_PROP = "Company";
const DEAL_CONTACT_PROP = "Contact";

const CONTACT_FIRST_PROP = "First Name";
const CONTACT_LAST_PROP = "Last Name";
const CONTACT_EMAIL_PROP = "Primary Email";

const InputSchema = z.unknown();

/** `defineDurable`'s input generic is constrained to an object type, so the
 *  loose runtime shapes (a bare page-id string, a double-encoded body) are
 *  handled by `normalizeInput` / `extractPageId` rather than by the type. */
type Input = Record<string, unknown>;

// --- Types --------------------------------------------------------------------

/** One person as Xero wants them. */
type Person = {
  pageId: string;
  firstName: string;
  lastName: string;
  email: string;
};

type CompanySnapshot = {
  pageId: string;
  name: string;
  accountNumber: string;
  xeroContactId: string;
  billingContactId: string | null;
  dealIds: string[];
};

type DealSnapshot = {
  pageId: string;
  name: string;
  companyId: string | null;
  contactId: string | null;
};

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

function sameNotionId(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return dashUuid(a) === dashUuid(b);
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
 * Pull the Notion page id out of whatever the trigger delivered.
 *
 * Notion database automations post `{ data: { id, properties, ... } }`; a
 * button property posts the same shape. `run-durable` / `trigger-workflow`
 * take a bare id or `{ pageId }` so a run can be replayed by hand.
 */
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

function previewOnlyFlag(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, any>;
  return o.previewOnly === true || o.previewOnly === "true";
}

/** Data source a page belongs to, when the API says so. Empty when it doesn't. */
function parentDataSource(page: any): string {
  const parent = page?.parent ?? {};
  return dashUuid(firstString(parent.data_source_id) || firstString(parent.database_id));
}

function readCompany(page: any): CompanySnapshot {
  const props = page?.properties ?? {};
  const uid = props[COMPANY_UID_PROP]?.unique_id;
  const accountNumber =
    uid?.number != null ? `${firstString(uid.prefix) ? `${uid.prefix}-` : ""}${uid.number}` : "";
  const billing = relationIds(props[COMPANY_BILLING_PROP]);
  return {
    pageId: dashUuid(firstString(page?.id)),
    name: plainText(props[COMPANY_TITLE_PROP]?.title),
    accountNumber,
    xeroContactId: plainText(props[COMPANY_XERO_ID_PROP]?.rich_text),
    billingContactId: billing[0] ?? null,
    dealIds: relationIds(props[COMPANY_DEALS_PROP]),
  };
}

function readDeal(page: any): DealSnapshot {
  const props = page?.properties ?? {};
  const company = relationIds(props[DEAL_COMPANY_PROP]);
  const contact = relationIds(props[DEAL_CONTACT_PROP]);
  return {
    pageId: dashUuid(firstString(page?.id)),
    name: plainText(props[DEAL_TITLE_PROP]?.title),
    companyId: company[0] ?? null,
    contactId: contact[0] ?? null,
  };
}

function readPerson(page: any): Person {
  const props = page?.properties ?? {};
  return {
    pageId: dashUuid(firstString(page?.id)),
    firstName: plainText(props[CONTACT_FIRST_PROP]?.rich_text),
    lastName: plainText(props[CONTACT_LAST_PROP]?.rich_text),
    email: firstString(props[CONTACT_EMAIL_PROP]?.email).trim(),
  };
}

/**
 * Xero requires a contact person to carry at least one of first name, last
 * name or email — a person with none of the three is not worth sending.
 */
function hasIdentity(p: Person | null): p is Person {
  if (!p) return false;
  return Boolean(p.firstName || p.lastName || p.email);
}

/**
 * Dig a Xero contact id out of the action result.
 *
 * The `contact` action flattens Xero's `Contacts[0]` into its output row, but
 * the exact spelling of the id key is not contractual, so try the plausible
 * ones rather than trusting one. Returning "" simply means the write-back is
 * skipped — the contact itself is already created either way.
 */
function extractXeroContactId(result: unknown): string {
  const rows = (result as any)?.data;
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || typeof row !== "object") return "";
  const direct =
    firstString(row.ContactID) ||
    firstString(row.contactID) ||
    firstString(row.contact_id) ||
    firstString(row.contactId) ||
    firstString(row.id);
  if (direct) return direct;
  const nested = Array.isArray(row.Contacts) ? row.Contacts[0] : null;
  return nested ? firstString(nested.ContactID) : "";
}

// --- Workflow -----------------------------------------------------------------

const workflow = defineDurable<Input, unknown>(
  "xero-contact-from-notion-deal",
  async (ctx: DurableContext, rawInput: Input) => {
    const payload = normalizeInput(InputSchema.parse(rawInput));
    const triggerPageId = extractPageId(payload);
    const previewOnly = previewOnlyFlag(payload);

    // 1. Never trust the payload's property values — a button click and a
    //    database automation both deliver a snapshot that may already be stale
    //    by the time this runs. Re-read the page.
    const triggerPage = await ctx.step("fetch-trigger-page", async () => {
      const res = await sdk.fetch(`${NOTION_API}/pages/${triggerPageId}`, {
        connection: NOTION_CONNECTION,
        headers: { "Notion-Version": NOTION_VERSION },
      });
      if (!res.ok) {
        throw new Error(`Notion get page ${triggerPageId} failed (${res.status}): ${await res.text()}`);
      }
      return res.json();
    });

    if ((triggerPage as any)?.archived || (triggerPage as any)?.in_trash) {
      return { skipped: "trigger-page-archived", triggerPageId } satisfies Outcome;
    }

    // 2. The trigger fires from two places with two different page types: the
    //    Companies "Create Xero Contact" button sends a Company, and the deal
    //    stage automation sends a Deal. Work out which arrived, then resolve
    //    the pair. Parent data source is the reliable signal; the property
    //    shape is the fallback when the API omits it.
    const parentDs = parentDataSource(triggerPage);
    const triggerProps = (triggerPage as any)?.properties ?? {};
    const isDeal =
      parentDs === DEALS_DS ||
      (parentDs !== COMPANIES_DS && DEAL_COMPANY_PROP in triggerProps && DEAL_TITLE_PROP in triggerProps);
    const isCompany =
      parentDs === COMPANIES_DS ||
      (parentDs !== DEALS_DS && COMPANY_DEALS_PROP in triggerProps && COMPANY_TITLE_PROP in triggerProps);

    if (!isDeal && !isCompany) {
      return {
        skipped: "unrecognized-page-type",
        triggerPageId,
        parentDataSource: parentDs,
        properties: Object.keys(triggerProps).slice(0, 30),
      } satisfies Outcome;
    }

    let company: CompanySnapshot;
    let deal: DealSnapshot | null = null;

    if (isDeal) {
      deal = readDeal(triggerPage);
      if (!deal.companyId) {
        return { skipped: "deal-has-no-company", dealId: deal.pageId, dealName: deal.name } satisfies Outcome;
      }
      const companyPage = await ctx.step("fetch-company-page", async () => {
        const res = await sdk.fetch(`${NOTION_API}/pages/${deal!.companyId}`, {
          connection: NOTION_CONNECTION,
          headers: { "Notion-Version": NOTION_VERSION },
        });
        if (!res.ok) {
          throw new Error(`Notion get company ${deal!.companyId} failed (${res.status}): ${await res.text()}`);
        }
        return res.json();
      });
      company = readCompany(companyPage);
    } else {
      company = readCompany(triggerPage);
    }

    // 3. Idempotence guard, carried over from the classic Zap's Table lookup.
    //    Read straight off the company record rather than the mirror Table:
    //    the Table is fed from this same property by
    //    notion-companies-to-zapier-table, so the page is the fresher of the
    //    two and it is already in hand — no extra call, no mirror lag.
    //
    //    `previewOnly` deliberately walks PAST this guard and reports it as
    //    `wouldSkip` instead. Every company that has a billing contact today
    //    also already has a Xero id, so returning here would make the
    //    two-person shape untestable without writing to Xero.
    if (company.xeroContactId && !previewOnly) {
      return {
        skipped: "already-in-xero",
        companyId: company.pageId,
        company: company.name,
        xeroContactId: company.xeroContactId,
      } satisfies Outcome;
    }

    if (!company.name) {
      return { skipped: "company-has-no-name", companyId: company.pageId } satisfies Outcome;
    }

    // 4. A company with no deal at all is out of scope — same as the classic
    //    Zap's "Deals relation exists" filter. When the button fired on a
    //    company, take its first deal, which is what the classic Zap did.
    if (!deal) {
      const dealId = company.dealIds[0];
      if (!dealId) {
        return {
          skipped: "company-has-no-deals",
          companyId: company.pageId,
          company: company.name,
        } satisfies Outcome;
      }
      const dealPage = await ctx.step("fetch-deal-page", async () => {
        const res = await sdk.fetch(`${NOTION_API}/pages/${dealId}`, {
          connection: NOTION_CONNECTION,
          headers: { "Notion-Version": NOTION_VERSION },
        });
        if (!res.ok) {
          throw new Error(`Notion get deal ${dealId} failed (${res.status}): ${await res.text()}`);
        }
        return res.json();
      });
      deal = readDeal(dealPage);
    }

    // 5. Read the two candidate people. Either may be absent.
    let billingContact: Person | null = null;
    if (company.billingContactId) {
      const page = await ctx.step("fetch-billing-contact", async () => {
        const res = await sdk.fetch(`${NOTION_API}/pages/${company.billingContactId}`, {
          connection: NOTION_CONNECTION,
          headers: { "Notion-Version": NOTION_VERSION },
        });
        if (!res.ok) {
          throw new Error(
            `Notion get billing contact ${company.billingContactId} failed (${res.status}): ${await res.text()}`,
          );
        }
        return res.json();
      });
      billingContact = readPerson(page);
    }

    let dealContact: Person | null = null;
    const sameParty = sameNotionId(company.billingContactId, deal.contactId);
    if (deal.contactId && !sameParty) {
      const page = await ctx.step("fetch-deal-contact", async () => {
        const res = await sdk.fetch(`${NOTION_API}/pages/${deal!.contactId}`, {
          connection: NOTION_CONNECTION,
          headers: { "Notion-Version": NOTION_VERSION },
        });
        if (!res.ok) {
          throw new Error(
            `Notion get deal contact ${deal!.contactId} failed (${res.status}): ${await res.text()}`,
          );
        }
        return res.json();
      });
      dealContact = readPerson(page);
    }

    // 6. Who goes on the Xero contact.
    //
    //    The billing contact is the primary person when there is one, and the
    //    deal contact rides along as Xero's secondary "contact person" only
    //    when it is a DIFFERENT human. Otherwise the single known person is
    //    the primary and there is no secondary.
    //
    //    The classic Zap only covered two of these four combinations: its
    //    Path A demanded billing != deal contact and its Path C demanded no
    //    billing contact at all, so "billing == deal contact" and "billing but
    //    no deal contact" matched no path and silently produced nothing. Both
    //    now land on the single-person shape.
    const primary = hasIdentity(billingContact) ? billingContact : hasIdentity(dealContact) ? dealContact : null;
    const secondary =
      hasIdentity(billingContact) && hasIdentity(dealContact) && !sameParty ? dealContact : null;

    if (!primary) {
      return {
        skipped: "no-usable-contact",
        companyId: company.pageId,
        company: company.name,
        dealId: deal.pageId,
        billingContactId: company.billingContactId,
        dealContactId: deal.contactId,
      } satisfies Outcome;
    }

    const contactInputs: Record<string, unknown> = {
      organization: XERO_ORGANIZATION,
      name: company.name,
      first_name: primary.firstName,
      last_name: primary.lastName,
      email_address: primary.email,
    };
    if (company.accountNumber) contactInputs.account_number = company.accountNumber;
    if (secondary) {
      contactInputs.contact_person__first_name = secondary.firstName;
      contactInputs.contact_person__last_name = secondary.lastName;
      contactInputs.contact_person__email_address = secondary.email;
      contactInputs.contact_person__include_in_emails = true;
    }

    const plan = {
      companyId: company.pageId,
      company: company.name,
      dealId: deal.pageId,
      deal: deal.name,
      primaryContactId: primary.pageId,
      secondaryContactId: secondary ? secondary.pageId : null,
      shape: secondary ? "billing-primary-with-deal-contact-person" : "single-person",
      xeroInputs: contactInputs,
    };

    // `previewOnly` resolves the whole chain and reports what WOULD be sent.
    // Xero's Create/Update Contact matches on name, so a careless test run
    // against a real company overwrites the live contact's people — this is
    // how the Notion side gets validated without that risk.
    if (previewOnly) {
      return {
        previewOnly: true,
        wouldSkip: company.xeroContactId ? "already-in-xero" : null,
        existingXeroContactId: company.xeroContactId || null,
        ...plan,
      } satisfies Outcome;
    }

    // 7. Create (or update, if Xero already knows this name) the contact.
    const created = await ctx.step("create-xero-contact", async () =>
      sdk.runAction({
        appKey: XERO_APP_KEY,
        actionType: "write",
        actionKey: "contact",
        connection: XERO_CONNECTION,
        inputs: contactInputs,
      }),
    );

    // 8. Write the id back so the guard in step 3 has teeth on the next run.
    //    notion-companies-to-zapier-table mirrors this property into the
    //    Company IDs Table, so the Table stays correct with no work here.
    const xeroContactId = extractXeroContactId(created);
    let writeBack: string;
    if (!xeroContactId) {
      console.log(
        `WARNING: created the Xero contact for "${company.name}" but could not read a contact id out of ` +
          `the action result, so ${COMPANY_XERO_ID_PROP} was left empty. Result keys: ` +
          `${JSON.stringify(Object.keys((created as any)?.data?.[0] ?? {})).slice(0, 300)}`,
      );
      writeBack = "skipped-no-contact-id";
    } else {
      await ctx.step("write-xero-id-to-notion", async () => {
        const res = await sdk.fetch(`${NOTION_API}/pages/${company.pageId}`, {
          connection: NOTION_CONNECTION,
          method: "PATCH",
          headers: {
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            properties: {
              [COMPANY_XERO_ID_PROP]: { rich_text: [{ text: { content: xeroContactId } }] },
            },
          }),
        });
        if (!res.ok) {
          throw new Error(
            `Notion write-back of ${COMPANY_XERO_ID_PROP} to ${company.pageId} failed (${res.status}): ${await res.text()}`,
          );
        }
        return res.json();
      });
      writeBack = "written";
    }

    console.log(
      `created Xero contact "${company.name}" (${xeroContactId || "id unknown"}) from deal "${deal.name}" ` +
        `— primary ${primary.email || primary.firstName || primary.pageId}` +
        (secondary ? `, contact person ${secondary.email || secondary.firstName || secondary.pageId}` : ""),
    );

    return { created: true, xeroContactId, writeBack, ...plan } satisfies Outcome;
  },
);

export default workflow;
