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
// SYNCHRONOUSLY (~17s, verified live 2026-10-07) with the profile — name,
// headline, about, current title + company, parsed location — and, with
// `findEmail`, an SMTP-checked `emails[]`. An unknown URL answers with an empty
// `data` array, not an error. The booleans are the strings "true" / "false".
const HARVESTAPI_APP_KEY = "App242893CLIAPI";
const HARVESTAPI_CONNECTION = "harvestapi";
/** Notion caps a rich_text segment at 2000 characters; a LinkedIn "about"
 *  can run longer. */
const BIO_MAX_CHARS = 2000;
// Fallback enrichment: BetterContact. `enrich_contact` submits an ASYNC waterfall job
// and answers with a request id at once; the result lands later, either POSTed
// to the `webhook` URL sent with the job (this durable's own callback URL — see
// the workflow body) or read back with `get_contact` by request id. Only
// `status: "terminated"` carries results (`not_started` / `processing` are
// still running; `on_hold` means the account is out of credits and the job
// resumes by itself once topped up). Verified live 2026-09-18: the webhook
// reached the durable's callback ~90s after submit and the run resumed with the
// payload; the body is identical to `GET /async/{request_id}`.
const BETTERCONTACT_APP_KEY = "App217413CLIAPI";
const BETTERCONTACT_CONNECTION = "bettercontact";
/** How long the run parks for BetterContact's webhook before falling back to
 *  polling. Delivery is normally well under two minutes; ten minutes covers a
 *  slow waterfall without leaving a run parked all day. */
const CALLBACK_TIMEOUT_SECONDS = 600;
/** Polling fallback, used only when the webhook never arrives (delivery lost,
 *  or the job is `on_hold`). Waits are free; each poll is a billed action, so
 *  the loop is short. */
const POLL_ATTEMPTS = 5;
const POLL_WAIT_SECONDS = 60;
/** Email verification statuses that may be written to the contact. A plain
 *  `catch_all` (unverified) or `undeliverable` address is reported in the
 *  outcome comment but never written. */
const WRITABLE_EMAIL_STATUSES = new Set(["deliverable", "catch_all_safe"]);

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

// --- Names and URLs as sent to BetterContact -------------------------------
//
// BetterContact's public Zapier integration (App217413, v1.0.3 — not ours to
// change) copies the contact's name into an HTTP header. The platform's HTTP
// client rejects any header value holding a character above U+00FF, client
// side, before the request leaves: "SY Peng (彭思瑀) is not a legal HTTP header
// value" failed the run for "Alice SY Peng (彭思瑀)" twice on 2026-10-01.
// Latin-1 accents (José, Müller) pass; Łukasz, Иван and 彭思瑀 do not.
//
// Percent-encoding the name would get it past the client, but BetterContact
// would then match on the literal "%E5%BD%AD…", which matches nobody. So the
// name is RENDERED instead: the parenthesised alternate-script name is dropped
// (the Latin name beside it is the one a work address is built from), accents
// outside Latin-1 are folded, and a name that still cannot be carried is not
// sent at all — the run skips BetterContact with a reason naming the fix
// (a romanised First/Last Name), rather than failing with a header error.
//
// The rendering is for the REQUEST only. The contact's own name is what gets
// written back to Notion; see `updateContactRecord`.

/** True when every character fits an HTTP header value as the platform's
 *  client checks it: tab, printable ASCII, or Latin-1 (U+0080–U+00FF). */
function isHeaderSafe(s: string): boolean {
  return /^[\t\x20-\x7e\x80-\xff]*$/.test(s);
}

/** Letters with no canonical decomposition, so NFD alone cannot fold them. */
const FOLD_EXTRA: Record<string, string> = {
  "Ł": "L", "ł": "l", "Đ": "D", "đ": "d", "Ħ": "H", "ħ": "h", "ı": "i",
  "Œ": "OE", "œ": "oe", "Ŋ": "N", "ŋ": "n", "Ŧ": "T", "ŧ": "t",
};

