// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/luma-guest-registered-to-event-attendance
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
const NOTION_APP_KEY = "NotionCLIAPI";
const NOTION_CONNECTION = "notion_wf";
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

// Marketing Events workspace data sources.
const EVENTS_DS = "65490a1e-aa79-4884-932b-60e88db67042";
const CONTACTS_DS = "21991b07-11ac-81a6-a894-000be4a09a67";
const ATTENDANCE_DS = "a591ecac-259f-4490-8f09-f7fddd556eed";

// Zapier Tables (free ops). Tables auth is automatic (no connection).
// Email -> Contact page id.
const CONTACT_EMAIL_TABLE = "01JYEPSEARXB2Z6BJRCMFGXBC2";
// Luma event id -> Event page id.
const LUMA_EVENT_TABLE = "01KY6MEV55JF723XYDEE4EP0T6";
// Mirror of Event Attendance: "<eventPageId>::<contactPageId>" -> attendance
// page id (+ the related Event/Contact page ids). Lets the highest-volume guest
// triggers dedup attendance without a Notion search.
const ATTENDANCE_TABLE = "01KY6NDTW05196F1A3G3XY3ESY";

// The Luma "Guest Registered"/"Guest Updated" triggers deliver a guest object
// with a nested `event`. Accept anything and extract defensively.
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

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/** Lowercased, validated email — or null. Every Table row and lookup is
 *  lowercase, so a raw-case address would never match. */
function cleanEmail(v: unknown): string | null {
  const s = firstString(v)?.toLowerCase() ?? null;
  return s && EMAIL_RE.test(s) ? s : null;
}

/** True for a registration-question label that asks for a work address —
 *  it has to mention an email AND a work-ish word, so "Work Email",
 *  "Business e-mail address" and "What's your company email?" all match while
 *  a plain "Email" (the Luma account address) does not. */
function isWorkEmailLabel(label: string): boolean {
  const l = label.toLowerCase();
  return (
    /e-?mail/.test(l) &&
    /\b(work|business|company|corporate|office|professional)\b/.test(l)
  );
}

/**
 * The work-email answer from the guest's Luma registration form, if they gave
 * one. Luma delivers answers twice — `registration_answers` (an array of
 * `{ label, value, answer, value_text, question_id }`) and
 * `registration_answers_by_label` (snake_cased label -> value) — so read the
 * array first and fall back to the map. Both are matched on the label rather
 * than a hardcoded `question_id`, because Luma mints a fresh question id per
 * event: the same "Work Email" question has a different id on every event.
 */
function extractWorkEmail(g: Record<string, any>): string | null {
  const answers = Array.isArray(g.registration_answers) ? g.registration_answers : [];
  for (const a of answers) {
    const label = firstString(a?.label, a?.question, a?.name);
    if (!label || !isWorkEmailLabel(label)) continue;
    const email = cleanEmail(firstString(a?.value, a?.answer, a?.value_text));
    if (email) return email;
  }
  const byLabel = g.registration_answers_by_label;
  if (byLabel && typeof byLabel === "object" && !Array.isArray(byLabel)) {
    for (const [key, value] of Object.entries(byLabel)) {
      if (!isWorkEmailLabel(key.replace(/_/g, " "))) continue;
      const email = cleanEmail(value);
      if (email) return email;
    }
  }
  return null;
}

/** First item of a runAction result ({ data: [...] } or a bare array). */
function firstResult(res: any): any {
  if (res && Array.isArray(res.data)) return res.data[0] ?? null;
  if (Array.isArray(res)) return res[0] ?? null;
  return res ?? null;
}

interface LumaEvent {
  id: string;
  name: string | null;
  startAt: string | null;
  endAt: string | null;
  url: string | null;
  coverUrl: string | null;
  descriptionMarkdown: string | null;
  type: "In-person" | "Virtual";
}

