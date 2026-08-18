// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/spot-project-request-to-notion
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
// The partner-tool credential lives on the TRIGGER, not here — this workflow
// never calls the partner tool back, it only consumes the request it delivers.
const NOTION_APP_KEY = "NotionCLIAPI";
const NOTION_CONNECTION = "notion_wf";
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

// Core CRM Objects — three data sources in one database.
const CONTACTS_DS = "21991b07-11ac-81a6-a894-000be4a09a67";
const COMPANIES_DS = "21991b07-11ac-80b0-b787-000b3d3995f6";
const DEALS_DS = "21a91b07-11ac-808d-9657-000b1390d20b";

// Zapier Tables (free ops, no connection).
// email -> Notion Contact page id, owned by `contact-emails-to-zapier-table`.
const CONTACT_EMAIL_TABLE = "01JYEPSEARXB2Z6BJRCMFGXBC2";
// Notion Companies mirror, owned by `notion-companies-to-zapier-table`. Keyed on
// "Notion Page ID"; carries "Company Name" and "Domain" (a link field, so Tables
// normalises a bare host to `https://…` — see `resolveCompany`).
const COMPANY_TABLE = "01JM8PH8YM93A482M8BFZ6WKW6";

/**
 * Project request id -> the records this workflow created for it.
 *
 * This is what makes the workflow safe to retry: without it, nothing stops a
 * durable retry — or a re-poll after the trigger is re-claimed — from minting a
 * second Contact/Company/Deal for a request already in the CRM. The workflow
 * refuses to run if this is ever blanked, rather than proceeding unguarded.
 *
 * Columns: `Request Id` (key) · `Deal Page ID` · `Contact Page ID` ·
 * `Company Page ID` · `Email` · `Company Name` · `Stage` · `Created On` ·
 * `Payload` (the raw trigger JSON — see the note on `extractRequest`).
 *
 * `Created On` is deliberately a **Text** field, not Date & Time: Tables coerces
 * a bare `YYYY-MM-DD` into the account timezone and stores `T16:00:00Z` on the
 * *previous* day, which is the trap `register-zapier-partner-lead` had to pin
 * `T00:00:00Z` to avoid. Here the value is only ever read back as a date.
 */
const REQUEST_TABLE = "01KYV1R8BWAZ697HQ8P1QV80AF";

/**
 * The Contacts `Lead Source` option a partner-directory request earns. Already
 * an option on the select (it predates this workflow — the flow was manual), so
 * nothing new is minted.
 */
const CONTACT_LEAD_SOURCE = "Zapier Partner Directory";

/**
 * `Size` options on Notion Companies. A value is only written when it matches
 * one of these exactly: writing an unknown option into a select is how you
 * silently mint schema, and the partner tool's own vocabulary spells the top
 * band `1,000+` (see COMPANY_SIZE_MAP in `register-zapier-partner-lead`).
 */
const COMPANY_SIZE_OPTIONS: Record<string, string> = {
  "1-49": "1-49",
  "50-249": "50-249",
  "250-999": "250-999",
  "1000+": "1000+",
  "1,000+": "1000+",
  // SPOT bands. Its ladder is finer than Notion's, so a band only earns an
  // entry when it sits ENTIRELY inside one Notion option. "1-10" does; a band
  // like "11-50" would straddle `1-49` and `50-249`, so it is deliberately
  // absent and drops rather than guess. Observed so far: "1-10"
  // (request 02700000000002800hE). Add others as real requests reveal them —
  // do not populate this from an assumed ladder.
  "1-10": "1-49",
};

/**
 * SPOT industry vocabulary -> the Notion Companies `Industry` option.
 *
 * Only exact, observed pairs. `matchOption` already handles the case where the
 * two vocabularies agree; this map is for the ones that mean the same thing
 * and spell it differently. "Retail & Wholesale" (request 02700000000002800hE)
 * is Notion's "Retail" — near enough that dropping it loses real information,
 * and far enough that the exact-match guard rejects it.
 */
const COMPANY_INDUSTRY_FROM_NAME: Record<string, string> = {
  "retail & wholesale": "Retail",
  "retail and wholesale": "Retail",
};

/**
 * **SPOT sends a REGION, not a country.** The first real request carried
 * `location: "Oceania (Australia & New Zealand)"` — and note the key is
 * `location`, not any of the `country` spellings this file used to guess at.
 *
 * A region that names two countries cannot become one, so it maps to nothing
 * and the country is recovered from the website's ccTLD instead
 * (`www.doeckeelectrical.com.au` -> Australia). Regions naming exactly one
 * country are listed here; the rest resolve through the TLD or not at all.
 */
const COUNTRY_FROM_REGION: Record<string, string> = {
  "northern america": "United States",
};

/**
 * ccTLD -> the Contacts `Country` full name. Restricted to countries one of
 * the two selects can actually store, so a match always lands somewhere real.
 * A country-coded domain is strong evidence — `.com.au` requires an Australian
 * presence to register — but it is still evidence, not a declaration, so it is
 * only consulted after the payload's own fields have failed.
 */
const COUNTRY_FROM_CCTLD: Record<string, string> = {
  ae: "United Arab Emirates",
  au: "Australia",
  de: "Germany",
  fr: "France",
  id: "Indonesia",
  ie: "Ireland",
  in: "India",
  jp: "Japan",
  my: "Malaysia",
  nl: "Netherlands",
  nz: "New Zealand",
  ph: "Philippines",
  sg: "Singapore",
  th: "Thailand",
  uk: "United Kingdom",
  vn: "Vietnam",
  za: "South Africa",
};

/**
 * **Contacts and Companies spell `Country` differently, and both must be fed
 * the spelling its own select uses.**
 *
 * Companies stores ISO-3166 alpha-2 and has only these eight options; Contacts
 * stores full country names and has 64. The directory form supplies a full name
 * ("United States"), so Companies needs the name mapped down to a code while
 * Contacts takes it as-is.
 *
 * Getting this backwards is the classic way to mint a select option by accident:
 * writing "United States" to Companies would create a ninth `Country` option
 * sitting alongside `US`. Hence the explicit map, and hence an unmapped country
 * is written to neither.
 */
const COMPANY_COUNTRY_OPTIONS: readonly string[] = [
  "AE",
  "AU",
  "GB",
  "ID",
  "JP",
  "NL",
  "SG",
  "US",
];

/** Full country name -> the Companies alpha-2 option. Only the eight that
 *  Companies can actually store; anything else is deliberately absent. */
