// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/enrich-contact-records
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
const NOTION_APP_KEY = "NotionCLIAPI";
const NOTION_CONNECTION = "notion_wf";
// Enrichment: BetterContact. `enrich_contact` submits an ASYNC waterfall job
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

/** The single enrichment source. Kept as a union so the outcome comment and
 *  corroboration keep their per-source shape if another source is added. */
type EnrichmentSource = "bettercontact";

const SOURCE_LABELS: Record<EnrichmentSource, string> = {
  bettercontact: "BetterContact",
};

interface EnrichedData {
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
  return {
    linkedinUrl: firstString(row?.contact_linkedin_profile_url) ?? "",
    country: firstString(row?.contact_location_country, row?.contact_country) ?? "",
    city: firstString(row?.contact_city, row?.contact_location_city) ?? "",
    newEmail: betterContactEmail(row),
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
//   * the source only resolves on the contact's OWN company domain + name, so
//     any record it returns is a person at the employer already recorded. This
//     is BetterContact's case: the request is gated on first + last name +
//     company domain, and its result echoes `company_domain`, so in practice the
//     domain rule fires first and this one is the backstop.
//
// The per-source shape is kept (Apollo's fuzzy name-only match was the original
// offender, and needed evidence in the returned record) so a future fuzzy source
// does not inherit the gated-lookup exemption by accident.
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
  source: EnrichmentSource,
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

  if (source === "bettercontact") {
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
  source: EnrichmentSource,
): Promise<{
  emailPath: string;
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
    ? corroborateEnrichedIdentity(contact, enriched, source)
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
// page that triggered the webhook. If the webhook was triggered by a button
// click and the payload included the user's Notion ID, the comment mentions
// that user for better visibility.

interface WorkflowResult {
  pageId: string;
  enriched: boolean;
  /** Which enrichment source produced the data, when enriched. */
  source?: EnrichmentSource;
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
 *  ("BetterContact", or null) and a short human-readable phrase. Unwraps the
 *  JSON error body and strips any HTML that upstream errors arrive in. */
function parseFailure(why: string): { source: string | null; brief: string } {
  let s = why.replace(/\s+/g, " ").trim();
  let source: string | null = null;
  const src = s.match(/^(bettercontact)\s+/i);
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
    const via = result.source ? SOURCE_LABELS[result.source] : "enrichment";
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

    // 1. Enrich the contact via BetterContact. The request is an ASYNC job:
    //    `enrich_contact` answers with a request id straight away and the
    //    waterfall runs on BetterContact's side. Rather than poll, the run
    //    hands BetterContact its own callback URL (`ctx.createCallback`) as the
    //    job's `webhook` and parks; BetterContact POSTs the finished result to
    //    it and the run resumes with the payload. Polling `get_contact` is the
    //    fallback for a webhook that never arrives. Every BetterContact call
    //    catches its own errors and returns a value, so a failing vendor does
    //    NOT spin the durable's step-retry loop — it becomes a reason in the
    //    outcome comment.
    let enrichedData: EnrichedData | null = null;
    let source: EnrichmentSource | null = null;
    const reasons: string[] = [];

    // BetterContact matches on first + last name plus the employer domain; a
    // LinkedIn URL sharpens the match but is not accepted on its own, and an
    // existing email is not an input at all (it finds addresses, it does not
    // take them). Nothing to send without name + domain, so skip with an honest
    // reason — more actionable than a false "no result".
    const viable = Boolean(
      contact.firstName && contact.lastName && contact.domain,
    );

    if (!viable) {
      const why = !contact.domain
        ? isFreemail(contact.primaryEmail)
          ? "skipped — no company domain (a personal email names no employer)"
          : "skipped — no company domain, from the Company relation or the Primary Email"
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
              first_name: contact.firstName,
              last_name: contact.lastName,
              company_domain: contact.domain,
              linkedin_url: contact.linkedinUrl,
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
          enrichedData = extractEnrichedFromBetterContact(outcome.row);
          source = "bettercontact";
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
      );
      result = {
        pageId: contact.pageId,
        enriched: true,
        source,
        // Notes recorded before the enrichment succeeded (none today, with a
        // single source; kept so the comment shape survives adding one).
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
