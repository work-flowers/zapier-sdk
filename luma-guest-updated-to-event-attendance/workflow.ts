// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/luma-guest-updated-to-event-attendance
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
const ATTENDANCE_DS = "a591ecac-259f-4490-8f09-f7fddd556eed";
const CONTACTS_DS = "21991b07-11ac-81a6-a894-000be4a09a67";

// Zapier Tables (free ops). Tables auth is automatic (no connection).
const CONTACT_EMAIL_TABLE = "01JYEPSEARXB2Z6BJRCMFGXBC2";
const LUMA_EVENT_TABLE = "01KY6MEV55JF723XYDEE4EP0T6";
const ATTENDANCE_TABLE = "01KY6NDTW05196F1A3G3XY3ESY";

// The Luma "Guest Updated" trigger delivers a guest object with a nested
// `event`. Accept anything and extract defensively.
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

/**
 * The work-email answer from the guest's Luma registration form, if they gave
 * one. Luma delivers answers twice — `registration_answers` (an array of
 * `{ label, value, answer, value_text, question_id }`) and
 * `registration_answers_by_label` (snake_cased label -> value) — so read the
 * array first and fall back to the map.
 *
 * Matched on the label, never a hardcoded `question_id`: Luma mints a fresh
 * question id per event, so the same "Work Email" question has a different id
 * on every event. The best-scoring label wins, so an explicit "Work Email"
 * question beats a merely work-ish one no matter which order they appear in.
 */
function extractWorkEmail(g: Record<string, any>): string | null {
  const candidates: Array<{ score: number; email: string }> = [];

  const answers = Array.isArray(g.registration_answers) ? g.registration_answers : [];
  for (const a of answers) {
    const label = firstString(a?.label, a?.question, a?.name);
    if (!label) continue;
    const score = workEmailLabelScore(label);
    if (score === 0) continue;
    const email = cleanEmail(firstString(a?.value, a?.answer, a?.value_text));
    if (email) candidates.push({ score, email });
  }

  const byLabel = g.registration_answers_by_label;
  if (byLabel && typeof byLabel === "object" && !Array.isArray(byLabel)) {
    for (const [key, value] of Object.entries(byLabel)) {
      const score = workEmailLabelScore(key.replace(/_/g, " "));
      if (score === 0) continue;
      const email = cleanEmail(value);
      if (email) candidates.push({ score, email });
    }
  }

  if (candidates.length === 0) return null;
  // Highest score wins; ties keep source order (array before map).
  return candidates.reduce((best, c) => (c.score > best.score ? c : best)).email;
}

/** First item of a runAction result ({ data: [...] } or a bare array). */
function firstResult(res: any): any {
  if (res && Array.isArray(res.data)) return res.data[0] ?? null;
  if (Array.isArray(res)) return res[0] ?? null;
  return res ?? null;
}

function extractEventId(o: Record<string, any>): string | null {
  const ev = (o.event ?? o) as Record<string, any>;
  return firstString(ev.id, ev.event_id, ev.api_id);
}

