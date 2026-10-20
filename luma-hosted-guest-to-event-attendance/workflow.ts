// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/luma-hosted-guest-to-event-attendance
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections. The
// Luma credential lives on the TRIGGER (zap.json trigger.authentication_id);
// this code never calls Luma.
const NOTION_APP_KEY = "NotionCLIAPI";
const NOTION_CONNECTION = "notion_wf";
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

// Where a cross-contact address collision is recorded — a REVIEW flag, never
// `Duplicate of`, which the "Contact Merger" Notion Custom Agent treats as an
// instruction to merge two records and delete one. See the long note in
// `contact-emails-to-zapier-table/workflow.ts` for the 2026-07-28 incident that
// forced the split. Writes to it are always a union of the existing links.
const POSSIBLE_DUPLICATE_PROP = "Possible duplicate of";
// Read only, never written (see above): a contact carrying it is the losing
// half of a merge, awaiting archive.
const DUPLICATE_OF_PROP = "Duplicate of";

// Marketing Events workspace data sources (the same ones the retired Luma Zaps
// wrote to).
const EVENTS_DS = "65490a1e-aa79-4884-932b-60e88db67042";
const CONTACTS_DS = "21991b07-11ac-81a6-a894-000be4a09a67";
const ATTENDANCE_DS = "a591ecac-259f-4490-8f09-f7fddd556eed";

// Zapier Tables (free ops). Tables auth is automatic (no connection).
// Email -> Contact page id.
const CONTACT_EMAIL_TABLE = "01JYEPSEARXB2Z6BJRCMFGXBC2";
// Luma event id -> Event page id.
const LUMA_EVENT_TABLE = "01KY6MEV55JF723XYDEE4EP0T6";
// Mirror of Event Attendance: "<eventPageId>::<contactPageId>" -> attendance
// page id (+ the related Event/Contact page ids).
const ATTENDANCE_TABLE = "01KY6NDTW05196F1A3G3XY3ESY";
// Contacts `Lead Source` (select) for a contact this workflow creates. Set on
// CREATE only: Lead Source records how we first met someone, so an existing
// contact's value is never overwritten (same convention as
// contact-us-form-to-notion-contact and spot-project-request-to-notion).
const CONTACT_LEAD_SOURCE = "Event";
// Events Dennis manages. Written by luma-manager-email-to-table. A guest of an
// event not listed here is skipped: the trigger emits the guests of EVERY event
// on the Notion Singapore calendar, because Luma's API does not list hidden hosts.
const MANAGED_EVENTS_TABLE = "01M4ZRWQAHCB41XGGJ263S9BDH";

// Email domain -> personal/organisation verdicts from Jev, cached so each
// domain is judged once (gmail.com once, ever). Columns: Domain, Verdict,
// "P Personal %", Model. Seeded 2026-10-15 with the 208 domains in the Notion
// SG guest data.
const DOMAIN_TABLE = "01M4ZY38AWDS7FTRJ4PW9BY03F";

// Jev (TypeSafe), called through the `typesafe` API-by-Zapier connection — the
// same binding gmail-attachments-to-drive-by-type and merge-duplicate-contacts
// use (CLAUDE.md "AI-step exception"). Each call is a Zapier task; a call only
// happens for a NEW contact with an answer email whose domain is not cached,
// and it judges all such domains at once.
const JEV_CONNECTION = "typesafe";
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";

/** P(personal) at or above this counts as a personal provider. Set from the
 *  offline run on jev-1.13.0 (2026-10-15, 208 real domains): consumer mail
 *  scored >= 0.38 (asia.com 0.38, live.com.sg 0.46, zohomail.com 0.53, the big
 *  webmail providers >= 0.83), organisations <= 0.29. */
const JEV_PERSONAL_MIN = 0.35;

/** The one Jev question, asked once per unseen domain (keyed d0, d1, …). */
const JEV_DOMAIN_CRITERIA = {
  true:
    "A consumer mailbox provider: anyone can sign up for a personal address there (a webmail service, an internet service provider or telco's customer mail, or a privacy/forwarding mail service).",
  false:
    "A domain belonging to one specific organisation that issues addresses to its own people: a company, startup, agency, school or university, government body, non-profit or community group.",
};

/** How long to give luma-hosted-event-to-notion to create the Event page before
 *  this workflow creates a bare one itself. */
const EVENT_PAGE_GRACE_SECONDS = 90;

// --- Pure helpers ----------------------------------------------------------
export function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline can deliver input double-encoded (a JSON string of a
  // JSON string), while run-durable delivers it single-encoded.
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

/** Empty = no keys, or only wrapper keys with nothing in them. A polling
 *  trigger never sends this, but a manual `trigger-workflow` or a test can. */
export function isEmptyPing(raw: unknown): boolean {
  if (raw === null || raw === undefined || raw === "") return true;
  if (typeof raw !== "object") return false;
  const WRAPPER_KEYS = new Set(["querystring", "headers", "params", "body", "query"]);
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!WRAPPER_KEYS.has(key)) return false;
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object" && Object.keys(value as object).length === 0) continue;
    return false;
  }
  return true;
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/** Lowercased, validated email — or null. Every Table row and lookup is
 *  lowercase, so a raw-case address would never match. */
function cleanEmail(v: unknown): string | null {
  const s = firstString(v)?.toLowerCase() ?? null;
  return s && EMAIL_RE.test(s) ? s : null;
}

/**
 * Registration-question labels are free text that gets reworded per event, so
 * the match is on MEANING, not exact wording. Normalise first: lowercase, fold
 * the various unicode hyphens/dashes and curly apostrophes a rich-text editor
 * produces down to ASCII, and collapse whitespace.
 */
function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Marks the address as belonging to the guest's employer. */
const WORK_WORD_RE =
  /\b(work|works|working|workplace|business|company|companies|corporate|office|professional|employer|organisation|organization|official|firm)\b/;

/** Marks the field as an email address. Tolerates `e-mail`, `e mail`, `emails`
 *  and a bare `mail`; `\b` keeps it off `mailing` and `gmail`. */
const EMAIL_WORD_RE = /\b(e-? ?mails?|mail)\b/;

/**
 * Marks the address as SOMEONE ELSE'S. Without this, "Your manager's work
 * email" and "Referred by (work email)" both read as work-email questions and
 * would promote a third party's address into the guest's `Primary Email`.
 */
const THIRD_PARTY_RE =
  /\b(manager|managers|colleague|colleagues|coworker|co-worker|teammate|team-mate|refer|refers|referral|referrals|referred|referrer|friend|friends|someone|somebody|assistant|boss|supervisor|plus-? ?one|companion|their|his|her)\b/;

/**
 * How strongly a label reads as "the guest's own work email":
 *   2 — a work-ish word AND an email word ("Work Email", "Organisation e-mail")
 *   1 — a work-ish word only ("Your work address"); a weaker signal, used only
 *       when nothing scores 2, and still safe because the ANSWER must parse as
 *       an email before it's used
 *   0 — no work-ish word, or a third-party marker
 */
function workEmailLabelScore(label: string): 0 | 1 | 2 {
  const l = normalizeLabel(label);
  if (THIRD_PARTY_RE.test(l)) return 0;
  if (!WORK_WORD_RE.test(l)) return 0;
  return EMAIL_WORD_RE.test(l) ? 2 : 1;
}

/** An email address the guest typed into a registration question. */
export interface AnswerEmail {
  email: string;
  label: string;
  /** workEmailLabelScore of the label: 2 "work email", 1 work-ish, 0 neither. */
  workScore: number;
}

/**
 * Every email address the guest gave in a registration answer that is THEIR
 * OWN, in question order. Any question can carry one — "What is your work
 * email?", "What email do you use for Notion?" — so the label is no longer
 * required to say "work"; it only must not be about someone else
 * (THIRD_PARTY_RE: "your manager's email", "referred by"). Luma delivers the
 * answers twice (`registration_answers`, then `registration_answers_by_label`),
 * so both are read and de-duplicated. Matched on labels, never a
 * `question_id`, which Luma mints fresh per event.
 */
