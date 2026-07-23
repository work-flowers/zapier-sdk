// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/contrast-registrations-to-event-attendance
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
const CONTACTS_DS = "21991b07-11ac-81a6-a894-000be4a09a67";
const ATTENDANCE_DS = "a591ecac-259f-4490-8f09-f7fddd556eed";

// Zapier Table indexing email -> Notion Contact page id.
// Columns: "Email" (email), "Page ID" (string), "Type" (Primary/Secondary/Tertiary),
// "Trigger Contact Creation" (boolean). Tables auth is automatic (no connection).
const CONTACT_EMAIL_TABLE = "01JYEPSEARXB2Z6BJRCMFGXBC2";

// Verified Contrast "Registrations" payload (2026-07-21): id (registration),
// email, firstName, lastName, webinarName, groupName, organizationName,
// registeredAt, utm*, phoneNumber, jobTitle, companyName, industry,
// websiteUrl, registrationAnswers. No webinar id/slug — webinarName is the
// only event identifier. Accept anything and extract defensively regardless.
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

interface Registration {
  email: string;
  emailLower: string;
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  contrastEventId: string | null;
  webinarName: string | null;
  registeredAt: string | null;
}

function extractRegistration(raw: unknown): Registration {
  const o = (raw ?? {}) as Record<string, any>;
  const email = firstString(o.email, o.attendeeEmail, o.attendee?.email);
  if (!email) {
    throw new Error(
      "No attendee email in Contrast registration payload: " +
        JSON.stringify(raw).slice(0, 300),
    );
  }
  const contrastEventId = firstString(
    o.webinarId,
    o.webinar_id,
    o.webinarUid,
    o.webinar?.id,
    o.eventId,
    o.event_id,
  );
  const webinarName = firstString(
    o.webinarName,
    o.webinar_name,
    o.webinar?.name,
    o.webinar?.title,
  );
  if (!contrastEventId && !webinarName) {
    throw new Error(
      "No webinar id or name in Contrast registration payload: " +
        JSON.stringify(raw).slice(0, 300),
    );
  }
  return {
    email,
    emailLower: email.toLowerCase(),
    firstName: firstString(o.firstName, o.first_name),
    lastName: firstString(o.lastName, o.last_name),
    jobTitle: firstString(o.jobTitle, o.job_title),
    contrastEventId,
    webinarName,
    registeredAt: firstString(o.registeredAt, o.registered_at, o.createdAt),
  };
}

