// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/enrich-contact-records
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
const NOTION_APP_KEY = "NotionCLIAPI";
const NOTION_CONNECTION = "notion_wf";
// Primary enrichment, used when the contact has a LinkedIn URL: HarvestAPI.
// `find_profile` (a search) looks the profile up by its URL and answers
// SYNCHRONOUSLY (usually 6–25s; see isActionTimeout) with the profile — name,
// headline, about, current title + company, parsed location — and, with
// `findEmail`, an SMTP-checked `emails[]`. An unknown URL answers with an empty
// `data` array, not an error. The booleans are the strings "true" / "false".
const HARVESTAPI_APP_KEY = "App242893CLIAPI";
const HARVESTAPI_CONNECTION = "harvestapi";
/** Notion caps a rich_text segment at 2000 characters; a LinkedIn "about"
 *  can run longer. */
const BIO_MAX_CHARS = 2000;
// Fallback enrichment: Apollo.io `people/match` (since 2026-11-03, replacing
// BetterContact). Called with `sdk.fetch` through an *API by Zapier*
// connection holding Apollo's master API key, so it is one synchronous call —
// no job, no callback. It matches on whatever it is given (email, LinkedIn
// URL, name + domain) and is FUZZY: it will match on a name alone, which is how
// the Grace Tang collision happened (see "Identity corroboration"). Verified
// 2026-11-03: `person` carries `email` + `email_status`, `linkedin_url`,
// `title`, `headline`, `city`, `country`, `photo_url` and `organization`.
const APOLLO_CONNECTION = "apollo";
const APOLLO_MATCH_URL = "https://api.apollo.io/api/v1/people/match";
/** Apollo `email_status` values that may be written. Anything else
 *  (`unverified`, `extrapolated`, `likely to engage`, …) is named in the
 *  outcome comment and written nowhere. */
const APOLLO_WRITABLE_EMAIL_STATUSES = new Set(["verified"]);
/** A trigger whose last edit was this workflow's own write, landing within
 *  this many minutes of the `Last Enriched` stamp it set, is that write's echo
 *  — see `isOwnWriteEcho`. */
const ECHO_WINDOW_MINUTES = 5;

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

/**
 * The Contacts default template's own title, which shows through on any
 * contact created from the template without a name. It is not a person: on
 * 2026-09-28 a contact titled "New Contact" was sent to BetterContact as
 * New / Contact at du.edu, which answered with a guessed new.contact@du.edu
 * that was then written to the contact and indexed. Compared on letters only,
 * so spacing, case and a trailing space (the live title is "New Contact ")
 * don't matter.
 */
const PLACEHOLDER_TITLES = new Set(["newcontact", "contactnew", "untitled"]);