function extractEvent(o: Record<string, any>): LumaEvent | null {
  const ev = (o.event ?? o) as Record<string, any>;
  const id = firstString(ev.id, ev.event_id, ev.api_id);
  if (!id) return null;
  const hasAddress =
    firstString(ev.address) !== null ||
    ev.latitude != null ||
    ev.longitude != null ||
    ev.geo_latitude != null;
  return {
    id,
    name: firstString(ev.name, ev.title),
    startAt: firstString(ev.start_at, ev.startAt, ev.start),
    endAt: firstString(ev.end_at, ev.endAt, ev.end),
    url: firstString(ev.url, ev.event_url),
    coverUrl: firstString(ev.cover_url, ev.coverUrl),
    descriptionMarkdown: firstString(ev.description_markdown, ev.descriptionMarkdown),
    type: hasAddress ? "In-person" : "Virtual",
  };
}

interface Guest {
  /** The email on the guest's Luma account — often a personal address. */
  accountEmail: string;
  /** The "Work Email" registration answer, when the guest supplied one and it
   *  differs from their account address. */
  workEmail: string | null;
  /** The address that belongs in Notion's `Primary Email`: the work email when
   *  we have one, else the Luma account address. */
  primaryEmail: string;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  approvalStatus: string | null;
  registeredAt: string | null;
  checkedIn: boolean;
  event: LumaEvent;
}