interface Guest {
  /** The email on the guest's Luma account — often a personal address. */
  accountEmail: string;
  /** The "Work Email" registration answer, when the guest supplied one and it
   *  differs from their account address. */
  workEmail: string | null;
  approvalStatus: string | null;
  checkedIn: boolean;
  eventId: string;
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
  const eventId = extractEventId(g);
  if (!eventId) return null;
  const answered = extractWorkEmail(g);
  // A work-email answer that just repeats the account address is no answer at
  // all — treat it as absent so nothing gets promoted or duplicated.
  const workEmail = answered && answered !== accountEmail ? answered : null;
  const tickets = Array.isArray(g.tickets) ? g.tickets : [];
  // `checked_in_at` (guest or ticket) is the physical QR-scan check-in.
  // `joined_at` is Luma's separate signal for a virtual guest joining the
  // meeting link — a virtual event never gets a QR scan, so this is the only
  // way its attendance shows up.
  const checkedIn =
    firstString(g.checked_in_at) !== null ||
    firstString(g.joined_at) !== null ||
    tickets.some((t: any) => firstString(t?.checked_in_at) !== null);
  return {
    accountEmail,
    workEmail,
    approvalStatus: firstString(g.approval_status, g.status),
    checkedIn,
    eventId,
  };
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
 * via a raw `sdk.fetch`.
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
 * Work out the email changes a work-email answer implies for a contact. The
 * rule: the guest's own work-email answer always wins the Primary slot, and
 * everything it displaces is kept as a Secondary — so no address is ever lost,
 * even when the contact already had a curated Primary (e.g. one set by
 * `enrich-contact-records`).
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

// --- Workflow ----------------------------------------------------------------
// PURE UPDATER — never creates Event / Contact / Attendance records. Creation
// is owned solely by luma-guest-registered-to-event-attendance. Luma fires
// guest.registered AND guest.updated near-simultaneously on a new registration;
// if both could create, they race and produce duplicate records (neither sees
// the other's just-created record — Notion search lags and this account has no
// unique Table constraint). So this workflow only looks records up and, when it
// finds an existing Attendance record, updates it (approval status + check-in).
// If the event / contact / attendance isn't found yet, it skips as a clean
// no-op — the registered workflow will (or already did) create it, and a later
// guest.updated (e.g. the check-in) will find it and apply the change.
//
// EMAIL IDENTITY: it DOES update an existing contact's emails, promoting a
// "Work Email" registration answer into `Primary Email` and keeping the Luma
// account address as a Secondary (see the registered workflow for the rule).
// That's an update, not a create, and it's the only path that catches a guest
// EDITING their work-email answer after registering — `guest_registered` has
// already fired by then, so only `guest_updated` sees the change.
const workflow = defineDurable(
  "luma-guest-updated-to-event-attendance",
  async (ctx, rawInput: unknown) => {
    const guest = extractGuest(InputSchema.parse(normalizeInput(rawInput)));
    if (!guest) {
      console.log("skipping: no guest email/event in payload (empty/test delivery)");
      return { skipped: true, reason: "no guest email or event in payload" };
    }

    // 1. Resolve the Event (lookup only) — free Table lookup, then Notion.
    const eventTableHit = await ctx.step("find-event-in-table", async () =>
      sdk.listTableRecords({
        table: LUMA_EVENT_TABLE,
        keyMode: "names",
        filters: [
          { fieldKey: "Luma Event ID", operator: "exact", value: guest.eventId },
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
            "properties|||Luma ID|||rich_text": guest.eventId,
            "properties|||Luma ID|||match": "required",
          },
        }),
      );
      eventPageId = firstResult(found)?.id ?? null;
    }
    if (!eventPageId) {
      console.log("skipping: event not found yet (created by the registered workflow)");
      return { skipped: true, reason: "event not found", lumaEventId: guest.eventId };
    }

    // 2. Resolve the Contact (lookup only) via the email -> page id Table.
    // With a work-email answer there are two candidate addresses; the work email
    // is the identity we want, so it is tried first.
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
    // person. Treat the work-email contact as canonical and leave both records'
    // emails alone; the registered workflow owns flagging the duplicate.
    const emailCollision =
      workEmailPageId !== null &&
      accountEmailPageId !== null &&
      workEmailPageId !== accountEmailPageId;

    const contactPageId: string | null = workEmailPageId ?? accountEmailPageId;
    if (!contactPageId) {
      console.log("skipping: contact not found yet (created by the registered workflow)");
      return { skipped: true, reason: "contact not found", email: guest.accountEmail };
    }

    // 2b. Promote a work-email answer into `Primary Email`, keeping whatever it
    // displaces (the old Primary, plus the Luma account address) in the
    // `Secondary Email` multi-select. This is the path that catches a guest
    // EDITING their answer after registering — only `guest_updated` fires then.
    // It's an update to an existing contact, so it stays within this workflow's
    // lookup/update-only remit.
    //
    // The read and the write live in ONE step so a step retry re-reads the
    // contact rather than writing a multi-select computed from stale state.
    let emailsReconciled: {
      changed: boolean;
      primarySet: string | null;
      secondaries: string[] | null;
      read: boolean;
    } | null = null;

    if (workEmail && !emailCollision) {
      emailsReconciled = await ctx.step("reconcile-contact-emails", async () => {
        const current = await readContactEmails(contactPageId);
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
          page: contactPageId,
        };
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

      // Index any address that wasn't already in the table — a contact email
      // missing here is what creates duplicate contacts on the next
      // registration.
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
                  "Page ID": contactPageId,
                  Type: type,
                  "Trigger Contact Creation": false,
                },
              })),
            }),
          );
        }
      }
    }

    // 3. Resolve the Attendance record: free Table lookup, then Notion.
    const matchKey = `${eventPageId}::${contactPageId}`;
    const attnHit = await ctx.step("find-attendance-in-table", async () =>
      sdk.listTableRecords({
        table: ATTENDANCE_TABLE,
        keyMode: "names",
        filters: [{ fieldKey: "Match Key", operator: "exact", value: matchKey }],
        pageSize: 1,
      }),
    );
    let attendancePageId: string | null =
      firstString(attnHit?.data?.[0]?.data?.["Attendance Page ID"]) ?? null;
    let foundViaTable = attendancePageId != null;
    if (!attendancePageId) {
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
    if (!attendancePageId) {
      // No record yet — the registered workflow owns creation. A later
      // guest.updated (e.g. the check-in) will find it and apply the change.
      console.log("skipping: no attendance record yet (creation owned by the registered workflow)");
      return {
        skipped: true,
        reason: "attendance not found; creation owned by registered workflow",
        email: workEmail ?? guest.accountEmail,
        accountEmail: guest.accountEmail,
        workEmail,
        contactPageId,
        emailsReconciled,
        lumaEventId: guest.eventId,
      };
    }

    // 4. Update the existing record: refresh Approval Status ("Attended" once
    // the guest has checked in — see resolveAttendanceStatus); only ever tick
    // "Checked In" true (never un-tick on a later non-checkin update).
    // Registration Date is left untouched.
    const approvalStatus = resolveAttendanceStatus(
      guest.approvalStatus,
      guest.checkedIn,
    );
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

    // 5. Backfill the free Table if we resolved via a Notion search (a record
    // that predates the Table), so future lookups for this pair are free.
    if (!foundViaTable) {
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
      email: workEmail ?? guest.accountEmail,
      accountEmail: guest.accountEmail,
      workEmail,
      lumaEventId: guest.eventId,
      eventPageId,
      contactPageId,
      emailsReconciled,
      emailCollision,
      attendancePageId,
      attendanceUpdated: true,
      attendanceFoundViaTable: foundViaTable,
      approvalStatus,
      checkedIn: guest.checkedIn,
    };
  },
);

export default workflow;