const COMPANY_COUNTRY_FROM_NAME: Record<string, string> = {
  "united arab emirates": "AE",
  "australia": "AU",
  "united kingdom": "GB",
  "uk": "GB",
  "great britain": "GB",
  "indonesia": "ID",
  "japan": "JP",
  "netherlands": "NL",
  "the netherlands": "NL",
  "singapore": "SG",
  "united states": "US",
  "united states of america": "US",
  "usa": "US",
  "us": "US",
};

/**
 * `Country` options on Notion Contacts — full names. Includes an explicit
 * `Other`, which is deliberately NOT used as a fallback: "we don't recognise
 * this country" and "this person is somewhere we chose to call Other" are
 * different claims, and only a human should make the second one.
 */
const CONTACT_COUNTRY_OPTIONS: readonly string[] = [
  "Argentina", "Australia", "Austria", "Belgium", "Brazil", "Bulgaria",
  "Canada", "China", "Colombia", "Cyprus", "Denmark", "France", "Georgia",
  "Germany", "Greece", "Hong Kong", "Hungary", "India", "Indonesia", "Ireland",
  "Israel", "Italy", "Jamaica", "Japan", "Kenya", "Luxembourg", "Malaysia",
  "Mexico", "Monaco", "Morocco", "Myanmar", "Netherlands", "New Zealand",
  "Nigeria", "Norway", "Other", "Pakistan", "Papua New Guinea", "Philippines",
  "Poland", "Portugal", "Qatar", "Reunion", "Romania",
  "Saint Vincent and the Grenadines", "Saudi Arabia", "Singapore",
  "South Africa", "South Georgia and South Sandwich Islands", "South Korea",
  "Spain", "Sri Lanka", "Sweden", "Switzerland", "Taiwan", "Thailand",
  "Turkey", "UK", "Ukraine", "United Arab Emirates", "United Kingdom",
  "United States", "Uruguay", "Vietnam",
];

/**
 * `Industry` options on Notion Companies. Deliberately matched on the exact
 * option name only — the partner tool's industry vocabulary is unknown, and a
 * near-miss ("Tech" vs "Technology") should leave the field empty for a human
 * rather than create a fifteenth-and-a-half option.
 */
const COMPANY_INDUSTRY_OPTIONS: readonly string[] = [
  "Automation Agency",
  "E-commerce",
  "Education",
  "Energy",
  "Finance",
  "Healthcare",
  "Manufacturing",
  "Marketing Agency",
  "Media & Entertainment",
  "Nonprofit",
  "Retail",
  "Sports and Fitness Education",
  "Sports Training and Education",
  "Technology",
  "Transportation",
];

// The `new_project_request` polling trigger delivers one request per run.
// Accept anything and extract defensively — see `extractRequest`.
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

/** Joins an array-or-string field into one line. The partner tool may deliver
 *  "which apps are involved" as either. */
function joinList(v: unknown): string {
  if (Array.isArray(v)) {
    return v
      .map((x) => firstString(x) ?? "")
      .filter((s) => s !== "")
      .join(", ");
  }
  return firstString(v) ?? "";
}

/**
 * **SPOT withholds client identity until the request is accepted, and it does
 * so with prose, not with an empty field.** The first real request
 * (`02700000000002800hE`, 2026-08-06) arrived at stage `Pending` carrying:
 *
 *     email:      "Please accept or secure the lead to see the email."
 *     first_name: "Please accept or secure the lead to see the first name."
 *     last_name:  "Please accept or secure the lead to see the last name."
 *
 * That run skipped only because the email sentence fails `EMAIL_RE` — it has
 * no `@`. The name sentences carry no such accident: they are non-empty
 * strings, so `firstString` accepts them, and a Contact and Deal would have
 * been titled "Please accept or secure the lead to see the first name. Please
 * accept or secure the lead to see the last name." if the address had ever
 * been parseable.
 *
 * So the sentinel is matched explicitly rather than left to a regex that
 * happens to reject it. Matched loosely — on the stable "accept or secure"
 * phrase — because the surrounding wording is Zapier's to change.
 */
const SENTINEL_RE = /\baccept or secure the lead\b/i;

function isSentinel(v: unknown): boolean {
  return typeof v === "string" && SENTINEL_RE.test(v);
}

/** `firstString`, but placeholder prose counts as absent. */
function firstRealString(...vals: unknown[]): string | null {
  return firstString(...vals.filter((v) => !isSentinel(v)));
}

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/** Lowercased, validated email — or "". Every row in the email Table is
 *  lowercase, so a raw-case address would never match. */
function cleanEmail(v: unknown): string {
  if (isSentinel(v)) return "";
  const s = firstString(v)?.toLowerCase() ?? "";
  return EMAIL_RE.test(s) ? s : "";
}

/**
 * The date part of a partner-tool timestamp.
 *
 * The sibling trigger delivers these as `"2026-10-17T00:00:00"` — no timezone,
 * always midnight, because they name calendar dates rather than moments.
 * Feeding the raw string to Notion as a datetime invites a timezone shift onto
 * a date that has no time in it.
 */
function dateOnly(v: unknown): string {
  const s = firstString(v) ?? "";
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : "";
}

/** A bare lowercase host from a URL, domain or email address — scheme, `www.`,
 *  port, path and query stripped. Returns "" for anything without a dot, so a
 *  bare company name or "n/a" never becomes a domain. */
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

/** Consumer mailbox domains, matched exactly. Copied from
 *  `enrich-contact-records`, where the same question is asked. */
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

/** True for a consumer mailbox address. Unparseable input is NOT freemail — the
 *  caller then falls through to the conservative path. */
function isFreemail(email: string): boolean {
  const domain = normalizeDomain(email);
  if (domain === "") return false;
  if (FREEMAIL_EXACT.has(domain)) return true;
  return FREEMAIL_PREFIXES.some((p) => domain.startsWith(p));
}

/** The canonical spelling of a select option, or "" when the value isn't one.
 *  Case-insensitive, because a vocabulary we have never seen is unlikely to
 *  agree with Notion's on capitalisation. */
function matchOption(raw: unknown, options: readonly string[]): string {
  const s = firstString(raw)?.toLowerCase() ?? "";
  if (s === "") return "";
  return options.find((o) => o.toLowerCase() === s) ?? "";
}

function mapCompanySize(raw: unknown): string {
  const s = firstString(raw)?.trim() ?? "";
  if (s === "") return "";
  return COMPANY_SIZE_OPTIONS[s] ?? "";
}

/** The Companies alpha-2 option for a country. Accepts either a full name
 *  ("United States") or a code already ("US"); returns "" for anything the
 *  eight-option select cannot store. */