function extractGuest(raw: unknown): Guest | null {
  const o = (raw ?? {}) as Record<string, any>;
  const g = (o.guest ?? o.data ?? o) as Record<string, any>;
  const accountEmail = cleanEmail(
    firstString(g.email, g.attendee_email, g.attendee?.email),
  );
  // Empty/malformed payload (e.g. a manual "test" run from the Zapier UI) or a
  // guest with no resolvable event — return null so the workflow exits as a
  // clean no-op rather than a failed run.
  if (!accountEmail) return null;
  const event = extractEvent(g);
  if (!event) return null;
  const answered = extractWorkEmail(g);
  // A work-email answer that just repeats the account address is no answer at
  // all — treat it as absent so nothing gets promoted or duplicated.
  const workEmail = answered && answered !== accountEmail ? answered : null;
  const tickets = Array.isArray(g.tickets) ? g.tickets : [];
  const checkedIn =
    firstString(g.checked_in_at) !== null ||
    tickets.some((t: any) => firstString(t?.checked_in_at) !== null);
  return {
    accountEmail,
    workEmail,
    primaryEmail: workEmail ?? accountEmail,
    firstName: firstString(g.first_name, g.firstName),
    lastName: firstString(g.last_name, g.lastName),
    name: firstString(g.name),
    approvalStatus: firstString(g.approval_status, g.status),
    registeredAt: firstString(g.registered_at, g.registeredAt, g.created_at),
    checkedIn,
    event,
  };
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
 * Work out the email changes a work-email answer implies for an EXISTING
 * contact. The rule: the guest's own work-email answer always wins the Primary
 * slot, and everything it displaces is kept as a Secondary — so no address is
 * ever lost, even when the contact already had a curated Primary (e.g. one set
 * by `enrich-contact-records`).
 *
 * Existing multi-select options are carried over verbatim rather than
 * re-normalised, so a stray non-email option isn't silently dropped.
 * Returns null for a field that needs no write.
 */
function planContactEmails(
  current: ContactEmailState,
  workEmail: string,
  accountEmail: string,
): { primary: string | null; secondaries: string[] | null } {
  const kept: string[] = [];
  // The work email is moving to Primary, so it must not also sit in Secondary.
  const seen = new Set<string>([workEmail]);
  const push = (name: string) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    kept.push(name);
  };
  for (const name of current.secondaryNames) push(name);
  if (current.primary) push(current.primary);
  push(accountEmail);

  const secondariesChanged =
    kept.length !== current.secondaryNames.length ||
    kept.some((name, i) => name !== current.secondaryNames[i]);

  return {
    primary: current.primary === workEmail ? null : workEmail,
    secondaries: secondariesChanged ? kept : null,
  };
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

// --- Workflow ----------------------------------------------------------------
// SOLE CREATOR of Event / Contact / Attendance records for the guest flow.
// Luma fires guest.registered AND guest.updated near-simultaneously on a new
// registration; if both workflows could create, they race and produce
// duplicate Attendance (and Contact) records — neither sees the other's
// just-created record (Notion search lags, and this account has no unique
// Table constraint). So creation lives here only; the guest_updated deployment
// (luma-guest-updated-to-event-attendance) is lookup/update-only.
//
// EMAIL IDENTITY: the Luma events ask for a "Work Email" as a registration
// question, because a guest's Luma account address is often personal. When that
// answer is present it becomes the contact's `Primary Email`, and the Luma
// account address is kept in the `Secondary Email` multi-select. The answer wins
// the Primary slot even against a Primary already on the contact — whatever it
// displaces moves to Secondary, so no address is ever lost.
const workflow = defineDurable<unknown, unknown>(
  "luma-guest-registered-to-event-attendance",
  async (ctx, rawInput) => {
    const guest = extractGuest(InputSchema.parse(normalizeInput(rawInput)));
    if (!guest) {
      console.log("skipping: no guest email/event in payload (empty/test delivery)");
      return { skipped: true, reason: "no guest email or event in payload" };
    }
    const ev = guest.event;

    // 1. Resolve the Event: free Table lookup -> Notion search -> create.
    const eventTableHit = await ctx.step("find-event-in-table", async () =>
      sdk.listTableRecords({
        table: LUMA_EVENT_TABLE,
        keyMode: "names",
        filters: [
          { fieldKey: "Luma Event ID", operator: "exact", value: ev.id },
        ],
        pageSize: 1,
      }),
    );
    let eventPageId: string | null =
      firstString(eventTableHit?.data?.[0]?.data?.["Page ID"]) ?? null;

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

    let eventCreated = false;
    if (!eventPageId) {
      const createEventInputs: Record<string, unknown> = {
        datasource: EVENTS_DS,
        "properties|||Event|||title": ev.name ?? `Luma event ${ev.id}`,
        "properties|||Luma ID|||rich_text": ev.id,
        "properties|||Type|||select": ev.type,
      };
      if (ev.url) createEventInputs["properties|||Event page|||url"] = ev.url;
      if (ev.startAt) {
        createEventInputs["use_zapier_datetime_fields"] = true;
        createEventInputs["properties|||Date|||date__start"] = ev.startAt;
        if (ev.endAt) createEventInputs["properties|||Date|||date__end"] = ev.endAt;
      }
      // Apply the Events default template if one exists, then append Luma's
      // description as the body (create-only here; the luma-event-to-notion
      // workflow owns ongoing body sync via event_updated).
      const created = await createItemWithTemplate(
        ctx,
        "event",
        EVENTS_DS,
        createEventInputs,
        ev.descriptionMarkdown,
      );
      eventPageId = created.pageId;
      eventCreated = true;
      if (!eventPageId) {
        throw new Error("Event creation returned no page id");
      }

      // Best-effort page cover from the Luma cover image.
      if (ev.coverUrl) {
        const pageId = eventPageId;
        const coverUrl = ev.coverUrl;
        await ctx.step("set-event-cover", async () => {
          try {
            const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
              connection: NOTION_CONNECTION,
              method: "PATCH",
              headers: {
                "Notion-Version": NOTION_VERSION,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                cover: { type: "external", external: { url: coverUrl } },
              }),
            });
            return { ok: res.ok };
          } catch (err) {
            return { ok: false, error: String((err as Error)?.message ?? err) };
          }
        });
      }

      // Index the new event so future lookups resolve from the free Table.
      await ctx.step("index-event-in-table", async () => {
        try {
          await sdk.createTableRecords({
            table: LUMA_EVENT_TABLE,
            keyMode: "names",
            records: [
              {
                data: {
                  "Luma Event ID": ev.id,
                  "Page ID": eventPageId,
                  "Event Name": ev.name ?? "",
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

    // 2. Resolve the Contact via the email -> page id Zapier Table (covers
    // both Primary and Secondary emails; one row per known address).
    //
    // With a work-email answer there are TWO candidate addresses, so look both
    // up: the work email is the identity we want on the record, but the guest
    // may already be known under their Luma account address (or, rarely, under
    // both — on two different contacts).
    const workEmail = guest.workEmail;
    const workEmailHit = workEmail
      ? await ctx.step("find-contact-by-work-email", async () =>
          sdk.listTableRecords({
            table: CONTACT_EMAIL_TABLE,
            keyMode: "names",
            filters: [{ fieldKey: "Email", operator: "exact", value: workEmail }],
            pageSize: 1,
          }),
        )
      : null;
    const workEmailPageId: string | null =
      firstString(workEmailHit?.data?.[0]?.data?.["Page ID"]) ?? null;

    const contactHit = await ctx.step("find-contact-in-table", async () =>
      sdk.listTableRecords({
        table: CONTACT_EMAIL_TABLE,
        keyMode: "names",
        filters: [
          { fieldKey: "Email", operator: "exact", value: guest.accountEmail },
        ],
        pageSize: 1,
      }),
    );
    const accountEmailPageId: string | null =
      firstString(contactHit?.data?.[0]?.data?.["Page ID"]) ?? null;

    // Both addresses resolve, but to DIFFERENT contacts — two records for one
    // person. Treat the work-email contact as canonical (it carries the
    // identity the guest just told us) and leave both records' emails alone
    // rather than shuffling addresses between them; the account-email record is
    // flagged `Duplicate of` below so the collision surfaces in Notion.
    const emailCollision =
      workEmailPageId !== null &&
      accountEmailPageId !== null &&
      workEmailPageId !== accountEmailPageId;

    let contactPageId: string | null = workEmailPageId ?? accountEmailPageId;
    let contactCreated = false;

    if (!contactPageId) {
      const fullName =
        guest.name ||
        [guest.firstName, guest.lastName].filter(Boolean).join(" ") ||
        guest.primaryEmail;
      const createContactInputs: Record<string, unknown> = {
        datasource: CONTACTS_DS,
        "properties|||Name|||title": fullName,
        "properties|||Primary Email|||email": guest.primaryEmail,
      };
      if (workEmail) {
        // The work email took the Primary slot, so the Luma account address
        // (often a personal one) is kept as a Secondary.
        createContactInputs["properties|||Secondary Email|||multi_select"] = [
          guest.accountEmail,
        ];
      }
      if (guest.firstName) {
        createContactInputs["properties|||First Name|||rich_text"] =
          guest.firstName;
      }
      if (guest.lastName) {
        createContactInputs["properties|||Last Name|||rich_text"] =
          guest.lastName;
      }
      // Contacts HAS a default template (blue user-circle icon), so this picks
      // it up — automation-created contacts match hand-made ones.
      const createdContact = await createItemWithTemplate(
        ctx,
        "contact",
        CONTACTS_DS,
        createContactInputs,
      );
      contactPageId = createdContact.pageId;
      contactCreated = true;
      if (!contactPageId) {
        throw new Error("Contact creation returned no page id");
      }

      // Index EVERY address now on the contact so future lookups resolve from
      // the table — an email missing here is what creates a duplicate contact
      // on the guest's next registration.
      // "Trigger Contact Creation" stays false: the contact already exists.
      const newContactPageId = contactPageId;
      await ctx.step("index-contact-in-table", async () =>
        sdk.createTableRecords({
          table: CONTACT_EMAIL_TABLE,
          keyMode: "names",
          records: [
            { email: guest.primaryEmail, type: "Primary" as const },
            ...(workEmail
              ? [{ email: guest.accountEmail, type: "Secondary" as const }]
              : []),
          ].map(({ email, type }) => ({
            data: {
              Email: email,
              "Page ID": newContactPageId,
              Type: type,
              "Trigger Contact Creation": false,
            },
          })),
        }),
      );
    }

    // 2b. A work-email answer against a contact that already existed: promote
    // the work email into `Primary Email` and keep whatever it displaces (the
    // old Primary, plus the Luma account address) in the `Secondary Email`
    // multi-select. Nothing to do when the contact was just created above (it
    // already has the right emails) or on a cross-contact collision.
    //
    // The read and the write live in ONE step so a step retry re-reads the
    // contact rather than writing a multi-select computed from stale state.
    let emailsReconciled: {
      changed: boolean;
      primarySet: string | null;
      secondaries: string[] | null;
      read: boolean;
    } | null = null;

    if (workEmail && contactPageId && !contactCreated && !emailCollision) {
      const pageId = contactPageId;
      emailsReconciled = await ctx.step("reconcile-contact-emails", async () => {
        const current = await readContactEmails(pageId);
        if (!current) {
          // Couldn't read the page — leave the emails alone rather than
          // clobbering the multi-select from a guess.
          return { changed: false, primarySet: null, secondaries: null, read: false };
        }
        const plan = planContactEmails(current, workEmail, guest.accountEmail);
        if (plan.primary === null && plan.secondaries === null) {
          return { changed: false, primarySet: null, secondaries: null, read: true };
        }
        const updateInputs: Record<string, unknown> = {
          datasource: CONTACTS_DS,
          page: pageId,
        };
        // An empty string means "leave unchanged" to the Notion action, which
        // is exactly what a null plan field wants.
        if (plan.primary !== null) {
          updateInputs["properties|||Primary Email|||email"] = plan.primary;
        }
        if (plan.secondaries !== null) {
          updateInputs["properties|||Secondary Email|||multi_select"] =
            plan.secondaries;
        }
        await sdk.runAction({
          appKey: NOTION_APP_KEY,
          actionType: "write",
          actionKey: "update_database_item",
          connection: NOTION_CONNECTION,
          inputs: updateInputs,
        });
        return {
          changed: true,
          primarySet: plan.primary,
          secondaries: plan.secondaries,
          read: true,
        };
      });

      // Index any address that wasn't already in the table. The Contacts DB
      // automation behind `contact-emails-to-zapier-table` also indexes these
      // off the edit above, but it checks for an existing row first and this
      // workflow must not depend on that timing — a missing row is what creates
      // duplicate contacts.
      if (emailsReconciled?.read) {
        const rows: Array<{ email: string; type: "Primary" | "Secondary" }> = [];
        if (!workEmailPageId) rows.push({ email: workEmail, type: "Primary" });
        if (!accountEmailPageId) {
          rows.push({ email: guest.accountEmail, type: "Secondary" });
        }
        if (rows.length > 0) {
          await ctx.step("index-promoted-emails-in-table", async () =>
            sdk.createTableRecords({
              table: CONTACT_EMAIL_TABLE,
              keyMode: "names",
              records: rows.map(({ email, type }) => ({
                data: {
                  Email: email,
                  "Page ID": pageId,
                  Type: type,
                  "Trigger Contact Creation": false,
                },
              })),
            }),
          );
        }
      }
    }

    // 2c. Flag the cross-contact collision in Notion so it can be merged by
    // hand — the same `Duplicate of` convention `contact-emails-to-zapier-table`
    // uses when an address already belongs to another contact.
    let markedDuplicateOf: string | null = null;
    if (emailCollision) {
      const owner = workEmailPageId as string;
      const dupe = accountEmailPageId as string;
      await ctx.step("mark-duplicate-contact", async () => {
        try {
          await sdk.runAction({
            appKey: NOTION_APP_KEY,
            actionType: "write",
            actionKey: "update_database_item",
            connection: NOTION_CONNECTION,
            inputs: {
              datasource: CONTACTS_DS,
              page: dupe,
              "properties|||Duplicate of|||relation": [owner],
            },
          });
          return { marked: true as const };
        } catch (err) {
          return {
            marked: false as const,
            error: String((err as Error)?.message ?? err),
          };
        }
      });
      markedDuplicateOf = owner;
    }

    // 3. Upsert the Attendance record, deduped on Event + Contact.
    const approvalStatus = mapApprovalStatus(guest.approvalStatus);
    const matchKey = `${eventPageId}::${contactPageId}`;

    // If we just created the event or the contact, no attendance can pre-exist
    // for this pair — skip both lookups entirely and create directly. This is
    // the common first-time-registrant path and costs zero read calls.
    const canPreexist = !eventCreated && !contactCreated;

    // 3a. Resolve the attendance page id via the free attendance-index Table.
    let attendancePageId: string | null = null;
    let foundViaTable = false;
    if (canPreexist) {
      const attnHit = await ctx.step("find-attendance-in-table", async () =>
        sdk.listTableRecords({
          table: ATTENDANCE_TABLE,
          keyMode: "names",
          filters: [
            { fieldKey: "Match Key", operator: "exact", value: matchKey },
          ],
          pageSize: 1,
        }),
      );
      attendancePageId =
        firstString(attnHit?.data?.[0]?.data?.["Attendance Page ID"]) ?? null;
      foundViaTable = attendancePageId != null;
    }

    // 3b. Fall back to a Notion search only on a Table miss — backfills records
    // created before this Table existed (Contrast-era / manual), then indexes
    // them below so the next lookup is free.
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

    if (!attendancePageId) {
      // No title: a native database automation sets it (ATT-<ID>).
      const createInputs: Record<string, unknown> = {
        datasource: ATTENDANCE_DS,
        "properties|||Event|||relation": [eventPageId],
        "properties|||Contact|||relation": [contactPageId],
        "properties|||Approval Status|||select": approvalStatus,
      };
      if (guest.checkedIn) {
        createInputs["properties|||Checked In|||checkbox"] = true;
      }
      if (guest.registeredAt) {
        createInputs["use_zapier_datetime_fields"] = true;
        createInputs["properties|||Registration Date|||date__start"] =
          guest.registeredAt;
      }
      const created = await createItemWithTemplate(
        ctx,
        "attendance",
        ATTENDANCE_DS,
        createInputs,
      );
      attendancePageId = created.pageId;
      attendanceCreated = true;
    } else {
      // Update the approval status to the current value. Only ever tick
      // "Checked In" true — never un-tick it on a later non-checkin update.
      // Registration Date is left untouched.
      const pageId = attendancePageId;
      const updateInputs: Record<string, unknown> = {
        datasource: ATTENDANCE_DS,
        page: pageId,
        "properties|||Approval Status|||select": approvalStatus,
      };
      if (guest.checkedIn) {
        updateInputs["properties|||Checked In|||checkbox"] = true;
      }
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
    }

    // 3c. Index the pair in the free attendance Table unless it was already
    // resolved from there (covers both a fresh create and a Notion backfill),
    // so subsequent guest triggers for this pair skip the Notion search.
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

    return {
      email: guest.primaryEmail,
      accountEmail: guest.accountEmail,
      workEmail,
      lumaEventId: ev.id,
      eventPageId,
      eventCreated,
      contactPageId,
      contactCreated,
      emailsReconciled,
      emailCollision,
      markedDuplicateOf,
      attendancePageId,
      attendanceCreated,
      attendanceUpdated,
      attendanceFoundViaTable: foundViaTable,
      approvalStatus,
      checkedIn: guest.checkedIn,
    };
  },
);

export default workflow;