function isPlaceholderTitle(title: string): boolean {
  return PLACEHOLDER_TITLES.has(title.toLowerCase().replace(/[^a-z]/g, ""));
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

/** A value safe to write to a Notion `select`: Notion rejects any option
 *  containing a comma ("Invalid select option, commas not allowed"), and that
 *  rejection fails the whole contact update, so commas are dropped
 *  ("Washington, D.C." → "Washington D.C."). Known country forms are mapped to
 *  existing options first — see `countryName`. */
function selectOption(value: string): string {
  return value.replace(/\s*,\s*/g, " ").replace(/\s+/g, " ").trim();
}

/** The list with blanks dropped and each address kept once, first occurrence
 *  winning and case ignored (see `sameAddress`). */
function dedupeAddresses(addresses: string[]): string[] {
  return addresses.filter(
    (e, i, all) =>
      e.trim() !== "" && all.findIndex((x) => sameAddress(x, e)) === i,
  );
}

// --- Names and URLs as sent to the enrichment sources ----------------------
//
// The name Apollo is asked to match on is a RENDERING of the contact's own:
// the parenthesised alternate-script aside is dropped ("Alice SY Peng (彭思瑀)"
// — the Latin name beside it is the one a work address is built from), and so
// are initials in a name split from the page title. Apollo takes the name in a
// JSON body, so any script travels; the header-safety folding BetterContact's
// integration needed (2026-10-01) went with it on 2026-11-03.
//
// The rendering is for the REQUEST only. The contact's own name is what gets
// written back to Notion; see `updateContactRecord`.

/** Parenthesised asides dropped — "(彭思瑀)", "（彭思瑀）", "(Bob)" — and the
 *  whitespace they leave collapsed. */
function stripParenthetical(s: string): string {
  return s
    .replace(/[(（][^)）]*[)）]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A token that is only initials: "SY", "J.", "J.R.". Real surnames carry
 *  lowercase ("Ng", "Wu"), so these never match one. */
const INITIALS = /^(?:[A-Z]{1,3}|(?:[A-Z]\.)+[A-Z]?)\.?$/;

/**
 * The first + last name Apollo is asked to match on.
 *
 * - Parenthesised asides are dropped from both parts: an alternate-script name
 *   ("Alice SY Peng (彭思瑀)") is not how the work address is spelled.
 * - When the split came from the page TITLE (no First/Last Name set), initials
 *   between the first and last word are dropped too — "Alice SY Peng" asks for
 *   Alice Peng, the name an alice.peng@ address is built from, not "SY Peng".
 *   Lowercase particles stay ("Jan van der Berg" keeps "van der Berg"). Names
 *   typed into First/Last Name are trusted as given.
 */
function matchName(
  firstName: string,
  lastName: string,
  fromTitle: boolean,
): { firstName: string; lastName: string } {
  let first = stripParenthetical(firstName);
  let last = stripParenthetical(lastName);
  if (fromTitle) {
    // Re-split, since the aside may have held the only word after the first.
    const words = `${first} ${last}`.trim().split(" ").filter(Boolean);
    first = words[0] ?? "";
    const rest = words.slice(1);
    while (rest.length > 1 && INITIALS.test(rest[0] ?? "")) rest.shift();
    last = rest.join(" ");
  }
  return { firstName: first, lastName: last };
}

/** A URL with every non-ASCII run percent-encoded (linkedin.com/in/彭思瑀 is
 *  linkedin.com/in/%E5%BD%AD…), so an integration that puts it in a header
 *  can carry it. */
function asciiUrl(url: string): string {
  return url.replace(/[^\x00-\x7f]+/g, (run) => encodeURIComponent(run));
}

// --- Contact data extracted from the Notion webhook payload ---------------

interface ContactData {
  pageId: string;
  /** The contact's own name, as the CRM holds it. Written back unchanged. */
  firstName: string;
  lastName: string;
  /** The name as sent to Apollo — see `matchName`. */
  matchFirstName: string;
  matchLastName: string;
  primaryEmail: string;
  domain: string;
  linkedinUrl: string;
  secondaryEmails: string[];
  primaryPhone: string;
  /** For `isOwnWriteEcho`: who made the page's last edit and when, the
   *  `Last Enriched` stamp, and whether a person fired this run explicitly
   *  (a button press carries `source.user_id`; the property automation
   *  does not). */
  lastEditedBy: string;
  lastEditedTime: string;
  lastEnriched: string;
  pressedByUser: boolean;
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

  // The domain is both an Apollo match input (with first + last name) and the
  // strongest corroboration signal for what comes back. When the Company
  // relation is missing or unusable, fall back to the Primary Email's own
  // host: for any non-consumer address that IS the employer's domain.
  const domain =
    rollupDomains[0] ??
    (isFreemail(primaryEmail)
      ? ""
      : normalizeDomain(primaryEmail.slice(primaryEmail.lastIndexOf("@") + 1)));

  // Auto-created contacts (e.g. from an event registration) often carry the
  // person's name only in the page title — the First/Last Name rich_text
  // properties arrive empty. Fall back to splitting the title so the
  // enrichment sources get a name to match on. A title that is just an email
  // address (the placeholder for a contact created from a bare registration)
  // is not a name, and neither is the Contacts template's own default title.
  let firstName = plainText(props["First Name"]?.rich_text).trim();
  let lastName = plainText(props["Last Name"]?.rich_text).trim();
  let fromTitle = false;
  if (!firstName && !lastName) {
    const title = plainText(props["Name"]?.title).trim();
    if (title && !title.includes("@") && !isPlaceholderTitle(title)) {
      const parts = title.split(/\s+/);
      firstName = parts[0] ?? "";
      lastName = parts.slice(1).join(" ");
      fromTitle = true;
    }
  }
  const match = matchName(firstName, lastName, fromTitle);

  return {
    pageId,
    firstName,
    lastName,
    matchFirstName: match.firstName,
    matchLastName: match.lastName,
    primaryEmail,
    domain,
    linkedinUrl: props["Linkedin"]?.url ?? "",
    secondaryEmails: (props["Secondary Email"]?.multi_select ?? [])
      .map((s: any) => s?.name)
      .filter(Boolean),
    primaryPhone: props["Primary Phone"]?.phone_number ?? "",
    lastEditedBy: firstString(data?.last_edited_by?.id) ?? "",
    lastEditedTime: firstString(data?.last_edited_time) ?? "",
    lastEnriched: firstString(props["Last Enriched"]?.date?.start) ?? "",
    pressedByUser: Boolean(firstString(o.source?.user_id)),
  };
}

// --- Loop guard: this workflow's own LinkedIn write --------------------------
//
// The Contacts automation fires this workflow when the `Linkedin` property is
// edited, and this workflow writes `Linkedin` — so its own write can fire it
// again. That was already happening before Apollo: a person pasting
// `linkedin.com/in/x` got HarvestAPI's `https://www.linkedin.com/in/x` written
// back, the automation fired, and a second full run (a second HarvestAPI
// lookup, a second comment) followed seconds later — 12 contacts between
// 2026-10-24 and 2026-11-02. Every echo run's payload has `last_edited_by` =
// the Notion connection's own bot and `last_edited_time` within a minute of the
// `Last Enriched` stamp the first run set.
//
// So a run is the echo of our own write — and skipped — when all hold:
//   * no person pressed a button for it (`source.user_id` absent);
//   * the last edit landed 0–ECHO_WINDOW_MINUTES after `Last Enriched`;
//   * the last editor is this connection's bot (`GET /v1/users/me`, read only
//     when the first two hold, so an ordinary run makes no extra call).
// A person editing the URL afterwards is the last editor, so their correction
// still runs; so does a button press. The run that wrote the URL already did
// everything the echo would (HarvestAPI included, in-run), so nothing is lost.
// Writing `Linkedin` only when the slug actually changes (`linkedinToWrite`)
// keeps most runs from firing the automation at all.

/** Minutes since the epoch for a Notion timestamp (`2026-11-02T02:24:00.000Z`,
 *  `…+08:00`), or null. Integer arithmetic: `Date` throws in the workflow body
 *  (see the determinism guard). */
function isoToEpochMinutes(iso: string): number | null {
  const m = iso.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/,
  );
  if (!m) return null;
  let mins = daysFromCivil(+m[1], +m[2], +m[3]) * 1440 + +m[4] * 60 + +m[5];
  const tz = m[6];
  if (tz && tz !== "Z") {
    const sign = tz[0] === "-" ? -1 : 1;
    mins -= sign * (+tz.slice(1, 3) * 60 + +tz.slice(4, 6));
  }
  return mins;
}

/** Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
 *  Copied from drive-invoice-to-xero. */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The payload-only half of the echo test: not a button press, and the last
 *  edit landed within the window after `Last Enriched`. The caller then checks
 *  the editor is our own bot. One minute of slack below zero, since Notion
 *  rounds both stamps to the minute. */
function isOwnWriteEchoCandidate(contact: ContactData): boolean {
  if (contact.pressedByUser || !contact.lastEditedBy) return false;
  const edited = isoToEpochMinutes(contact.lastEditedTime);
  const enriched = isoToEpochMinutes(contact.lastEnriched);
  if (edited === null || enriched === null) return false;
  const gap = edited - enriched;
  return gap >= -1 && gap <= ECHO_WINDOW_MINUTES;
}

// --- Enrichment result extraction ------------------------------------------

/** HarvestAPI first when the contact has a LinkedIn URL, Apollo as the
 *  fallback (and HarvestAPI again when Apollo finds the URL). Corroboration
 *  keeps its per-source shape. */
type EnrichmentSource = "harvestapi" | "apollo";

const SOURCE_LABELS: Record<EnrichmentSource, string> = {
  harvestapi: "HarvestAPI",
  apollo: "Apollo",
};

interface EnrichedData {
  /** The source the profile fields came from. */
  source: EnrichmentSource;
  /** The source `newEmail` came from — differs from `source` when HarvestAPI
   *  found the profile but no deliverable address and Apollo supplied one.
   *  Null with no email. */
  emailSource: EnrichmentSource | null;
  /** When set, decides whether `newEmail` may be written, in place of
   *  `corroborateEnrichedIdentity`. Set where the address's evidence lives on
   *  a record other than the profile's: Apollo's address merged into a
   *  HarvestAPI profile (Apollo's own record must vouch for it), or a
   *  HarvestAPI lookup keyed on a URL Apollo found (Apollo's match must). */
  identity?: IdentityCorroboration;
  linkedinUrl: string;
  country: string;
  city: string;
  newEmail: string;
  bio: string;
  jobTitle: string;
  firstName: string;
  lastName: string;
  /** A real profile photo URL (placeholders filtered by `realPhotoUrl`), or
   *  "". HarvestAPI's, else a corroborated Apollo match's. Stored in Notion and
   *  set as the page icon and cover (Path C). */
  profilePicUrl: string;
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
// When a LinkedIn profile has no photo, a scraper may not return `null` — Apollo
// returned LinkedIn's generic grey silhouette, verbatim (HarvestAPI scrapes the
// same pages, so the same guard applies to it):
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
//      whose URL we have not seen (a new LinkedIn one) at the
//      cost of one import. The unattached upload expires on its own.
// An empty `profilePicUrl` then takes the same route as a photo-less result: the
// icon is left alone, so a contact with a real photo (or the data source's
// default template icon) keeps it.

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

// --- HarvestAPI result extraction ------------------------------------------
//
// One row of `find_profile`'s `data[]`, shape captured from a live run on
// 2026-10-07: `firstName`, `lastName`, `linkedinUrl`, `about`,
// `currentJobTitle`, `location.parsed.{city,country}`, `experience[]` (each
// with `company.website`), and `emails[]` of
// `{ email, deliverable, catchAllDomain, status, qualityScore }`. The row also
// carries `photo` (a signed `media.licdn.com` link), which Path C stores in
// Notion and sets as the page icon.

/** The first address HarvestAPI verified, or "". Only `deliverable: true` with
 *  `status: "valid"` counts, the counterpart of
 *  APOLLO_WRITABLE_EMAIL_STATUSES; anything else is reported, never written. */
function harvestEmail(row: any): string {
  const emails: any[] = Array.isArray(row?.emails) ? row.emails : [];
  const ok = emails.find(
    (e) =>
      e?.deliverable === true &&
      String(e?.status ?? "").toLowerCase() === "valid" &&
      firstString(e?.email),
  );
  return firstString(ok?.email) ?? "";
}

/** The current position's employer website, normalised — the open-ended
 *  ("Present") entry first, else the most recent one. */
function harvestEmployerDomain(row: any): string {
  const exp: any[] = Array.isArray(row?.experience) ? row.experience : [];
  const current =
    exp.find((e) => /present/i.test(String(e?.endDate?.text ?? ""))) ?? exp[0];
  return normalizeDomain(firstString(current?.company?.website));
}

/** ISO 3166 names HarvestAPI's `location.parsed.country` uses, mapped to the
 *  common names the Contacts `Country` select already holds ("South Korea",
 *  "Vietnam", "Taiwan"). The comma forms are not just cosmetic: Notion rejects
 *  a select option containing a comma, and "Korea, Republic of" failed the
 *  whole contact update on 2026-10-07. */
const COUNTRY_ALIASES: Record<string, string> = {
  "korea, republic of": "South Korea",
  "republic of korea": "South Korea",
  "korea, democratic people's republic of": "North Korea",
  "taiwan, province of china": "Taiwan",
  "viet nam": "Vietnam",
  "russian federation": "Russia",
  "türkiye": "Turkey",
  "iran, islamic republic of": "Iran",
  "syrian arab republic": "Syria",
  "lao people's democratic republic": "Laos",
  "tanzania, united republic of": "Tanzania",
  "venezuela, bolivarian republic of": "Venezuela",
  "bolivia, plurinational state of": "Bolivia",
  "moldova, republic of": "Moldova",
  "micronesia, federated states of": "Micronesia",
  "palestine, state of": "Palestine",
  "congo, the democratic republic of the": "Democratic Republic of the Congo",
  "congo, democratic republic of the": "Democratic Republic of the Congo",
  "macedonia, the former yugoslav republic of": "North Macedonia",
  "virgin islands, british": "British Virgin Islands",
  "virgin islands, u.s.": "U.S. Virgin Islands",
  "united kingdom of great britain and northern ireland": "United Kingdom",
  "united states of america": "United States",
};

function countryName(raw: string | null): string {
  const v = (raw ?? "").trim();
  return COUNTRY_ALIASES[v.toLowerCase()] ?? v;
}

/** True when a runAction error is the platform killing the action at its 30s
 *  execution limit ("Action execution failed: RequestId: … Error: Task timed
 *  out after 30.00 seconds"). `find_profile` with the SMTP check usually
 *  answers in 6–25s but has overrun twice (2026-10-08, 2026-10-14); a retry a
 *  minute later answered in ~6s, so HarvestAPI evidently caches the lookup.
 *  Matched narrowly so every other HarvestAPI error still falls straight
 *  through to Apollo. */
function isActionTimeout(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /\bTask timed out after \d+(\.\d+)? seconds\b/.test(msg);
}

/** True when the row is a real profile (an unknown URL returns no row). */
function harvestRowUsable(row: any): boolean {
  if (!row || typeof row !== "object") return false;
  return Boolean(firstString(row.linkedinUrl, row.publicIdentifier));
}

function extractEnrichedFromHarvest(row: any): EnrichedData {
  const newEmail = harvestEmail(row);
  const parsed = row?.location?.parsed ?? {};
  const rawEmails: string[] = [
    ...(Array.isArray(row?.emails) ? row.emails.map((e: any) => e?.email) : []),
    row?.email,
  ].filter((e): e is string => typeof e === "string");
  return {
    source: "harvestapi",
    emailSource: newEmail ? "harvestapi" : null,
    linkedinUrl: firstString(row?.linkedinUrl) ?? "",
    country: countryName(firstString(parsed.country)),
    city: firstString(parsed.city) ?? "",
    newEmail,
    bio: (firstString(row?.about) ?? "").slice(0, BIO_MAX_CHARS),
    jobTitle: firstString(row?.currentJobTitle) ?? "",
    firstName: firstString(row?.firstName) ?? "",
    lastName: firstString(row?.lastName) ?? "",
    allEmails: dedupeAddresses(rawEmails),
    employerDomain: harvestEmployerDomain(row),
    profilePicUrl: realPhotoUrl(row?.photo),
  };
}

/** HarvestAPI's profile with Apollo's address filled in, for a profile that
 *  came back without a deliverable email. Profile fields stay HarvestAPI's
 *  (read straight off LinkedIn) where it has them. The address is judged on
 *  Apollo's own record (`apolloIdentity`), never on HarvestAPI's: Apollo is
 *  fuzzy, so its match could be a different person even when the profile
 *  beside it is the right one. */
function mergeApolloEmail(
  harvest: EnrichedData,
  apollo: EnrichedData,
  apolloIdentity: IdentityCorroboration,
): EnrichedData {
  return {
    ...harvest,
    emailSource: apollo.newEmail ? "apollo" : null,
    newEmail: apollo.newEmail,
    identity: apollo.newEmail ? apolloIdentity : undefined,
    country: harvest.country || apollo.country,
    city: harvest.city || apollo.city,
    jobTitle: harvest.jobTitle || apollo.jobTitle,
    allEmails: dedupeAddresses([...harvest.allEmails, ...apollo.allEmails]),
  };
}

// --- Apollo result extraction ------------------------------------------------
//
// `people/match` answers `{ person, request_id }`; `person` is null on no
// match. Shape captured live 2026-11-03: `first_name`, `last_name`,
// `linkedin_url`, `title`, `headline`, `city`, `country`, `photo_url`,
// `email` + `email_status` (`verified` on the probe), `employment_history[]`
// (each with an optional `description`) and `organization.primary_domain`.

/** Apollo's address, or "" when there is none, it is the
 *  `email_not_unlocked@…` placeholder a credit-locked record carries, or its
 *  status is not one we write (APOLLO_WRITABLE_EMAIL_STATUSES). */
function apolloEmail(person: any): string {
  const email = apolloRawEmail(person?.email);
  if (!email) return "";
  const status = (firstString(person?.email_status) ?? "").toLowerCase();
  return APOLLO_WRITABLE_EMAIL_STATUSES.has(status) ? email : "";
}

function apolloRawEmail(email: unknown): string {
  const e = firstString(email);
  if (!e || /email_not_unlocked/i.test(e)) return "";
  return e;
}

/** True when the match carries at least one signal worth writing. */
function apolloPersonUsable(person: any): boolean {
  if (!person || typeof person !== "object") return false;
  return Boolean(
    apolloRawEmail(person.email) ||
      person.linkedin_url ||
      person.title ||
      person.city ||
      person.country,
  );
}

function extractEnrichedFromApollo(person: any): EnrichedData {
  const newEmail = apolloEmail(person);
  // Role descriptions read as a bio; the headline stands in when there are none.
  const descriptions = (Array.isArray(person?.employment_history) ? person.employment_history : [])
    .map((e: any) => e?.description)
    .filter((d: unknown): d is string => typeof d === "string" && d.trim() !== "");
  const bio = descriptions.length
    ? descriptions.join("\n\n")
    : (firstString(person?.headline) ?? "");
  return {
    source: "apollo",
    emailSource: newEmail ? "apollo" : null,
    linkedinUrl: firstString(person?.linkedin_url) ?? "",
    country: countryName(firstString(person?.country)),
    city: firstString(person?.city) ?? "",
    newEmail,
    bio: bio.slice(0, BIO_MAX_CHARS),
    jobTitle: firstString(person?.title) ?? "",
    firstName: firstString(person?.first_name) ?? "",
    lastName: firstString(person?.last_name) ?? "",
    // Every address on the record, whatever its status: corroboration only
    // compares them against addresses the contact already holds.
    allEmails: dedupeAddresses(
      [
        apolloRawEmail(person?.email),
        ...(Array.isArray(person?.personal_emails)
          ? person.personal_emails.map((e: unknown) => apolloRawEmail(e))
          : []),
      ].filter(Boolean),
    ),
    employerDomain: normalizeDomain(
      firstString(
        person?.organization?.primary_domain,
        person?.organization?.website_url,
      ),
    ),
    profilePicUrl: realPhotoUrl(person?.photo_url),
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
// against something the CRM already knows. Any one of these clears it:
//
//   * an address the contact already holds appears on the returned record;
//   * the returned LinkedIn URL and the contact's reduce to the same slug;
//   * the enriched address's host, or the record's employer domain, equals the
//     company domain the CRM already holds;
//   * HarvestAPI looked the profile up by the contact's OWN LinkedIn URL — an
//     exact key, not a match, so the record it returns IS this contact. The
//     LinkedIn rule above normally fires first; this is the backstop for a
//     profile whose slug LinkedIn has since renamed (the old URL redirects).
//
// Apollo, the original offender, gets no exemption: its match must show
// evidence in the returned record. And the HarvestAPI exemption needs the
// contact to hold a URL — a HarvestAPI lookup keyed on a URL APOLLO found is
// only as good as Apollo's match, so it carries Apollo's corroboration
// explicitly instead (`EnrichedData.identity`), as does an Apollo address
// merged into a HarvestAPI profile. The address is always judged on the
// record it came from.
//
// An uncorroborated address is not written anywhere — not Primary, not
// Secondary, not the Table — and is named in the outcome comment for a human to
// judge. Title, city, country and bio are still written: those are visible on
// the page and carry no identity downstream, and in the Grace case they were
// in fact correct. An uncorroborated Apollo match's LinkedIn URL and photo are
// NOT kept (see `enrichViaApollo`): a URL on the contact is itself identity,
// since it keys every later HarvestAPI lookup and satisfies the LinkedIn rule.

interface IdentityCorroboration {
  verified: boolean;
  /** Which signal cleared it, or why nothing did. For the outcome comment. */
  how: string;
}

function corroborateEnrichedIdentity(
  contact: ContactData,
  enriched: EnrichedData,
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

  if (enriched.emailSource === "harvestapi" && contact.linkedinUrl.trim()) {
    // Looked up by the contact's own LinkedIn URL: the profile is theirs.
    return { verified: true, how: "resolved from the contact's own LinkedIn URL" };
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
// view. HarvestAPI (like Apollo before it) hands back LinkedIn's CDN link
// verbatim, and those links are
// signed and time-limited — `…?e=<unix-expiry>&v=beta&t=<signature>`. A few
// weeks after enrichment the URL starts 403ing and Notion, having stored the
// dead link forever, renders empty white space: the page still *has* an icon
// and cover, they just draw as nothing. Nothing errors, so it goes unnoticed.
// An audit on 2026-08-12 found 210 of 962 contacts already in that state.
//
// Storing the bytes in Notion instead makes it permanent. The PATCH comes back
// as `type: "file"` on Notion's own S3, whose URL Notion re-signs on each read.
// One upload backs both the icon and the cover — verified 2026-08-12 against a
// live contact, and again 2026-10-07; the docs don't state it either way.
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
 *  HarvestAPI hands back are LinkedIn CDN links with no extension in
 *  the path, so the extension is taken from the path when there is one and
 *  falls back to `.jpg`, which is what LinkedIn serves. The stored file's real
 *  content type comes from the response Notion fetches, not from this name. */
function photoFilename(photoUrl: string): string {
  const path = photoUrl.split("?")[0];
  const ext = path.match(/\.(jpe?g|png|webp|gif)$/i)?.[1];
  return `profile-photo.${ext ? ext.toLowerCase() : "jpg"}`;
}

/** Hand `photoUrl` to Notion to fetch and store, returning the file upload id
 *  to attach as the icon. Throws on any failure — `PlaceholderPhotoError`
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
//                                    (removed 2026-09-18; back 2026-10-07,
//                                    from HarvestAPI's photo)
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
): Promise<{
  emailPath: string;
  iconUpdated: boolean;
  iconError?: string;
  unverifiedEmail?: string;
  identity?: string;
  linkedinWritten: boolean;
}> {
  // An enriched name never replaces a part the contact already has — it only
  // fills a blank one (a contact titled with a bare email). A HarvestAPI name
  // is LinkedIn's display name, which people decorate ("Jane Doe, MBA", "Jane
  // Doe 🚀"); an Apollo name may belong to a fuzzy match; and either would
  // erase an alternate-script aside ("(彭思瑀)") the CRM holds.
  const firstName = contact.firstName || enriched.firstName;
  const lastName = contact.lastName || enriched.lastName;
  const fullName = `${firstName} ${lastName}`.trim();

  // --- LinkedIn URL: write only a real change ---
  // Writing `Linkedin` fires the Contacts automation that triggers this
  // workflow (see "Loop guard"), so the property is left alone when the found
  // profile is the one already there, however the URL is spelled. A contact
  // with no profile URL gets the found one (an uncorroborated Apollo match
  // arrives with none — see `enrichViaApollo`); one whose URL HarvestAPI
  // resolved to a different slug (a renamed profile) gets the current one. An
  // Apollo URL never replaces one the contact holds.
  const ownSlug = normalizeLinkedin(contact.linkedinUrl);
  const foundSlug = normalizeLinkedin(enriched.linkedinUrl);
  const linkedinToWrite =
    !foundSlug || foundSlug === ownSlug
      ? ""
      : !ownSlug || enriched.source === "harvestapi"
        ? enriched.linkedinUrl
        : "";

  // --- Gate the enriched address on identity corroboration ---
  // See "Identity corroboration" above. An address that cannot be tied to this
  // contact is dropped here, before any path logic sees it: the rest of this
  // function then behaves exactly as it does for a source that returned no
  // email at all, so nothing reaches Primary, Secondary or the Table.
  const identity = enriched.newEmail
    ? (enriched.identity ?? corroborateEnrichedIdentity(contact, enriched))
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
    "properties|||Linkedin|||url": linkedinToWrite,
    "properties|||Job Title|||rich_text": enriched.jobTitle,
    "properties|||Primary Phone|||phone_number": "",
    "properties|||First Name|||rich_text": firstName,
    "properties|||Last Name|||rich_text": lastName,
    "properties|||Bio|||rich_text": enriched.bio,
    "properties|||Country|||select": selectOption(enriched.country),
    "properties|||City|||select": selectOption(enriched.city),
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
    return { emailPath: "page-archived", iconUpdated: false, linkedinWritten: false };
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

  // --- Update the page icon + cover from the profile photo (Path C) ---
  //
  // The photo is uploaded to Notion rather than linked. See "Profile photo
  // storage" above: linking the source URL is what left 210 contacts rendering
  // a blank icon and cover once the signed link expired. The one upload backs
  // both.
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
      // Not a failure: the profile has no photo and said so with a picture of
      // nobody. Logged so the run history shows it was seen.
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
    linkedinWritten: Boolean(linkedinToWrite),
  };
}

// --- Add outcome comment to the triggering page ----------------------------
//
// After every run (success or skip), posts a brief comment on the Notion
// page that triggered the webhook. It mentions nobody: the payload's user ids
// are often bots, and a bot mention makes Notion reject the whole comment.

interface WorkflowResult {
  pageId: string;
  enriched: boolean;
  /** Which enrichment source produced the profile, when enriched. */
  source?: EnrichmentSource;
  /** Which source produced the written email, when one was written and it
   *  differs from `source` (HarvestAPI profile + Apollo address). */
  emailSource?: EnrichmentSource;
  /** True when the HarvestAPI lookup was keyed on a LinkedIn URL that Apollo
   *  found, the contact having had none. */
  linkedinViaApollo?: boolean;
  /** Whether the `Linkedin` property was written this run. */
  linkedinWritten?: boolean;
  reason?: string;
  /** Failure notes, one entry per source that failed (in order). Kept as a
   *  list so the outcome comment can show each on its own — joining them first
   *  and truncating after is what once hid a fallback's "no result" behind a
   *  verbose primary-source error and made the fallback look like it never ran
   *  (TKT-811). */
  reasons?: string[];
  emailPath?: string;
  /** Whether the page icon was set from the profile photo (Path C). */
  iconUpdated?: boolean;
  /** Why the photo could not be stored, when it could not. */
  iconError?: string;
  /** An enriched address that was NOT written because it could not be tied to
   *  this contact (Path U). Named in the outcome comment so a person can judge
   *  it — the whole point of the guard is that this is visible, not silent. */
  unverifiedEmail?: string;
  /** Why `unverifiedEmail` failed corroboration. */
  identity?: string;
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

/** A single source's failure reason parsed into a source label
 *  ("HarvestAPI", "Apollo", or null) and a short human-readable phrase. Unwraps the
 *  JSON error body and strips any HTML that upstream errors arrive in. */
function parseFailure(why: string): { source: string | null; brief: string } {
  let s = why.replace(/\s+/g, " ").trim();
  let source: string | null = null;
  const src = s.match(/^(harvestapi|apollo)\s+/i);
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
  // any markup embedded in it. Vendors key it `error` or `message`.
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
    if (result.linkedinWritten) changes.push("LinkedIn URL");
    changes.push("contact details");
    if (result.iconUpdated) changes.push("profile icon and cover");
    let via = result.source ? SOURCE_LABELS[result.source] : "enrichment";
    if (result.linkedinViaApollo) via += " (LinkedIn profile found by Apollo)";
    if (result.emailSource && result.emailSource !== result.source) {
      via += ` (email via ${SOURCE_LABELS[result.emailSource]})`;
    }
    summary = `Contact enriched via ${via} and updated: ${changes.join(", ")}.`;
    // An address the source returned but that could not be tied to this contact
    // (Path U). Worth naming prominently: it is either a real address this
    // contact owns and nobody has recorded, or evidence the source matched a
    // different person of the same name. Only a human can tell which.
    if (result.unverifiedEmail) {
      summary += ` Email ${result.unverifiedEmail} NOT written — ${result.identity ?? "could not be corroborated"}. Add it by hand if it is really theirs.`;
    }
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

  // No @mention. It used to mention the payload's acting user, falling back to
  // the page's last editor / creator — routinely Notion's system user or an
  // integration bot when another integration's write fired the automation.
  // Notion rejects the WHOLE comment for that (`400 Cannot mention bots`,
  // `404 Could not find user`): 18 of 45 runs from 2026-09-22 to 10-02 left
  // the contact with no outcome comment. Removed 2026-10-03.
  const richText = [{ type: "text", text: { content: summary } }];

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

// --- HarvestAPI lookup ---------------------------------------------------------
//
// `find_profile` by a LinkedIn URL — the contact's own, or (the handoff) one
// Apollo found for a contact that had none. Errors are caught inside the step
// and become a reason, so a failing vendor falls through instead of spinning
// the step-retry loop. Takes `ctx` and the step id so the body can call it
// twice with two literal ids. Pushes a reason for every outcome that is not a
// profile with a verified address.

async function findHarvestProfile(
  ctx: DurableCtx,
  stepId: string,
  url: string,
  pageId: string,
  reasons: string[],
): Promise<EnrichedData | null> {
  const found = await ctx.step(stepId, async () => {
    try {
      const findProfile = () =>
        sdk.runAction({
          appKey: HARVESTAPI_APP_KEY,
          actionType: "search",
          actionKey: "find_profile",
          connection: HARVESTAPI_CONNECTION,
          inputs: {
            url: asciiUrl(url),
            findEmail: "true",
            skipSmtp: "false",
          },
        });
      let res: unknown;
      try {
        res = await findProfile();
      } catch (err) {
        // One retry, on the platform's 30s action timeout only: the lookup
        // is a read, and HarvestAPI answers a repeat of a slow lookup fast.
        if (!isActionTimeout(err)) throw err;
        console.log(`HarvestAPI timed out for ${pageId}; retrying once`);
        res = await findProfile();
      }
      const row = firstResult(res);
      if (!harvestRowUsable(row)) {
        return { enriched: null as EnrichedData | null, unwritable: "", error: null as string | null };
      }
      const enriched = extractEnrichedFromHarvest(row);
      // An address HarvestAPI returned but did not verify, for the comment.
      const unwritable = enriched.newEmail
        ? ""
        : (firstString(row?.email, row?.emails?.[0]?.email) ?? "");
      return { enriched, unwritable, error: null as string | null };
    } catch (err) {
      return {
        enriched: null as EnrichedData | null,
        unwritable: "",
        error: String((err as Error)?.message ?? err),
      };
    }
  });

  if (found.error) {
    reasons.push(`harvestapi error: ${found.error}`);
    console.log(`HarvestAPI failed for ${pageId}: ${found.error}`);
    return null;
  }
  if (!found.enriched) {
    reasons.push("harvestapi returned no result");
    console.log(`HarvestAPI found no profile for ${pageId} at ${url}`);
    return null;
  }
  if (!found.enriched.newEmail) {
    reasons.push(
      found.unwritable
        ? `harvestapi found ${found.unwritable} but could not verify it; not written`
        : "harvestapi found the profile but no email",
    );
  }
  console.log(
    `HarvestAPI found ${pageId}'s profile` +
      (found.enriched.newEmail ? " with a verified email" : " without a verified email"),
  );
  return found.enriched;
}

// --- Apollo (fallback source) --------------------------------------------------
//
// One synchronous `people/match`, through `sdk.fetch` on the API by Zapier
// connection (Apollo's key rides on the connection, never in source). It is
// sent every identifier the contact holds — email, LinkedIn URL, name +
// domain — and matches on any of them, so its result must be corroborated
// against the CRM before anything identity-bearing is kept: the match is
// judged once here (`identity`), and an uncorroborated match loses its
// LinkedIn URL and photo on the spot, so neither the handoff below nor the
// write-back can use them. Errors are caught inside the step and become a
// reason; a non-2xx (out of credits, rate limit) falls through without retry.

async function enrichViaApollo(
  ctx: DurableCtx,
  contact: ContactData,
  reasons: string[],
): Promise<{ data: EnrichedData; identity: IdentityCorroboration } | null> {
  const name = Boolean(contact.matchFirstName && contact.matchLastName);
  if (!contact.primaryEmail && !contact.linkedinUrl && !(name && contact.domain)) {
    const why = !name
      ? "skipped — no email, LinkedIn URL or first + last name to match on"
      : "skipped — no email or LinkedIn URL, and no company domain to pair with the name";
    reasons.push(`apollo ${why}`);
    console.log(`Apollo ${why} for ${contact.pageId}`);
    return null;
  }

  const match = await ctx.step("apollo-match", async () => {
    try {
      const body: Record<string, unknown> = {
        // Keep credit spend minimal: no phone data, no personal emails.
        reveal_personal_emails: false,
        reveal_phone_number: false,
      };
      if (contact.matchFirstName) body.first_name = contact.matchFirstName;
      if (contact.matchLastName) body.last_name = contact.matchLastName;
      if (contact.domain) body.domain = contact.domain;
      if (contact.primaryEmail) body.email = contact.primaryEmail;
      if (contact.linkedinUrl) body.linkedin_url = asciiUrl(contact.linkedinUrl);
      const res = await sdk.fetch(APOLLO_MATCH_URL, {
        connection: APOLLO_CONNECTION,
        method: "POST",
        headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        return { person: null as any, error: `http ${res.status}: ${text.slice(0, 300)}` };
      }
      let person: any = null;
      try {
        person = JSON.parse(text)?.person ?? null;
      } catch {
        return { person: null as any, error: `non-JSON response: ${text.slice(0, 200)}` };
      }
      return { person, error: null as string | null };
    } catch (err) {
      return { person: null as any, error: String((err as Error)?.message ?? err) };
    }
  });

  if (match.error) {
    reasons.push(`apollo error: ${match.error}`);
    console.log(`Apollo failed for ${contact.pageId}: ${match.error}`);
    return null;
  }
  if (!apolloPersonUsable(match.person)) {
    reasons.push("apollo returned no result");
    console.log(`Apollo found no match for ${contact.pageId}`);
    return null;
  }

  const data = extractEnrichedFromApollo(match.person);
  const identity = corroborateEnrichedIdentity(contact, data);
  data.identity = identity;
  if (!identity.verified) {
    // A fuzzy match nothing ties to this contact: keep nothing that carries
    // identity. The address goes to Path U and is named in the comment.
    if (data.linkedinUrl) {
      reasons.push(`apollo match not corroborated (${identity.how}); its LinkedIn URL ${data.linkedinUrl} was not used`);
    }
    data.linkedinUrl = "";
    data.profilePicUrl = "";
  }
  if (!data.newEmail) {
    const raw = apolloRawEmail(match.person?.email);
    reasons.push(
      raw
        ? `apollo found ${raw} but its status is ${firstString(match.person?.email_status) ?? "unknown"}; not written`
        : "apollo found the person but no email",
    );
  }
  console.log(
    `Apollo matched ${contact.pageId} (${identity.verified ? "corroborated" : "NOT corroborated"}: ${identity.how})`,
  );
  return { data, identity };
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

    // The echo of this workflow's own write (see "Loop guard"). The bot id is
    // read only when the payload already looks like an echo; a failed read
    // returns "" and the run proceeds — a redundant run beats a missed one.
    if (isOwnWriteEchoCandidate(contact)) {
      const botId = await ctx.step("notion-bot-user", async () => {
        try {
          const res = await sdk.fetch(`${NOTION_API}/users/me`, {
            connection: NOTION_CONNECTION,
            method: "GET",
            headers: { "Notion-Version": NOTION_VERSION },
          });
          if (!res.ok) return "";
          return firstString((await res.json())?.id) ?? "";
        } catch {
          return "";
        }
      });
      if (botId && botId === contact.lastEditedBy) {
        console.log(
          `Skipping ${contact.pageId}: triggered by this workflow's own write (last edit ${contact.lastEditedTime}, Last Enriched ${contact.lastEnriched}).`,
        );
        return { skipped: "own-write-echo", pageId: contact.pageId };
      }
    }

    console.log(
      `Enriching contact ${contact.pageId}: ${contact.firstName} ${contact.lastName}`.trim(),
    );

    // 1. HarvestAPI, when the contact has a LinkedIn URL: a direct lookup by
    //    that URL, returning the profile and, when it can, an SMTP-checked
    //    address.
    // 2. Apollo, when HarvestAPI did not produce a verified address: no
    //    LinkedIn URL, no profile, an error, or a profile with no address. In
    //    the last case HarvestAPI's profile is kept and only Apollo's address
    //    is taken.
    // 3. The handoff: when the contact had NO LinkedIn URL and Apollo's
    //    corroborated match carries one, HarvestAPI is asked with it — it reads
    //    LinkedIn better than Apollo does. If it finds nothing, Apollo's data
    //    stands.
    const reasons: string[] = [];
    let harvest: EnrichedData | null = null;
    let linkedinViaApollo = false;

    if (!contact.linkedinUrl) {
      console.log(`No LinkedIn URL on ${contact.pageId}; HarvestAPI not tried first`);
    } else {
      harvest = await findHarvestProfile(
        ctx, "harvestapi-find-profile", contact.linkedinUrl, contact.pageId, reasons,
      );
    }

    let enrichedData: EnrichedData | null = harvest;
    if (!harvest?.newEmail) {
      const apollo = await enrichViaApollo(ctx, contact, reasons);
      if (apollo && harvest) {
        enrichedData = apollo.data.newEmail
          ? mergeApolloEmail(harvest, apollo.data, apollo.identity)
          : harvest;
      } else if (apollo && !contact.linkedinUrl && apollo.data.linkedinUrl) {
        // `linkedinUrl` survives only on a corroborated match.
        const handoff = await findHarvestProfile(
          ctx, "harvestapi-find-profile-from-apollo", apollo.data.linkedinUrl, contact.pageId, reasons,
        );
        if (!handoff) {
          enrichedData = apollo.data;
        } else {
          linkedinViaApollo = true;
          enrichedData = handoff.newEmail
            ? {
                ...handoff,
                identity: {
                  verified: true,
                  how: `resolved from the LinkedIn URL of an Apollo match that ${apollo.identity.how}`,
                },
              }
            : apollo.data.newEmail
              ? mergeApolloEmail(handoff, apollo.data, apollo.identity)
              : handoff;
        }
      } else if (apollo) {
        enrichedData = apollo.data;
      }
    }

    let result: WorkflowResult;

    if (!enrichedData) {
      result = {
        pageId: contact.pageId,
        enriched: false,
        reason: reasons.join("; ") || "no result from enrichment",
        reasons,
      };
    } else {
      // 4. Update the contact record (inline sub-zap logic).
      const updateResult = await updateContactRecord(ctx, contact, enrichedData);
      result = {
        pageId: contact.pageId,
        enriched: true,
        source: enrichedData.source,
        emailSource:
          enrichedData.emailSource && enrichedData.emailSource !== enrichedData.source
            ? enrichedData.emailSource
            : undefined,
        linkedinViaApollo: linkedinViaApollo || undefined,
        // Notes from sources tried before (or alongside) the one that did the
        // work — e.g. HarvestAPI found no address, or Apollo found no email.
        reasons: reasons.length ? reasons : undefined,
        ...updateResult,
      };
    }

    // 5. Add a brief comment to the triggering page stating the outcome.
    const comment = await addOutcomeComment(ctx, contact, result);

    return { ...result, commentPosted: comment.posted, commentError: comment.error };
  },
);

export default workflow;
