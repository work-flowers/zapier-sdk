// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/enrich-contact-records
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
const NOTION_APP_KEY = "NotionCLIAPI";
const NOTION_CONNECTION = "notion_wf";
// Primary enrichment: Apollo.io people/match. Called through Apollo's native
// "API Request (Beta)" action (_zap_raw_request), which makes an authenticated
// raw HTTP request that includes the integration's own auth headers — a plain
// sdk.fetch through the connection does NOT get those headers and Apollo
// rejects it with 401. Preferred over Lusha because it also returns a profile
// photo (page icon/cover) and a bio, which Lusha never provides.
const APOLLO_APP_KEY = "ApolloCLIAPI";
const APOLLO_CONNECTION = "apollo";
const APOLLO_RAW_REQUEST_ACTION = "_zap_raw_request";
const APOLLO_MATCH_URL = "https://api.apollo.io/api/v1/people/match";
// Second source: Lusha Connect. Two-call flow — despite its name,
// `search_and_enrich_contacts` only resolves a Lusha contact id (its output
// carries no email fields at all; verified 2026-08-10 against Megan Anderson
// with reveal set and unset). The id then goes to `enrich_contacts` with
// reveal:["emails"], which returns the work email plus title/location/LinkedIn
// and never spends phone credits — this workflow doesn't consume phone data.
const LUSHA_APP_KEY = "LushaCLIAPI";
const LUSHA_CONNECTION = "lusha";
// Final fallback: NinjaPear (unofficial Zapier app).
const ENRICHMENT_APP_KEY = "App243984CLIAPI";
const ENRICHMENT_CONNECTION = "enrichment";

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

// --- Pure helpers ----------------------------------------------------------

// The webhook payload shape varies (Notion DB automation → Zapier webhook),
// so the workflow accepts anything and extracts defensively.
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

/**
 * True for the empty body a catch URL receives when it is merely touched
 * rather than fired: pasting it into a Notion DB automation and hitting
 * "test", opening it in a browser, or curling it delivers `{"querystring":{}}`
 * or similar. Those are pings, not events — throwing on them turns routine
 * setup into Zapier error alerts. A payload that DOES carry content but no
 * page id is a real event we failed to understand and still throws, loudly.
 * (Reference implementation: xero-contact-from-notion-deal.)
 */
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

/** The cascade order: Apollo first, Lusha second, NinjaPear last. */
type EnrichmentSource = "apollo" | "lusha" | "ninjapear";

const SOURCE_LABELS: Record<EnrichmentSource, string> = {
  apollo: "Apollo",
  lusha: "Lusha",
  ninjapear: "NinjaPear",
};

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
  /** EVERY address the matched record carries, `newEmail` included. Used only
   *  to corroborate identity (see `corroborateEnrichedIdentity`) — never
   *  written to Notion. An address the contact already holds appearing here is
   *  proof the source found the right person. */
  allEmails: string[];
  /** The employer domain on the matched record, normalised. Corroborating
   *  evidence when it equals the company domain the CRM already holds. */
  employerDomain: string;
}

// --- Placeholder photos ----------------------------------------------------
//
// When a LinkedIn profile has no photo, Apollo does not return `photo_url:
// null` — it returns LinkedIn's generic grey silhouette, verbatim:
//
//   https://static.licdn.com/aero-v1/sc/h/9c8pery4andzj6ohjkjp54ma2
//
// That is a 489-byte SVG on LinkedIn's *static asset* CDN. Real photos live on
// `media.licdn.com/dms/image/…` and arrive as multi-kilobyte JPEGs. Truthiness
// cannot tell them apart, so until 2026-09-03 the silhouette was imported and
// attached as icon and cover exactly like a real photo — 7 of the 43 most
// recent runs did so — displacing the data source's default icon with a
// picture of nobody.
//
// Two guards, because they fail differently:
//   1. `realPhotoUrl` below rejects by host, at extraction, for free. It covers
//      every observed case and never costs an API call.
//   2. `storeProfilePhoto` rejects by content after Notion has imported the
//      file — SVG, or under `MIN_PHOTO_BYTES` — which catches a placeholder
//      whose URL we have not seen (NinjaPear's, or a new LinkedIn one) at the
//      cost of one import. The unattached upload expires on its own.
// An empty `profilePicUrl` then takes the same route as a Lusha result: the
// icon and cover are left alone, so a contact with a real photo keeps it.

/** Hosts that serve site assets, never a user's uploaded photo. */
const PLACEHOLDER_PHOTO_HOSTS = new Set(["static.licdn.com"]);