export function extractAnswerEmails(g: Record<string, any>, accountEmail: string): AnswerEmail[] {
  const out: AnswerEmail[] = [];
  const push = (label: string, value: unknown) => {
    if (THIRD_PARTY_RE.test(normalizeLabel(label))) return;
    const email = cleanEmail(value);
    if (!email || email === accountEmail || out.some((x) => x.email === email)) return;
    out.push({ email, label, workScore: workEmailLabelScore(label) });
  };
  const answers = Array.isArray(g.registration_answers) ? g.registration_answers : [];
  for (const a of answers) {
    const label = firstString(a?.label, a?.question, a?.name);
    if (label) push(label, firstString(a?.value, a?.answer, a?.value_text));
  }
  const byLabel = g.registration_answers_by_label;
  if (byLabel && typeof byLabel === "object" && !Array.isArray(byLabel)) {
    for (const [key, value] of Object.entries(byLabel)) push(key.replace(/_/g, " "), value);
  }
  return out;
}

export type DomainVerdict = "personal" | "organisation";

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * Which address becomes a NEW contact's `Primary Email`, and which are kept as
 * Secondary. Guests often register on Luma with a personal address while a
 * question asks for their work or Notion email (91 of 241 email answers across
 * the Notion SG events, 2026-10-15), and the CRM wants the organisation one.
 * Domains are judged by Jev (`verdicts`); the rule, in order:
 *
 *   1. an answer to a "work email"-style question at an organisation domain;
 *   2. else the Luma account address, if its domain is an organisation's —
 *      it's already a work address, and other answers may be role addresses
 *      ("manager@…" given as the Notion email);
 *   3. else the first answer at an organisation domain (e.g. a company address
 *      given as the Notion email);
 *   4. else nothing is an organisation's: the label rule the retired Zaps used —
 *      a "work email" answer, else the account address.
 *
 * Without verdicts (Jev unavailable) it is step 4 alone.
 */
export function choosePrimaryEmail(
  accountEmail: string,
  answers: AnswerEmail[],
  verdicts: Record<string, DomainVerdict> | null,
): { primary: string; secondaries: string[]; reason: string } {
  const isOrg = (e: string) => verdicts?.[emailDomain(e)] === "organisation";
  const workAnswer = answers.find((a) => a.workScore === 2)?.email ?? null;
  let primary: string;
  let reason: string;
  if (verdicts && answers.some((a) => a.workScore === 2 && isOrg(a.email))) {
    primary = answers.find((a) => a.workScore === 2 && isOrg(a.email))!.email;
    reason = "work-email answer at an organisation domain";
  } else if (verdicts && isOrg(accountEmail)) {
    primary = accountEmail;
    reason = "Luma account is at an organisation domain";
  } else if (verdicts && answers.some((a) => isOrg(a.email))) {
    primary = answers.find((a) => isOrg(a.email))!.email;
    reason = "answer at an organisation domain";
  } else {
    primary = workAnswer ?? accountEmail;
    const why = !verdicts ? "domain verdicts unavailable" : answers.length ? "no organisation domain" : "no other address";
    reason = `${why}: ${workAnswer ? "work-email answer" : "Luma account address"}`;
  }
  const all = [...answers.map((a) => a.email), accountEmail];
  return { primary, secondaries: all.filter((e) => e !== primary), reason };
}

/**
 * Addresses to ADD to an existing contact's `Secondary Email`. An existing
 * contact keeps its Primary (Dennis, 2026-10-15: the domain rule is for new
 * contacts only); a new address is kept rather than lost. Existing options are
 * carried over verbatim, since writing a multi-select replaces the whole list.
 * Returns null when nothing needs writing.
 */
export function planSecondaryAdditions(
  current: { primary: string | null; secondaryNames: string[] },
  addresses: string[],
): string[] | null {
  const have = new Set([...(current.primary ? [current.primary] : []), ...current.secondaryNames.map((n) => n.toLowerCase())]);
  const add = addresses.filter((e) => !have.has(e));
  return add.length ? [...current.secondaryNames, ...add] : null;
}

/** A live contact whose Name is name-equivalent to the guest's. */
export interface NameMatch {
  id: string;
  /** Primary + Secondary Email, lowercased. */
  emails: string[];
  /** Carries a `Duplicate of` link: the losing half of a merge awaiting
   *  archive, so not a contact to reuse or to count as a rival. */
  isMergedAway: boolean;
}

/**
 * The existing contact to REUSE for a guest whose addresses resolved to
 * nothing — or null, and the caller creates a new contact and flags the name
 * matches as before. Reuse needs all three:
 *
 *   1. exactly one live contact with the guest's name (ignoring merged-away
 *      records) — a second same-name contact means we can't tell which;
 *   2. one of the guest's addresses shares a domain with an address on it;
 *   3. that domain is an organisation's (Jev verdict), never a personal
 *      provider — two people both on gmail.com prove nothing.
 *
 * Why: the email Table is exact-match, and the usual miss is a second address
 * format at the same company. Manuel Denoual registered on 2026-10-19 as
 * manuel@aheadgaining.com while his contact carried
 * manuel.denoual@aheadgaining.com, and got a duplicate. A name alone is not
 * proof (see findNameMatchedContacts), but the same name at the same
 * organisation's domain is. Replayed over all 1,047 live contacts on
 * 2026-10-20, it fires only on that pair: every other same-name group differs
 * in domain or shares only gmail.com.
 */
export function pickSameOrgNameMatch(
  matches: NameMatch[],
  guestEmails: string[],
  verdicts: Record<string, DomainVerdict> | null,
): { id: string; domain: string } | null {
  if (!verdicts) return null;
  const live = matches.filter((m) => !m.isMergedAway);
  if (live.length !== 1) return null;
  const theirs = new Set(live[0].emails.map(emailDomain));
  const domain = guestEmails.map(emailDomain).find((d) => theirs.has(d) && verdicts[d] === "organisation");
  return domain ? { id: live[0].id, domain } : null;
}

/** Domains a sole live name match shares with the guest: what
 *  pickSameOrgNameMatch needs judged. Empty when it can't fire anyway. */
export function sharedDomainsWithSoleMatch(matches: NameMatch[], guestEmails: string[]): string[] {
  const live = matches.filter((m) => !m.isMergedAway);
  if (live.length !== 1) return [];
  const theirs = new Set(live[0].emails.map(emailDomain));
  return [...new Set(guestEmails.map(emailDomain).filter((d) => theirs.has(d)))];
}

/** First item of a runAction result ({ data: [...] } or a bare array). */
function firstResult(res: any): any {
  if (res && Array.isArray(res.data)) return res.data[0] ?? null;
  if (Array.isArray(res)) return res[0] ?? null;
  return res ?? null;
}

/** The event embedded in a guest item. Only these six fields come with it; the
 *  cover image and location type are luma-hosted-event-to-notion's to set. */
export interface EmbeddedEvent {
  id: string;
  name: string | null;
  startAt: string | null;
  endAt: string | null;
  url: string | null;
}

export interface Guest {
  /** Luma guest id (gst-…) — the stable key. The trigger's top-level `id` is
   *  `<guest id>_<approval_status>_<check-in time>`, a VERSION, never a key. */
  guestId: string;
  /** The email on the guest's Luma account — often a personal address. */
  accountEmail: string;
  /** The guest's own email addresses from registration answers, excluding
   *  the account address; see extractAnswerEmails. */
  answerEmails: AnswerEmail[];
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  approvalStatus: string | null;
  registeredAt: string | null;
  /** Every registration question and answer, as markdown for the Attendance
   *  page body; null when the guest answered nothing. */
  answersMarkdown: string | null;
  checkedIn: boolean;
  event: EmbeddedEvent;
}