/** Characters above U+00FF folded to Latin where a fold exists (Łukasz →
 *  Lukasz, Nguyễn → Nguyen); Latin-1 characters are left exactly as they are,
 *  since those already travel. Anything with no fold (CJK, Cyrillic) is kept,
 *  for `isHeaderSafe` to catch. */
function foldBeyondLatin1(s: string): string {
  return Array.from(s)
    .map((ch) => {
      if (ch.charCodeAt(0) <= 0xff) return ch;
      if (FOLD_EXTRA[ch]) return FOLD_EXTRA[ch];
      const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
      return base.normalize("NFC");
    })
    .join("");
}

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
 * The first + last name BetterContact is asked to match on.
 *
 * - Parenthesised asides are dropped from both parts: an alternate-script name
 *   ("Alice SY Peng (彭思瑀)") is not how the work address is spelled.
 * - When the split came from the page TITLE (no First/Last Name set), initials
 *   between the first and last word are dropped too — "Alice SY Peng" asks for
 *   Alice Peng, the name an alice.peng@ address is built from, not "SY Peng".
 *   Lowercase particles stay ("Jan van der Berg" keeps "van der Berg"). Names
 *   typed into First/Last Name are trusted as given.
 * - Accents beyond Latin-1 are folded. If a part still holds a character the
 *   integration cannot carry, both come back empty and the request is skipped.
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
  first = foldBeyondLatin1(first);
  last = foldBeyondLatin1(last);
  if (!isHeaderSafe(first) || !isHeaderSafe(last)) {
    return { firstName: "", lastName: "" };
  }
  return { firstName: first, lastName: last };
}

/** A URL with every non-ASCII run percent-encoded. Unlike a name, a URL means
 *  the same thing encoded (linkedin.com/in/彭思瑀 is linkedin.com/in/%E5%BD%AD…),
 *  so it is encoded rather than dropped, in case the integration puts it in a
 *  header too. */
function asciiUrl(url: string): string {
  return url.replace(/[^\x00-\x7f]+/g, (run) => encodeURIComponent(run));
}

// --- Contact data extracted from the Notion webhook payload ---------------

interface ContactData {
  pageId: string;
  /** The contact's own name, as the CRM holds it. Written back unchanged. */
  firstName: string;
  lastName: string;
  /** The name as sent to BetterContact — see `matchName`. Empty when the
   *  name cannot be rendered in characters the integration can carry. */
  matchFirstName: string;
  matchLastName: string;
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

  // BetterContact matches on first + last name + employer domain — a work
  // email is not an input at all and a LinkedIn URL only sharpens a match (the
  // retired NinjaPear fallback behaved the same way, verified 2026-07-28). That
  // makes the domain the load-bearing identifier, so when the Company relation
  // is missing or unusable, fall back to the Primary Email's own host: for any
  // non-consumer address that IS the employer's domain.
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
  // is not a name.
  let firstName = plainText(props["First Name"]?.rich_text).trim();
  let lastName = plainText(props["Last Name"]?.rich_text).trim();
  let fromTitle = false;
  if (!firstName && !lastName) {
    const title = plainText(props["Name"]?.title).trim();
    if (title && !title.includes("@")) {
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
  };
}

// --- Enrichment result extraction ------------------------------------------

/** HarvestAPI first when the contact has a LinkedIn URL, BetterContact as the
 *  fallback. Corroboration keeps its per-source shape. */
type EnrichmentSource = "harvestapi" | "bettercontact";

const SOURCE_LABELS: Record<EnrichmentSource, string> = {
  harvestapi: "HarvestAPI",
  bettercontact: "BetterContact",
};

interface EnrichedData {
  /** The source the profile fields came from. */
  source: EnrichmentSource;
  /** The source `newEmail` came from — differs from `source` when HarvestAPI
   *  found the profile but no deliverable address and BetterContact supplied
   *  one. Corroboration is judged against this source. Null with no email. */
  emailSource: EnrichmentSource | null;
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

// --- HarvestAPI result extraction ------------------------------------------
//
// One row of `find_profile`'s `data[]`, shape captured from a live run on
// 2026-10-07: `firstName`, `lastName`, `linkedinUrl`, `about`,
// `currentJobTitle`, `location.parsed.{city,country}`, `experience[]` (each
// with `company.website`), and `emails[]` of
// `{ email, deliverable, catchAllDomain, status, qualityScore }`. The row also
// carries `photo`, which is deliberately not used — see the README's photo
// notes before wiring it in.

/** The first address HarvestAPI verified, or "". Only `deliverable: true` with
 *  `status: "valid"` counts, the counterpart of BetterContact's
 *  WRITABLE_EMAIL_STATUSES; anything else is reported, never written. */
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
  };
}