function companyCountry(raw: unknown): string {
  const s = firstString(raw)?.trim().toLowerCase() ?? "";
  if (s === "") return "";
  const mapped = COMPANY_COUNTRY_FROM_NAME[s];
  if (mapped) return mapped;
  return matchOption(s, COMPANY_COUNTRY_OPTIONS);
}

/** The Companies `Industry` option, by exact match first and then through the
 *  SPOT synonym map. "" when neither knows the value. */
function mapIndustry(raw: unknown): string {
  const exact = matchOption(raw, COMPANY_INDUSTRY_OPTIONS);
  if (exact !== "") return exact;
  const s = firstString(raw)?.trim().toLowerCase() ?? "";
  return COMPANY_INDUSTRY_FROM_NAME[s] ?? "";
}

/** The final segment of a host, or "" — `doeckeelectrical.com.au` -> `au`. */
function tld(domain: string): string {
  const parts = domain.split(".");
  return parts.length > 1 ? (parts[parts.length - 1] ?? "") : "";
}

/**
 * A country full name from whatever the payload managed to say, in descending
 * order of authority: an actual country, then a region that names exactly one
 * country, then the website's ccTLD.
 *
 * Returns a **full name** (the Contacts vocabulary) in every case, because
 * `companyCountry` maps names down to the Companies alpha-2 codes but not the
 * other way. "" when nothing resolves — which still writes nothing, rather
 * than minting a select option out of a region.
 */
function resolveCountryName(raw: string, website: string): string {
  const s = raw.trim().toLowerCase();
  if (s !== "") {
    // Already a country the Contacts select knows, or a name Companies knows.
    const known = matchOption(s, CONTACT_COUNTRY_OPTIONS);
    if (known !== "") return known;
    if (COMPANY_COUNTRY_FROM_NAME[s]) {
      const code = COMPANY_COUNTRY_FROM_NAME[s];
      const name = Object.keys(COMPANY_COUNTRY_FROM_NAME).find(
        (k) => COMPANY_COUNTRY_FROM_NAME[k] === code && k.length > 2,
      );
      const canonical = matchOption(name ?? s, CONTACT_COUNTRY_OPTIONS);
      if (canonical !== "") return canonical;
    }
    const fromRegion = COUNTRY_FROM_REGION[s];
    if (fromRegion) return fromRegion;
  }
  const fromTld = COUNTRY_FROM_CCTLD[tld(normalizeDomain(website))];
  return fromTld ?? "";
}

/** Notion rich_text has a 2000-character ceiling per block. A brief that runs
 *  longer is truncated in the property and carried in full in the page body. */
function clip(s: string, max = 1900): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// --- The project request ---------------------------------------------------

/**
 * **The key spellings are now KNOWN.** The first real project request
 * (`02700000000002800hE`, stage `Pending`, 2026-08-06T16:26:47) delivered:
 *
 *   id · project_request_id · type · source · lead_stage · created_on ·
 *   modified_on · modified_by_id · partner_account · partner_contact ·
 *   client_id · email · first_name · last_name · company · website ·
 *   company_size · industry · language · location · timezone · budget ·
 *   service_requested · tool_requested · project_description
 *
 * Four of this function's candidate lists had missed, and each miss silently
 * emptied a field the payload was carrying:
 *
 *   country        <- `location`            (and it holds a REGION, not a country)
 *   apps           <- `tool_requested`      (singular)
 *   servicesNeeded <- `service_requested`   (singular)
 *   stage          <- `lead_stage`
 *
 * Two more resolved only on a later candidate, which is fine but worth knowing:
 * `company` (2nd) and `project_description` (3rd).
 *
 * The candidate lists are kept rather than collapsed to the known spellings.
 * They cost nothing, the payload predates the app's 1.5.0 stabilisation, and
 * the PartnerPage vocabulary they were built from (`comments`, `your_country`,
 * `tools_to_connect`) is still what a directory-sourced request may carry —
 * this one came from `source: "Zapier Sales"`, not the directory.
 *
 * Still absent from a real payload, so still unproven: `phone_number`,
 * `job_title`, `project_name`, `timeline`, `zapier_account_email`. The last
 * one matters — `register-zapier-partner-lead` needs it — and SPOT may simply
 * not carry it.
 *
 * A miss leaves a field empty; it never writes the wrong value somewhere. The
 * raw payload is preserved verbatim on the Deal page, in the request Table row
 * and in the run output.
 *
 * Deliberately NOT guessed at: a bare `title` key, which could plausibly be the
 * person's job title or the project's name. Writing it to the wrong one is a
 * real data error, so it is read into neither.
 */
interface RequestData {
  requestId: string;
  email: string;
  firstName: string;
  lastName: string;
  name: string;
  jobTitle: string;
  phone: string;
  companyName: string;
  website: string;
  companySize: string;
  country: string;
  industry: string;
  projectName: string;
  description: string;
  budget: string;
  timeline: string;
  apps: string;
  /** "Services needed" — what the requester wants done, in the form's own
   *  vocabulary (e.g. "Technical support/troubleshooting"). Note this is NOT
   *  mapped to the Deal's `Type`: see `createDeal`. */
  servicesNeeded: string;
  timezone: string;
  /** The Zapier account the requester wants worked on — distinct from their
   *  contact address, and the input `submit_client` needs. */
  zapierAccountEmail: string;
  /** SPOT's client id (`028…`), when it supplies one — the same namespace as
   *  the Companies `Zapier Client Id` property and the join key
   *  `zapier-partner-lead-status-to-notion` resolves companies by. Empty on
   *  every payload observed so far (2026-08-18). */
  clientId: string;
  stage: string;
  createdOn: string;
  /** The payload as delivered, for the page body and the Table row. */
  raw: unknown;
}