/**
 * A `new_or_updated_guest` item from the private "Luma Calendar API"
 * integration (App247901CLIAPI): the raw Luma guest plus `guest_id`, `email` /
 * `name` aliases of `user_email` / `user_name`, a computed `checked_in_at`
 * (latest ticket check-in), and the event's id/name/start/end/url under
 * `event`.
 *
 * Returns null when the payload carries no guest id, email or event id — the
 * caller throws on that (a non-empty payload we cannot read is never skipped
 * silently).
 */
export function extractGuest(raw: unknown): Guest | null {
  const g = (raw ?? {}) as Record<string, any>;
  const guestId = firstString(g.guest_id);
  const accountEmail = cleanEmail(firstString(g.email, g.user_email));
  const ev = (g.event ?? {}) as Record<string, any>;
  const eventId = firstString(ev.id);
  if (!guestId || !accountEmail || !eventId || !eventId.startsWith("evt-")) return null;
  const answerEmails = extractAnswerEmails(g, accountEmail);
  const tickets = Array.isArray(g.event_tickets) ? g.event_tickets : [];
  // `checked_in_at` is the physical QR-scan check-in (the integration already
  // lifts the latest ticket's into the top level); `joined_at` is Luma's signal
  // for a virtual guest joining the meeting link.
  const checkedIn =
    firstString(g.checked_in_at) !== null ||
    firstString(g.joined_at) !== null ||
    tickets.some((t: any) => firstString(t?.checked_in_at) !== null);
  return {
    guestId,
    accountEmail,
    answerEmails,
    firstName: firstString(g.user_first_name, g.first_name),
    lastName: firstString(g.user_last_name, g.last_name),
    name: firstString(g.name, g.user_name),
    approvalStatus: firstString(g.approval_status),
    registeredAt: firstString(g.registered_at),
    answersMarkdown: formatRegistrationAnswers(g.registration_answers),
    checkedIn,
    event: {
      id: eventId,
      name: firstString(ev.name),
      startAt: firstString(ev.start_at),
      endAt: firstString(ev.end_at),
      url: firstString(ev.url),
    },
  };
}

/** Notion caps a rich-text run at 2000 characters; keep each answer under it. */
const ANSWER_MAX_CHARS = 1800;

/** Neutralise markdown a guest typed, so an answer can't become a heading,
 *  list or quote in the page body. */
function escapeMarkdownLine(line: string): string {
  return line.replace(/^(\s*)([#>*+\-]|\d+[.)])(\s)/, "$1\\$2$3");
}

/** One registration answer as display text, or null when unanswered. Shapes
 *  seen across the Notion SG events (2026-10-15): text and single select
 *  (string), multi-select (string[]), company ({company, job_title}), terms
 *  and agree-check (boolean), linkedin ("/in/handle"). */
export function answerText(a: Record<string, any>): string | null {
  const type = firstString(a?.question_type) ?? "";
  const v = a?.value !== undefined ? a.value : a?.answer;
  if (v === null || v === undefined || v === "") return null;
  if (type === "company" || (typeof v === "object" && !Array.isArray(v) && ("company" in v || "job_title" in v))) {
    const company = firstString(v?.company, a?.answer_company);
    const title = firstString(v?.job_title, a?.answer_job_title);
    return [company, title].filter(Boolean).join(" — ") || null;
  }
  if (type === "linkedin" && typeof v === "string") {
    const path = v.trim();
    return /^https?:\/\//i.test(path) ? path : `https://www.linkedin.com${path.startsWith("/") ? "" : "/"}${path}`;
  }
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) {
    const parts = v.map((x) => (typeof x === "string" || typeof x === "number" ? String(x) : JSON.stringify(x)));
    return parts.filter((x) => x.trim() !== "").join(", ") || null;
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v).trim() || null;
}

/**
 * Registration questions differ per event, so rather than map them to
 * properties the whole set goes into the Attendance page body (Dennis,
 * 2026-10-15), in the order Luma asked them.
 */
export function formatRegistrationAnswers(answers: unknown): string | null {
  if (!Array.isArray(answers)) return null;
  const blocks: string[] = [];
  for (const a of answers) {
    const question = firstString(a?.label, a?.question);
    const text = answerText(a ?? {});
    if (!question || text === null) continue;
    const clipped = text.length > ANSWER_MAX_CHARS ? `${text.slice(0, ANSWER_MAX_CHARS)}…` : text;
    const body = clipped.split(/\r?\n/).map(escapeMarkdownLine).join("\n");
    blocks.push(`**${question.replace(/\*/g, "")}**\n${body}`);
  }
  return blocks.length ? `## Registration answers\n${blocks.join("\n")}` : null;
}

/**
 * Invited-only guests are not written to Notion (Dennis, 2026-10-15). Luma
 * events here are bulk-invited to the community — 231 of 254 guests on the first
 * Build Bar — and a Contact per invitee would swamp the CRM. A guest reaches
 * Notion once they register (status leaves `invited`) or check in; because the
 * trigger's id carries the status, that change fires this workflow again.
 */
export function isInvitedOnly(g: Guest): boolean {
  return (g.approvalStatus ?? "").toLowerCase() === "invited" && !g.checkedIn;
}

/**
 * Create a Notion data source item, applying the data source's DEFAULT TEMPLATE
 * when one exists, so automation-created pages look like hand-made ones (icon,
 * body blocks, and any property defaults set on the template).
 *
 * Two constraints of the Notion create action shape this helper:
 *  1. `template_mode: "default"` THROWS on a data source that has no default
 *     template ("No default template is configured for this data source"), so
 *     that one error is caught and the create retried without it. No
 *     per-data-source config is needed, and a template added in Notion later is
 *     picked up automatically. (Today: Contacts has a default template; Events
 *     and Event Attendance do not.)
 *  2. A template and inline `content` are mutually exclusive — "If you select a
 *     template, you cannot include content" — so body content must be appended
 *     in a second call, via write/page_content.
 *
 * The fallback is caught INSIDE the step so a template miss doesn't spin the
 * durable's step-retry loop.
 */
async function createItemWithTemplate(
  ctx: any,
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

// --- Contact email reconciliation ------------------------------------------

interface ContactEmailState {
  /** `Primary Email` (an email property), lowercased, or null when empty. */
  primary: string | null;
  /** `Secondary Email` multi-select option names, verbatim and in order. */
  secondaryNames: string[];
}

/**
 * Read a contact's current email properties straight from the Notion REST API,
 * via a raw `sdk.fetch` (the same idiom as the page-cover PATCH below).
 *
 * Why not a Notion search action: `Secondary Email` is a multi-select, which
 * `find_data_source_item` cannot read back, and writing a multi-select REPLACES
 * the whole option list — so appending an address without first reading the
 * current list would silently drop every address already on the contact.
 */
async function readContactEmails(pageId: string): Promise<ContactEmailState | null> {
  const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
    connection: NOTION_CONNECTION,
    headers: { "Notion-Version": NOTION_VERSION },
  });
  if (!res.ok) return null;
  const body: any = await res.json();
  const props = body?.properties ?? {};
  const secondaryNames = (props["Secondary Email"]?.multi_select ?? [])
    .map((o: any) => firstString(o?.name))
    .filter((n: unknown): n is string => typeof n === "string");
  return {
    primary: cleanEmail(props["Primary Email"]?.email),
    secondaryNames,
  };
}

/**
 * Read a contact's current `Possible duplicate of` page ids.
 *
 * Same hazard as `readContactEmails` above, for the same reason: writing a
 * relation REPLACES it, so appending a collision flag without reading the
 * current list first would drop every earlier flag. Returns null when the page
 * can't be read, which the caller treats as "don't write" — losing a review
 * flag is far cheaper than replacing the ones already there.
 */
async function readPossibleDuplicateLinks(
  pageId: string,
): Promise<string[] | null> {
  const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
    connection: NOTION_CONNECTION,
    headers: { "Notion-Version": NOTION_VERSION },
  });
  if (!res.ok) return null;
  const body: any = await res.json();
  const links: string[] = [];
  for (const rel of body?.properties?.[POSSIBLE_DUPLICATE_PROP]?.relation ?? []) {
    const id = firstString(rel?.id);
    if (id && !links.includes(id)) links.push(id);
  }
  return links;
}