/** HarvestAPI's profile with BetterContact's address filled in, for a profile
 *  that came back without a deliverable email. Profile fields stay
 *  HarvestAPI's (read straight off LinkedIn) where it has them. */
function mergeBetterContactEmail(
  harvest: EnrichedData,
  bc: EnrichedData,
): EnrichedData {
  return {
    ...harvest,
    emailSource: bc.newEmail ? "bettercontact" : null,
    newEmail: bc.newEmail,
    country: harvest.country || bc.country,
    city: harvest.city || bc.city,
    jobTitle: harvest.jobTitle || bc.jobTitle,
    linkedinUrl: harvest.linkedinUrl || bc.linkedinUrl,
    allEmails: dedupeAddresses([...harvest.allEmails, ...bc.allEmails]),
    // The employer domain corroborates BetterContact's address, so it is the
    // record that address came from that speaks for it.
    employerDomain: bc.employerDomain || harvest.employerDomain,
  };
}

// --- BetterContact result extraction ---------------------------------------
//
// One row of the terminated response's `data[]` — BetterContact's field names
// (`contact_*`, `company_*`), shape captured from a live run on 2026-09-18.
// An email-only waterfall fills the identity fields (email + status, LinkedIn
// URL, company domain, country) and leaves most profile fields (`contact_job_title`,
// `contact_city`) null unless a provider happened to return them — so a
// BetterContact enrichment is usually an address, not a full profile, and the
// page's Bio is left as it is. BetterContact never returns a photo
// (`contact_avatar` is a legacy always-null key), and no other acceptable source
// does either, so the former Path C icon/cover update was removed 2026-09-18.

/** The row's address, or "" when there is none or its verification status is
 *  not one we write (see WRITABLE_EMAIL_STATUSES). */
function betterContactEmail(row: any): string {
  const email = firstString(row?.contact_email_address);
  if (!email) return "";
  const status = (firstString(row?.contact_email_address_status) ?? "").toLowerCase();
  return WRITABLE_EMAIL_STATUSES.has(status) ? email : "";
}

/** True when the row carries at least one signal worth writing. */
function betterContactRowUsable(row: any): boolean {
  if (!row || typeof row !== "object") return false;
  return Boolean(
    betterContactEmail(row) ||
      row.contact_job_title ||
      row.contact_linkedin_profile_url ||
      row.contact_location_country,
  );
}

function extractEnrichedFromBetterContact(row: any): EnrichedData {
  const rawEmail = firstString(row?.contact_email_address) ?? "";
  const newEmail = betterContactEmail(row);
  return {
    source: "bettercontact",
    emailSource: newEmail ? "bettercontact" : null,
    linkedinUrl: firstString(row?.contact_linkedin_profile_url) ?? "",
    country: firstString(row?.contact_location_country, row?.contact_country) ?? "",
    city: firstString(row?.contact_city, row?.contact_location_city) ?? "",
    newEmail,
    // BetterContact returns no biography; "" is a no-change write.
    bio: "",
    jobTitle: firstString(row?.contact_job_title) ?? "",
    firstName: firstString(row?.contact_first_name) ?? "",
    lastName: firstString(row?.contact_last_name) ?? "",
    // The raw address, whatever its status: corroboration only compares it
    // against addresses the contact already holds, it never writes it.
    allEmails: dedupeAddresses(rawEmail ? [rawEmail] : []),
    employerDomain: normalizeDomain(firstString(row?.company_domain)),
  };
}

// --- BetterContact async job handling ---------------------------------------

