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
    if (t[0] !== "{" && t[0] !== "[" && t[0] !== '"') break;
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
  /** Notion user ID of whoever triggered the webhook (e.g. by clicking a
   *  button on the page). Null when the trigger was not a user action. */
  triggeredById: string | null;
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

  // Extract the Notion user ID of whoever triggered the webhook (e.g. by
  // clicking a button on the page). Notion may surface this under several
  // keys depending on the automation type.
  const triggeredById = firstString(
    data?.triggered_by?.id,
    data?.triggered_by,
    data?.created_by?.id,
    data?.last_edited_by?.id,
    data?.user_id,
    data?.userId,
    o?.triggered_by?.id,
    o?.triggered_by,
  );

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
    triggeredById,
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

// --- Durable context type --------------------------------------------------

type DurableCtx = Parameters<Parameters<typeof defineDurable<unknown, unknown>>[1]>[0];

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
  ctx: DurableCtx,
  contact: ContactData,
  enriched: EnrichedData,
): Promise<{ emailPath: string; iconUpdated: boolean }> {
  const fullName = `${enriched.firstName || contact.firstName} ${enriched.lastName || contact.lastName}`.trim();

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
  // new Date() is non-deterministic, so the Last Enriched timestamp must be
  // computed inside the step (GUARDED mode forbids it at workflow level).
  await ctx.step("update-contact-record", async () =>
    sdk.runAction({
      appKey: NOTION_APP_KEY,
      actionType: "write",
      actionKey: "update_database_item",
      connection: NOTION_CONNECTION,
      inputs: {
        ...updateInputs,
        "properties|||Last Enriched|||date__start": new Date().toISOString(),
      },
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

// --- Add outcome comment to the triggering page ----------------------------
//
// After every run (success or skip), posts a brief comment on the Notion
// page that triggered the webhook. If the webhook was triggered by a button
// click and the payload included the user's Notion ID, the comment mentions
// that user for better visibility.

interface WorkflowResult {
  pageId: string;
  enriched: boolean;
  reason?: string;
  emailPath?: string;
  iconUpdated?: boolean;
}

async function addOutcomeComment(
  ctx: DurableCtx,
  contact: ContactData,
  result: WorkflowResult,
): Promise<void> {
  // Build a brief summary of the outcome.
  let summary: string;
  if (result.enriched) {
    const changes: string[] = [];
    if (result.emailPath === "same-or-no-prior") changes.push("primary email");
    if (result.emailPath === "new-email") changes.push("secondary email");
    if (result.iconUpdated) changes.push("profile icon");
    changes.push("contact details");
    summary = `Contact enriched and updated: ${changes.join(", ")}.`;
  } else {
    summary = `Enrichment skipped: ${result.reason ?? "no data found"}.`;
  }

  // Build the rich_text array. If we know who triggered the run, mention
  // them at the start of the comment.
  const richText: any[] = [];

  if (contact.triggeredById) {
    richText.push({
      type: "mention",
      mention: { type: "user", user: { id: contact.triggeredById } },
    });
    richText.push({
      type: "text",
      text: { content: " " + summary },
    });
  } else {
    richText.push({
      type: "text",
      text: { content: summary },
    });
  }

  await ctx.step("add-outcome-comment", async () => {
    try {
      const res = await sdk.fetch(`${NOTION_API}/comments`, {
        connection: NOTION_CONNECTION,
        method: "POST",
        headers: {
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          parent: { page_id: contact.pageId },
          rich_text: richText,
        }),
      });
      if (!res.ok) {
        console.log(
          `Failed to add outcome comment (${res.status}): ${await res.text()}`,
        );
      }
    } catch (err) {
      console.log(
        `Failed to add outcome comment: ${String((err as Error)?.message ?? err)}`,
      );
    }
  });
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

    let result: WorkflowResult;

    if (!enriched) {
      result = {
        pageId: contact.pageId,
        enriched: false,
        reason: enrichmentError
          ? `enrichment error: ${enrichmentError}`
          : "no result from enrichment",
      };
    } else {
      // 2. Update the contact record (inline sub-zap logic).
      const enrichedData = extractEnriched(enriched);
      const updateResult = await updateContactRecord(ctx, contact, enrichedData);
      result = {
        pageId: contact.pageId,
        enriched: true,
        ...updateResult,
      };
    }

    // 3. Add a brief comment to the triggering page stating the outcome.
    //    If the webhook was triggered by a button click and the payload
    //    included a user ID, the comment mentions that user.
    await addOutcomeComment(ctx, contact, result);

    return result;
  },
);

export default workflow;