/** Notion page ids compare hyphen- and case-insensitively: the same id reaches
 *  us in both spellings depending on which API or Table row it came from. */
function sameNotionId(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.replace(/-/g, "").toLowerCase() === b.replace(/-/g, "").toLowerCase();
}

/**
 * A comparable name key: lowercased, punctuation-stripped, tokens SORTED.
 *
 * Sorting is the point. Luma sends whatever the guest typed, and the order is
 * not reliable — Lionel Sim registered as "Sim Lionel" on 2026-07-24, so an
 * exact title comparison would have missed his existing contact. Returns "" for
 * anything with fewer than two tokens: a lone "Grace" is far too weak to flag a
 * stranger's record on.
 */
function normalizeNameKey(name: string): string {
  const tokens = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .sort();
  return tokens.length >= 2 ? tokens.join(" ") : "";
}

/**
 * Live contacts whose Name is name-equivalent to `fullName`.
 *
 * Why this exists: contacts are resolved ONLY through the email -> page-id
 * Table, so a guest registering with an address that isn't indexed yet gets a
 * brand-new contact even when they are already in the CRM under a different
 * address. That is how the duplicate Lionel Sim page appeared on 2026-07-24,
 * and every downstream mess followed from it — the address could not have
 * resolved, because his record did not carry it.
 *
 * A name match ALONE is not treated as proof and never reuses the record: two
 * different people share a name often enough that attaching a registration to
 * the wrong contact would be the same false-positive this repo has just spent a
 * day undoing. The new contact is still created; it is only FLAGGED, so a
 * person decides. See POSSIBLE_DUPLICATE_PROP. The one exception, a sole name
 * match at the same organisation's domain, is pickSameOrgNameMatch.
 *
 * Queried against the data source endpoint directly: `find_data_source_item`
 * returns a single hit, and a name needle can legitimately match several.
 */
async function findNameMatchedContacts(fullName: string): Promise<NameMatch[]> {
  const key = normalizeNameKey(fullName);
  if (!key) return [];
  // Search on the longest token — the most selective one, and the one least
  // likely to be a common given name.
  const needle = key.split(" ").reduce((a, b) => (b.length > a.length ? b : a));
  if (needle.length < 3) return [];

  const res = await sdk.fetch(`${NOTION_API}/data_sources/${CONTACTS_DS}/query`, {
    method: "POST",
    connection: NOTION_CONNECTION,
    headers: {
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filter: { property: "Name", title: { contains: needle } },
      page_size: 100,
    }),
  });
  // Best-effort: a registration must never fail because the duplicate check
  // could not run.
  if (!res.ok) return [];
  const body: any = await res.json();

  const matches: NameMatch[] = [];
  for (const page of body?.results ?? []) {
    if (page?.in_trash === true || page?.archived === true) continue;
    const props = page?.properties ?? {};
    const title = (props.Name?.title ?? [])
      .map((t: any) => firstString(t?.plain_text))
      .filter(Boolean)
      .join(" ");
    if (normalizeNameKey(title) !== key) continue;
    const id = firstString(page?.id);
    if (!id || matches.some((m) => m.id === id)) continue;
    const emails = [
      cleanEmail(props["Primary Email"]?.email),
      ...(props["Secondary Email"]?.multi_select ?? []).map((o: any) => cleanEmail(o?.name)),
    ].filter((e): e is string => typeof e === "string");
    const isMergedAway = (props[DUPLICATE_OF_PROP]?.relation ?? []).length > 0;
    matches.push({ id, emails, isMergedAway });
  }
  return matches;
}

/** Map Luma approval_status to the Notion "Approval Status" select option. */
function mapApprovalStatus(status: string | null): string {
  switch ((status ?? "").toLowerCase()) {
    case "approved":
      return "Approved";
    case "pending_approval":
    case "pending":
    case "pending_review":
      return "Pending Approval";
    case "waitlist":
    case "waitlisted":
    case "on_waitlist":
      return "Waitlist";
    case "declined":
    case "rejected":
      return "Declined";
    case "invited":
      return "Invited";
    default:
      return "Approved";
  }
}

/**
 * The value to write into `Approval Status`.
 *
 * Despite the name, that select is the record's LIFECYCLE status in this
 * workspace, not a pure approval field — "Registered" and "Attended" are both
 * options and neither is a Luma `approval_status` value. A guest who actually
 * turned up outranks whatever Luma still reports as their approval state, so a
 * check-in resolves to "Attended".
 *
 * This is also what stops "Attended" being clobbered. The select is rewritten on
 * EVERY `guest_updated`, so mapping straight from `approval_status` would knock a
 * checked-in guest back to "Approved" on their next profile edit. `checkedIn` is
 * monotonic — Luma never unsets `joined_at` or `checked_in_at` — so every later
 * payload for that guest still resolves to "Attended" and the value survives
 * without a read-modify-write.
 */
function resolveAttendanceStatus(status: string | null, checkedIn: boolean): string {
  return checkedIn ? "Attended" : mapApprovalStatus(status);
}
/**
 * Personal/organisation verdicts for `domains`: the cache Table first, then ONE
 * Jev call for every miss, written back to the cache (best-effort). Returns
 * null when Jev can't answer, and the caller falls back to the label rule.
 * Throws only on a retryable Jev status (429/5xx), which a step retry can fix.
 */
async function classifyDomains(
  ctx: any,
  domains: string[],
): Promise<{ verdicts: Record<string, DomainVerdict> | null; jevCalled: boolean; model: string | null }> {
  return ctx.step("classify-email-domains", async () => {
    const verdicts: Record<string, DomainVerdict> = {};
    const misses: string[] = [];
    for (const domain of domains) {
      const hit: any = await sdk.listTableRecords({
        table: DOMAIN_TABLE,
        keyMode: "names",
        filters: [{ fieldKey: "Domain", operator: "exact", value: domain }],
        pageSize: 1,
      });
      const v = firstString(hit?.data?.[0]?.data?.Verdict);
      if (v === "personal" || v === "organisation") verdicts[domain] = v;
      else misses.push(domain);
    }
    if (misses.length === 0) return { verdicts, jevCalled: false, model: null };

    const state: Record<string, string> = {};
    const questions: Record<string, unknown> = {};
    misses.forEach((domain, i) => {
      state[`d${i}`] = domain;
      questions[`d${i}`] = {
        type: "noul",
        instructions: `Is the email domain \`d${i}\` a personal (consumer) email provider?`,
        criteria: JEV_DOMAIN_CRITERIA,
      };
    });
    const res = await sdk.fetch(JEV_URL, {
      connection: JEV_CONNECTION,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
    });
    const text = await res.text();
    if (res.status === 429 || res.status >= 500) throw new Error(`Jev ${res.status}: ${text.slice(0, 300)}`);
    if (res.status !== 200) {
      console.log(`Jev rejected the request (${res.status}): ${text.slice(0, 300)}`);
      return { verdicts: null, jevCalled: true, model: null };
    }
    const body = JSON.parse(text);
    const model = firstString(body?.model);
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < misses.length; i++) {
      const p = body?.answers?.[`d${i}`]?.noul;
      if (typeof p !== "number") return { verdicts: null, jevCalled: true, model };
      const verdict: DomainVerdict = p >= JEV_PERSONAL_MIN ? "personal" : "organisation";
      verdicts[misses[i]] = verdict;
      rows.push({ Domain: misses[i], Verdict: verdict, "P Personal %": Math.round(p * 100), Model: model ?? "" });
      console.log(`Jev ${model}: ${misses[i]} P(personal)=${p.toFixed(2)} -> ${verdict}`);
    }
    try {
      await sdk.createTableRecords({ table: DOMAIN_TABLE, keyMode: "names", records: rows.map((data) => ({ data })) });
    } catch (err) {
      console.log(`domain cache write failed: ${String((err as Error)?.message ?? err)}`);
    }
    return { verdicts, jevCalled: true, model };
  });
}

