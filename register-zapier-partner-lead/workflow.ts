// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/register-zapier-partner-lead
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
const PARTNER_APP_KEY = "App227952CLIAPI"; // Solution Partner Operations Tool
const PARTNER_CONNECTION = "zapier_partner";

const NOTION_CONNECTION = "notion_wf";
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

// Zapier Tables (free ops, no connection).
// client id -> Notion Company page id, plus the submission log.
const LEAD_TABLE = "01KPZFHX4RP6SER3AEK4YJ62BF";
// Notion user id -> Zapier partner contact id ("User IDs" table).
const USER_ID_TABLE = "01JM3J9SG5X6S8GBSSC8AS28AT";

// Fallback owner when the deal owner has no partner contact id of their own.
// Inferred from the classic Zap's `Components.variables[…]` default, which is
// not readable through the SDK — Dennis is the only plausible value (he owns
// 245 of the 247 leads in the partner tool) and every partner contact id is
// enumerable via `list-action-input-field-choices … partner_contact_id`.
const DEFAULT_PARTNER_CONTACT_ID = "00500000000005d00hE"; // Dennis Chiuten

// Recorded on the partner-side client record so a lead's provenance is visible
// there; the classic Zap left `source` empty.
const LEAD_SOURCE = "Notion CRM";

// Notion's `Size` select vs. the partner tool's `company_size` select. The two
// vocabularies agree except for the top band, which the partner tool spells
// with a thousands separator. An unmapped value is sent as "" (the field is
// optional) rather than guessed at.
const COMPANY_SIZE_MAP: Record<string, string> = {
  "1-49": "1-49",
  "50-249": "50-249",
  "250-999": "250-999",
  "1000+": "1,000+",
};

// Singapore has had no DST since 1982, so a fixed offset is exact — and it
// avoids depending on the durable runtime shipping a full ICU timezone
// database. The service agreement's start date must be Dennis's local day: the
// UTC day rolls over at 08:00 SGT, so a UTC date would back-date every
// agreement registered before 8am.
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

// The Notion DB automation posts `{ data: { id, url, properties }, source: {…} }`
// with properties in full Notion API form. Accept anything and extract
// defensively — an automation payload can arrive with a property omitted.
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

function plainText(rich: any): string {
  return (Array.isArray(rich) ? rich : [])
    .map((t: any) => t?.plain_text ?? "")
    .join("")
    .trim();
}

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