/** A source's photo URL, or "" when there is none or it is a known placeholder. */
function realPhotoUrl(v: unknown): string {
  const url = firstString(v);
  if (!url) return "";
  const host = url.match(/^https?:\/\/([^/?#]+)/i)?.[1]?.toLowerCase() ?? "";
  if (PLACEHOLDER_PHOTO_HOSTS.has(host)) return "";
  return url;
}

function extractEnrichedFromNinjaPear(enriched: any): EnrichedData {
  // work_experience is an array of objects with description fields; join them.
  const we = enriched?.work_experience;
  const bio = Array.isArray(we)
    ? we.map((w: any) => w?.description ?? "").filter(Boolean).join("\n\n")
    : typeof we === "string"
      ? we
      : (we?.description ?? "");

  const workExperience = Array.isArray(we) ? we : [];

  return {
    profilePicUrl: realPhotoUrl(enriched?.profile_pic_url),
    linkedinUrl: firstString(enriched?.linkedin_profile_url) ?? "",
    country: firstString(enriched?.country_name) ?? "",
    city: firstString(enriched?.city_name) ?? "",
    newEmail: firstString(enriched?.work_email_lookup) ?? "",
    bio,
    jobTitle: firstString(enriched?.current_role) ?? "",
    firstName: firstString(enriched?.first_name) ?? "",
    lastName: firstString(enriched?.last_name) ?? "",
    allEmails: dedupeAddresses(
      [
        firstString(enriched?.work_email_lookup) ?? "",
        firstString(enriched?.personal_email) ?? "",
        ...(Array.isArray(enriched?.personal_emails)
          ? enriched.personal_emails.map((e: unknown) => firstString(e) ?? "")
          : []),
      ].filter(Boolean),
    ),
    employerDomain: normalizeDomain(
      firstString(
        enriched?.employer_website,
        workExperience[0]?.company_website,
        workExperience[0]?.website,
        workExperience[0]?.company?.website,
      ),
    ),
  };
}

// Lusha's `enrich_contacts` output uses the action's labelled field keys —
// literal keys with spaces like "First Name", "Job Title", "Email 1" /
// "Email Type 1" (verified 2026-08-10). The raw Lusha API shapes (camelCase,
// `emailAddresses` array) are checked as fallbacks in case the integration's
// output mapping changes.

/** Every revealed email on a Lusha contact, work addresses first. */
function lushaEmails(c: any): string[] {
  const pairs: Array<{ email: string; type: string }> = [];
  for (let i = 1; i <= 5; i++) {
    const e = firstString(c?.[`Email ${i}`]);
    if (e)
      pairs.push({
        email: e,
        type: (firstString(c?.[`Email Type ${i}`]) ?? "").toLowerCase(),
      });
  }
  if (!pairs.length && Array.isArray(c?.emailAddresses)) {
    for (const ea of c.emailAddresses) {
      const e = firstString(ea?.email);
      if (e)
        pairs.push({
          email: e,
          type: (firstString(ea?.emailType) ?? "").toLowerCase(),
        });
    }
  }
  const work = pairs.filter((p) => p.type === "work");
  const rest = pairs.filter((p) => p.type !== "work");
  return dedupeAddresses([...work, ...rest].map((p) => p.email));
}

/** First revealed email on a Lusha contact, preferring type "work". */
function lushaEmail(c: any): string {
  return lushaEmails(c)[0] ?? "";
}

/** True when a Lusha contact carries at least one useful signal — a bare
 *  match with nothing to write means Lusha effectively found nothing. */
function lushaContactUsable(c: any): boolean {
  if (!c || typeof c !== "object") return false;
  return Boolean(
    firstString(c["First Name"], c.firstName) ||
      firstString(c["Last Name"], c.lastName) ||
      firstString(c["Job Title"], c.jobTitle?.title ?? c.jobTitle) ||
      firstString(c["LinkedIn Profile"], c.linkedinUrl) ||
      lushaEmail(c),
  );
}

function extractEnrichedFromLusha(c: any): EnrichedData {
  return {
    // Lusha returns no profile photo or bio text; empty strings leave the
    // Notion icon and Bio property untouched downstream.
    profilePicUrl: "",
    bio: "",
    linkedinUrl: firstString(c?.["LinkedIn Profile"], c?.linkedinUrl) ?? "",
    country: firstString(c?.["Contact Location Country"], c?.location?.country) ?? "",
    city: firstString(c?.["Contact Location City"], c?.location?.city) ?? "",
    newEmail: lushaEmail(c),
    jobTitle: firstString(c?.["Job Title"], c?.jobTitle?.title ?? c?.jobTitle) ?? "",
    firstName: firstString(c?.["First Name"], c?.firstName) ?? "",
    lastName: firstString(c?.["Last Name"], c?.lastName) ?? "",
    allEmails: lushaEmails(c),
    employerDomain: normalizeDomain(
      firstString(
        c?.["Company Domain"],
        c?.["Company Website"],
        c?.companyDomain,
        c?.company?.domain,
        c?.company?.website,
      ),
    ),
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
      realPhotoUrl(person.photo_url) ||
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
    profilePicUrl: realPhotoUrl(person?.photo_url),
    linkedinUrl: firstString(person?.linkedin_url) ?? "",
    country: firstString(person?.country) ?? "",
    city: firstString(person?.city) ?? "",
    newEmail: apolloRealEmail(person?.email),
    bio,
    jobTitle: firstString(person?.title) ?? "",
    firstName: firstString(person?.first_name) ?? "",
    lastName: firstString(person?.last_name) ?? "",
    allEmails: dedupeAddresses(
      [
        apolloRealEmail(person?.email),
        ...(Array.isArray(person?.personal_emails)
          ? person.personal_emails.map((e: unknown) => apolloRealEmail(e))
          : []),
        ...(Array.isArray(person?.contact_emails)
          ? person.contact_emails.map((e: any) => apolloRealEmail(e?.email))
          : []),
      ].filter(Boolean),
    ),
    employerDomain: normalizeDomain(
      firstString(
        person?.organization?.primary_domain,
        person?.organization?.website_url,
        person?.organization?.domain,
      ),
    ),
  };
}

// --- Identity corroboration -------------------------------------------------
//
// An enriched email address is the one field here that carries IDENTITY. It
// goes into `Primary Email` or `Secondary Email` and from there into
// CONTACT_EMAIL_TABLE, which is how the Luma guest workflows decide *who a
// registration belongs to*. So an address written here does not merely annotate
// a contact — it defines them for every other Zap.
//
// That is what made the Grace Tang collision (diagnosed 2026-08-12) so
// expensive. Apollo's people/match is FUZZY: it is handed name, email, domain
// and LinkedIn URL together and will happily match on the name alone. For a
// long-standing contact whose Primary was a personal Gmail with no Company
// relation, it returned a *different person of the same name*, whose corporate
// address then took the Primary slot (Path G-promote) and was indexed into the
// Table. From then on the stranger's Luma registrations, her account address, a
// company page, 25 email threads and a signed agreement all attached to the
// wrong contact — and nothing errored, because every one of those Zaps was
// correctly trusting the Table.
//
// So before an enriched address is written, the match has to be corroborated
// against something the CRM already knows. The bar differs per source because
// their matching does:
//
//   * Apollo — fuzzy. Requires evidence in the RETURNED record: an address the
//     contact already holds, the contact's LinkedIn URL, or the company domain
//     the CRM already has.
//   * Lusha — exact-identifier search (`id | linkedinUrl | email | firstName +
//     lastName + company`). When the request carried only identifiers the
//     contact OWNS — their email, their LinkedIn URL — and no name branch at
//     all, a hit IS the corroboration. This is the case that legitimately
//     discovers a work address for a contact sitting on a personal mailbox, and
//     the guard deliberately keeps it working.
//   * NinjaPear — only ever resolves on employer_website + name, and the
//     workflow gates the call on the contact's OWN company domain, so any
//     profile it returns is a person at the employer the CRM already recorded.
//
// An uncorroborated address is not written anywhere — not Primary, not
// Secondary, not the Table — and is named in the outcome comment for a human to
// judge. Everything else the source returned (title, bio, city, photo) is still
// written: those are visible on the page and carry no identity downstream, and
// in the Grace case they were in fact correct.
//
// The known false negative: a contact on a personal mailbox with no Company and
// no LinkedIn URL, whom Apollo matched genuinely by that personal address.
// Apollo is called with `reveal_personal_emails: false`, so the address we sent
// usually is not echoed back and the match reads as uncorroborated. That costs
// an enrichment we would previously have taken — visibly, in the comment,
// rather than silently writing a stranger's identity. That trade is the point.

interface IdentityCorroboration {
  verified: boolean;
  /** Which signal cleared it, or why nothing did. For the outcome comment. */
  how: string;
}

function corroborateEnrichedIdentity(
  contact: ContactData,
  enriched: EnrichedData,
  source: EnrichmentSource,
  /** Lusha only: the search carried the contact's own email and/or LinkedIn
   *  URL, and no name + domain branch that could have matched someone else. */
  matchedOwnIdentifierOnly: boolean,
): IdentityCorroboration {
  const ownAddresses = dedupeAddresses([
    contact.primaryEmail,
    ...contact.secondaryEmails,
  ]);

  const shared = enriched.allEmails.find((e) =>
    ownAddresses.some((own) => sameAddress(own, e)),
  );
  if (shared) {
    return { verified: true, how: `matched an address already on the contact (${shared})` };
  }

  const ownLinkedin = normalizeLinkedin(contact.linkedinUrl);
  const foundLinkedin = normalizeLinkedin(enriched.linkedinUrl);
  if (ownLinkedin && foundLinkedin && ownLinkedin === foundLinkedin) {
    return { verified: true, how: "matched the contact's LinkedIn profile" };
  }

  if (contact.domain) {
    const emailDomain = normalizeDomain(enriched.newEmail);
    if (emailDomain === contact.domain || enriched.employerDomain === contact.domain) {
      return {
        verified: true,
        how: `employer matches the contact's company domain (${contact.domain})`,
      };
    }
  }

  if (source === "ninjapear") {
    // The lookup is gated on the contact's own company domain + name, so the
    // profile is a person at the employer the CRM already holds.
    return { verified: true, how: "resolved from the contact's own company domain and name" };
  }

  if (source === "lusha" && matchedOwnIdentifierOnly) {
    return {
      verified: true,
      how: "Lusha matched on the contact's own email or LinkedIn URL",
    };
  }

  return {
    verified: false,
    how: "no shared address, LinkedIn profile or company domain ties it to this contact",
  };
}

/** A LinkedIn profile URL reduced to its identifying slug, so
 *  `https://www.linkedin.com/in/gtang1/` and `linkedin.com/in/gtang1` compare
 *  equal. Returns "" when there is no `/in/<slug>` to compare. */
function normalizeLinkedin(url: string | null | undefined): string {
  const m = (url ?? "").trim().toLowerCase().match(/\/in\/([^/?#]+)/);
  return m?.[1] ?? "";
}

// --- Profile photo storage -------------------------------------------------
//
// Notion renders an `external` icon/cover by re-fetching that URL on every
// view. Apollo hands back LinkedIn's CDN link verbatim, and those links are
// signed and time-limited — `…?e=<unix-expiry>&v=beta&t=<signature>`. A few
// weeks after enrichment the URL starts 403ing and Notion, having stored the
// dead link forever, renders empty white space: the page still *has* an icon
// and cover, they just draw as nothing. Nothing errors, so it goes unnoticed.
// An audit on 2026-08-12 found 210 of 962 contacts already in that state.
//
// Storing the bytes in Notion instead makes it permanent. The PATCH comes back
// as `type: "file"` on Notion's own S3, whose URL Notion re-signs on each read.
// One upload can back both the icon and the cover — verified 2026-08-12 against
// a live contact; the docs don't state it either way.
//
// Notion does the downloading, via `file_uploads` mode `external_url`.
//
// Note this is the OPPOSITE choice to `esignatures-status-to-notion`, which
// files its PDF by downloading the bytes and pushing a `single_part` upload.
// Both are right for their case: `external_url` makes Notion probe the URL
// with `HEAD` first, and the S3 links eSignatures hands out are presigned for
// `GET` alone, so they answer that probe with 403. LinkedIn's CDN answers HEAD
// normally, so the simpler route works here — no download, no hand-built
// multipart body, no content-type matching to get wrong.
//
// The durable cannot casually download the bytes itself either way: a bare
// `fetch` fails for every host — example.com, pbs.twimg.com, media.licdn.com,
// even api.notion.com — and `sdk.fetch` *with a connection* is domain-filtered
// to that connection's own app ("Domain media.licdn.com did not match expected
// domain filter `api.notion.com`"). Both probed against the real runtime on
// 2026-08-12. The escape hatch, if `external_url` ever stops working, is
// `sdk.fetch` with **no connection** — see that Zap's README.

/** How many times to poll an `external_url` import before giving up. Notion
 *  has finished on the first poll in every observed case (~1s); the extra
 *  attempts are headroom, not the expected path. */
const PHOTO_UPLOAD_POLL_ATTEMPTS = 6;

/** Smallest file accepted as a real photo. LinkedIn's silhouette is 489 bytes;
 *  the smallest genuine 200×200 JPEG in the run history is about 7.8 KB. */
const MIN_PHOTO_BYTES = 1024;

/** Thrown by `storeProfilePhoto` when the imported file is a placeholder, not
 *  a photo (see "Placeholder photos"). Distinct from a failed import so Path C
 *  can skip quietly instead of reporting a storage failure that never was. */
class PlaceholderPhotoError extends Error {
  constructor(detail: string) {
    super(`placeholder image (${detail})`);
    this.name = "PlaceholderPhotoError";
  }
}

/** A filename for the stored photo. `external_url` mode *requires* one (a
 *  create without it is rejected `400 validation_error`), but the photo URLs
 *  Apollo and NinjaPear hand back are LinkedIn CDN links with no extension in
 *  the path, so the extension is taken from the path when there is one and
 *  falls back to `.jpg`, which is what LinkedIn serves. The stored file's real
 *  content type comes from the response Notion fetches, not from this name. */
function photoFilename(photoUrl: string): string {
  const path = photoUrl.split("?")[0];
  const ext = path.match(/\.(jpe?g|png|webp|gif)$/i)?.[1];
  return `profile-photo.${ext ? ext.toLowerCase() : "jpg"}`;
}

/** Hand `photoUrl` to Notion to fetch and store, returning the file upload id
 *  to attach as icon/cover. Throws on any failure — `PlaceholderPhotoError`
 *  when the file Notion fetched is a silhouette rather than a photo — and the
 *  caller catches inside its own step so a dead photo URL never spins the
 *  step-retry loop or sinks an otherwise good enrichment.
 *
 *  MUST be called from inside a `ctx.step` — it makes network calls. */
async function storeProfilePhoto(photoUrl: string): Promise<string> {
  const createRes = await sdk.fetch(`${NOTION_API}/file_uploads`, {
    connection: NOTION_CONNECTION,
    method: "POST",
    headers: {
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mode: "external_url",
      external_url: photoUrl,
      filename: photoFilename(photoUrl),
    }),
  });
  if (!createRes.ok) {
    throw new Error(
      `file_upload create failed (${createRes.status}): ${await createRes.text()}`,
    );
  }
  const created = await createRes.json();
  const uploadId = firstString(created?.id);
  if (!uploadId) throw new Error("file_upload create returned no id");

  // The import is asynchronous — `pending` until Notion has pulled the bytes.
  let upload: any = created;
  let status = firstString(upload?.status) ?? "pending";
  for (let i = 0; i < PHOTO_UPLOAD_POLL_ATTEMPTS && status === "pending"; i++) {
    const pollRes = await sdk.fetch(`${NOTION_API}/file_uploads/${uploadId}`, {
      connection: NOTION_CONNECTION,
      method: "GET",
      headers: { "Notion-Version": NOTION_VERSION },
    });
    if (!pollRes.ok) {
      throw new Error(
        `file_upload poll failed (${pollRes.status}): ${await pollRes.text()}`,
      );
    }
    upload = await pollRes.json();
    status = firstString(upload?.status) ?? "pending";
  }

  if (status !== "uploaded") {
    // `failed` means Notion could not fetch the URL — an already-expired link,
    // or a host that refuses Notion's fetcher. Nothing to retry.
    throw new Error(`Notion could not import the photo (status: ${status})`);
  }

  // Content guard — see "Placeholder photos". `content_type` and
  // `content_length` describe the bytes Notion actually fetched, not the
  // `.jpg` filename invented above, so this judges the real file. No genuine
  // profile photo is an SVG, and none is smaller than a kilobyte.
  const contentType = (firstString(upload?.content_type) ?? "").toLowerCase();
  const contentLength =
    typeof upload?.content_length === "number" ? upload.content_length : null;
  if (contentType.includes("svg")) {
    throw new PlaceholderPhotoError(
      `${contentType}, ${contentLength ?? "?"} bytes`,
    );
  }
  if (contentLength !== null && contentLength < MIN_PHOTO_BYTES) {
    throw new PlaceholderPhotoError(
      `${contentType || "unknown type"}, ${contentLength} bytes`,
    );
  }
  return uploadId;
}

// --- Durable context type --------------------------------------------------

// The runtime's own context type. This used to be derived as
// `Parameters<Parameters<typeof defineDurable<unknown, unknown>>[1]>[0]`, which
// fails to type-check — `defineDurable`'s input generic is constrained to
// `Record<string, unknown>`, so `<unknown, unknown>` is rejected and the alias
// collapsed to `never`, taking every `ctx.step` in the helpers below with it.
// Nothing on the publish path runs `tsc`, so it shipped and ran fine anyway.
type DurableCtx = DurableContext;

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
  source: EnrichmentSource,
  matchedOwnIdentifierOnly: boolean,
): Promise<{
  emailPath: string;
  iconUpdated: boolean;
  iconError?: string;
  unverifiedEmail?: string;
  identity?: string;
}> {
  const fullName = `${enriched.firstName || contact.firstName} ${enriched.lastName || contact.lastName}`.trim();

  // --- Gate the enriched address on identity corroboration ---
  // See "Identity corroboration" above. An address that cannot be tied to this
  // contact is dropped here, before any path logic sees it: the rest of this
  // function then behaves exactly as it does for a source that returned no
  // email at all, so nothing reaches Primary, Secondary or the Table.
  const identity = enriched.newEmail
    ? corroborateEnrichedIdentity(
        contact,
        enriched,
        source,
        matchedOwnIdentifierOnly,
      )
    : { verified: true, how: "no email returned" };
  const unverifiedEmail =
    enriched.newEmail && !identity.verified ? enriched.newEmail : "";
  const newEmail = unverifiedEmail ? "" : enriched.newEmail;

  if (unverifiedEmail) {
    console.log(
      `Enriched email ${unverifiedEmail} not written to ${contact.pageId} — ${identity.how}`,
    );
  }

  // --- Determine email path (mirrors the sub-zap's Path D / Path G logic) ---
  const hasNewEmail = Boolean(newEmail);
  const hasExistingEmail = Boolean(contact.primaryEmail);
  // Case-insensitive: an enriched address that differs from the Primary only by
  // case is the same address, not a new one. See `sameAddress`.
  const sameEmail =
    hasNewEmail &&
    hasExistingEmail &&
    sameAddress(contact.primaryEmail, newEmail);
  const noPriorEmail = hasNewEmail && !hasExistingEmail;
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

  if (unverifiedEmail) {
    // Path U: the source returned an address it cannot corroborate against this
    // contact. Write no email at all — neither slot, and no Table row — and let
    // the outcome comment name the address so a person can judge it. Every other
    // property still updates.
    emailPath = "unverified-email";
  } else if (sameEmail || noPriorEmail) {
    // Path D: set primary email to the enriched email; leave secondary untouched.
    emailPath = "same-or-no-prior";
    updateInputs["properties|||Primary Email|||email"] = newEmail;
  } else if (
    differentEmail &&
    isFreemail(contact.primaryEmail) &&
    !isFreemail(newEmail)
  ) {
    // Path G-promote: the contact's Primary is a consumer mailbox (a signup
    // artefact) and enrichment found a corporate address, so the work address
    // takes Primary and the personal one is kept as a Secondary. This matches
    // the rule the Luma guest workflows apply to a "Work Email" registration
    // answer; before it existed, Path G left the personal address in Primary and
    // buried the work address in Secondary — inverted on ~26 contacts.
    emailPath = "promote-over-freemail";
    updateInputs["properties|||Primary Email|||email"] = newEmail;
    updateInputs["properties|||Secondary Email|||multi_select"] = dedupeAddresses([
      ...contact.secondaryEmails,
      contact.primaryEmail,
    ]).filter((e) => !sameAddress(e, newEmail));
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
      newEmail,
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
  //
  // Path U writes nothing here: `hasNewEmail` is false for an uncorroborated
  // address, and this Table is exactly where such an address does the damage —
  // it is what the Luma guest workflows resolve a registration's identity from.
  if (hasNewEmail && emailPath !== "no-new-email") {
    const emailLower = newEmail.toLowerCase();
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
  //
  // The photo is uploaded to Notion rather than linked. See "Profile photo
  // storage" above: linking the source URL is what left 210 contacts rendering
  // a blank icon and cover once the signed link expired.
  let iconUpdated = false;
  let iconError: string | undefined;
  if (enriched.profilePicUrl) {
    const outcome = await ctx.step("update-page-icon", async () => {
      // The import is caught in here, not outside the step: a photo URL that
      // is already dead or that Notion refuses to fetch is a fact about the
      // source, not a transient failure, so retrying it just burns the retry
      // budget and would eventually fail a run whose email and property
      // updates all succeeded. A Notion PATCH failure below is genuinely worth
      // retrying and is therefore left to throw.
      let uploadId: string;
      try {
        uploadId = await storeProfilePhoto(enriched.profilePicUrl);
      } catch (err) {
        if (err instanceof PlaceholderPhotoError) {
          return {
            ok: false as const,
            placeholder: true as const,
            detail: err.message,
          };
        }
        return {
          ok: false as const,
          error: String((err as Error)?.message ?? err),
        };
      }

      const res = await sdk.fetch(`${NOTION_API}/pages/${contact.pageId}`, {
        connection: NOTION_CONNECTION,
        method: "PATCH",
        headers: {
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          icon: { type: "file_upload", file_upload: { id: uploadId } },
          cover: { type: "file_upload", file_upload: { id: uploadId } },
        }),
      });
      if (!res.ok) {
        throw new Error(
          `Notion icon update failed (${res.status}): ${await res.text()}`,
        );
      }
      return { ok: true as const };
    });

    if (outcome.ok) {
      iconUpdated = true;
    } else if ("placeholder" in outcome) {
      // Not a failure: the source had no photo and said so with a picture of
      // nobody. Logged so the run history shows it was seen; the outcome
      // comment then reads as a photo-less enrichment, same as a Lusha result.
      console.log(
        `Placeholder photo skipped for ${contact.pageId}: ${outcome.detail}`,
      );
    } else {
      // Surfaced in the outcome comment rather than swallowed — a photo that
      // never stored is worth seeing on the page, just not worth failing over.
      iconError = outcome.error;
    }
  }

  return {
    emailPath,
    iconUpdated,
    iconError,
    unverifiedEmail: unverifiedEmail || undefined,
    identity: unverifiedEmail ? identity.how : undefined,
  };
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
  source?: EnrichmentSource;
  reason?: string;
  /** Per-source failure notes, one entry per source that failed (in order).
   *  When enriched via a later source, these say why the earlier sources were
   *  skipped over; when nothing enriched, they cover every source tried.
   *  Kept separate so the outcome comment can show each source's failure on
   *  its own — joining them first and truncating after is what hid "ninjapear
   *  returned no result" behind Apollo's verbose out-of-credits blob and made
   *  the fallback look like it never ran (TKT-811). */
  reasons?: string[];
  emailPath?: string;
  /** An enriched address that was NOT written because it could not be tied to
   *  this contact (Path U). Named in the outcome comment so a person can judge
   *  it — the whole point of the guard is that this is visible, not silent. */
  unverifiedEmail?: string;
  /** Why `unverifiedEmail` failed corroboration. */
  identity?: string;
  iconUpdated?: boolean;
  /** Why the profile photo could not be stored, when one was offered. Kept
   *  distinct from `reasons` — the enrichment itself succeeded. */
  iconError?: string;
  /** Whether the outcome comment reached the page. `false` means Notion
   *  definitively rejected it (see `commentError`); a transient failure is
   *  retried and, if it never clears, fails the run instead of hiding here. */
  commentPosted?: boolean;
  commentError?: string;
}

/** HTTP statuses worth retrying: the request may well succeed a moment later,
 *  and nothing was written. 429 is Notion's rate limit, 409 its
 *  `conflict_error` under concurrent saves, 408 a timeout, 5xx its problem. */
function isTransientStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** A single source's failure reason parsed into a source label ("Lusha",
 *  "Apollo", "NinjaPear", or null) and a short human-readable phrase. Unwraps
 *  the JSON error body and strips the HTML that upstream errors arrive in —
 *  Apollo's out-of-credits body is a JSON blob with an inline <a> tag. */
function parseFailure(why: string): { source: string | null; brief: string } {
  let s = why.replace(/\s+/g, " ").trim();
  let source: string | null = null;
  const src = s.match(/^(lusha|apollo|ninjapear)\s+/i);
  if (src) {
    source = SOURCE_LABELS[src[1].toLowerCase() as EnrichmentSource];
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
  // any markup embedded in it. Apollo keys it `error`, Notion `message`.
  s = s.match(/"error"\s*:\s*"([^"]+)"/i)?.[1] ??
    s.match(/"message"\s*:\s*"([^"]+)"/i)?.[1] ??
    s;
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
): Promise<{ posted: boolean; error?: string }> {
  // Build a brief summary of the outcome.
  let summary: string;
  if (result.enriched) {
    const changes: string[] = [];
    if (result.emailPath === "same-or-no-prior") changes.push("primary email");
    if (result.emailPath === "new-email") changes.push("secondary email");
    if (result.iconUpdated) changes.push("profile icon");
    changes.push("contact details");
    const via = result.source ? SOURCE_LABELS[result.source] : "enrichment";
    summary = `Contact enriched via ${via} and updated: ${changes.join(", ")}.`;
    // An address the source returned but that could not be tied to this contact
    // (Path U). Worth naming prominently: it is either a real address this
    // contact owns and nobody has recorded, or evidence the source matched a
    // different person of the same name. Only a human can tell which.
    if (result.unverifiedEmail) {
      summary += ` Email ${result.unverifiedEmail} NOT written — ${result.identity ?? "could not be corroborated"}. Add it by hand if it is really theirs.`;
    }
    // A photo that failed to store is worth naming: the rest of the record is
    // correct, so nothing else in this comment would hint the icon is missing.
    if (result.iconError) {
      summary += ` Profile photo not stored: ${parseFailure(result.iconError).brief}.`;
    }
    // When a fallback did the work, note why each earlier source was skipped
    // over — one labelled clause per source, same as the skip branch.
    if (result.reasons?.length) {
      const skipped = result.reasons.map((r) => {
        const { source, brief } = parseFailure(r);
        return source ? `${source}: ${brief}` : brief;
      });
      summary += ` (${skipped.join("; ")})`;
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

  // Post it. This is the LAST Notion call of every run, so when several runs
  // fire at once — the Contacts automation enriches new pages in batches of
  // four or five — it is the call most exposed to Notion's transient answers:
  // 429 rate_limited, 409 conflict_error, the odd 5xx. Until 2026-09-03 any
  // non-OK response was logged and swallowed: the step "completed", the run
  // finished green, and the page simply had no comment. Two bursts on
  // 2026-09-02 lost 3 of 4 and 3 of 5 comments that way, while every
  // single-run button trigger posted fine.
  //
  // A transient status now THROWS, so the durable's step retry (5 attempts,
  // ~155s of backoff — comfortably past any Retry-After Notion sends) posts it
  // again; a network error thrown by the fetch itself retries the same way,
  // which is why there is no try/catch here. The record updates above are
  // memoised steps, so a retry re-posts the comment and nothing else. If five
  // attempts all fail, the run goes red — the repo's chosen alert channel —
  // rather than pretending it succeeded.
  //
  // A definite rejection (400 malformed body, 403 missing the "Insert
  // comments" capability, 404 page gone) cannot succeed on retry and is not
  // worth failing an otherwise-good run over, so it returns `posted: false`
  // with the reason, which the workflow carries into its output as
  // `commentPosted`/`commentError` where the run history shows it.
  return await ctx.step("add-outcome-comment", async () => {
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
    if (res.ok) return { posted: true };

    const detail = `${res.status}: ${await res.text()}`;
    if (isTransientStatus(res.status)) {
      const retryAfter = res.headers.get("retry-after");
      throw new Error(
        `Outcome comment POST failed transiently (${detail})` +
          (retryAfter ? ` — Retry-After ${retryAfter}s` : ""),
      );
    }
    console.log(`Failed to add outcome comment (${detail})`);
    return { posted: false, error: detail };
  });
}

// --- Workflow --------------------------------------------------------------

const workflow = defineDurable(
  "enrich-contact-records",
  async (ctx, rawInput: unknown) => {
    const norm = normalizeInput(rawInput);

    // A bare touch of the catch URL (Notion automation "test" button, browser
    // hit, curl) is a ping, not an event — skip without raising, but log so
    // the run history shows it was seen.
    if (isEmptyPing(norm)) {
      console.log("Empty webhook ping (no payload); skipping.");
      return { skipped: "empty-payload" };
    }

    const contact = extractContactData(norm);

    console.log(
      `Enriching contact ${contact.pageId}: ${contact.firstName} ${contact.lastName}`.trim(),
    );

    // 1. Enrich the contact. Three-source cascade: Apollo (people/match)
    //    first, then Lusha, then NinjaPear as the final fallback. Each source
    //    runs inside a step that catches its own errors and returns a value
    //    instead of throwing — so a failing source does NOT trigger the
    //    durable's step-retry loop (which would stall every run on an
    //    out-of-credits source) and we fall through cleanly to the next one.
    let enrichedData: EnrichedData | null = null;
    let source: EnrichmentSource | null = null;
    const reasons: string[] = [];
    // Set when the Lusha search is sent with only identifiers the contact OWNS
    // (their email and/or LinkedIn URL) and no firstName/lastName branch that
    // could have matched a different person of the same name. A hit on such a
    // request is itself proof of identity — see "Identity corroboration".
    let lushaMatchedOwnIdentifierOnly = false;

    // --- First: Apollo people/match, via the "API Request (Beta)" action.
    //     fail_on_errors:false makes the action return the response (with its
    //     status) instead of throwing on a non-2xx, so a locked/credit-less
    //     Apollo response falls through to Lusha without retries.
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
      reasons.push(why);
      console.log(
        `Apollo enrichment unavailable for ${contact.pageId} (${why}); falling back to Lusha`,
      );
    }

    // --- Second: Lusha — only when Apollo produced nothing. Search resolves
    //     the Lusha contact id, enrich_contacts reveals the details (see the
    //     bindings comment for why two calls). Lusha matches on an email, a
    //     LinkedIn URL, or a name + company domain; with none of those there
    //     is nothing to send.
    if (!enrichedData) {
      const lushaViable = Boolean(
        contact.primaryEmail ||
          contact.linkedinUrl ||
          ((contact.firstName || contact.lastName) && contact.domain),
      );

      if (!lushaViable) {
        const why =
          "lusha skipped — no email, LinkedIn URL, or name + company domain to match on";
        reasons.push(why);
        console.log(`Lusha ${why.slice("lusha ".length)} for ${contact.pageId}`);
      } else {
        // Lusha validates the *name* branch independently, and a failure there
        // aborts the whole request: `firstName` + `lastName` with no company
        // or domain is rejected outright —
        //   Each contact must have one of: id, linkedinUrl, email, or
        //   firstName + lastName + (companyName | companyDomain)
        // — EVEN WHEN `linkedinUrl` or `email` is also present and each of
        // those identifies a contact on its own. Sending all five fields
        // therefore turns a perfectly identifiable contact into a hard error
        // whenever the domain is empty, which is every contact on a consumer
        // mailbox with no Company relation. That is what made Derek Wong
        // (LinkedIn URL populated, gmail Primary, no Company) fail on 2026-08-12.
        //
        // So the names ride along only when a domain accompanies them. Proven
        // against the live action 2026-08-12: `linkedinUrl` alone resolved him
        // where `email` alone returned "Contact not found", and
        // `firstName + lastName + linkedinUrl` without a domain was rejected.
        //
        // Empty values are omitted rather than sent as "" — the identifiers
        // are what Lusha branches on, so an empty one is noise at best.
        const lushaInputs: Record<string, unknown> = {};
        if (contact.linkedinUrl) lushaInputs.linkedinUrl = contact.linkedinUrl;
        if (contact.primaryEmail) lushaInputs.email = contact.primaryEmail;
        if (contact.domain) {
          lushaInputs.domain = contact.domain;
          if (contact.firstName) lushaInputs.firstName = contact.firstName;
          if (contact.lastName) lushaInputs.lastName = contact.lastName;
        }

        // Whether a hit can stand as its own identity proof: true when the only
        // things Lusha had to match on are this contact's own email / LinkedIn
        // URL. Once a name + domain branch rides along, Lusha may have matched
        // through that instead, and the returned record has to corroborate
        // itself like Apollo's does.
        lushaMatchedOwnIdentifierOnly =
          Boolean(lushaInputs.email || lushaInputs.linkedinUrl) &&
          !lushaInputs.firstName &&
          !lushaInputs.lastName;

        const lusha = await ctx.step("lusha-enrich", async () => {
          try {
            const searchRes = await sdk.runAction({
              appKey: LUSHA_APP_KEY,
              actionType: "search",
              actionKey: "search_and_enrich_contacts",
              connection: LUSHA_CONNECTION,
              inputs: lushaInputs,
            });
            // Result shape: { "Request Id", results: [{ id, error, ...fields }] }.
            const searchOuter = firstResult(searchRes) ?? {};
            const hit = Array.isArray(searchOuter.results)
              ? searchOuter.results[0]
              : searchOuter;
            const lushaId = firstString(hit?.id);
            if (!lushaId) {
              const hitError = firstString(hit?.error);
              return {
                contact: null as any,
                error: hitError ? `search error: ${hitError}` : null,
              };
            }
            // reveal:["emails"] — never spend Lusha phone credits; this
            // workflow doesn't consume phone data.
            const enrichRes = await sdk.runAction({
              appKey: LUSHA_APP_KEY,
              actionType: "search",
              actionKey: "enrich_contacts",
              connection: LUSHA_CONNECTION,
              inputs: { ids: [lushaId], reveal: ["emails"] },
            });
            const enrichOuter = firstResult(enrichRes) ?? {};
            const person = Array.isArray(enrichOuter.results)
              ? enrichOuter.results[0]
              : enrichOuter;
            const personError = firstString(person?.error);
            return {
              contact: person ?? null,
              error: personError ? `enrich error: ${personError}` : null,
            };
          } catch (err) {
            return {
              contact: null as any,
              error: String((err as Error)?.message ?? err),
            };
          }
        });

        if (!lusha.error && lushaContactUsable(lusha.contact)) {
          enrichedData = extractEnrichedFromLusha(lusha.contact);
          source = "lusha";
          console.log(`Lusha enriched ${contact.pageId}`);
        } else {
          const why = lusha.error
            ? `lusha error: ${lusha.error}`
            : "lusha returned no result";
          reasons.push(why);
          console.log(
            `Lusha enrichment unavailable for ${contact.pageId} (${why}); falling back to NinjaPear`,
          );
        }
      }
    }

    // --- Final fallback: NinjaPear — only when neither Apollo nor Lusha
    //     produced anything.
    if (!enrichedData) {
      // NinjaPear find_person_profile.
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
      const updateResult = await updateContactRecord(
        ctx,
        contact,
        enrichedData,
        source,
        lushaMatchedOwnIdentifierOnly,
      );
      result = {
        pageId: contact.pageId,
        enriched: true,
        source,
        // Failures of the sources tried before the one that succeeded, so
        // the outcome comment can say why the cascade fell through to it.
        reasons: reasons.length ? reasons : undefined,
        ...updateResult,
      };
    }

    // 3. Add a brief comment to the triggering page stating the outcome.
    //    If the webhook was triggered by a button click and the payload
    //    included a user ID, the comment mentions that user.
    const comment = await addOutcomeComment(ctx, contact, result);

    return { ...result, commentPosted: comment.posted, commentError: comment.error };
  },
);

export default workflow;