// --- Event-link race guard -------------------------------------------------
//
// Event Attendance.Event is a TWO-WAY relation: every Attendance create also
// appends to the Event page's own relation list. Notion applies that append as
// a read-modify-write of the Event page, so when several runs link rows to the
// SAME event in the same second, later writes overwrite earlier ones and the
// losers' Event link is cleared — including rows that already existed. Seen
// 2026-10-15 on the first Build Bar backfill: 23 rows created in bursts of 10,
// only 9 left linked. Durables have no serialization, so the guard is to keep
// creates for one event apart (a stagger) and then to check the link stuck.

/** Seconds to wait before creating an Attendance row: 5..44, derived from the
 *  guest id so it is deterministic (no Math.random in the workflow body) and
 *  spreads guests who arrive in the same poll across ~40 s. */
export function staggerSeconds(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return 5 + (h % 40);
}

/** Time for any concurrent burst on the same Event page to finish before the
 *  link is checked. */
const LINK_SETTLE_SECONDS = 60;

/** Page ids compare hyphen- and case-insensitively. */
export function relationHas(relation: unknown, id: string): boolean {
  const want = id.replace(/-/g, "").toLowerCase();
  return Array.isArray(relation) &&
    relation.some((r: any) => typeof r?.id === "string" && r.id.replace(/-/g, "").toLowerCase() === want);
}

async function staggerBeforeLink(ctx: any, key: string): Promise<void> {
  await ctx.wait("stagger-before-attendance-create", staggerSeconds(key));
}

/**
 * Re-read the Attendance row once things have settled and put the Event link
 * back if a concurrent write dropped it. Runs on every guest run, so a row
 * dropped by SOMEONE ELSE's burst also heals the next time its guest changes.
 * Read and write share one step, so a retry re-reads before writing.
 */
async function ensureEventLink(
  ctx: any,
  attendancePageId: string,
  eventPageId: string,
): Promise<{ linked: boolean; repaired: boolean; error?: string }> {
  await ctx.wait("settle-before-link-check", LINK_SETTLE_SECONDS);
  return ctx.step("ensure-event-link", async () => {
    const res = await sdk.fetch(`${NOTION_API}/pages/${attendancePageId}`, {
      connection: NOTION_CONNECTION,
      headers: { "Notion-Version": NOTION_VERSION },
    });
    if (!res.ok) return { linked: false, repaired: false, error: `read ${res.status}` };
    const page: any = await res.json();
    const current = page?.properties?.Event?.relation ?? [];
    if (relationHas(current, eventPageId)) return { linked: true, repaired: false };
    const patch = await sdk.fetch(`${NOTION_API}/pages/${attendancePageId}`, {
      connection: NOTION_CONNECTION,
      method: "PATCH",
      headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify({
        properties: { Event: { relation: [...current.map((r: any) => ({ id: r.id })), { id: eventPageId }] } },
      }),
    });
    if (!patch.ok) {
      // A 4xx here is a real fault (permissions, schema): fail loudly rather
      // than leave an unlinked row behind a green run.
      throw new Error(`Event link repair failed (${patch.status}): ${(await patch.text()).slice(0, 200)}`);
    }
    console.log(`repaired dropped Event link on ${attendancePageId}`);
    return { linked: true, repaired: true };
  });
}

// --- Duplicate-create guard (claim-then-verify) ------------------------------
//
// Two runs for ONE guest can overlap: a registration approved within a poll
// interval arrives as two trigger items (`<guest>_pending_approval_none`, then
// `<guest>_approved_none`), both runs find no Attendance row, and both create.
// Seen 2026-10-19: ATT-357/358, created 20 s apart. Neither Notion nor a Table
// can create-if-absent, so every run that CREATED a row re-reads the
// Event+Contact pair once things have settled, and all runs agree on one
// winner: the lowest ATT number (the auto-increment ID, i.e. created first).
// Only a losing run acts — it moves its own status onto the winner when it is
// further along, deletes its own Table index entry, then trashes its own row —
// so two runs never fight. The loser always sees the winner: the winner was
// created first, and the loser checks a full settle period after its own create.

/** How far along an Approval Status is. A loser's status replaces the
 *  winner's only when strictly higher, so on a tie (Approved vs Declined) the
 *  winner's value stands. */
const STATUS_RANK: Record<string, number> = {
  Invited: 0,
  "Pending Approval": 1,
  Waitlist: 1,
  Approved: 2,
  Declined: 2,
  Attended: 3,
};

export function statusRank(status: string | null): number {
  return status != null && status in STATUS_RANK ? STATUS_RANK[status] : -1;
}

export interface AttendanceRow {
  id: string;
  /** Auto-increment ID number (ATT-<n>); null when Notion did not return it. */
  number: number | null;
  status: string | null;
  checkedIn: boolean;
}

const normId = (id: string) => id.replace(/-/g, "").toLowerCase();

/** The row every run keeps: the lowest ATT number, then the lowest page id. A
 *  row without a number sorts after every numbered row. */
export function pickAttendanceWinner(rows: AttendanceRow[]): AttendanceRow | null {
  let best: AttendanceRow | null = null;
  for (const r of rows) {
    if (!best) {
      best = r;
      continue;
    }
    const a = r.number ?? Number.POSITIVE_INFINITY;
    const b = best.number ?? Number.POSITIVE_INFINITY;
    if (a < b || (a === b && normId(r.id) < normId(best.id))) best = r;
  }
  return best;
}

/** Properties to write onto the winner from a losing run, or null if none. */
export function mergeOntoWinner(
  winner: AttendanceRow,
  loserStatus: string,
  loserCheckedIn: boolean,
): Record<string, unknown> | null {
  const props: Record<string, unknown> = {};
  if (statusRank(loserStatus) > statusRank(winner.status)) {
    props["Approval Status"] = { select: { name: loserStatus } };
  }
  if (loserCheckedIn && !winner.checkedIn) props["Checked In"] = { checkbox: true };
  return Object.keys(props).length ? props : null;
}

/** Notion's answer to trashing a page that is already in the trash. Replaying
 *  the trash is then a success, not a failure (see durables-sdk.md). */
export function isAlreadyTrashed(status: number, body: string): boolean {
  return status === 400 && /archived/i.test(body);
}

export function toAttendanceRow(page: any): AttendanceRow | null {
  const id = firstString(page?.id);
  if (!id || page?.in_trash === true || page?.archived === true) return null;
  const n = page?.properties?.ID?.unique_id?.number;
  return {
    id,
    number: typeof n === "number" ? n : null,
    status: firstString(page?.properties?.["Approval Status"]?.select?.name),
    checkedIn: page?.properties?.["Checked In"]?.checkbox === true,
  };
}

type DedupeResult =
  | { checked: false; error: string }
  | { checked: true; duplicates: number; kept: string; lost: boolean; merged: string[] };

/**
 * Runs only after this run CREATED `ownPageId`, and after the link-check
 * settle wait. Read and writes share one step, ordered so a retry is safe: the
 * merge is a plain property write, the Table delete re-lists first, and the
 * trash goes last and treats "already trashed" as done.
 */