// --- Workflow ----------------------------------------------------------------
const workflow = defineDurable<unknown, unknown>(
  "contrast-registrations-to-event-attendance",
  async (ctx, rawInput) => {
    const reg = extractRegistration(
      InputSchema.parse(normalizeInput(rawInput)),
    );

    // 1. Resolve the Event. The Contrast trigger payload carries no webinar
    // id or slug — webinarName is the only event identifier it sends — so the
    // "Contrast ID" property holds the exact Contrast webinar name (a real id
    // still wins if Contrast ever adds one to the payload).
    const eventKey = reg.contrastEventId ?? reg.webinarName!;

    const foundEvent = await ctx.step("find-event-by-contrast-id", async () =>
      sdk.runAction({
        appKey: NOTION_APP_KEY,
        actionType: "search",
        actionKey: "find_data_source_item",
        connection: NOTION_CONNECTION,
        inputs: {
          datasource: EVENTS_DS,
          search_fields: ["Contrast ID"],
          "properties|||Contrast ID|||filter": "equals",
          "properties|||Contrast ID|||rich_text": eventKey,
          "properties|||Contrast ID|||match": "required",
        },
      }),
    );

    let eventPageId: string | null = firstResult(foundEvent)?.id ?? null;
    let eventCreated = false;
    let eventSelfHealed = false;

    // Fall back to an exact title match, to adopt events that were created by
    // hand before their Contrast ID was filled in.
    if (!eventPageId && reg.webinarName) {
      const foundByTitle = await ctx.step("find-event-by-title", async () =>
        sdk.runAction({
          appKey: NOTION_APP_KEY,
          actionType: "search",
          actionKey: "find_data_source_item",
          connection: NOTION_CONNECTION,
          inputs: {
            datasource: EVENTS_DS,
            search_fields: ["Event"],
            "properties|||Event|||filter": "equals",
            "properties|||Event|||title": reg.webinarName,
            "properties|||Event|||match": "required",
          },
        }),
      );
      const titleMatch = firstResult(foundByTitle);
      const existingContrastId = firstString(
        titleMatch?.properties?.["Contrast ID"],
      );
      // Adopt only when its Contrast ID is empty; a different non-empty value
      // means the title collides with a different Contrast webinar.
      if (titleMatch?.id && !existingContrastId) {
        eventPageId = titleMatch.id;
        await ctx.step("self-heal-event-contrast-id", async () =>
          sdk.runAction({
            appKey: NOTION_APP_KEY,
            actionType: "write",
            actionKey: "update_database_item",
            connection: NOTION_CONNECTION,
            inputs: {
              datasource: EVENTS_DS,
              page: eventPageId,
              "properties|||Contrast ID|||rich_text": eventKey,
            },
          }),
        );
        eventSelfHealed = true;
      }
    }

    if (!eventPageId) {
      const createdEvent = await ctx.step("create-event", async () =>
        sdk.runAction({
          appKey: NOTION_APP_KEY,
          actionType: "write",
          actionKey: "create_database_item",
          connection: NOTION_CONNECTION,
          inputs: {
            datasource: EVENTS_DS,
            "properties|||Event|||title": reg.webinarName ?? eventKey,
            "properties|||Contrast ID|||rich_text": eventKey,
            "properties|||Type|||select": "Virtual",
          },
        }),
      );
      eventPageId = firstResult(createdEvent)?.id ?? null;
      eventCreated = true;
      if (!eventPageId) {
        throw new Error(
          "Event creation returned no page id: " +
            JSON.stringify(createdEvent).slice(0, 300),
        );
      }
    }

    // 2. Resolve the Contact via the email -> page id Zapier Table (covers
    // both Primary and Secondary emails; one row per known address).
    const tableHit = await ctx.step("find-contact-in-table", async () =>
      sdk.listTableRecords({
        table: CONTACT_EMAIL_TABLE,
        keyMode: "names",
        filters: [
          { fieldKey: "Email", operator: "exact", value: reg.emailLower },
        ],
        pageSize: 1,
      }),
    );

    let contactPageId: string | null =
      firstString(tableHit?.data?.[0]?.data?.["Page ID"]) ?? null;
    let contactCreated = false;

    if (!contactPageId) {
      const fullName =
        [reg.firstName, reg.lastName].filter(Boolean).join(" ") || reg.email;
      const createContactInputs: Record<string, unknown> = {
        datasource: CONTACTS_DS,
        "properties|||Name|||title": fullName,
        "properties|||Primary Email|||email": reg.emailLower,
      };
      if (reg.firstName) {
        createContactInputs["properties|||First Name|||rich_text"] =
          reg.firstName;
      }
      if (reg.lastName) {
        createContactInputs["properties|||Last Name|||rich_text"] =
          reg.lastName;
      }
      if (reg.jobTitle) {
        createContactInputs["properties|||Job Title|||rich_text"] =
          reg.jobTitle;
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
                Email: reg.emailLower,
                "Page ID": contactPageId,
                Type: "Primary",
                "Trigger Contact Creation": false,
              },
            },
          ],
        }),
      );
    }

    // 3. Upsert the Attendance record, deduped on Event + Contact relations.
    const foundAttendance = await ctx.step("find-attendance", async () =>
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

    let attendancePageId: string | null =
      firstResult(foundAttendance)?.id ?? null;
    let attendanceCreated = false;

    if (!attendancePageId) {
      // No title: a native database automation sets it (ATT-<ID>).
      const createAttendanceInputs: Record<string, unknown> = {
        datasource: ATTENDANCE_DS,
        "properties|||Event|||relation": [eventPageId],
        "properties|||Contact|||relation": [contactPageId],
        "properties|||Attendance|||select": "Registered",
      };
      if (reg.registeredAt) {
        createAttendanceInputs["use_zapier_datetime_fields"] = true;
        createAttendanceInputs["properties|||Registration Date|||date__start"] =
          reg.registeredAt;
      }
      const createdAttendance = await ctx.step("create-attendance", async () =>
        sdk.runAction({
          appKey: NOTION_APP_KEY,
          actionType: "write",
          actionKey: "create_database_item",
          connection: NOTION_CONNECTION,
          inputs: createAttendanceInputs,
        }),
      );
      attendancePageId = firstResult(createdAttendance)?.id ?? null;
      attendanceCreated = true;
    }
    // Existing record: leave untouched (never downgrade "Attended", never
    // overwrite dates) — re-deliveries of the same registration are no-ops.

    return {
      email: reg.emailLower,
      eventKey,
      webinarName: reg.webinarName,
      eventPageId,
      eventCreated,
      eventSelfHealed,
      contactPageId,
      contactCreated,
      attendancePageId,
      attendanceCreated,
    };
  },
);

export default workflow;