/** What a BetterContact status body says, whether it arrived by webhook or by
 *  polling. `status` is BetterContact's (`terminated` | `processing` |
 *  `not_started` | `on_hold`), or "error" / "unknown" for a call that failed or
 *  answered with no status. `row` is `data[0]` when present. */
interface BetterContactOutcome {
  status: string;
  row: any;
  error?: string;
}

function readBetterContactResult(payload: unknown): BetterContactOutcome {
  const body = (payload ?? {}) as any;
  const status = String(body?.status ?? "unknown").toLowerCase();
  const row = Array.isArray(body?.data) ? (body.data[0] ?? null) : null;
  return { status, row };
}

/** Polling fallback for a job whose webhook never arrived: wait, read the job
 *  back with `get_contact`, stop on a terminal status. Takes `ctx` so the
 *  loop-indexed step ids live outside the workflow body, which the publish-time
 *  analyzer requires to use string-literal ids. A `get_contact` that throws
 *  while the job is still running (Zapier searches may error on a 202 body) is
 *  treated as "not yet" and polled again. */
async function pollBetterContactResult(
  ctx: DurableCtx,
  stepPrefix: string,
  requestId: string,
): Promise<BetterContactOutcome> {
  let last: BetterContactOutcome = { status: "unknown", row: null };
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    await ctx.wait(`${stepPrefix}-poll-wait-${i}`, POLL_WAIT_SECONDS);
    last = await ctx.step(`${stepPrefix}-poll-${i}`, async () => {
      try {
        const res = await sdk.runAction({
          appKey: BETTERCONTACT_APP_KEY,
          actionType: "search",
          actionKey: "get_contact",
          connection: BETTERCONTACT_CONNECTION,
          inputs: { id: requestId },
        });
        return readBetterContactResult(firstResult(res));
      } catch (err) {
        return {
          status: "error",
          row: null,
          error: String((err as Error)?.message ?? err),
        } as BetterContactOutcome;
      }
    });
    console.log(`BetterContact poll ${i + 1}/${POLL_ATTEMPTS} for ${requestId}: ${last.status}`);
    if (last.status === "terminated" || last.status === "on_hold") return last;
  }
  return last;
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
//   * the source only resolves on an identifier the CRM already holds, so the
//     record it returns IS this contact. Two sources qualify:
//       - HarvestAPI looks the profile up by the contact's own LinkedIn URL —
//         an exact key, not a match. The LinkedIn rule above normally fires
//         first; this is the backstop for a profile whose slug LinkedIn has
//         since renamed (the old URL redirects to the new one).
//       - BetterContact is gated on first + last name + the contact's own
//         company domain, so any record it returns is a person at the employer
//         already recorded. Its result echoes `company_domain`, so in practice
//         the domain rule fires first.
//
// The exemption is judged against the source the EMAIL came from
// (`emailSource`), not the source of the profile: when HarvestAPI finds the
// profile and BetterContact the address, it is BetterContact's lookup that has
// to vouch for the address. The per-source shape is kept (Apollo's fuzzy
// name-only match was the original offender, and needed evidence in the
// returned record) so a future fuzzy source does not inherit the gated-lookup
// exemption by accident.
//
// An uncorroborated address is not written anywhere — not Primary, not
// Secondary, not the Table — and is named in the outcome comment for a human to
// judge. Everything else the source returned (title, city, country) is still
// written: those are visible on the page and carry no identity downstream, and
// in the Grace case they were in fact correct.

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

  if (enriched.emailSource === "harvestapi") {
    // Looked up by the contact's own LinkedIn URL: the profile is theirs.
    return { verified: true, how: "resolved from the contact's own LinkedIn URL" };
  }

  if (enriched.emailSource === "bettercontact") {
    // The request is gated on the contact's own first + last name + company
    // domain, so the record is a person at the employer the CRM already holds.
    return { verified: true, how: "resolved from the contact's own company domain and name" };
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
//                                    (removed 2026-09-18: no source returns photos)
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
  unverifiedEmail?: string;
  identity?: string;
}> {
  // When the request name was a lossy rendering of the contact's own (an
  // alternate-script aside dropped, accents folded), BetterContact echoes the
  // rendering back; writing that would erase "(彭思瑀)" from the CRM. Keep the
  // contact's own name then, and take BetterContact's only when ours was sent
  // as it stands.
  //
  // A HarvestAPI profile name is LinkedIn's display name, which people decorate
  // ("Jane Doe, MBA", "Jane Doe 🚀"), so it never replaces a name the contact
  // already has — it only fills one in (a contact titled with a bare email).
  const keepOwnName =
    contact.matchFirstName !== contact.firstName ||
    contact.matchLastName !== contact.lastName ||
    (enriched.source === "harvestapi" &&
      Boolean(contact.firstName || contact.lastName));
  const firstName = keepOwnName
    ? contact.firstName
    : enriched.firstName || contact.firstName;
  const lastName = keepOwnName
    ? contact.lastName
    : enriched.lastName || contact.lastName;
  const fullName = `${firstName} ${lastName}`.trim();

  // --- Gate the enriched address on identity corroboration ---
  // See "Identity corroboration" above. An address that cannot be tied to this
  // contact is dropped here, before any path logic sees it: the rest of this
  // function then behaves exactly as it does for a source that returned no
  // email at all, so nothing reaches Primary, Secondary or the Table.
  const identity = enriched.newEmail
    ? corroborateEnrichedIdentity(contact, enriched)
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
    return { emailPath: "page-archived" };
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

  return {
    emailPath,
    unverifiedEmail: unverifiedEmail || undefined,
    identity: unverifiedEmail ? identity.how : undefined,
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
   *  differs from `source` (HarvestAPI profile + BetterContact address). */
  emailSource?: EnrichmentSource;
  reason?: string;
  /** Failure notes, one entry per source that failed (in order). Kept as a
   *  list so the outcome comment can show each on its own — joining them first
   *  and truncating after is what once hid a fallback's "no result" behind a
   *  verbose primary-source error and made the fallback look like it never ran
   *  (TKT-811). */
  reasons?: string[];
  emailPath?: string;
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
 *  ("HarvestAPI", "BetterContact", or null) and a short human-readable phrase. Unwraps the
 *  JSON error body and strips any HTML that upstream errors arrive in. */
function parseFailure(why: string): { source: string | null; brief: string } {
  let s = why.replace(/\s+/g, " ").trim();
  let source: string | null = null;
  const src = s.match(/^(harvestapi|bettercontact)\s+/i);
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
    changes.push("contact details");
    let via = result.source ? SOURCE_LABELS[result.source] : "enrichment";
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

// --- BetterContact (fallback source) -----------------------------------------
//
// Enrich via BetterContact. The request is an ASYNC job:
// `enrich_contact` answers with a request id straight away and the
// waterfall runs on BetterContact's side. Rather than poll, the run
// hands BetterContact its own callback URL (`ctx.createCallback`) as the
// job's `webhook` and parks; BetterContact POSTs the finished result to
// it and the run resumes with the payload. Polling `get_contact` is the
// fallback for a webhook that never arrives. Every BetterContact call
// catches its own errors and returns a value, so a failing vendor does
// NOT spin the durable's step-retry loop — it becomes a reason in the
// outcome comment.
//
// Lives outside the workflow body so the body reads as the source order; its
// step ids, callback name and helper prefix are string literals, as they were
// in the body. Pushes a reason for every outcome that is not a usable row.

async function enrichViaBetterContact(
  ctx: DurableCtx,
  contact: ContactData,
  reasons: string[],
): Promise<EnrichedData | null> {
  let enriched: EnrichedData | null = null;

  // BetterContact matches on first + last name plus the employer domain; a
  // LinkedIn URL sharpens the match but is not accepted on its own, and an
  // existing email is not an input at all (it finds addresses, it does not
  // take them). Nothing to send without name + domain, so skip with an honest
  // reason — more actionable than a false "no result".
  // The name tested is the one actually sent (see `matchName`), so a name
  // the integration cannot carry is a skip with a fix, not a header error.
  const viable = Boolean(
    contact.matchFirstName && contact.matchLastName && contact.domain,
  );

  if (!viable) {
    const why = !contact.domain
      ? isFreemail(contact.primaryEmail)
        ? "skipped — no company domain (a personal email names no employer)"
        : "skipped — no company domain, from the Company relation or the Primary Email"
      : contact.firstName && contact.lastName && !contact.matchFirstName
        ? "skipped — the name has characters BetterContact's Zapier integration cannot send (non-Latin script); add a romanised First Name and Last Name"
        : "skipped — needs both a first and a last name to pair with the company domain";
    reasons.push(`bettercontact ${why}`);
    console.log(`BetterContact ${why} for ${contact.pageId}`);
  } else {
    // The callback is created BEFORE the submit step so its URL can ride
    // along in the request. It is awaited only once the submit succeeded: a
    // callback that is registered but never awaited does not park the run
    // (dormancy engages only on an awaited wait), so a failed submit still
    // returns promptly. The URL is unguessable and single-use, which is the
    // whole of its security — BetterContact's webhook carries no signature.
    const [resultPromise, callbackUrl] = await ctx.createCallback({
      name: "bettercontact-result",
      timeoutSeconds: CALLBACK_TIMEOUT_SECONDS,
    });

    const submit = await ctx.step("bettercontact-submit", async () => {
      try {
        const res = await sdk.runAction({
          appKey: BETTERCONTACT_APP_KEY,
          actionType: "write",
          actionKey: "enrich_contact",
          connection: BETTERCONTACT_CONNECTION,
          inputs: {
            // Never the raw CRM name: the integration puts it in an HTTP
            // header. See "Names and URLs as sent to BetterContact".
            first_name: contact.matchFirstName,
            last_name: contact.matchLastName,
            company_domain: contact.domain,
            linkedin_url: asciiUrl(contact.linkedinUrl),
            // Echoed back in the result's custom_fields, so a payload read
            // outside the run (BetterContact's API usage page) names the page.
            uuid: contact.pageId,
            webhook: callbackUrl,
            // The action's booleans are the strings "True" / "False". Emails
            // only: this workflow does not consume phone data.
            enrich_email_address: "True",
            enrich_phone_number: "False",
          },
        });
        // Response row: { id, success, message } — verified 2026-09-18.
        const row = firstResult(res) ?? {};
        const requestId = firstString(row.id, row.request_id);
        if (!requestId) {
          return {
            requestId: null as string | null,
            error: `no request id in response: ${JSON.stringify(row).slice(0, 200)}`,
          };
        }
        return { requestId, error: null as string | null };
      } catch (err) {
        return {
          requestId: null as string | null,
          error: String((err as Error)?.message ?? err),
        };
      }
    });

    if (!submit.requestId) {
      reasons.push(`bettercontact error: ${submit.error}`);
      console.log(
        `BetterContact submit failed for ${contact.pageId}: ${submit.error}`,
      );
    } else {
      console.log(
        `BetterContact request ${submit.requestId} submitted for ${contact.pageId}; waiting for the webhook`,
      );

      // Park until BetterContact POSTs the result, or the deadline passes.
      // The server decides the outcome once: a late POST after expiry cannot
      // flip it, so the polling fallback can never double-handle a result.
      const delivered = await resultPromise;
      let outcome: BetterContactOutcome;
      if (delivered.status === "delivered") {
        outcome = readBetterContactResult(delivered.value);
        console.log(
          `BetterContact webhook delivered for ${submit.requestId} (status ${outcome.status})`,
        );
      } else {
        console.log(
          `BetterContact webhook for ${submit.requestId} not delivered within ${CALLBACK_TIMEOUT_SECONDS}s; polling`,
        );
        outcome = await pollBetterContactResult(
          ctx,
          "bettercontact",
          submit.requestId,
        );
      }

      if (outcome.status === "terminated" && betterContactRowUsable(outcome.row)) {
        enriched = extractEnrichedFromBetterContact(outcome.row);
        console.log(`BetterContact enriched ${contact.pageId}`);
      } else if (outcome.status === "terminated") {
        // Finished with nothing we write. Name an address that came back
        // with an unverified status so a person can decide about it.
        const found = firstString(outcome.row?.contact_email_address);
        const status = firstString(outcome.row?.contact_email_address_status);
        reasons.push(
          found
            ? `bettercontact found ${found} but its status is ${status ?? "unknown"}; not written`
            : "bettercontact returned no result",
        );
      } else if (outcome.status === "on_hold") {
        reasons.push(
          `bettercontact on hold — the account is out of credits (request ${submit.requestId} resumes on its own once topped up)`,
        );
      } else {
        reasons.push(
          `bettercontact error: ${
            outcome.error ??
            `request ${submit.requestId} still ${outcome.status} after the webhook timeout and ${POLL_ATTEMPTS} polls`
          }`,
        );
      }
    }
  }

  return enriched;
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

    // 1. HarvestAPI, when the contact has a LinkedIn URL. It is a direct
    //    lookup by that URL — no name or domain needed — and answers in one
    //    synchronous call with the profile and, when it can find one, an
    //    SMTP-checked address. Its errors are caught inside the step and become
    //    a reason, exactly like BetterContact's, so a failing vendor falls
    //    through to the fallback instead of spinning the step-retry loop.
    // 2. BetterContact, when HarvestAPI did not produce a deliverable address:
    //    no LinkedIn URL, no profile found, an error, or a profile with no
    //    address. In the last case HarvestAPI's profile is kept and only the
    //    address is taken from BetterContact.
    const reasons: string[] = [];
    let harvest: EnrichedData | null = null;

    if (!contact.linkedinUrl) {
      console.log(`No LinkedIn URL on ${contact.pageId}; HarvestAPI not tried`);
    } else {
      const found = await ctx.step("harvestapi-find-profile", async () => {
        try {
          const res = await sdk.runAction({
            appKey: HARVESTAPI_APP_KEY,
            actionType: "search",
            actionKey: "find_profile",
            connection: HARVESTAPI_CONNECTION,
            inputs: {
              url: asciiUrl(contact.linkedinUrl),
              findEmail: "true",
              skipSmtp: "false",
            },
          });
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
        console.log(`HarvestAPI failed for ${contact.pageId}: ${found.error}`);
      } else if (!found.enriched) {
        reasons.push("harvestapi returned no result");
        console.log(`HarvestAPI found no profile for ${contact.pageId}`);
      } else {
        harvest = found.enriched;
        if (!harvest.newEmail) {
          reasons.push(
            found.unwritable
              ? `harvestapi found ${found.unwritable} but could not verify it; not written`
              : "harvestapi found the profile but no email",
          );
        }
        console.log(
          `HarvestAPI found ${contact.pageId}'s profile` +
            (harvest.newEmail ? " with a verified email" : " without a verified email"),
        );
      }
    }

    let enrichedData: EnrichedData | null = harvest;
    if (!harvest?.newEmail) {
      const bc = await enrichViaBetterContact(ctx, contact, reasons);
      if (bc && harvest) {
        enrichedData = bc.newEmail ? mergeBetterContactEmail(harvest, bc) : harvest;
      } else if (bc) {
        enrichedData = bc;
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
      // 3. Update the contact record (inline sub-zap logic).
      const updateResult = await updateContactRecord(ctx, contact, enrichedData);
      result = {
        pageId: contact.pageId,
        enriched: true,
        source: enrichedData.source,
        emailSource:
          enrichedData.emailSource && enrichedData.emailSource !== enrichedData.source
            ? enrichedData.emailSource
            : undefined,
        // Notes from sources tried before (or alongside) the one that did the
        // work — e.g. HarvestAPI found no address, or BetterContact was skipped.
        reasons: reasons.length ? reasons : undefined,
        ...updateResult,
      };
    }

    // 4. Add a brief comment to the triggering page stating the outcome.
    const comment = await addOutcomeComment(ctx, contact, result);

    return { ...result, commentPosted: comment.posted, commentError: comment.error };
  },
);

export default workflow;