async function dedupeCreatedAttendance(
  ctx: any,
  ownPageId: string,
  eventPageId: string,
  contactPageId: string,
  ownStatus: string,
  ownCheckedIn: boolean,
): Promise<DedupeResult> {
  return ctx.step("dedupe-created-attendance", async () => {
    const res = await sdk.fetch(`${NOTION_API}/data_sources/${ATTENDANCE_DS}/query`, {
      method: "POST",
      connection: NOTION_CONNECTION,
      headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify({
        filter: {
          and: [
            { property: "Event", relation: { contains: eventPageId } },
            { property: "Contact", relation: { contains: contactPageId } },
          ],
        },
        page_size: 100,
      }),
    });
    // Best-effort, like the other reads: a check that cannot run leaves at
    // worst the duplicate this guard exists to remove, never a lost row.
    if (!res.ok) return { checked: false as const, error: `query ${res.status}` };
    const body: any = await res.json();
    const rows = (body?.results ?? [])
      .map(toAttendanceRow)
      .filter((r: AttendanceRow | null): r is AttendanceRow => r !== null);
    const own = normId(ownPageId);
    // The query may not show our own row yet; it exists, so count it.
    if (!rows.some((r: AttendanceRow) => normId(r.id) === own)) {
      rows.push({ id: ownPageId, number: null, status: ownStatus, checkedIn: ownCheckedIn });
    }
    const winner = pickAttendanceWinner(rows) as AttendanceRow;
    if (normId(winner.id) === own) {
      return { checked: true as const, duplicates: rows.length - 1, kept: ownPageId, lost: false, merged: [] };
    }

    const merge = mergeOntoWinner(winner, ownStatus, ownCheckedIn);
    if (merge) {
      const patch = await sdk.fetch(`${NOTION_API}/pages/${winner.id}`, {
        connection: NOTION_CONNECTION,
        method: "PATCH",
        headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: merge }),
      });
      if (!patch.ok) {
        throw new Error(`Attendance merge onto ${winner.id} failed (${patch.status}): ${(await patch.text()).slice(0, 200)}`);
      }
    }

    const indexed = await sdk.listTableRecords({
      table: ATTENDANCE_TABLE,
      keyMode: "names",
      filters: [{ fieldKey: "Attendance Page ID", operator: "exact", value: ownPageId }],
      pageSize: 10,
    });
    const recordIds = (indexed?.data ?? []).map((r: any) => firstString(r?.id)).filter(Boolean) as string[];
    if (recordIds.length) await sdk.deleteTableRecords({ table: ATTENDANCE_TABLE, records: recordIds });

    const trash = await sdk.fetch(`${NOTION_API}/pages/${ownPageId}`, {
      connection: NOTION_CONNECTION,
      method: "PATCH",
      headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify({ in_trash: true }),
    });
    if (!trash.ok) {
      const text = await trash.text();
      if (!isAlreadyTrashed(trash.status, text)) {
        throw new Error(`Trashing duplicate Attendance ${ownPageId} failed (${trash.status}): ${text.slice(0, 200)}`);
      }
    }
    console.log(`duplicate Attendance ${ownPageId} trashed; kept ${winner.id}`);
    return {
      checked: true as const,
      duplicates: rows.length - 1,
      kept: winner.id,
      lost: true,
      merged: merge ? Object.keys(merge) : [],
    };
  });
}