function extractRequest(raw: unknown): RequestData {
  const o = (raw ?? {}) as Record<string, any>;
  // A polling trigger delivers one item per run, but tolerate a wrapped or
  // batched shape.
  const r: Record<string, any> = Array.isArray(o) ? o[0] ?? {} : (o.data ?? o);

  // `firstRealString` throughout: SPOT fills withheld identity fields with
  // prose ("Please accept or secure the lead to see the first name."), which is
  // a non-empty string and would otherwise sail straight into a page title.
  const firstName = firstRealString(r.first_name, r.contact_first_name) ?? "";
  const lastName = firstRealString(r.last_name, r.contact_last_name) ?? "";
  const name =
    firstRealString(r.name, r.contact_name, r.full_name) ??
    [firstName, lastName].filter((s) => s !== "").join(" ");

  const website =
    firstRealString(r.website, r.company_website, r.domain, r.url) ?? "";

  return {
    // NOT `r.id` first: the `updated_project_request` trigger's `id` is its
    // dedupe key, `<request id>_<modified-on timestamp>` — one per stage
    // CHANGE, not per request. Keying the dedupe Table on it would make every
    // stage event look like a fresh request and mint duplicate Deals. The
    // suffix-strip fallback keeps a hand-fed payload with only `id` safe too.
    requestId:
      firstString(r.project_request_id, r.request_id, r.project_id) ??
      (firstString(r.id) ?? "").split("_")[0]!,
    email: cleanEmail(
      firstRealString(r.email, r.contact_email, r.requester_email),
    ),
    firstName,
    lastName,
    name,
    jobTitle: firstRealString(r.job_title, r.contact_title, r.role) ?? "",
    phone: firstRealString(r.phone_number, r.phone, r.contact_phone) ?? "",
    companyName:
      firstRealString(
        r.company_name,
        r.company,
        r.account_name,
        r.organization,
      ) ?? "",
    website,
    companySize: firstString(r.company_size, r.size, r.employees) ?? "",
    // `location` is SPOT's spelling, and it holds a REGION — resolved to a
    // country here (via the ccTLD when the region names more than one) so the
    // write path keeps taking a plain country name.
    country: resolveCountryName(
      firstString(r.country, r.your_country, r.company_country, r.location) ??
        "",
      website,
    ),
    industry: firstString(r.industry, r.vertical) ?? "",
    projectName: firstString(r.project_name, r.project_title, r.subject) ?? "",
    // "Comments" is what the directory form calls the brief.
    description:
      firstString(
        r.comments,
        r.description,
        r.project_description,
        r.details,
        r.message,
        r.notes,
        r.brief,
      ) ?? "",
    budget:
      firstString(
        r.project_budget,
        r.budget,
        r.budget_range,
        r.estimated_budget,
      ) ?? "",
    timeline: firstString(r.timeline, r.timeframe, r.start_timeline) ?? "",
    // "Tools you are trying to connect" — may be a list or a single string.
    // SPOT spells it `tool_requested` (singular), and sent it empty on the
    // first real request.
    apps: joinList(
      r.tool_requested ??
        r.tools_to_connect ??
        r.tools ??
        r.apps ??
        r.apps_used ??
        r.integrations,
    ),
    // SPOT: `service_requested`, singular again.
    servicesNeeded: joinList(
      r.service_requested ?? r.services_needed ?? r.services,
    ),
    timezone: firstString(r.time_zone, r.timezone, r.your_time_zone) ?? "",
    zapierAccountEmail: cleanEmail(
      firstRealString(r.zapier_account_email, r.account_email),
    ),
    clientId: firstRealString(r.client_id) ?? "",
    // SPOT: `lead_stage` — Pending / Accepted / Declined / Expired /
    // Secured / Lost / Abandoned.
    stage: firstString(r.lead_stage, r.stage, r.status) ?? "",
    createdOn: dateOnly(
      firstString(r.created_on, r.created_date, r.submitted_on),
    ),
    raw: r,
  };
}

// --- Notion plumbing -------------------------------------------------------

// `defineDurable` is overloaded, so deriving the ctx type from its parameters
// resolves to the options overload and collapses to `never`. The durable
// package exports the type directly.
type DurableCtx = DurableContext;

function firstResult(res: unknown): any {
  const data = (res as { data?: unknown } | undefined)?.data;
  return Array.isArray(data) ? data[0] : data;
}

function plainText(rich: any): string {
  return (Array.isArray(rich) ? rich : [])
    .map((t: any) => t?.plain_text ?? "")
    .join("")
    .trim();
}

/**
 * Create a page in a data source with that data source's **default template**
 * applied (repo rule 5), falling back to a plain create when the data source
 * has none. Copied from `luma-guest-registered-to-event-attendance`.
 *
 * All three data sources this workflow writes to currently have a default
 * template — Contacts (`33b91b07-…`), Companies (`21991b07-11ac-807d-…`) and
 * Deals (`21a91b07-11ac-80a9-…`) — so the fallback should never fire here. It
 * is kept anyway: the catch is what lets a template be added or removed in
 * Notion with no code change.
 *
 * The `page_content` second call exists because a template and inline `content`
 * are mutually exclusive in one create.
 */
async function createItemWithTemplate(
  ctx: DurableCtx,
  stepPrefix: string,
  datasource: string,
  props: Record<string, unknown>,
  contentMarkdown?: string | null,
): Promise<{ pageId: string | null; usedTemplate: boolean }> {
  const created = await ctx.step(`${stepPrefix}-create`, async () => {
    const inputs = { datasource, ...props };
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

  const pageId: string | null = firstResult(created?.res)?.id ?? null;

  if (pageId && contentMarkdown) {
    await ctx.step(`${stepPrefix}-content`, async () =>
      sdk.runAction({
        appKey: NOTION_APP_KEY,
        actionType: "write",
        actionKey: "page_content",
        connection: NOTION_CONNECTION,
        inputs: {
          page_id: pageId,
          content: contentMarkdown,
          content_format: "markdown",
        },
      }),
    );
  }

  return { pageId, usedTemplate: Boolean(created?.usedTemplate) };
}

/** Raw PATCH. Used instead of `update_database_item` because that action
 *  addresses properties as `properties|||<name>|||<type>` keys drawn from a
 *  cached schema, which can lag Notion by more than minutes. A raw PATCH names
 *  properties directly, so it cannot go stale, and it costs the same. */
async function patchPage(
  pageId: string,
  properties: Record<string, unknown>,
): Promise<void> {
  const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
    method: "PATCH",
    connection: NOTION_CONNECTION,
    headers: {
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) {
    throw new Error(
      `Notion page PATCH failed (${res.status}): ${(await res.text()).slice(0, 300)}`,
    );
  }
}

async function readPage(pageId: string): Promise<any | null> {
  const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
    connection: NOTION_CONNECTION,
    headers: { "Notion-Version": NOTION_VERSION },
  });
  if (!res.ok) {
    console.log(`Notion page read failed (${res.status}) for ${pageId}`);
    return null;
  }
  return (await res.json()) as any;
}