function cleanEmail(v: unknown): string {
  const s = firstString(v);
  return s && EMAIL_RE.test(s) ? s : "";
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Today's calendar date in Asia/Singapore, as `YYYY-MM-DD`. */
function localDate(nowMs: number): string {
  const d = new Date(nowMs + TZ_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * The latest end date the partner tool will accept: it requires the agreement
 * to end **less than** 12 months after it starts, so this is the same calendar
 * date next year minus one day.
 *
 * The classic Zap used `+11 months`, which satisfied the rule with a month to
 * spare and shortened every commission window by that much. Leap years fall out
 * correctly — 2028-02-29 → 2029-02-28 — because the arithmetic is done in UTC
 * milliseconds and Date.UTC normalises the overflow.
 */
function agreementEndDate(startYmd: string): string {
  const [y, m, d] = startYmd.split("-").map(Number);
  const end = new Date(Date.UTC(y + 1, m - 1, d) - 86_400_000);
  return `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}`;
}

/**
 * A Zapier Tables **datetime** column coerces a bare `YYYY-MM-DD` into the
 * account's timezone, storing `…T16:00:00Z` the previous day. Pinning midnight
 * UTC keeps the stored row on the day it actually names. (The three rows the
 * classic Zap wrote all carry the shifted form.)
 */
function tableDate(ymd: string): string {
  return `${ymd}T00:00:00Z`;
}

// --- Company data extracted from the Notion webhook payload ----------------

interface CompanyData {
  pageId: string;
  pageUrl: string;
  companyName: string;
  clientEmail: string;
  firstName: string;
  lastName: string;
  companySize: string;
  /** Notion user id of the Deal Owner, via the `Deal Owner` rollup. */
  dealOwnerUserId: string;
  /** Non-empty when this company has already been registered. */
  existingClientId: string;
  existingStatus: string;
  /** Notion user id of whoever clicked the button. */
  triggeredById: string | null;
}

/** The first `email`-typed entry of a rollup array. */
function rollupEmail(prop: any): string {
  for (const entry of prop?.rollup?.array ?? []) {
    const e = cleanEmail(entry?.email);
    if (e) return e;
  }
  return "";
}

/** The first non-empty `rich_text` entry of a rollup array. */
function rollupText(prop: any): string {
  for (const entry of prop?.rollup?.array ?? []) {
    const t = plainText(entry?.rich_text);
    if (t) return t;
  }
  return "";
}

/** The first person id in a `people`-typed rollup array. */
function rollupPersonId(prop: any): string {
  for (const entry of prop?.rollup?.array ?? []) {
    const id = firstString(entry?.people?.[0]?.id);
    if (id) return id;
  }
  return "";
}

function extractCompanyData(raw: unknown): CompanyData {
  const o = (raw ?? {}) as Record<string, any>;
  // Notion webhook payloads nest the page under `data`; manual/test input may
  // pass the page object directly.
  const data = o.data ?? o;
  const props = data?.properties ?? {};

  const pageId = firstString(data?.id, o.id, o.page_id, o.pageId) ?? "";
  if (!pageId) {
    throw new Error(
      "Could not find a Notion page id in webhook payload: " +
        JSON.stringify(raw).slice(0, 300),
    );
  }

  // An `Account Owner Email Override` beats the rollup: the override exists
  // precisely for companies whose Zapier account owner is not the contact the
  // rollup reaches.
  const clientEmail =
    cleanEmail(props["Account Owner Email Override"]?.email) ||
    rollupEmail(props["Account Owner Email"]);

  return {
    pageId,
    pageUrl: firstString(data?.url) ?? "",
    companyName: plainText(props["Company Name"]?.title),
    clientEmail,
    firstName: rollupText(props["Account Owner First Name"]),
    lastName: rollupText(props["Account Owner Last Name"]),
    companySize:
      COMPANY_SIZE_MAP[firstString(props["Size"]?.select?.name) ?? ""] ?? "",
    dealOwnerUserId: rollupPersonId(props["Deal Owner"]),
    existingClientId: plainText(props["Zapier Client Id"]?.rich_text),
    existingStatus: firstString(props["Zapier Lead Status"]?.select?.name) ?? "",
    // Notion DB automations put the acting user in source.user_id.
    triggeredById: firstString(
      o?.source?.user_id,
      data?.source?.user_id,
      data?.last_edited_by?.id,
    ),
  };
}

/** The submit-blocking fields, named the way a maintainer would say them. */
function missingRequiredFields(company: CompanyData): string[] {
  const missing: string[] = [];
  if (!company.clientEmail) {
    missing.push("an account owner email (Account Owner Email Override, or the Account Owner Email rollup)");
  }
  if (!company.firstName) missing.push("Account Owner First Name");
  if (!company.lastName) missing.push("Account Owner Last Name");
  return missing;
}

// --- Partner-tool response extraction --------------------------------------

interface SubmitResult {
  clientId: string;
  clientName: string;
  clientCompanyName: string;
  clientEmail: string;
  clientFirstName: string;
  clientLastName: string;
  clientCreatedOn: string;
  clientOwnerId: string;
  clientContact: string;
  clientSource: string;
  agreementId: string;
  agreementClient: string;
  agreementCreatedOn: string;
  agreementStartDate: string;
  agreementEndDate: string;
}

function extractSubmitResult(res: any): SubmitResult {
  const row = firstResult(res) ?? {};
  const client = row.client ?? {};
  const agreement = row.service_agreement ?? {};
  return {
    clientId: firstString(client.id) ?? "",
    clientName: firstString(client.name) ?? "",
    clientCompanyName: firstString(client.company_name) ?? "",
    clientEmail: firstString(client.email) ?? "",
    clientFirstName: firstString(client.first_name) ?? "",
    clientLastName: firstString(client.last_name) ?? "",
    clientCreatedOn: firstString(client.created_on) ?? "",
    clientOwnerId: firstString(client.owner_id) ?? "",
    clientContact: firstString(client.contact) ?? "",
    clientSource: firstString(client.source) ?? "",
    agreementId: firstString(agreement.id) ?? "",
    agreementClient: firstString(agreement.client) ?? "",
    agreementCreatedOn: firstString(agreement.created_on) ?? "",
    agreementStartDate: firstString(agreement.start_date) ?? "",
    agreementEndDate: firstString(agreement.end_date) ?? "",
  };
}

/**
 * Whether a `submit_client` failure is worth retrying.
 *
 * A rejected input (bad email, an end date the tool considers 12 months out) is
 * permanent — retrying it just spins the durable's step-retry loop until the run
 * gives up, and nothing ever tells Dennis why. A timeout or a 5xx is transient
 * and should retry. Anything unrecognised is treated as transient, so an
 * unfamiliar outage never gets silently swallowed as "won't work".
 */
function isPermanentSubmitError(message: string): boolean {
  const m = message.toLowerCase();
  if (/\b(429|500|502|503|504)\b/.test(m)) return false;
  if (/timeout|timed out|econnreset|socket hang up|temporarily/.test(m)) {
    return false;
  }
  return /\b(400|401|403|404|409|422)\b/.test(m) || /invalid|required|must be|not allowed|malformed/.test(m);
}

// --- Notion writes ---------------------------------------------------------

// `defineDurable` is overloaded, so deriving the ctx type from its parameters
// (as the older Zaps here do) resolves to the options overload and collapses to
// `never`. The durable package exports the type directly.
type DurableCtx = DurableContext;

/**
 * Patch the company page through the raw Notion API rather than the
 * `NotionCLIAPI` `update_database_item` action.
 *
 * The action addresses properties as `properties|||<name>|||<type>` keys drawn
 * from a **cached** copy of the data source schema, and that cache had not
 * picked up the six `Zapier …` properties added for this migration minutes
 * after they existed. A raw PATCH names properties directly, so it cannot go
 * stale, and it is the same cost (a raw request through a connection is billed
 * like an action — only Zapier Table ops are free).
 */
async function patchCompanyPage(
  ctx: DurableCtx,
  stepName: string,
  pageId: string,
  properties: Record<string, unknown>,
): Promise<void> {
  await ctx.step(stepName, async () => {
    const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
      connection: NOTION_CONNECTION,
      method: "PATCH",
      headers: {
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ properties }),
    });
    if (!res.ok) {
      // Worth retrying: the lead is already registered in the partner tool, so
      // a page that never learns its client id is the broken state.
      throw new Error(
        `Notion page PATCH failed (${res.status}): ${(await res.text()).slice(0, 300)}`,
      );
    }
    return { patched: Object.keys(properties) };
  });
}

