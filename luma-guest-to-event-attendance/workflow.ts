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
  type: "In-person" | "Virtual";
}

function extractEvent(o: Record<string, any>): LumaEvent {
  const ev = (o.event ?? o) as Record<string, any>;
  const id = firstString(ev.id, ev.event_id, ev.api_id);
  if (!id) {
    throw new Error(
      "No event id in Luma guest payload: " + JSON.stringify(o).slice(0, 300),
    );
  }
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
    type: hasAddress ? "In-person" : "Virtual",
  };
}

interface Guest {
  email: string;
  emailLower: string;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  approvalStatus: string | null;
  registeredAt: string | null;
  checkedIn: boolean;
  event: LumaEvent;
}

function extractGuest(raw: unknown): Guest {
  const o = (raw ?? {}) as Record<string, any>;
  const g = (o.guest ?? o.data ?? o) as Record<string, any>;
  const email = firstString(g.email, g.attendee_email, g.attendee?.email);
  if (!email) {
    throw new Error(
      "No guest email in Luma payload: " + JSON.stringify(raw).slice(0, 300),
    );
  }
  const tickets = Array.isArray(g.tickets) ? g.tickets : [];
  const checkedIn =
    firstString(g.checked_in_at) !== null ||
    tickets.some((t: any) => firstString(t?.checked_in_at) !== null);
  return {
    email,
    emailLower: email.toLowerCase(),
    firstName: firstString(g.first_name, g.firstName),
    lastName: firstString(g.last_name, g.lastName),
    name: firstString(g.name),
    approvalStatus: firstString(g.approval_status, g.status),
    registeredAt: firstString(g.registered_at, g.registeredAt, g.created_at),
    checkedIn,
    event: extractEvent(g),
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
const workflow = defineDurable<unknown, unknown>(
  "luma-guest-to-event-attendance",
  async (ctx, rawInput) => {
    const guest = extractGuest(InputSchema.parse(normalizeInput(rawInput)));
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
      const created = await ctx.step("create-event", async () =>
        sdk.runAction({
          appKey: NOTION_APP_KEY,
          actionType: "write",
          actionKey: "create_database_item",
          connection: NOTION_CONNECTION,
          inputs: createEventInputs,
        }),
      );
      eventPageId = firstResult(created)?.id ?? null;
      eventCreated = true;
      if (!eventPageId) {
        throw new Error(
          "Event creation returned no page id: " +
            JSON.stringify(created).slice(0, 300),
        );
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
    let contactPageId: string | null =
      firstString(contactHit?.data?.[0]?.data?.["Page ID"]) ?? null;
    let contactCreated = false;

    if (!contactPageId) {
      const fullName =
        guest.name ||
        [guest.firstName, guest.lastName].filter(Boolean).join(" ") ||
        guest.email;
      const createContactInputs: Record<string, unknown> = {
        datasource: CONTACTS_DS,
        "properties|||Name|||title": fullName,
        "properties|||Primary Email|||email": guest.emailLower,
      };
      if (guest.firstName) {
        createContactInputs["properties|||First Name|||rich_text"] =
          guest.firstName;
      }
      if (guest.lastName) {
        createContactInputs["properties|||Last Name|||rich_text"] =
          guest.lastName;
      }
      const createdContact = await ctx.step("create-contact", async () =>
        sdk.runAction({
          appKey: NOTION_APP_KEY,
          actionType: "write",
          actionKey: "create_database_item",
          connection: NOTION_CONNECTION,
          inputs: createContactInputs,
        }),
      );
      contactPageId = firstResult(createdContact)?.id ?? null;
      contactCreated = true;
      if (!contactPageId) {
        throw new Error(
          "Contact creation returned no page id: " +
            JSON.stringify(createdContact).slice(0, 300),
        );
      }

      // Index the new contact so future lookups resolve from the table.
      // "Trigger Contact Creation" stays false: the contact already exists.
      await ctx.step("index-contact-in-table", async () =>
        sdk.createTableRecords({
          table: CONTACT_EMAIL_TABLE,
          keyMode: "names",
          records: [
            {
              data: {
                Email: guest.emailLower,
                "Page ID": contactPageId,
                Type: "Primary",
                "Trigger Contact Creation": false,
              },
            },
          ],
        }),
      );
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
      const created = await ctx.step("create-attendance", async () =>
        sdk.runAction({
          appKey: NOTION_APP_KEY,
          actionType: "write",
          actionKey: "create_database_item",
          connection: NOTION_CONNECTION,
          inputs: createInputs,
        }),
      );
      attendancePageId = firstResult(created)?.id ?? null;
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
      email: guest.emailLower,
      lumaEventId: ev.id,
      eventPageId,
      eventCreated,
      contactPageId,
      contactCreated,
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