/** Post a comment on a page. Best-effort — never fails the run. */
async function addComment(
  ctx: DurableCtx,
  stepName: string,
  pageId: string,
  summary: string,
): Promise<void> {
  await ctx.step(stepName, async () => {
    try {
      const res = await sdk.fetch(`${NOTION_API}/comments`, {
        connection: NOTION_CONNECTION,
        method: "POST",
        headers: {
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          parent: { page_id: pageId },
          rich_text: [{ type: "text", text: { content: summary } }],
        }),
      });
      if (!res.ok) {
        console.log(`Failed to add comment (${res.status}): ${await res.text()}`);
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

// --- Company resolution ----------------------------------------------------

/** How the company was found. `created` is the only one that costs a task
 *  beyond the lookup, and the only one worth commenting on. */
type CompanyVia =
  | "mirror-table"
  | "contact-relation"
  | "notion-website"
  | "created";

/**
 * Find the Notion Companies page for this request, creating one if it genuinely
 * does not exist.
 *
 * Order is cheapest-first, but the last lookup is also the one that closes a
 * race. The mirror Table is populated *by* a Notion webhook, so a company this
 * workflow created seconds ago is not in it yet; two requests from the same new
 * domain arriving back to back would otherwise create the company twice. The
 * Notion query reads the live data source, so it sees the first create.
 *
 *   1. mirror Table by `Domain`   — free
 *   2. the contact's single `Related Company` — free-ish (one page read we may
 *      already be doing), and correct even when the request carries no website
 *   3. Notion Companies by `Website` — authoritative and immediate
 *   4. create
 */
async function resolveCompany(
  ctx: DurableCtx,
  req: RequestData,
  domain: string,
  existingContactPageId: string | null,
): Promise<{ pageId: string | null; via: CompanyVia }> {
  // 1. The mirror Table.
  if (domain) {
    const fromTable = await ctx.step("company-via-mirror-table", async () => {
      try {
        // `Domain` is a link field: Zapier Tables normalises a bare host to
        // `https://…`, and the mirror writes whatever the Notion `Website`
        // property holds — which may carry a scheme, `www.` or a trailing
        // slash. So match loosely, then confirm on the normalised host.
        const found = await sdk.listTableRecords({
          table: COMPANY_TABLE,
          keyMode: "names",
          filters: [
            { fieldKey: "Domain", operator: "icontains", value: domain },
          ],
          pageSize: 10,
        });
        const hits = (found.data ?? []).filter((row) => {
          const d = (row.data as Record<string, any> | undefined)?.["Domain"];
          return normalizeDomain(firstString(d)) === domain;
        });
        // Two companies on one domain is a data problem, not something to pick
        // between — fall through and let the Notion query say the same thing.
        if (hits.length !== 1) {
          if (hits.length > 1) {
            console.log(`${hits.length} companies share domain ${domain}`);
          }
          return null;
        }
        return firstString(
          (hits[0]!.data as Record<string, any>)["Notion Page ID"],
        );
      } catch (err) {
        console.log(
          `Company mirror lookup failed: ${String((err as Error)?.message ?? err)}`,
        );
        return null;
      }
    });
    if (fromTable) return { pageId: fromTable, via: "mirror-table" };
  }

  // 2. The existing contact's company. Catches the case the domain cannot:
  //    a request sent from a consumer mailbox by someone already in the CRM.
  if (existingContactPageId) {
    const fromContact = await ctx.step("company-via-contact", async () => {
      const page = await readPage(existingContactPageId);
      const related = page?.properties?.["Related Company"]?.relation ?? [];
      // A contact linked to several companies gives no single answer.
      if (related.length !== 1) return null;
      return firstString(related[0]?.id);
    });
    if (fromContact) return { pageId: fromContact, via: "contact-relation" };
  }

  // 3. Notion Companies by Website — live, so it sees a create from seconds ago.
  if (domain) {
    const fromNotion = await ctx.step("company-via-notion-website", async () => {
      try {
        const res = await sdk.fetch(
          `${NOTION_API}/data_sources/${COMPANIES_DS}/query`,
          {
            connection: NOTION_CONNECTION,
            method: "POST",
            headers: {
              "Notion-Version": NOTION_VERSION,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              filter: { property: "Website", url: { contains: domain } },
              page_size: 10,
            }),
          },
        );
        if (!res.ok) {
          console.log(
            `Companies query failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
          );
          return null;
        }
        const body = (await res.json()) as any;
        const results = Array.isArray(body?.results) ? body.results : [];
        const exact = results.filter(
          (p: any) =>
            normalizeDomain(p?.properties?.["Website"]?.url) === domain,
        );
        if (exact.length !== 1) return null;
        return firstString(exact[0]?.id);
      } catch (err) {
        console.log(
          `Companies query failed: ${String((err as Error)?.message ?? err)}`,
        );
        return null;
      }
    });
    if (fromNotion) return { pageId: fromNotion, via: "notion-website" };
  }

  // 4. Create. Requires a name — a company page titled after a domain, or
  //    worse untitled, is worse than no company page at all.
  if (!req.companyName) return { pageId: null, via: "created" };

  const props: Record<string, unknown> = {
    "properties|||Company Name|||title": req.companyName,
  };
  if (domain) props["properties|||Website|||url"] = `https://${domain}`;
  const size = mapCompanySize(req.companySize);
  if (size) props["properties|||Size|||select"] = size;
  const country = companyCountry(req.country);
  if (country) props["properties|||Country|||select"] = country;
  const industry = mapIndustry(req.industry);
  if (industry) props["properties|||Industry|||select"] = industry;
  // The Zapier account the requester wants worked on. Written only on a company
  // this workflow is CREATING — there is nothing to clobber and no curation to
  // respect. An existing company's override is left alone: it may have been set
  // deliberately, and the value is on the Deal page either way.
  //
  // This is what makes a new company immediately registerable: the Companies
  // "Register Lead" button feeds `register-zapier-partner-lead`, which reads the
  // account owner's email to call `submit_client`.
  if (req.zapierAccountEmail) {
    props["properties|||Account Owner Email Override|||email"] =
      req.zapierAccountEmail;
  }
  // The SPOT client id, when the payload carries one, is the join key the
  // referral-lead pipeline resolves companies by (`zapier-partner-lead-
  // status-to-notion`, path 2). Never observed non-empty yet, but free to
  // carry when it arrives.
  if (req.clientId) {
    props["properties|||Zapier Client Id|||rich_text"] = req.clientId;
  }

  const created = await createItemWithTemplate(
    ctx,
    "company",
    COMPANIES_DS,
    props,
  );
  return { pageId: created.pageId, via: "created" };
}

// --- Contact resolution ----------------------------------------------------

type ContactVia = "email-table" | "created";

/**
 * Find or create the Notion Contact for the requester, keyed on email.
 *
 * Resolution is the email Table only — the same single path every other
 * contact-resolving Zap in this repo uses, and the reason that Table exists.
 * A Notion-side search is deliberately not added as a fallback: the Table is
 * kept current by `contact-emails-to-zapier-table` for both Primary and
 * Secondary addresses, and a second inexact path would be the thing that
 * created a duplicate.
 *
 * An existing contact is only ever *filled in*, never overwritten. Someone
 * curated those fields; a lead form did not.
 */
async function resolveContact(
  ctx: DurableCtx,
  req: RequestData,
  companyPageId: string | null,
): Promise<{ pageId: string | null; via: ContactVia; filled: string[] }> {
  const existing = await ctx.step("contact-via-email-table", async () => {
    try {
      const found = await sdk.listTableRecords({
        table: CONTACT_EMAIL_TABLE,
        keyMode: "names",
        filters: [{ fieldKey: "Email", operator: "exact", value: req.email }],
        pageSize: 1,
      });
      return firstString(
        (found.data?.[0]?.data as Record<string, any> | undefined)?.["Page ID"],
      );
    } catch (err) {
      console.log(
        `Contact email lookup failed: ${String((err as Error)?.message ?? err)}`,
      );
      return null;
    }
  });

  if (existing) {
    const filled = await ctx.step("contact-fill-blanks", async () => {
      const page = await readPage(existing);
      if (!page) return [] as string[];
      const props = page.properties ?? {};
      const patch: Record<string, unknown> = {};

      if (req.firstName && plainText(props["First Name"]?.rich_text) === "") {
        patch["First Name"] = {
          rich_text: [{ type: "text", text: { content: req.firstName } }],
        };
      }
      if (req.lastName && plainText(props["Last Name"]?.rich_text) === "") {
        patch["Last Name"] = {
          rich_text: [{ type: "text", text: { content: req.lastName } }],
        };
      }
      if (req.jobTitle && plainText(props["Job Title"]?.rich_text) === "") {
        patch["Job Title"] = {
          rich_text: [{ type: "text", text: { content: req.jobTitle } }],
        };
      }
      if (req.phone && !props["Primary Phone"]?.phone_number) {
        patch["Primary Phone"] = { phone_number: req.phone };
      }
      // Contacts stores Country as a FULL NAME, unlike Companies' alpha-2.
      const contactCountry = matchOption(req.country, CONTACT_COUNTRY_OPTIONS);
      if (contactCountry && !props["Country"]?.select) {
        patch["Country"] = { select: { name: contactCountry } };
      }
      // Lead Source records how we FIRST met someone, so an existing value is
      // the earlier truth and is left alone.
      if (!props["Lead Source"]?.select) {
        patch["Lead Source"] = { select: { name: CONTACT_LEAD_SOURCE } };
      }
      if (req.createdOn && !props["First Contacted"]?.date) {
        patch["First Contacted"] = { date: { start: req.createdOn } };
      }
      // Relations are unioned, never replaced: a contact may legitimately sit
      // against more than one company.
      if (companyPageId) {
        const current: string[] = (props["Related Company"]?.relation ?? [])
          .map((rel: any) => firstString(rel?.id) ?? "")
          .filter((s: string) => s !== "");
        if (!current.includes(companyPageId)) {
          patch["Related Company"] = {
            relation: [...current, companyPageId].map((id) => ({ id })),
          };
        }
      }

      if (Object.keys(patch).length === 0) return [] as string[];
      await patchPage(existing, patch);
      return Object.keys(patch);
    });
    return { pageId: existing, via: "email-table", filled };
  }

  // Create. `Name` is the title, so it must not be empty — fall back to the
  // email's local part rather than minting an untitled contact.
  const title =
    req.name ||
    [req.firstName, req.lastName].filter((s) => s !== "").join(" ") ||
    req.email.split("@")[0] ||
    req.email;

  const props: Record<string, unknown> = {
    "properties|||Name|||title": title,
    "properties|||Primary Email|||email": req.email,
    "properties|||Lead Source|||select": CONTACT_LEAD_SOURCE,
  };
  if (req.firstName) props["properties|||First Name|||rich_text"] = req.firstName;
  if (req.lastName) props["properties|||Last Name|||rich_text"] = req.lastName;
  if (req.jobTitle) props["properties|||Job Title|||rich_text"] = req.jobTitle;
  if (req.phone) props["properties|||Primary Phone|||phone_number"] = req.phone;
  // Full name here, alpha-2 on Companies — two different vocabularies.
  const newContactCountry = matchOption(req.country, CONTACT_COUNTRY_OPTIONS);
  if (newContactCountry) {
    props["properties|||Country|||select"] = newContactCountry;
  }
  if (req.createdOn) {
    props["properties|||First Contacted|||date__start"] = req.createdOn;
  }
  if (companyPageId) {
    props["properties|||Related Company|||relation"] = [companyPageId];
  }

  const created = await createItemWithTemplate(
    ctx,
    "contact",
    CONTACTS_DS,
    props,
  );

  // Index the new address immediately. `contact-emails-to-zapier-table` will
  // also index it off the Notion automation, but its upsert treats
  // "row -> this page" as a no-op — and waiting on its timing is exactly what
  // would let two requests from one person create two contacts.
  // "Trigger Contact Creation" stays false: the contact already exists.
  const newPageId = created.pageId;
  if (newPageId) {
    await ctx.step("index-contact-email", async () => {
      try {
        await sdk.createTableRecords({
          table: CONTACT_EMAIL_TABLE,
          keyMode: "names",
          records: [
            {
              data: {
                Email: req.email,
                "Page ID": newPageId,
                Type: "Primary",
                "Trigger Contact Creation": false,
              },
            },
          ],
        });
        return { indexed: true };
      } catch (err) {
        console.log(
          `Contact email indexing failed: ${String((err as Error)?.message ?? err)}`,
        );
        return { indexed: false };
      }
    });
  }

  return { pageId: created.pageId, via: "created", filled: [] };
}

// --- The Deal --------------------------------------------------------------

/**
 * The brief, rendered for the Deal's page body.
 *
 * The raw payload goes in verbatim below it. That is not defensive
 * belt-and-braces — it is the only complete record of a request whose field
 * names this workflow is guessing at, and it costs nothing beyond the
 * `page_content` call the template already forces.
 */
function buildDealBody(req: RequestData): string {
  const lines: string[] = [
    "## Zapier Partner Directory request",
    "",
    `- **Request id:** \`${req.requestId}\``,
    `- **From:** ${req.name || req.email}${req.jobTitle ? ` — ${req.jobTitle}` : ""}`,
    `- **Email:** ${req.email}`,
  ];
  if (req.phone) lines.push(`- **Phone:** ${req.phone}`);
  if (req.companyName) lines.push(`- **Company:** ${req.companyName}`);
  if (req.website) lines.push(`- **Website:** ${req.website}`);
  if (req.country) lines.push(`- **Country:** ${req.country}`);
  if (req.timezone) lines.push(`- **Time zone:** ${req.timezone}`);
  if (req.servicesNeeded) {
    lines.push(`- **Services needed:** ${req.servicesNeeded}`);
  }
  if (req.budget) lines.push(`- **Stated budget:** ${req.budget}`);
  if (req.timeline) lines.push(`- **Stated timeline:** ${req.timeline}`);
  if (req.apps) lines.push(`- **Tools to connect:** ${req.apps}`);
  if (req.zapierAccountEmail) {
    lines.push(`- **Zapier account:** ${req.zapierAccountEmail}`);
  }
  if (req.stage) lines.push(`- **Stage at submission:** ${req.stage}`);
  if (req.createdOn) lines.push(`- **Submitted:** ${req.createdOn}`);

  if (req.description) {
    lines.push("", "### Brief", "", req.description);
  }

  lines.push(
    "",
    "### Raw request payload",
    "",
    "The field names this Zap reads are inferred — the partner account had no",
    "project request to sample when it was written. This block is the payload as",
    "delivered, so nothing is lost if a mapping missed.",
    "",
    "```json",
    JSON.stringify(req.raw, null, 2),
    "```",
  );

  return lines.join("\n");
}

/**
 * Create the Deal.
 *
 * **Every request gets one, unqualified or not.** That is the policy: register
 * the lead, and if it is not worth pursuing a human marks the Deal `Declined`
 * in Notion — which is what that status option is for ("deals that we have
 * chosen to walk away from"). Declining in the directory and recording nothing
 * leaves no trace that the enquiry ever happened, which is the gap this closes.
 *
 * **Nothing here ever writes `Status` on a Deal that already exists** — this
 * function only ever creates. Combined with the request-id dedupe, a
 * re-delivered or retried request is a no-op, so a Deal a human has moved to
 * `Declined` (or `Closed Won`) can never be dragged back to `Lead`.
 *
 * Deliberately left empty rather than guessed at:
 *
 * - **`Status`** — the Deals default template already sets it to `Lead`, which
 *   is exactly right for an unqualified inbound. Nothing is written, so the
 *   `properties|||…|||status` key form (unproven in this repo) is never needed.
 * - **`Type`** — the five options (Full Retainer, Project, Support Retainer,
 *   Vanta Subscription, Workshop) name a commercial model chosen during
 *   scoping. A brief does not state one. In particular "Services needed:
 *   Technical support/troubleshooting" is **not** mapped to `Support Retainer`:
 *   asking for troubleshooting help is not agreeing to a retainer, and the
 *   difference is a pricing decision.
 * - **`Value`** / **`Deal Currency`** — a stated budget is a band ("$5k–$10k"),
 *   not a number, and `Deal Currency` is a relation to an FX Rates row that
 *   would need its own lookup. Both are left for the human who scopes the deal;
 *   whatever the request said is on the page body and in `Description`.
 * - **`Expected Close`** — a brief's timeline is a delivery timeline, not a
 *   close date.
 * - **`Owner`** — the template already assigns it.
 */
async function createDeal(
  ctx: DurableCtx,
  req: RequestData,
  companyPageId: string | null,
  contactPageId: string | null,
): Promise<string | null> {
  const dealName =
    req.projectName ||
    (req.companyName
      ? `${req.companyName} — Zapier Partner Directory request`
      : `Zapier Partner Directory request — ${req.name || req.email}`);

  const props: Record<string, unknown> = {
    "properties|||Deal Name|||title": dealName,
  };
  if (companyPageId) {
    props["properties|||Company|||relation"] = [companyPageId];
  }
  if (contactPageId) {
    props["properties|||Contact|||relation"] = [contactPageId];
  }
  const description = [
    req.description,
    req.servicesNeeded && `Services needed: ${req.servicesNeeded}`,
    req.apps && `Tools to connect: ${req.apps}`,
    req.budget && `Budget: ${req.budget}`,
    req.timeline && `Timeline: ${req.timeline}`,
  ]
    .filter((s) => s)
    .join(" · ");
  if (description) {
    props["properties|||Description|||rich_text"] = clip(description);
  }

  const created = await createItemWithTemplate(
    ctx,
    "deal",
    DEALS_DS,
    props,
    buildDealBody(req),
  );
  return created.pageId;
}

// --- Workflow --------------------------------------------------------------

const workflow = defineDurable<Record<string, unknown>, unknown>(
  "spot-project-request-to-notion",
  async (ctx, rawInput) => {
    const req = extractRequest(normalizeInput(rawInput));

    console.log(
      `Project request ${req.requestId || "?"} from ${req.email || "?"} ` +
        `(${req.companyName || "no company"})`,
    );

    // Only an acceptance is filed. The trigger (`updated_project_request`)
    // fires on EVERY stage change — Pending (identity still withheld behind
    // sentinel prose), Declined, Expired, Secured, Lost, Abandoned — and
    // `Accepted` is the one moment SPOT reveals the client's identity and the
    // enquiry is ours to pursue. A declined-in-SPOT request leaves no CRM
    // trace by design: declining happens in the directory, and nothing worth
    // a Deal ever existed. Stage changes AFTER acceptance are also caught by
    // the request-id dedupe below; this gate just makes the skip explicit and
    // free. A payload with no stage at all (a hand-fed replay of an older
    // shape) is let through — the email gate below still applies.
    if (req.stage && req.stage.toLowerCase() !== "accepted") {
      console.log(`Stage is ${req.stage} — not an acceptance, nothing to file`);
      return {
        skipped: true,
        reason: `stage is ${req.stage} — only Accepted requests are filed`,
        requestId: req.requestId,
        raw: req.raw,
      };
    }

    // The dedupe store is what makes this workflow safe to retry. Without it,
    // refuse — see REQUEST_TABLE.
    if (!REQUEST_TABLE) {
      return {
        skipped: true,
        reason:
          "REQUEST_TABLE is not configured — create the SPOT Project Requests " +
          "Table and set its id before publishing (see README → Publish runbook)",
        requestId: req.requestId,
        raw: req.raw,
      };
    }

    // Without an email there is no contact to key on, and a project request
    // with no way to reply to it is not something to file. Permanent, so
    // return rather than throw.
    if (!req.email) {
      return {
        skipped: true,
        reason: "payload carried no usable email address",
        requestId: req.requestId,
        raw: req.raw,
      };
    }

    // 1. Already filed? A polling trigger can re-deliver after the trigger is
    //    re-claimed, and a durable retries a failed run — either would mint a
    //    second Deal for one request.
    if (req.requestId) {
      const seen = await ctx.step("dedupe-request", async () => {
        try {
          const found = await sdk.listTableRecords({
            table: REQUEST_TABLE,
            keyMode: "names",
            filters: [
              {
                fieldKey: "Request Id",
                operator: "exact",
                value: req.requestId,
              },
            ],
            pageSize: 1,
          });
          const row = found.data?.[0];
          if (!row) return null;
          const d = row.data as Record<string, any>;
          return {
            dealPageId: firstString(d["Deal Page ID"]) ?? "",
            contactPageId: firstString(d["Contact Page ID"]) ?? "",
            companyPageId: firstString(d["Company Page ID"]) ?? "",
          };
        } catch (err) {
          // A failed dedupe read must NOT be treated as "not seen" — that is
          // how you get the duplicate this step exists to prevent. Rethrow so
          // the durable retries the read.
          throw new Error(
            `Request dedupe lookup failed: ${String((err as Error)?.message ?? err)}`,
          );
        }
      });
      if (seen) {
        console.log(`Request ${req.requestId} already filed — nothing to do`);
        return { skipped: true, reason: "already filed", ...seen };
      }
    }

    // 2. Company first, so the Contact can be created already linked to it.
    //    A consumer mailbox yields no domain — the host is the mailbox
    //    provider's, not the employer's, and treating it as one would file
    //    every Gmail requester under a company called Gmail.
    const emailDomain = isFreemail(req.email) ? "" : normalizeDomain(req.email);
    const domain = normalizeDomain(req.website) || emailDomain;

    // The contact may already exist; resolving it early lets the company fall
    // back to that contact's `Related Company` when there is no domain.
    const knownContactPageId = await ctx.step(
      "peek-contact",
      async () => {
        try {
          const found = await sdk.listTableRecords({
            table: CONTACT_EMAIL_TABLE,
            keyMode: "names",
            filters: [
              { fieldKey: "Email", operator: "exact", value: req.email },
            ],
            pageSize: 1,
          });
          return firstString(
            (found.data?.[0]?.data as Record<string, any> | undefined)?.[
              "Page ID"
            ],
          );
        } catch {
          return null;
        }
      },
    );

    const company = await resolveCompany(
      ctx,
      req,
      domain,
      knownContactPageId,
    );

    // A client id on the payload links the company into the referral-lead
    // pipeline (`Zapier Client Id` is how `zapier-partner-lead-status-to-notion`
    // resolves a company). A created company gets it in its create props; an
    // EXISTING company is only filled in where the property is empty — a value
    // already there was stamped by `register-zapier-partner-lead` and wins.
    // Best-effort: a failure here must not cost the Deal, so it logs and moves on.
    if (req.clientId && company.pageId && company.via !== "created") {
      await ctx.step("fill-company-client-id", async () => {
        try {
          const page = await readPage(company.pageId!);
          const existing = plainText(
            page?.properties?.["Zapier Client Id"]?.rich_text,
          );
          if (existing) return `kept existing ${existing}`;
          await patchPage(company.pageId!, {
            "Zapier Client Id": {
              rich_text: [{ text: { content: req.clientId } }],
            },
          });
          return `stamped ${req.clientId}`;
        } catch (err) {
          console.log(
            `Zapier Client Id fill-in failed: ${String((err as Error)?.message ?? err)}`,
          );
          return "failed";
        }
      });
    }

    // 3. Contact — found or created, and linked to the company.
    const contact = await resolveContact(ctx, req, company.pageId);

    // 4. Deal. Nothing else in this workflow is worth doing if this fails, so
    //    a failure here throws and earns a durable retry — the dedupe row is
    //    only written once the Deal exists.
    const dealPageId = await createDeal(
      ctx,
      req,
      company.pageId,
      contact.pageId,
    );
    if (!dealPageId) {
      throw new Error("Deal creation returned no page id");
    }

    // 5. Index the request. Written last: a row here means "this request is
    //    filed", and it must not be able to say that before the Deal exists.
    await ctx.step("index-request", async () => {
      try {
        await sdk.createTableRecords({
          table: REQUEST_TABLE,
          keyMode: "names",
          records: [
            {
              data: {
                "Request Id": req.requestId,
                "Deal Page ID": dealPageId,
                "Contact Page ID": contact.pageId ?? "",
                "Company Page ID": company.pageId ?? "",
                Email: req.email,
                "Company Name": req.companyName,
                Stage: req.stage,
                "Created On": req.createdOn,
                Payload: JSON.stringify(req.raw),
              },
            },
          ],
        });
        return { indexed: true };
      } catch (err) {
        // The CRM records — the thing a human reads — already exist. Log
        // rather than fail the run; the cost is that a re-delivery of this
        // request would not be recognised.
        console.log(
          `Request indexing failed: ${String((err as Error)?.message ?? err)}`,
        );
        return { indexed: false };
      }
    });

    // 6. Say what was inferred. A new company, or a company matched to a
    //    contact rather than a domain, is this workflow drawing a line nobody
    //    drew — the kind of thing worth a human's glance.
    if (company.via === "created" || company.via === "contact-relation") {
      const how =
        company.via === "created"
          ? `Created **${req.companyName}** from the request itself` +
            (domain ? ` (domain \`${domain}\`)` : " — no website given")
          : `Matched to this company through **${req.name || req.email}**'s ` +
            `existing Related Company, not a domain`;
      await addComment(
        ctx,
        "comment-inference",
        dealPageId,
        `${how}. Zapier Partner Directory project request \`${req.requestId}\`. ` +
          `Deal opened at Lead — Type, Value and Expected Close are deliberately ` +
          `empty for whoever scopes it.`,
      );
    }

    return {
      requestId: req.requestId,
      dealPageId,
      contactPageId: contact.pageId,
      companyPageId: company.pageId,
      companyVia: company.via,
      contactVia: contact.via,
      contactFilled: contact.filled,
      domain,
      // Echoed so the first real request's shape is readable from the run
      // output, not just from the Deal page.
      raw: req.raw,
    };
  },
);

export default workflow;
