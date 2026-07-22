import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
const NOTION_APP_KEY = "NotionCLIAPI";
const NOTION_CONNECTION = "notion_wf";
const ENRICHMENT_APP_KEY = "App243984CLIAPI";
const ENRICHMENT_CONNECTION = "enrichment";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

// Contacts data source (same as the original Zap).
const CONTACTS_DS = "21991b07-11ac-81a6-a894-000be4a09a67";

// The webhook payload shape varies (Notion DB automation → Zapier webhook),
// so accept anything and extract defensively.
const InputSchema = z.unknown();

// --- Pure helpers ----------------------------------------------------------

function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline can deliver input double-encoded (a JSON string of a
  // JSON string), while run-durable delivers it single-encoded. Parse until we
  // reach a non-string, or stop on a bare page id string / parse failure.
  let v: unknown = rawInput;
  for (let i = 0; i < 4 && typeof v === "string"; i++) {
    const t = v.trim();
    if (t[0] !== "{"" && t[0] !== "[" && t[0] !== '"') break;
    try {
      v = JSON.parse(t);
    } catch {
      break;
    }
  }
  return v;
}

/** First item of a runAction result ({ data: [...] } or a bare array). */
function firstResult(res: any): any {
  if (res && Array.isArray(res.data)) return res.data[0] ?? null;
  if (Array.isArray(res)) return res[0] ?? null;
  return res ?? null;
}

function plainText(rich: any): string {
  return (Array.isArray(rich) ? rich : []).map((t: any) => t?.plain_text ?? "").join("");
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

// --- Contact data extracted from the Notion webhook payload ---------------

interface ContactData {
  pageId: string;
  firstName: string;
  lastName: string;
  primaryEmail: string;
  domain: string;
  linkedinUrl: string;
  secondaryEmails: string[];
  primaryPhone: string;
}

function extractContactData(raw: unknown): ContactData {
  const o = (raw ?? {}) as Record<string, any>;
  // Notion webhook payloads nest the page under `data`; manual/test input
  // may pass the page object directly.
  const data = o.data ?? o;
  const props = data?.properties ?? {};

  const pageId = firstString(data?.id, o.id, o.page_id, o.pageId) ?? "";
  if (!pageId) {
    throw new Error(
      "Could not find a Notion page id in webhook payload: " +
        JSON.stringify(raw).slice(0, 300),
    );
  }

  // Domain is a rollup of URL fields on the linked Company page.
  const domainRollup = props["Domain"]?.rollup?.array ?? [];
  const domain = domainRollup
    .map((r: any) => r?.url)
    .filter(Boolean)
    .join("");

  return {
    pageId,
    firstName: plainText(props["First Name"]?.rich_text).trim(),
    lastName: plainText(props["Last Name"]?.rich_text).trim(),
    primaryEmail: props["Primary Email"]?.email ?? "",
    domain,
    linkedinUrl: props["Linkedin"]?.url ?? "",
    secondaryEmails: (props["Secondary Email"]?.multi_select ?? [])
      .map((s: any) => s?.name)
      .filter(Boolean),
    primaryPhone: props["Primary Phone"]?.phone_number ?? "",
  };
}

// --- Enrichment result extraction ------------------------------------------

interface EnrichedData {
  profilePicUrl: string;
  linkedinUrl: string;
  country: string;
  city: string;
  newEmail: string;
  bio: string;
  jobTitle: string;
  firstName: string;
  lastName: string;
}

function extractEnriched(enriched: any): EnrichedData {
  // work_experience is an array of objects with description fields; join them.
  const we = enriched?.work_experience;
  const bio = Array.isArray(we)
    ? we.map((w: any) => w?.description ?? "").filter(Boolean).join("\n\n")
    : typeof we === "string"
      ? we
      : (we?.description ?? "");

  return {
    profilePicUrl: firstString(enriched?.profile_pic_url) ?? "",
    linkedinUrl: firstString(enriched?.linkedin_profile_url) ?? "",
    country: firstString(enriched?.country_name) ?? "",
    city: firstString(enriched?.city_name) ?? "",
    newEmail: firstString(enriched?.work_email_lookup) ?? "",
    bio,
    jobTitle: firstString(enriched?.current_role) ?? "",
    firstName: firstString(enriched?.first_name) ?? "",
    lastName: firstString(enriched?.last_name) ?? "",
  };
}

// --- Inline sub-zap: update contact record ---------------------------------
//
// Replaces the "[Sub-Zap] Update Contact Record" Zap. The original sub-zap
// branched into four paths:
//   Path D "Same or No Prior Email" — set primary email to enriched email
//   Path G "New Email"            — keep existing primary, add new to secondary
//   Path C "Update Page Icon"      — set page icon + cover to profile pic
//   Path E "Exit"                  — return
//
// In the Durable these collapse to sequential if/else blocks.

async function updateContactRecord(
  ctx: Parameters<Parameters<typeof defineDurable<unknown, unknown>>[1]>[0],
  contact: ContactData,
  enriched: EnrichedData,
): Promise<{ emailPath: string; iconUpdated: boolean }> {
  const fullName = `${enriched.firstName || contact.firstName} ${enriched.lastName || contact.lastName}`.trim();
  const now = new Date().toISOString();

  // --- Determine email path (mirrors the sub-zap's Path D / Path G logic) ---
  const hasNewEmail = Boolean(enriched.newEmail);
  const hasExistingEmail = Boolean(contact.primaryEmail);
  const sameEmail =
    hasNewEmail && hasExistingEmail && contact.primaryEmail === enriched.newEmail;
  const noPriorEmail = !hasExistingEmail;
  const differentEmail = hasNewEmail && hasExistingEmail && !sameEmail;

  // Base property updates applied in all paths.
  const updateInputs: Record<string, unknown> = {
    datasource: CONTACTS_DS,
    page: contact.pageId,
    "properties|||Name|||title": fullName,
    "properties|||Linkedin|||url": enriched.linkedinUrl,
    "properties|||Job Title|||rich_text": enriched.jobTitle,
    "properties|||Primary Phone|||phone_number": "",
    "properties|||First Name|||rich_text":
      enriched.firstName || contact.firstName,
    "properties|||Last Name|||rich_text":
      enriched.lastName || contact.lastName,
    "properties|||Bio|||rich_text": enriched.bio,
    "properties|||Country|||select": enriched.country,
    "properties|||City|||select": enriched.city,
    "properties|||Twitter|||url": "",
    use_zapier_datetime_fields: true,
    "properties|||Last Enriched|||date__start": now,
  };

  let emailPath: string;

  if (sameEmail || noPriorEmail) {
    // Path D: set primary email to the enriched email; leave secondary untouched.
    emailPath = "same-or-no-prior";
    updateInputs["properties|||Primary Email|||email"] = enriched.newEmail;
  } else if (differentEmail) {
    // Path G: keep existing primary email (pass empty = no change),
    // add the new email to the secondary email multi-select.
    emailPath = "new-email";
    updateInputs["properties|||Primary Email|||email"] = "";
    updateInputs["properties|||Secondary Email|||multi_select"] = [
      ...contact.secondaryEmails,
      enriched.newEmail,
    ];
  } else {
    // No new email from enrichment; just update the other fields.
    emailPath = "no-new-email";
  }

  // --- Update the Notion contact record ---
  await ctx.step("update-contact-record", async () =>
    sdk.runAction({
      appKey: NOTION_APP_KEY,
      actionType: "write",
      actionKey: "update_database_item",
      connection: NOTION_CONNECTION,
      inputs: updateInputs,
    }),
  );

  // --- Update page icon + cover if a profile pic was found (Path C) ---
  let iconUpdated = false;
  if (enriched.profilePicUrl) {
    await ctx.step("update-page-icon", async () => {
      const res = await sdk.fetch(`${NOTION_API}/pages/${contact.pageId}`, {
        connection: NOTION_CONNECTION,
        method: "PATCH",
        headers: {
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          icon: {
            type: "external",
            external: { url: enriched.profilePicUrl },
          },
          cover: {
            type: "external",
            external: { url: enriched.profilePicUrl },
          },
        }),
      });
      if (!res.ok) {
        throw new Error(
          `Notion icon update failed (${res.status}): ${await res.text()}`,
        );
      }
      return { ok: true };
    });
    iconUpdated = true;
  }

  return { emailPath, iconUpdated };
}

// --- Workflow --------------------------------------------------------------

const workflow = defineDurable<unknown, unknown>(
  "enrich-contact-records",
  async (ctx, rawInput) => {
    const norm = normalizeInput(rawInput);
    const contact = extractContactData(norm);

    console.log(
      `Enriching contact ${contact.pageId}: ${contact.firstName} ${contact.lastName}`.trim(),
    );

    // 1. Call the person-enrichment search.
    //    The original Zap retried on error after a 1-minute delay; per Dennis's
    //    decision, we log and skip instead.
    let enriched: any = null;
    let enrichmentError: string | null = null;

    try {
      const result = await ctx.step("find-person-profile", async () =>
        sdk.runAction({
          appKey: ENRICHMENT_APP_KEY,
          actionType: "search",
          actionKey: "find_person_profile",
          connection: ENRICHMENT_CONNECTION,
          inputs: {
            work_email: contact.primaryEmail,
            first_name: contact.firstName,
            last_name: contact.lastName,
            employer_website: contact.domain,
            linkedin_profile_url: contact.linkedinUrl,
          },
        }),
      );
      enriched = firstResult(result);
    } catch (err) {
      enrichmentError = String((err as Error)?.message ?? err);
      console.log(`Enrichment failed for ${contact.pageId}: ${enrichmentError}`);
    }

    if (!enriched) {
      return {
        pageId: contact.pageId,
        enriched: false,
        reason: enrichmentError
          ? `enrichment error: ${enrichmentError}`
          : "no result from enrichment",
      };
    }

    // 2. Update the contact record (inline sub-zap logic).
    const enrichedData = extractEnriched(enriched);
    const updateResult = await updateContactRecord(ctx, contact, enrichedData);

    return {
      pageId: contact.pageId,
      enriched: true,
      ...updateResult,
    };
  },
);

export default workflow;
