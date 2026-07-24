import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
const NOTION_APP_KEY = "NotionCLIAPI";
const NOTION_CONNECTION = "notion_wf";

// Marketing Events workspace data sources.
const EVENTS_DS = "65490a1e-aa79-4884-932b-60e88db67042";
const ATTENDANCE_DS = "a591ecac-259f-4490-8f09-f7fddd556eed";

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

/** First item of a runAction result ({ data: [...] } or a bare array). */
function firstResult(res: any): any {
  if (res && Array.isArray(res.data)) return res.data[0] ?? null;
  if (Array.isArray(res)) return res[0] ?? null;
  return res ?? null;
}

interface LumaEvent {
  id: string;
  name: string | null;
  checkedIn?: boolean;
}

function extractEventId(o: Record<string, any>): string | null {
  const ev = (o.event ?? o) as Record<string, any>;
  return firstString(ev.id, ev.event_id, ev.api_id);
}

interface Guest {
  emailLower: string;
  approvalStatus: string | null;
  checkedIn: boolean;
  eventId: string;
}

function extractGuest(raw: unknown): Guest | null {
  const o = (raw ?? {}) as Record<string, any>;
  const g = (o.guest ?? o.data ?? o) as Record<string, any>;
  const email = firstString(g.email, g.attendee_email, g.attendee?.email);
  // Empty/malformed payload (e.g. a manual "test" run from the Zapier UI) or a
  // guest with no resolvable event — return null so the workflow exits as a
  // clean no-op rather than a failed run.
  if (!email) return null;
  const eventId = extractEventId(g);
  if (!eventId) return null;
  const tickets = Array.isArray(g.tickets) ? g.tickets : [];
  const checkedIn =
    firstString(g.checked_in_at) !== null ||
    tickets.some((t: any) => firstString(t?.checked_in_at) !== null);
  return {
    emailLower: email.toLowerCase(),
    approvalStatus: firstString(g.approval_status, g.status),
    checkedIn,
    eventId,
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
const workflow = defineDurable<unknown, unknown>(
  "luma-guest-updated-to-event-attendance",
  async (ctx, rawInput) => {
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
    const contactHit = await ctx.step("find-contact-in-table", async () =>
      sdk.listTableRecords({
        table: CONTACT_EMAIL_TABLE,
        keyMode: "names",
        filters: [
          { fieldKey: "Email", operator: "exact", value: guest.emailLower },
        ],
        pageSize: 1,
      }),
    );
    const contactPageId: string | null =
      firstString(contactHit?.data?.[0]?.data?.["Page ID"]) ?? null;
    if (!contactPageId) {
      console.log("skipping: contact not found yet (created by the registered workflow)");
      return { skipped: true, reason: "contact not found", email: guest.emailLower };
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
        email: guest.emailLower,
        lumaEventId: guest.eventId,
      };
    }

    // 4. Update the existing record: refresh Approval Status; only ever tick
    // "Checked In" true (never un-tick on a later non-checkin update).
    // Registration Date is left untouched.
    const approvalStatus = mapApprovalStatus(guest.approvalStatus);
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
      email: guest.emailLower,
      lumaEventId: guest.eventId,
      eventPageId,
      contactPageId,
      attendancePageId,
      attendanceUpdated: true,
      attendanceFoundViaTable: foundViaTable,
      approvalStatus,
      checkedIn: guest.checkedIn,
    };
  },
);

export default workflow;
