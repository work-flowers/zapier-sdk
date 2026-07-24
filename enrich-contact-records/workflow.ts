// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/enrich-contact-records
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
const NOTION_APP_KEY = "NotionCLIAPI";
const NOTION_CONNECTION = "notion_wf";
// Enrichment fallback: NinjaPear (unofficial Zapier app).
const ENRICHMENT_APP_KEY = "App243984CLIAPI";
const ENRICHMENT_CONNECTION = "enrichment";
// Primary enrichment: Apollo.io people/match. Called through Apollo's native
// "API Request (Beta)" action (_zap_raw_request), which makes an authenticated
// raw HTTP request that includes the integration's own auth headers — a plain
// sdk.fetch through the connection does NOT get those headers and Apollo
// rejects it with 401. Falls back to NinjaPear when Apollo errors, has no
// credits, or returns no usable match.
const APOLLO_APP_KEY = "ApolloCLIAPI";
const APOLLO_CONNECTION = "apollo";
const APOLLO_RAW_REQUEST_ACTION = "_zap_raw_request";
const APOLLO_MATCH_URL = "https://api.apollo.io/api/v1/people/match";

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
  // clicking a button on the page). Notion DB automations put the acting
  // user in source.user_id; page-level created_by/last_edited_by can be a
  // bot (e.g. the automation that created the page), so they come last.
  const triggeredById = firstString(
    o?.source?.user_id,
    data?.source?.user_id,
    data?.triggered_by?.id,
    data?.triggered_by,
    o?.triggered_by?.id,
    o?.triggered_by,
    data?.last_edited_by?.id,
    data?.created_by?.id,
    data?.user_id,
    data?.userId,
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

function extractEnrichedFromNinjaPear(enriched: any): EnrichedData {
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

/** Apollo returns a placeholder like `email_not_unlocked@domain.com` when the
 *  email is locked behind credits; treat those as "no email". */
function apolloRealEmail(email: unknown): string {
  const e = firstString(email);
  if (!e || /email_not_unlocked/i.test(e)) return "";
  return e;
}

/** True when Apollo's `person` object carries at least one useful signal.
 *  A bare/empty match means Apollo effectively found nothing → fall back. */
function apolloPersonUsable(person: any): boolean {
  if (!person || typeof person !== "object") return false;
  return Boolean(
    person.first_name ||
      person.last_name ||
      person.name ||
      person.linkedin_url ||
      person.title ||
      person.photo_url ||
      apolloRealEmail(person.email),
  );
}

function extractEnrichedFromApollo(person: any): EnrichedData {
  // employment_history entries carry per-role descriptions; join them into a
  // bio. Fall back to the person-level headline when no descriptions exist.
  const employment = Array.isArray(person?.employment_history)
    ? person.employment_history
    : [];
  const descriptions = employment
    .map((e: any) => e?.description)
    .filter((d: unknown): d is string => typeof d === "string" && d.trim() !== "");
  const bio = descriptions.length
    ? descriptions.join("\n\n")
    : (firstString(person?.headline) ?? "");

  return {
    profilePicUrl: firstString(person?.photo_url) ?? "",
    linkedinUrl: firstString(person?.linkedin_url) ?? "",
    country: firstString(person?.country) ?? "",
    city: firstString(person?.city) ?? "",
    newEmail: apolloRealEmail(person?.email),
    bio,
    jobTitle: firstString(person?.title) ?? "",
    firstName: firstString(person?.first_name) ?? "",
    lastName: firstString(person?.last_name) ?? "",
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
  /** Which enrichment source produced the data, when enriched. */
  source?: "apollo" | "ninjapear";
  /** Why the primary (Apollo) attempt failed, if it did — surfaced in the
   *  outcome comment so a maintainer can see why NinjaPear was used. */
  apolloError?: string;
  reason?: string;
  emailPath?: string;
  iconUpdated?: boolean;
}

/** Trim an internal Apollo failure reason down to a short, human-readable
 *  phrase for the outcome comment (e.g. "HTTP 401 — Invalid API key…"). */
function briefReason(why: string): string {
  let s = why
    .replace(/^apollo\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/^http\s+(\d+):\s*/i, "HTTP $1 — ");
  s = s.replace(/^error:\s*/i, "");
  return s.length > 160 ? s.slice(0, 159).trimEnd() + "…" : s;
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
    const via =
      result.source === "apollo"
        ? "Apollo"
        : result.source === "ninjapear"
          ? "NinjaPear"
          : "enrichment";
    summary = `Contact enriched via ${via} and updated: ${changes.join(", ")}.`;
    // When the fallback (NinjaPear) did the work, note why Apollo was skipped.
    if (result.source === "ninjapear" && result.apolloError) {
      summary += ` (Apollo unavailable: ${briefReason(result.apolloError)})`;
    }
  } else {
    summary = `Enrichment skipped: ${briefReason(result.reason ?? "no data found")}.`;
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

    // 1. Enrich the contact. Apollo.io (people/match) is the primary source;
    //    NinjaPear is the fallback. Each source runs inside a step that catches
    //    its own errors and returns a value instead of throwing — so a failing
    //    source does NOT trigger the durable's step-retry loop (which would
    //    stall every run on Apollo's free tier) and we fall through cleanly.
    let enrichedData: EnrichedData | null = null;
    let source: "apollo" | "ninjapear" | null = null;
    let apolloFailure: string | null = null;
    const reasons: string[] = [];

    // --- Primary: Apollo people/match, via the "API Request (Beta)" action.
    //     fail_on_errors:false makes the action return the response (with its
    //     status) instead of throwing on a non-2xx, so a locked/credit-less
    //     Apollo response falls through to NinjaPear without retries.
    const apollo = await ctx.step("apollo-match", async () => {
      try {
        const res = await sdk.runAction({
          appKey: APOLLO_APP_KEY,
          actionType: "write",
          actionKey: APOLLO_RAW_REQUEST_ACTION,
          connection: APOLLO_CONNECTION,
          inputs: {
            method: "POST",
            url: APOLLO_MATCH_URL,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-cache",
            },
            body: JSON.stringify({
              first_name: contact.firstName,
              last_name: contact.lastName,
              email: contact.primaryEmail,
              domain: contact.domain,
              linkedin_url: contact.linkedinUrl,
              // Keep credit spend minimal; we don't consume Apollo's phone data
              // and personal emails aren't wanted here.
              reveal_personal_emails: false,
              reveal_phone_number: false,
            }),
            fail_on_errors: false,
          },
        });
        // The action result wraps the upstream call as { request, response }.
        const response = firstResult(res)?.response ?? {};
        const status =
          typeof response.status === "number" ? response.status : 0;
        let person = response?.data?.person ?? null;
        if (!person && typeof response?.body === "string") {
          try {
            person = JSON.parse(response.body)?.person ?? null;
          } catch {
            /* non-JSON body */
          }
        }
        const ok = status >= 200 && status < 300;
        return {
          ok,
          status,
          person,
          raw: ok ? "" : String(response?.body ?? "").slice(0, 300),
          error: null as string | null,
        };
      } catch (err) {
        return {
          ok: false,
          status: 0,
          person: null as any,
          raw: "",
          error: String((err as Error)?.message ?? err),
        };
      }
    });

    if (apollo.ok && apolloPersonUsable(apollo.person)) {
      enrichedData = extractEnrichedFromApollo(apollo.person);
      source = "apollo";
      console.log(`Apollo enriched ${contact.pageId}`);
    } else {
      const why = apollo.error
        ? `apollo error: ${apollo.error}`
        : !apollo.ok
          ? `apollo http ${apollo.status}: ${apollo.raw}`.trim()
          : "apollo returned no usable match";
      apolloFailure = why;
      reasons.push(why);
      console.log(
        `Apollo enrichment unavailable for ${contact.pageId} (${why}); falling back to NinjaPear`,
      );

      // --- Fallback: NinjaPear find_person_profile.
      const ninja = await ctx.step("find-person-profile", async () => {
        try {
          const result = await sdk.runAction({
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
          });
          return { result: firstResult(result), error: null as string | null };
        } catch (err) {
          return {
            result: null,
            error: String((err as Error)?.message ?? err),
          };
        }
      });

      if (ninja.result) {
        enrichedData = extractEnrichedFromNinjaPear(ninja.result);
        source = "ninjapear";
        console.log(`NinjaPear enriched ${contact.pageId}`);
      } else {
        reasons.push(
          ninja.error
            ? `ninjapear error: ${ninja.error}`
            : "ninjapear returned no result",
        );
      }
    }

    let result: WorkflowResult;

    if (!enrichedData || !source) {
      result = {
        pageId: contact.pageId,
        enriched: false,
        reason: reasons.join("; ") || "no result from enrichment",
      };
    } else {
      // 2. Update the contact record (inline sub-zap logic).
      const updateResult = await updateContactRecord(ctx, contact, enrichedData);
      result = {
        pageId: contact.pageId,
        enriched: true,
        source,
        apolloError: apolloFailure ?? undefined,
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