// --- Workflow ----------------------------------------------------------------
// ONE workflow for every guest change: the integration's `new_or_updated_guest`
// trigger re-fires whenever a guest's approval status or check-in changes,
// because its `id` is `<guest id>_<status>_<check-in>` (durables dedupe on the
// raw top-level id — see CLAUDE.md "Known Zapier bug"). So this workflow is the
// sole creator AND the updater; the retired registered/updated pair (and the
// race between them) collapses into one. Every Notion write is keyed on the
// Luma event id, the contact's email and the Event+Contact pair — never on the
// trigger id.
//
// Also fired by luma-manager-email-to-table's backfill (sdk.triggerWorkflow,
// `source: "backfill"`) for guests the trigger delivered before Dennis managed
// the event.
//
// EMAIL IDENTITY and duplicate-flagging are unchanged from the retired
// luma-guest-registered-to-event-attendance; see that README. NEWSLETTER: the
// retired Buttondown opt-in is deliberately NOT ported — these are Notion
// Singapore community events, and their guests are not workFlowers newsletter
// sign-ups (Dennis, 2026-10-15).
const workflow = defineDurable(
  "luma-hosted-guest-to-event-attendance",
  async (ctx, rawInput: unknown) => {
    const payload = normalizeInput(rawInput);
    if (isEmptyPing(payload)) {
      console.log("skipping: empty payload (manual test or ping)");
      return { skipped: "empty-payload" };
    }
    const guest = extractGuest(payload);
    if (!guest) {
      const keys =
        payload && typeof payload === "object"
          ? Object.keys(payload).slice(0, 25).join(", ")
          : typeof payload;
      throw new Error(
        `Unrecognised Luma guest payload: need guest_id, an email and an evt- event id. Keys: ${keys}`,
      );
    }
    const ev = guest.event;

    if (isInvitedOnly(guest)) {
      console.log(`skipping ${guest.guestId}: invited, not registered`);
      return { skipped: "invited-only", guestId: guest.guestId, lumaEventId: ev.id };
    }

    // 0. Only events Dennis manages.
    const managed = await ctx.step("check-managed", async () =>
      sdk.listTableRecords({
        table: MANAGED_EVENTS_TABLE,
        keyMode: "names",
        filters: [{ fieldKey: "Luma Event ID", operator: "exact", value: ev.id }],
        pageSize: 1,
      }),
    );
    if (!managed?.data?.[0]) {
      console.log(`skipping ${guest.guestId}: event ${ev.id} not in Luma Managed Events`);
      return { skipped: "not-managed", guestId: guest.guestId, lumaEventId: ev.id };
    }

    // 1. Resolve the Event: free Table lookup -> Notion search. The Event page is
    // luma-hosted-event-to-notion's to create (it has the cover and type), so on a
    // miss wait once for it before falling back to a bare page of our own.
    const eventTableHit = await ctx.step("find-event-in-table", async () =>
      sdk.listTableRecords({
        table: LUMA_EVENT_TABLE,
        keyMode: "names",
        filters: [{ fieldKey: "Luma Event ID", operator: "exact", value: ev.id }],
        pageSize: 1,
      }),
    );
    let eventPageId: string | null = firstString(eventTableHit?.data?.[0]?.data?.["Page ID"]);

    if (!eventPageId) {
      const found = await ctx.step("find-event-in-notion", async () =>
        sdk.runAction({
          appKey: NOTION_APP_KEY,
          actionType: "search",
          actionKey: "find_data_source_item",
          connection: NOTION_CONNECTION,
          inputs: {
            datasource: EVENTS_DS,
            search_fields: ["Luma ID"],
            "properties|||Luma ID|||filter": "equals",
            "properties|||Luma ID|||rich_text": ev.id,
            "properties|||Luma ID|||match": "required",
          },
        }),
      );
      eventPageId = firstResult(found)?.id ?? null;
    }

    if (!eventPageId) {
      await ctx.wait("wait-for-event-page", EVENT_PAGE_GRACE_SECONDS);
      const retryHit = await ctx.step("find-event-in-table-again", async () =>
        sdk.listTableRecords({
          table: LUMA_EVENT_TABLE,
          keyMode: "names",
          filters: [{ fieldKey: "Luma Event ID", operator: "exact", value: ev.id }],
          pageSize: 1,
        }),
      );
      eventPageId = firstString(retryHit?.data?.[0]?.data?.["Page ID"]);
    }

    let eventCreated = false;
    if (!eventPageId) {
      // Bare page from the six fields the guest item carries. A later run of
      // luma-hosted-event-to-notion (or a backfill) finds it by Luma ID and adds
      // the cover and type.
      const createEventInputs: Record<string, unknown> = {
        datasource: EVENTS_DS,
        "properties|||Event|||title": ev.name ?? `Luma event ${ev.id}`,
        "properties|||Luma ID|||rich_text": ev.id,
      };
      if (ev.url) createEventInputs["properties|||Event page|||url"] = ev.url;
      if (ev.startAt) {
        createEventInputs["use_zapier_datetime_fields"] = true;
        createEventInputs["properties|||Date|||date__start"] = ev.startAt;
        if (ev.endAt) createEventInputs["properties|||Date|||date__end"] = ev.endAt;
      }
      const created = await createItemWithTemplate(ctx, "event", EVENTS_DS, createEventInputs);
      eventPageId = created.pageId;
      eventCreated = true;
      if (!eventPageId) throw new Error("Event creation returned no page id");
      const newEventPageId = eventPageId;
      await ctx.step("index-event-in-table", async () =>
        sdk.createTableRecords({
          table: LUMA_EVENT_TABLE,
          keyMode: "names",
          records: [
            { data: { "Luma Event ID": ev.id, "Page ID": newEventPageId, "Event Name": ev.name ?? "" } },
          ],
        }),
      );
    }

    // 2. Resolve the Contact via the email -> page id Zapier Table, trying every
    // address the guest gave: answers first ("work email"-style labels ahead),
    // then the Luma account address. The first hit is the contact.
    const lookupOrder = [
      ...[...guest.answerEmails].sort((a, b) => b.workScore - a.workScore).map((a) => a.email),
      guest.accountEmail,
    ];
    const emailHits: Record<string, string> = await ctx.step("find-contact-by-emails", async () => {
      const hits: Record<string, string> = {};
      for (const email of lookupOrder) {
        const res: any = await sdk.listTableRecords({
          table: CONTACT_EMAIL_TABLE,
          keyMode: "names",
          filters: [{ fieldKey: "Email", operator: "exact", value: email }],
          pageSize: 1,
        });
        const pageId = firstString(res?.data?.[0]?.data?.["Page ID"]);
        if (pageId) hits[email] = pageId;
      }
      return hits;
    });
    const hitEmail = lookupOrder.find((e) => emailHits[e]) ?? null;
    let contactPageId: string | null = hitEmail ? emailHits[hitEmail] : null;
    // Addresses resolving to OTHER contacts: one person, two records. Each is
    // flagged `Possible duplicate of` the canonical one below.
    const collidingPageIds = [
      ...new Set(Object.values(emailHits).filter((id) => contactPageId && !sameNotionId(id, contactPageId))),
    ];
    let contactCreated = false;
    let nameMatchedFlags: string[] = [];
    let primaryChoice: { primary: string; secondaries: string[]; reason: string } | null = null;
    let domainCheck: { jevCalled: boolean; model: string | null; verdicts: Record<string, DomainVerdict> | null } | null =
      null;
    let sameOrgNameMatch: { id: string; domain: string } | null = null;

    if (!contactPageId) {
      // No address resolved. Look for name-equivalent contacts first: a sole
      // one sharing an organisation domain with the guest is REUSED
      // (pickSameOrgNameMatch); otherwise a new contact is created and they
      // are flagged. Best-effort — a failed query means "no matches".
      const nameForMatch = guest.name || [guest.firstName, guest.lastName].filter(Boolean).join(" ");
      const nameMatches: NameMatch[] = await ctx.step("find-name-matched-contacts", async () => {
        if (!nameForMatch) return [];
        try {
          return await findNameMatchedContacts(nameForMatch);
        } catch (err) {
          console.log(`name-match query failed: ${String((err as Error)?.message ?? err)}`);
          return [];
        }
      });
      const guestEmails = [guest.accountEmail, ...guest.answerEmails.map((a) => a.email)];

      // One domain check covers both decisions: every guest domain when there
      // are answers to choose a Primary from, plus any domain a sole name
      // match shares (usually a cache hit; Jev only for an unseen domain).
      const toJudge = new Set(sharedDomainsWithSoleMatch(nameMatches, guestEmails));
      if (guest.answerEmails.length > 0) for (const e of guestEmails) toJudge.add(emailDomain(e));
      if (toJudge.size > 0) domainCheck = await classifyDomains(ctx, [...toJudge]);

      sameOrgNameMatch = pickSameOrgNameMatch(nameMatches, guestEmails, domainCheck ? domainCheck.verdicts : null);
      if (sameOrgNameMatch) {
        // Reused: from here on it is an existing contact, so 2b adds the
        // guest's addresses as Secondary and indexes them.
        contactPageId = sameOrgNameMatch.id;
        console.log(`Reusing name-matched contact ${contactPageId} (same organisation domain ${sameOrgNameMatch.domain})`);
      }
    }

    if (!contactPageId) {
      // New contact: pick its Primary by domain (choosePrimaryEmail).
      primaryChoice = choosePrimaryEmail(guest.accountEmail, guest.answerEmails, domainCheck ? domainCheck.verdicts : {});
      const { primary, secondaries } = primaryChoice;
      console.log(`Primary Email ${primary} (${primaryChoice.reason})`);

      const fullName =
        guest.name || [guest.firstName, guest.lastName].filter(Boolean).join(" ") || primary;
      const createContactInputs: Record<string, unknown> = {
        datasource: CONTACTS_DS,
        "properties|||Name|||title": fullName,
        "properties|||Primary Email|||email": primary,
        "properties|||Lead Source|||select": CONTACT_LEAD_SOURCE,
      };
      if (secondaries.length) createContactInputs["properties|||Secondary Email|||multi_select"] = secondaries;
      if (guest.firstName) createContactInputs["properties|||First Name|||rich_text"] = guest.firstName;
      if (guest.lastName) createContactInputs["properties|||Last Name|||rich_text"] = guest.lastName;
      // Contacts HAS a default template (blue user-circle icon).
      const createdContact = await createItemWithTemplate(ctx, "contact", CONTACTS_DS, createContactInputs);
      contactPageId = createdContact.pageId;
      contactCreated = true;
      if (!contactPageId) throw new Error("Contact creation returned no page id");

      // Index EVERY address now on the contact — an email missing here is what
      // creates a duplicate contact on the guest's next event.
      const newContactPageId = contactPageId;
      await ctx.step("index-contact-in-table", async () =>
        sdk.createTableRecords({
          table: CONTACT_EMAIL_TABLE,
          keyMode: "names",
          records: [
            { email: primary, type: "Primary" as const },
            ...secondaries.map((email) => ({ email, type: "Secondary" as const })),
          ].map(({ email, type }) => ({
            data: { Email: email, "Page ID": newContactPageId, Type: type, "Trigger Contact Creation": false },
          })),
        }),
      );

      // Flag a brand-new contact against every name-equivalent record so it
      // surfaces for review. Best-effort — never fails the run.
      nameMatchedFlags = await ctx.step("flag-name-matched-contacts", async () => {
        const matches = (await findNameMatchedContacts(fullName))
          .map((m) => m.id)
          .filter((id) => !sameNotionId(id, newContactPageId));
        if (matches.length === 0) return [];
        const existing = (await readPossibleDuplicateLinks(newContactPageId)) ?? [];
        const union = [...existing];
        for (const m of matches) {
          if (!union.some((l) => sameNotionId(l, m))) union.push(m);
        }
        if (union.length === existing.length) return [];
        try {
          await sdk.runAction({
            appKey: NOTION_APP_KEY,
            actionType: "write",
            actionKey: "update_database_item",
            connection: NOTION_CONNECTION,
            inputs: {
              datasource: CONTACTS_DS,
              page: newContactPageId,
              [`properties|||${POSSIBLE_DUPLICATE_PROP}|||relation`]: union,
            },
          });
        } catch {
          return [];
        }
        return matches;
      });
    }

    // 2b. Existing contact: its Primary is left alone; any address the guest
    // gave that it doesn't carry yet is added as a Secondary and indexed. Read
    // and write share one step so a retry re-reads rather than writing stale
    // state. Skipped on a collision, which a person resolves.
    let secondariesAdded: string[] = [];
    const unindexed = lookupOrder.filter((e) => !emailHits[e]);
    if (contactPageId && !contactCreated && collidingPageIds.length === 0 && unindexed.length > 0) {
      const pageId = contactPageId;
      secondariesAdded = await ctx.step("add-secondary-emails", async () => {
        const current = await readContactEmails(pageId);
        if (!current) return [];
        const next = planSecondaryAdditions(current, unindexed);
        if (next === null) return [];
        await sdk.runAction({
          appKey: NOTION_APP_KEY,
          actionType: "write",
          actionKey: "update_database_item",
          connection: NOTION_CONNECTION,
          inputs: { datasource: CONTACTS_DS, page: pageId, "properties|||Secondary Email|||multi_select": next },
        });
        return next.slice(current.secondaryNames.length);
      });
      if (secondariesAdded.length > 0) {
        const added = secondariesAdded;
        await ctx.step("index-added-emails-in-table", async () =>
          sdk.createTableRecords({
            table: CONTACT_EMAIL_TABLE,
            keyMode: "names",
            records: added.map((email) => ({
              data: { Email: email, "Page ID": pageId, Type: "Secondary", "Trigger Contact Creation": false },
            })),
          }),
        );
      }
    }

    // 2c. Flag each colliding contact `Possible duplicate of` the canonical one
    // for a person to judge. Best-effort.
    const markedPossibleDuplicates: string[] = [];
    if (contactPageId && collidingPageIds.length > 0) {
      const owner = contactPageId;
      const marked = await ctx.step("mark-possible-duplicate-contacts", async () => {
        const done: string[] = [];
        for (const dupe of collidingPageIds) {
          try {
            const existing = await readPossibleDuplicateLinks(dupe);
            if (existing === null || existing.some((l) => sameNotionId(l, owner))) continue;
            await sdk.runAction({
              appKey: NOTION_APP_KEY,
              actionType: "write",
              actionKey: "update_database_item",
              connection: NOTION_CONNECTION,
              inputs: {
                datasource: CONTACTS_DS,
                page: dupe,
                [`properties|||${POSSIBLE_DUPLICATE_PROP}|||relation`]: [...existing, owner],
              },
            });
            done.push(dupe);
          } catch (err) {
            console.log(`could not flag ${dupe}: ${String((err as Error)?.message ?? err)}`);
          }
        }
        return done;
      });
      markedPossibleDuplicates.push(...marked);
    }

    // 3. Upsert the Attendance record, deduped on Event + Contact.
    const approvalStatus = resolveAttendanceStatus(guest.approvalStatus, guest.checkedIn);
    const matchKey = `${eventPageId}::${contactPageId}`;
    // A just-created event or contact can have no attendance yet: skip lookups.
    const canPreexist = !eventCreated && !contactCreated;

    let attendancePageId: string | null = null;
    let foundViaTable = false;
    if (canPreexist) {
      const attnHit = await ctx.step("find-attendance-in-table", async () =>
        sdk.listTableRecords({
          table: ATTENDANCE_TABLE,
          keyMode: "names",
          filters: [{ fieldKey: "Match Key", operator: "exact", value: matchKey }],
          pageSize: 1,
        }),
      );
      attendancePageId = firstString(attnHit?.data?.[0]?.data?.["Attendance Page ID"]);
      foundViaTable = attendancePageId != null;
    }

    if (canPreexist && !attendancePageId) {
      const foundAttendance = await ctx.step("find-attendance-in-notion", async () =>
        sdk.runAction({
          appKey: NOTION_APP_KEY,
          actionType: "search",
          actionKey: "find_data_source_item",
          connection: NOTION_CONNECTION,
          inputs: {
            datasource: ATTENDANCE_DS,
            search_fields: ["Event", "Contact"],
            "properties|||Event|||filter": "contains",
            "properties|||Event|||relation": eventPageId,
            "properties|||Event|||match": "required",
            "properties|||Contact|||filter": "contains",
            "properties|||Contact|||relation": contactPageId,
            "properties|||Contact|||match": "required",
          },
        }),
      );
      attendancePageId = firstResult(foundAttendance)?.id ?? null;
    }

    let attendanceCreated = false;
    let attendanceUpdated = false;
    let bodyFilled = false;

    if (!attendancePageId) {
      // No title: a native database automation sets it (ATT-<ID>).
      const createInputs: Record<string, unknown> = {
        datasource: ATTENDANCE_DS,
        "properties|||Event|||relation": [eventPageId],
        "properties|||Contact|||relation": [contactPageId],
        "properties|||Approval Status|||select": approvalStatus,
      };
      if (guest.checkedIn) createInputs["properties|||Checked In|||checkbox"] = true;
      if (guest.registeredAt) {
        createInputs["use_zapier_datetime_fields"] = true;
        createInputs["properties|||Registration Date|||date__start"] = guest.registeredAt;
      }
      await staggerBeforeLink(ctx, guest.guestId);
      const created = await createItemWithTemplate(
        ctx,
        "attendance",
        ATTENDANCE_DS,
        createInputs,
        guest.answersMarkdown,
      );
      attendancePageId = created.pageId;
      attendanceCreated = true;
    } else {
      // Refresh the status; only ever tick "Checked In" true, never un-tick it.
      const pageId = attendancePageId;
      const updateInputs: Record<string, unknown> = {
        datasource: ATTENDANCE_DS,
        page: pageId,
        "properties|||Approval Status|||select": approvalStatus,
      };
      if (guest.checkedIn) updateInputs["properties|||Checked In|||checkbox"] = true;
      await ctx.step("update-attendance", async () =>
        sdk.runAction({
          appKey: NOTION_APP_KEY,
          actionType: "write",
          actionKey: "update_database_item",
          connection: NOTION_CONNECTION,
          inputs: updateInputs,
        }),
      );
      attendanceUpdated = true;

      // Rows created before the answers were written (or by hand) get them
      // once. Only an EMPTY body is filled, so notes written on the row are
      // never touched; read and write share a step so a retry re-reads.
      const answers = guest.answersMarkdown;
      if (answers) {
        bodyFilled = await ctx.step("fill-empty-attendance-body", async () => {
          const res = await sdk.fetch(`${NOTION_API}/blocks/${pageId}/children?page_size=1`, {
            connection: NOTION_CONNECTION,
            headers: { "Notion-Version": NOTION_VERSION },
          });
          if (!res.ok) return false;
          const body: any = await res.json();
          if ((body?.results ?? []).length > 0) return false;
          await sdk.runAction({
            appKey: NOTION_APP_KEY,
            actionType: "write",
            actionKey: "page_content",
            connection: NOTION_CONNECTION,
            inputs: { page_id: pageId, content: answers, content_format: "markdown" },
          });
          return true;
        });
      }
    }

    // 3c. Index the pair in the free attendance Table unless it came from there.
    if (!foundViaTable && attendancePageId) {
      const attnPageId = attendancePageId;
      await ctx.step("index-attendance-in-table", async () => {
        try {
          await sdk.createTableRecords({
            table: ATTENDANCE_TABLE,
            keyMode: "names",
            records: [
              {
                data: {
                  "Match Key": matchKey,
                  "Attendance Page ID": attnPageId,
                  "Event Page ID": eventPageId,
                  "Contact Page ID": contactPageId,
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

    // 4. Make sure the Event link survived any concurrent write (see above).
    const eventLink = attendancePageId
      ? await ensureEventLink(ctx, attendancePageId, eventPageId as string)
      : null;

    // 5. A concurrent run for the same guest may have created a row too (see
    //    the duplicate-create guard). The link check above was the settle wait.
    const attendanceDedupe = attendanceCreated && attendancePageId
      ? await dedupeCreatedAttendance(
          ctx,
          attendancePageId,
          eventPageId as string,
          contactPageId as string,
          approvalStatus,
          guest.checkedIn,
        )
      : null;
    if (attendanceDedupe?.checked && attendanceDedupe.lost) attendancePageId = attendanceDedupe.kept;

    return {
      guestId: guest.guestId,
      accountEmail: guest.accountEmail,
      answerEmails: guest.answerEmails.map((a) => a.email),
      primaryChoice,
      domainCheck,
      lumaEventId: ev.id,
      eventPageId,
      eventCreated,
      contactPageId,
      contactCreated,
      nameMatchedFlags,
      sameOrgNameMatch,
      secondariesAdded,
      collidingPageIds,
      markedPossibleDuplicates,
      attendancePageId,
      attendanceCreated,
      attendanceUpdated,
      attendanceFoundViaTable: foundViaTable,
      approvalStatus,
      checkedIn: guest.checkedIn,
      eventLink,
      attendanceDedupe,
      answersWritten: attendanceCreated ? guest.answersMarkdown !== null : bodyFilled,
    };
  },
);

export default workflow;