/** Post a comment on the company page, mentioning the clicker when known. */
async function addComment(
  ctx: DurableCtx,
  stepName: string,
  company: CompanyData,
  summary: string,
): Promise<void> {
  const richText: any[] = [];
  if (company.triggeredById) {
    richText.push({
      type: "mention",
      mention: { type: "user", user: { id: company.triggeredById } },
    });
    richText.push({ type: "text", text: { content: " " + summary } });
  } else {
    richText.push({ type: "text", text: { content: summary } });
  }

  await ctx.step(stepName, async () => {
    // Best-effort: a missing comment must never fail a run that already
    // registered a lead.
    try {
      const res = await sdk.fetch(`${NOTION_API}/comments`, {
        connection: NOTION_CONNECTION,
        method: "POST",
        headers: {
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          parent: { page_id: company.pageId },
          rich_text: richText,
        }),
      });
      if (!res.ok) {
        console.log(
          `Failed to add comment (${res.status}): ${await res.text()}`,
        );
      }
      return { commented: res.ok };
    } catch (err) {
      console.log(
        `Failed to add comment: ${String((err as Error)?.message ?? err)}`,
      );
      return { commented: false };
    }
  });
}

// --- Workflow --------------------------------------------------------------

const workflow = defineDurable<Record<string, unknown>, unknown>(
  "register-zapier-partner-lead",
  async (ctx, rawInput) => {
    const norm = normalizeInput(rawInput);
    let company = extractCompanyData(norm);

    console.log(
      `Register Zapier lead for ${company.companyName || company.pageId}`,
    );

    // 1. A Notion automation payload can arrive with a rollup omitted or
    //    truncated. Before deciding a company is unregisterable, re-read the
    //    page from the API and extract again — the API always computes rollups.
    if (missingRequiredFields(company).length > 0) {
      const refetched = await ctx.step("refetch-company-page", async () => {
        const res = await sdk.fetch(`${NOTION_API}/pages/${company.pageId}`, {
          connection: NOTION_CONNECTION,
          headers: { "Notion-Version": NOTION_VERSION },
        });
        if (!res.ok) {
          console.log(
            `Could not re-read company page (${res.status}); using webhook payload as-is`,
          );
          return null;
        }
        return (await res.json()) as Record<string, unknown>;
      });
      if (refetched) {
        const fromApi = extractCompanyData(refetched);
        // Keep the clicker from the webhook — a page read cannot know it.
        company = { ...fromApi, triggeredById: company.triggeredById };
      }
    }

    // 2. Already registered? Don't submit again.
    //    The partner tool reuses an existing client record but would open a
    //    second service agreement, and the Table would gain a duplicate row.
    //    The Notion property is the authority; the Table is checked too so a
    //    manually cleared property still can't cause a double submission.
    let alreadyClientId = company.existingClientId;
    if (!alreadyClientId) {
      alreadyClientId = await ctx.step("check-table-for-existing", async () => {
        try {
          const existing = await sdk.listTableRecords({
            table: LEAD_TABLE,
            keyMode: "names",
            filters: [
              {
                fieldKey: "Notion Company Page ID",
                operator: "exact",
                value: company.pageId,
              },
            ],
            pageSize: 1,
          });
          const row = existing.data?.[0]?.data as Record<string, any> | undefined;
          return firstString(row?.["Client Id"]) ?? "";
        } catch (err) {
          // A Table read failure must not block a first-time registration.
          console.log(
            `Lead table lookup failed: ${String((err as Error)?.message ?? err)}`,
          );
          return "";
        }
      });
    }

    if (alreadyClientId) {
      const status = company.existingStatus || "unknown";
      const summary =
        `Already registered as a Zapier partner lead — client \`${alreadyClientId}\`, ` +
        `status ${status}. Nothing re-submitted; a second click would open a ` +
        `duplicate service agreement.`;
      await addComment(ctx, "comment-already-registered", company, summary);
      console.log(`Skipped ${company.pageId}: already registered`);
      return {
        pageId: company.pageId,
        submitted: false,
        skipped: true,
        reason: "already registered",
        clientId: alreadyClientId,
      };
    }

    // 3. Everything the partner tool requires has to be on the record. This is
    //    a permanent condition — say what's missing on the page and stop,
    //    rather than throwing and retrying an input that cannot improve.
    const missing = missingRequiredFields(company);
    if (missing.length > 0) {
      const summary =
        `Zapier lead not registered — the partner tool requires ` +
        `${missing.join(", ")}. Fill ${missing.length > 1 ? "those in" : "that in"} ` +
        `and click Register Lead again.`;
      await addComment(ctx, "comment-missing-fields", company, summary);
      console.log(`Skipped ${company.pageId}: missing ${missing.join(", ")}`);
      return {
        pageId: company.pageId,
        submitted: false,
        skipped: true,
        reason: `missing required fields: ${missing.join(", ")}`,
      };
    }

    // 4. Whose lead is it? The company's Deal Owner, mapped Notion user id ->
    //    partner contact id through the free User IDs table. Rows without a
    //    partner contact id are excluded so the lookup can't return a blank
    //    and shadow the fallback.
    const partnerContactId = await ctx.step("resolve-partner-contact", async () => {
      if (!company.dealOwnerUserId) return DEFAULT_PARTNER_CONTACT_ID;
      try {
        const found = await sdk.listTableRecords({
          table: USER_ID_TABLE,
          keyMode: "names",
          filters: [
            {
              fieldKey: "Notion User ID",
              operator: "exact",
              value: company.dealOwnerUserId,
            },
            { fieldKey: "Zapier Partner Contact ID", operator: "isnull", value: false },
          ],
          pageSize: 1,
        });
        const row = found.data?.[0]?.data as Record<string, any> | undefined;
        return (
          firstString(row?.["Zapier Partner Contact ID"]) ??
          DEFAULT_PARTNER_CONTACT_ID
        );
      } catch (err) {
        console.log(
          `Partner contact lookup failed: ${String((err as Error)?.message ?? err)}`,
        );
        return DEFAULT_PARTNER_CONTACT_ID;
      }
    });

    // 5. The agreement window. `new Date()` is non-deterministic so it has to
    //    be read inside a step; the dates are then fixed for every retry.
    const window = await ctx.step("resolve-agreement-window", async () => {
      const startDate = localDate(Date.now());
      return { startDate, endDate: agreementEndDate(startDate) };
    });

    // 6. Submit. The step catches its own error so a permanent rejection can be
    //    reported on the page instead of spinning the retry loop; a transient
    //    one is rethrown from inside the step, which is what earns a retry.
    const submitted = await ctx.step("submit-client", async () => {
      try {
        const res = await sdk.runAction({
          appKey: PARTNER_APP_KEY,
          actionType: "write",
          actionKey: "submit_client",
          connection: PARTNER_CONNECTION,
          inputs: {
            partner_contact_id: partnerContactId,
            client_email: company.clientEmail,
            company_name: company.companyName,
            first_name: company.firstName,
            last_name: company.lastName,
            company_size: company.companySize,
            source: LEAD_SOURCE,
            submit_as_managed_revenue: true,
            start_date: window.startDate,
            end_date: window.endDate,
          },
        });
        return { ok: true as const, result: extractSubmitResult(res), error: "" };
      } catch (err) {
        const message = String((err as Error)?.message ?? err);
        if (!isPermanentSubmitError(message)) throw err;
        return { ok: false as const, result: null, error: message };
      }
    });

    if (!submitted.ok) {
      const summary =
        `Zapier lead submission was rejected by the partner tool: ` +
        `${submitted.error.slice(0, 400)}`;
      await addComment(ctx, "comment-submit-rejected", company, summary);
      console.log(`Submit rejected for ${company.pageId}: ${submitted.error}`);
      return {
        pageId: company.pageId,
        submitted: false,
        skipped: true,
        reason: `submit rejected: ${submitted.error}`,
      };
    }

    const lead = submitted.result;
    // No client id means no client record, whatever else came back — and every
    // downstream write is keyed on it. Fail loudly rather than log a row that
    // can never be matched to a status change.
    if (!lead.clientId) {
      throw new Error(
        "submit_client returned no client id: " +
          JSON.stringify(lead).slice(0, 300),
      );
    }

    console.log(
      `Submitted ${company.companyName} as client ${lead.clientId}` +
        (lead.agreementId ? ` (agreement ${lead.agreementId})` : ""),
    );

    // 7. Index the client id -> Notion page id mapping. This is what the
    //    status-change workflow resolves against, so it is written before the
    //    Notion patch: a lost Table row is the failure that leaves a status
    //    change unable to find its company.
    //
    //    `Success` is computed here rather than read off the response. The
    //    classic Zap mapped it from a `success` field the response does not
    //    carry, so all three rows it wrote say `false` despite having a service
    //    agreement id. `Status` is likewise set explicitly: the response has no
    //    status field either, which is why that column was null on every row.
    await ctx.step("index-lead-in-table", async () => {
      await sdk.createTableRecords({
        table: LEAD_TABLE,
        keyMode: "names",
        records: [
          {
            data: {
              "Notion Company Page ID": company.pageId,
              "Client Id": lead.clientId,
              "Client Company Name": lead.clientCompanyName,
              "Client Company Size": company.companySize,
              "Client Created On": lead.clientCreatedOn,
              "Client Email": lead.clientEmail,
              "Client First Name": lead.clientFirstName,
              "Client Last Name": lead.clientLastName,
              "Client Name": lead.clientName,
              "Client Owner Id": lead.clientOwnerId,
              "Client Contact": lead.clientContact,
              "Client Source": lead.clientSource || LEAD_SOURCE,
              "Service Agreement Id": lead.agreementId,
              "Service Agreement Client": lead.agreementClient,
              "Service Agreement Created On": lead.agreementCreatedOn,
              "Service Agreement Start Date": tableDate(window.startDate),
              "Service Agreement End Date": tableDate(window.endDate),
              Success: Boolean(lead.clientId),
              Status: "Submitted",
            },
          },
        ],
      });
      return { indexed: lead.clientId };
    });

    // 8. Stamp the company record. The classic Zap wrote nothing here, so a
    //    company had no client id — and no sign the click had worked — until a
    //    status change happened to arrive later.
    await patchCompanyPage(ctx, "stamp-company-page", company.pageId, {
      "Zapier Client Id": {
        rich_text: [{ type: "text", text: { content: lead.clientId } }],
      },
      "Zapier Lead Status": { select: { name: "Submitted" } },
    });

    // 9. Say so on the page.
    const summary =
      `Submitted to the Zapier partner program as client \`${lead.clientId}\`` +
      (lead.agreementId ? ` (service agreement \`${lead.agreementId}\`)` : "") +
      `, owned by partner contact \`${partnerContactId}\`, ` +
      `${window.startDate} → ${window.endDate}. ` +
      `The lead status will update itself as Zapier reviews it.`;
    await addComment(ctx, "comment-submitted", company, summary);

    return {
      pageId: company.pageId,
      submitted: true,
      clientId: lead.clientId,
      agreementId: lead.agreementId,
      partnerContactId,
      startDate: window.startDate,
      endDate: window.endDate,
    };
  },
);

export default workflow;
