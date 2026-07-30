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

// Zapier Table indexing email -> Notion Contact page id (free ops, no
// connection). The Luma guest workflows resolve contacts through this Table;
// any email that exists on a contact but not in the Table produces a duplicate
// contact when that person registers with it (seen with a secondary email,
// 2026-07-24). Every email this workflow adds to a contact must be indexed.
const CONTACT_EMAIL_TABLE = "01JYEPSEARXB2Z6BJRCMFGXBC2";

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

/**
 * Two email addresses are the same address, compared the way a mail server
 * would rather than the way `===` does.
 *
 * Enrichment sources return whatever case the upstream record happens to hold,
 * so "Zoe@automatico.com" and "zoe@automatico.com" arrive as different strings.
 * Comparing them exactly is what made this workflow treat a contact's own
 * Primary as a newly discovered address and file it under Secondary — nine
 * contacts ended up listing their Primary twice (cleaned up 2026-07-27).
 */
function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The list with blanks dropped and each address kept once, first occurrence
 *  winning and case ignored (see `sameAddress`). */
function dedupeAddresses(addresses: string[]): string[] {
  return addresses.filter(
    (e, i, all) =>
      e.trim() !== "" && all.findIndex((x) => sameAddress(x, e)) === i,
  );
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

  const primaryEmail = props["Primary Email"]?.email ?? "";

  // Domain is a rollup of URL fields on the linked Company page. Take the first
  // entry that is a real corporate host rather than joining them: the rollup
  // can carry several URLs, and consumer domains sneak in from loosely-linked
  // companies, so concatenation produced strings like
  // "https://hotmail.compangolin.net" that match nothing anywhere.
  const domainRollup = props["Domain"]?.rollup?.array ?? [];
  const rollupDomains: string[] = domainRollup
    .map((r: any) => normalizeDomain(r?.url))
    .filter((d: string) => d !== "" && !isFreemail(`x@${d}`));

  // A NinjaPear lookup only ever resolves on employer_website + a name —
  // neither a work email nor a LinkedIn profile URL matches on its own
  // (verified 2026-07-28; see "Why the NinjaPear fallback misses" in the
  // README). That makes the domain the load-bearing identifier, so when the
  // Company relation is missing or unusable, fall back to the Primary Email's
  // own host: for any non-consumer address that IS the employer's domain.
  const domain =
    rollupDomains[0] ??
    (isFreemail(primaryEmail)
      ? ""
      : normalizeDomain(primaryEmail.slice(primaryEmail.lastIndexOf("@") + 1)));

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

  // Auto-created contacts (e.g. from an event registration) often carry the
  // person's name only in the page title — the First/Last Name rich_text
  // properties arrive empty. Fall back to splitting the title so the
  // enrichment sources get a name to match on. A title that is just an email
  // address (the placeholder for a contact created from a bare registration)
  // is not a name.
  let firstName = plainText(props["First Name"]?.rich_text).trim();
  let lastName = plainText(props["Last Name"]?.rich_text).trim();
  if (!firstName && !lastName) {
    const title = plainText(props["Name"]?.title).trim();
    if (title && !title.includes("@")) {
      const parts = title.split(/\s+/);
      firstName = parts[0] ?? "";
      lastName = parts.slice(1).join(" ");
    }
  }

  return {
    pageId,
    firstName,
    lastName,
    primaryEmail,
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

// --- Freemail detection -----------------------------------------------------
//
// Used to decide whether an enriched work address should take the `Primary
// Email` slot. A consumer mailbox in Primary is a signup artefact — the person
// filled in a form with their personal address — so a corporate address found
// by enrichment is the better Primary. A Primary that is ALREADY on a corporate
// domain is treated as curated and left alone, because the enriched address is
// only a guess. See "Email paths" in the README.

/** Consumer mailbox domains, matched exactly. */
const FREEMAIL_EXACT = new Set([
  "gmail.com", "googlemail.com", "icloud.com", "me.com", "mac.com",
  "aol.com", "msn.com", "ymail.com", "rocketmail.com",
  "protonmail.com", "protonmail.ch", "proton.me", "pm.me",
  "mail.com", "email.com", "usa.com", "zoho.com", "fastmail.com",
  "hey.com", "tutanota.com", "tuta.io", "duck.com", "hushmail.com",
  "qq.com", "foxmail.com", "163.com", "126.com", "sina.com", "sohu.com",
  "naver.com", "daum.net", "hanmail.net", "mail.ru", "bk.ru", "list.ru",
  "web.de", "t-online.de", "orange.fr", "free.fr", "wanadoo.fr",
  "singnet.com.sg", "pacific.net.sg", "starhub.net.sg",
]);

/** Consumer mailbox families with many country TLDs (hotmail.co.uk, yahoo.com.sg…). */
const FREEMAIL_PREFIXES = [
  "hotmail.", "outlook.", "live.", "yahoo.", "gmx.", "yandex.",
  "inbox.", "laposte.", "btinternet.", "sky.", "rediffmail.",
];

/** True for a consumer mailbox address. Unparseable input is NOT freemail —
 *  the caller then falls through to the conservative path. */
function isFreemail(email: string | null | undefined): boolean {
  const at = (email ?? "").lastIndexOf("@");
  if (at < 0) return false;
  const domain = email!.slice(at + 1).trim().toLowerCase();
  if (!domain) return false;
  if (FREEMAIL_EXACT.has(domain)) return true;
  return FREEMAIL_PREFIXES.some((p) => domain.startsWith(p));
}

/** A bare lowercase host from a URL, domain or email host — scheme, `www.`,
 *  port, path and query stripped. Returns "" for anything without a dot, so
 *  junk like "n/a" or a bare company name never reaches an enrichment call. */
function normalizeDomain(value: string | null | undefined): string {
  let v = (value ?? "").trim().toLowerCase();
  if (v === "") return "";
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  v = v.split(/[/?#]/)[0] ?? "";
  v = v.split("@").pop() ?? "";
  v = v.split(":")[0] ?? "";
  v = v.replace(/^www\./, "").replace(/\.$/, "");
  return v.includes(".") ? v : "";
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
// In the Durable these collapse to sequential if/else blocks, plus one path the
// sub-zap never had:
//   Path G-promote — the existing Primary is a CONSUMER mailbox and the enriched
//   address is corporate, so the work address takes Primary and the personal one
//   moves to Secondary. Added 2026-07-26: the original Path G applied to every
//   "different email" case, which left signup-form gmail addresses sitting in
//   Primary with the real work address buried in Secondary (~26 contacts), and
//   contradicted the rule the Luma guest workflows apply to a "Work Email"
//   registration answer. A Primary already on a corporate domain is still
//   treated as curated and never overwritten by an enrichment guess.

async function updateContactRecord(
  ctx: DurableCtx,
  contact: ContactData,
  enriched: EnrichedData,
): Promise<{ emailPath: string; iconUpdated: boolean }> {
  const fullName = `${enriched.firstName || contact.firstName} ${enriched.lastName || contact.lastName}`.trim();

  // --- Determine email path (mirrors the sub-zap's Path D / Path G logic) ---
  const hasNewEmail = Boolean(enriched.newEmail);
  const hasExistingEmail = Boolean(contact.primaryEmail);
  // Case-insensitive: an enriched address that differs from the Primary only by
  // case is the same address, not a new one. See `sameAddress`.
  const sameEmail =
    hasNewEmail &&
    hasExistingEmail &&
    sameAddress(contact.primaryEmail, enriched.newEmail);
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
  } else if (
    differentEmail &&
    isFreemail(contact.primaryEmail) &&
    !isFreemail(enriched.newEmail)
  ) {
    // Path G-promote: the contact's Primary is a consumer mailbox (a signup
    // artefact) and enrichment found a corporate address, so the work address
    // takes Primary and the personal one is kept as a Secondary. This matches
    // the rule the Luma guest workflows apply to a "Work Email" registration
    // answer; before it existed, Path G left the personal address in Primary and
    // buried the work address in Secondary — inverted on ~26 contacts.
    emailPath = "promote-over-freemail";
    updateInputs["properties|||Primary Email|||email"] = enriched.newEmail;
    updateInputs["properties|||Secondary Email|||multi_select"] = dedupeAddresses([
      ...contact.secondaryEmails,
      contact.primaryEmail,
    ]).filter((e) => !sameAddress(e, enriched.newEmail));
  } else if (differentEmail) {
    // Path G: the existing Primary is already on a corporate domain (or the
    // enriched address is itself a consumer mailbox), so treat the Primary as
    // curated — keep it (pass empty = no change) and add the enriched address to
    // the secondary email multi-select. An enriched address is only a guess and
    // must never overwrite a deliberate corporate Primary.
    emailPath = "new-email";
    updateInputs["properties|||Primary Email|||email"] = "";
    // Never let the Primary appear in its own Secondary list, and never list an
    // address twice. The filter also strips a redundant Primary that some
    // earlier run already wrote, so a contact heals itself on next enrichment.
    updateInputs["properties|||Secondary Email|||multi_select"] = dedupeAddresses([
      ...contact.secondaryEmails,
      enriched.newEmail,
    ]).filter((e) => !sameAddress(e, contact.primaryEmail));
  } else {
    // No new email from enrichment; just update the other fields.
    emailPath = "no-new-email";
  }

  // --- Update the Notion contact record ---
  // new Date() is non-deterministic, so the Last Enriched timestamp must be
  // computed inside the step (GUARDED mode forbids it at workflow level).
  // The target page may have been archived (deleted) between the webhook
  // trigger and this step — a race that is not transient, so retrying won't
  // help. Catch the archived error and skip gracefully instead of exhausting
  // the step's retry budget (5 attempts, ~155s) and failing the whole run.
  const updateResult = await ctx.step("update-contact-record", async () => {
    try {
      await sdk.runAction({
        appKey: NOTION_APP_KEY,
        actionType: "write",
        actionKey: "update_database_item",
        connection: NOTION_CONNECTION,
        inputs: {
          ...updateInputs,
          "properties|||Last Enriched|||date__start": new Date().toISOString(),
        },
      });
      return { archived: false };
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (/archived/i.test(msg)) {
        console.log(`Contact page ${contact.pageId} is archived; skipping update.`);
        return { archived: true };
      }
      throw err;
    }
  });

  if (updateResult.archived) {
    return { emailPath: "page-archived", iconUpdated: false };
  }

  // --- Index the enriched email in the email -> page id Table ---
  // Path G adds a Secondary email; Path D can set a first-ever Primary; Path
  // G-promote makes the enriched address the Primary. Either way the address
  // must resolve to this contact in the Table or the Luma guest workflows will
  // create a duplicate contact when that person registers with it. Best-effort
  // upsert-if-missing (Table ops are free).
  //
  // The address Path G-promote DEMOTES needs no row of its own: it was this
  // contact's Primary, so it already resolves here. Its row keeps `Type:
  // "Primary"` and goes stale, which is harmless — lookups match on Email only.
  if (hasNewEmail && emailPath !== "no-new-email") {
    const emailLower = enriched.newEmail!.toLowerCase();
    const emailType = emailPath === "new-email" ? "Secondary" : "Primary";
    await ctx.step("index-email-in-table", async () => {
      try {
        const existing = await sdk.listTableRecords({
          table: CONTACT_EMAIL_TABLE,
          keyMode: "names",
          filters: [{ fieldKey: "Email", operator: "exact", value: emailLower }],
          pageSize: 1,
        });
        if (existing.data?.[0]) return { logged: "exists" as const };
        await sdk.createTableRecords({
          table: CONTACT_EMAIL_TABLE,
          keyMode: "names",
          records: [
            {
              data: {
                Email: emailLower,
                "Page ID": contact.pageId,
                Type: emailType,
                "Trigger Contact Creation": false,
              },
            },
          ],
        });
        return { logged: "created" as const };
      } catch (err) {
        return { logged: "error" as const, error: String((err as Error)?.message ?? err) };
      }
    });
  }

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
  /** Per-source failure notes when nothing enriched, one entry per source
   *  tried (in order). Kept separate so the outcome comment can show each
   *  source's failure on its own — joining them first and truncating after is
   *  what hid "ninjapear returned no result" behind Apollo's verbose
   *  out-of-credits blob and made the fallback look like it never ran
   *  (TKT-811). */
  reasons?: string[];
  emailPath?: string;
  iconUpdated?: boolean;
}

/** A single source's failure reason parsed into a source label ("Apollo",
 *  "NinjaPear", or null) and a short human-readable phrase. Unwraps the JSON
 *  error body and strips the HTML that upstream errors arrive in — Apollo's
 *  out-of-credits body is a JSON blob with an inline <a> tag. */
function parseFailure(why: string): { source: string | null; brief: string } {
  let s = why.replace(/\s+/g, " ").trim();
  let source: string | null = null;
  const src = s.match(/^(apollo|ninjapear)\s+/i);
  if (src) {
    source = src[1].toLowerCase() === "apollo" ? "Apollo" : "NinjaPear";
    s = s.slice(src[0].length);
  }
  s = s.replace(/^error:\s*/i, "");
  const http = s.match(/^http\s+(\d+):\s*(.*)$/i);
  let status = "";
  if (http) {
    status = http[1];
    s = http[2];
  }
  // Prefer the message inside a JSON error body over the raw blob, and drop
  // any markup embedded in it.
  s = s.match(/"error"\s*:\s*"([^"]+)"/i)?.[1] ?? s;
  s = s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  if (/^returned no result$/i.test(s)) s = "no profile found";
  if (/^returned no usable match$/i.test(s)) s = "no usable match";
  if (status) s = s ? `HTTP ${status} — ${s}` : `HTTP ${status}`;
  if (s.length > 140) s = s.slice(0, 139).trimEnd() + "…";
  return { source, brief: s || "unknown error" };
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
      summary += ` (Apollo unavailable: ${parseFailure(result.apolloError).brief})`;
    }
  } else {
    // One clause per source tried, each labelled and trimmed on its own, so
    // that a verbose primary-source error can never hide the fact that the
    // fallback also ran.
    const parts = (
      result.reasons?.length ? result.reasons : [result.reason ?? "no data found"]
    ).map((r) => {
      const { source, brief } = parseFailure(r);
      return source ? `${source}: ${brief}` : brief;
    });
    summary = `Enrichment skipped — ${parts.join("; ")}.`;
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
      // The ONLY input combination that actually resolves a profile is
      // `employer_website` + a name. Verified 2026-07-28 against two profiles
      // NinjaPear demonstrably holds (Megan Anderson, Sachin Kolekar): a lookup
      // by work_email alone, by linkedin_profile_url alone, and by
      // name + linkedin_profile_url each returned an empty result, while
      // name + employer_website matched both times — including for a profile
      // whose own record carries the exact LinkedIn URL we queried with.
      // The action's field docs claim a work email is sufficient; it is not.
      //
      // The LinkedIn URL and the work email are still passed — they cost
      // nothing, may sharpen a match, and may start resolving if NinjaPear
      // fixes it — but neither is treated as a usable identifier on its own.
      // A personal address in `work_email` additionally sinks the whole
      // request (NinjaPear rejects personal-email lookups for data-privacy
      // reasons), so a freemail Primary is stripped from the inputs.
      // isFreemail is list-based, so an unlisted consumer domain still goes
      // through and fails like any other no-match.
      const ninjaEmail = isFreemail(contact.primaryEmail)
        ? ""
        : contact.primaryEmail;
      const ninjaName = contact.firstName || contact.lastName;
      const ninjaViable = Boolean(contact.domain && ninjaName);

      if (!ninjaViable) {
        const why = !contact.domain
          ? isFreemail(contact.primaryEmail)
            ? "skipped — no company domain (a personal email yields none, and email-only lookups do not resolve)"
            : "skipped — no company domain, from the Company relation or the Primary Email"
          : "skipped — no name to pair with the company domain";
        reasons.push(`ninjapear ${why}`);
        console.log(`NinjaPear ${why} for ${contact.pageId}`);
      } else {
        const ninja = await ctx.step("find-person-profile", async () => {
          try {
            const result = await sdk.runAction({
              appKey: ENRICHMENT_APP_KEY,
              actionType: "search",
              actionKey: "find_person_profile",
              connection: ENRICHMENT_CONNECTION,
              inputs: {
                work_email: ninjaEmail,
                first_name: contact.firstName,
                last_name: contact.lastName,
                employer_website: contact.domain,
                linkedin_profile_url: contact.linkedinUrl,
                // `detailed` is needed for work_experience, which is where the
                // company and role come from; `fast` returns before that lands.
                enrichment: "detailed",
                // The action runs in a 30s Lambda, but NinjaPear's default
                // `if-recent` re-scrapes live whenever the cache is over 29
                // days old and a live enrichment takes 30–60s — that is what
                // timed out a run on 2026-07-27. `if-present` serves any cached
                // profile immediately and only goes live for one we have never
                // seen, so the recency re-scrape can no longer blow the budget.
                use_cache: "if-present",
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
    }

    let result: WorkflowResult;

    if (!enrichedData || !source) {
      result = {
        pageId: contact.pageId,
        enriched: false,
        reason: reasons.join("; ") || "no result from enrichment",
        reasons,
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
