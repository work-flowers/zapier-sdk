// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/gcal-client-meeting-to-harvest-time
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";

const sdk = createZapierSdk();

const HARVEST_CONNECTION = "harvest_wf";
const HARVEST_API = "https://api.harvestapp.com/v2";

// Zapier Table of company ids, mirrored from Notion Companies by
// notion-companies-to-zapier-table. A row with a Harvest Client ID is a client;
// its Domain (a link field, "https://knoxxfoods.com" or "knoxxfoods.com") is how
// an attendee's email is matched to it.
const COMPANY_TABLE = "01JM8PH8YM93A482M8BFZ6WKW6";
const HARVEST_CLIENT_FIELD = "Harvest Client ID";
const DOMAIN_FIELD = "Domain";

// The task a client meeting is logged against, matching how calendar imports
// were filed by hand in the Harvest UI.
const MEETING_TASK_NAME = "Advisory";

// Our own domain: attendees here are never the client.
const OWN_DOMAINS = new Set(["work.flowers"]);

// --- Pure helpers ----------------------------------------------------------
function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline can deliver input double-encoded (a JSON string of a
  // JSON string). Parse until we reach a non-string, or stop on parse failure.
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
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

type Attendee = { email: string; self: boolean; declined: boolean; resource: boolean };

type CalendarEvent = {
  id: string;
  seriesId: string;
  summary: string;
  status: string;
  eventType: string;
  startDateTime: string | null; // null for an all-day event
  durationMinutes: number | null;
  htmlLink: string | null;
  attendees: Attendee[];
};

/** The Google Calendar "Event Ended" record. Zapier adds `duration_minutes`
 *  to the plain API event, which saves doing date arithmetic in the body. */
function extractEvent(raw: unknown): CalendarEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, any>;
  const id = firstString(o.id);
  if (!id || o.kind !== "calendar#event") return null;
  const minutes = Number(o.duration_minutes);
  const attendees: Attendee[] = Array.isArray(o.attendees)
    ? o.attendees
        .filter((a: any) => typeof a?.email === "string")
        .map((a: any) => ({
          email: a.email.trim().toLowerCase(),
          self: a.self === true,
          declined: a.responseStatus === "declined",
          resource: a.resource === true,
        }))
    : [];
  return {
    id,
    seriesId: firstString(o.recurringEventId) ?? id,
    summary: firstString(o.summary) ?? "",
    status: firstString(o.status) ?? "",
    eventType: firstString(o.eventType) ?? "default",
    startDateTime: firstString(o.start?.dateTime),
    durationMinutes: Number.isFinite(minutes) ? minutes : null,
    htmlLink: firstString(o.htmlLink),
    attendees,
  };
}

/** Why an event is not a loggable meeting, or null when it is. */
function skipReason(e: CalendarEvent): string | null {
  if (e.status === "cancelled") return "cancelled";
  if (e.eventType !== "default") return `event-type-${e.eventType}`;
  if (!e.startDateTime) return "all-day";
  if (!e.durationMinutes || e.durationMinutes <= 0) return "no-duration";
  if (e.attendees.some((a) => a.self && a.declined)) return "declined";
  return null;
}

/** "https://www.knoxxfoods.com/about" -> "knoxxfoods.com". */
function hostOf(value: string): string | null {
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .split(/[/?#]/)[0]
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  return host.includes(".") ? host : null;
}

/** Domains of the guests who were not us and did not decline. */
function guestDomains(e: CalendarEvent): string[] {
  const domains = new Set<string>();
  for (const a of e.attendees) {
    if (a.self || a.declined || a.resource) continue;
    const domain = a.email.split("@")[1];
    if (domain && !OWN_DOMAINS.has(domain)) domains.add(domain);
  }
  return [...domains];
}

/** True when `domain` is the client's domain or a subdomain of it. */
function domainMatches(domain: string, clientDomain: string): boolean {
  return domain === clientDomain || domain.endsWith(`.${clientDomain}`);
}

function linkText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    return firstString(v.link, v.text) ?? "";
  }
  return "";
}

type Client = { clientId: string; name: string; domain: string };

async function harvestGet(path: string): Promise<any> {
  const res = await sdk.fetch(`${HARVEST_API}${path}`, { connection: HARVEST_CONNECTION });
  if (!res.ok) throw new Error(`[Harvest] GET ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function findEntryByReference(eventId: string): Promise<number | null> {
  const body = await harvestGet(
    `/time_entries?external_reference_id=${encodeURIComponent(eventId)}&per_page=1`,
  );
  const hit = body?.time_entries?.[0];
  return typeof hit?.id === "number" ? hit.id : null;
}

// --- Workflow --------------------------------------------------------------
const workflow = defineDurable("gcal-client-meeting-to-harvest-time", async (ctx, rawInput) => {
  const event = extractEvent(normalizeInput(rawInput));
  if (!event) {
    // A polling trigger never sends an empty ping, so anything unreadable is a
    // real event whose shape we failed to understand.
    throw new Error(
      `Unrecognized Google Calendar event payload: ${JSON.stringify(rawInput).slice(0, 500)}`,
    );
  }

  const reason = skipReason(event);
  if (reason) {
    console.log(`Skipping ${event.id} (${event.summary}): ${reason}`);
    return { skipped: reason, eventId: event.id };
  }

  const domains = guestDomains(event);
  if (domains.length === 0) {
    console.log(`Skipping ${event.id} (${event.summary}): no external guests`);
    return { skipped: "no-external-guests", eventId: event.id };
  }

  // Table reads cost no tasks. Only rows with a Harvest Client ID are clients.
  const clients = await ctx.step("load-harvest-clients", async () => {
    const out: Client[] = [];
    let cursor: string | undefined = undefined;
    for (let page = 0; page < 10; page++) {
      const res: any = await sdk.listTableRecords({
        table: COMPANY_TABLE,
        keyMode: "names",
        filters: [{ fieldKey: HARVEST_CLIENT_FIELD, operator: "isnull", value: false }],
        pageSize: 1000,
        ...(cursor ? { cursor } : {}),
      });
      for (const r of res.data ?? []) {
        const clientId = firstString(r.data?.[HARVEST_CLIENT_FIELD]);
        const domain = hostOf(linkText(r.data?.[DOMAIN_FIELD]));
        if (clientId && /^\d+$/.test(clientId) && domain) {
          out.push({ clientId, name: firstString(r.data?.["Company Name"]) ?? "", domain });
        }
      }
      cursor = res.nextCursor ?? undefined;
      if (!cursor) return out;
    }
    throw new Error(`[Table] Company IDs did not finish paginating (${out.length} clients read)`);
  });

  const matched = new Map<string, Client>();
  for (const d of domains) {
    for (const c of clients) if (domainMatches(d, c.domain)) matched.set(c.clientId, c);
  }
  if (matched.size === 0) {
    console.log(`Skipping ${event.id} (${event.summary}): no client among ${domains.join(", ")}`);
    return { skipped: "no-client-guests", eventId: event.id, domains };
  }
  if (matched.size > 1) {
    const names = [...matched.values()].map((c) => c.name).join(", ");
    throw new Error(
      `"${event.summary}" (${event.id}) has guests from several Harvest clients (${names}); ` +
        `log it by hand.`,
    );
  }
  const client = [...matched.values()][0];

  // The client's single active project, and the meeting task on it.
  const target = await ctx.step("resolve-project-and-task", async () => {
    const body = await harvestGet(`/projects?client_id=${client.clientId}&is_active=true`);
    const projects: any[] = body?.projects ?? [];
    if (projects.length !== 1) {
      return { projectCount: projects.length, projectId: null, projectName: null, taskId: null };
    }
    const project = projects[0];
    const tasks = await harvestGet(`/projects/${project.id}/task_assignments?is_active=true`);
    const task = (tasks?.task_assignments ?? []).find(
      (t: any) => t?.task?.name === MEETING_TASK_NAME,
    );
    return {
      projectCount: 1,
      projectId: project.id as number,
      projectName: String(project.name),
      taskId: typeof task?.task?.id === "number" ? (task.task.id as number) : null,
    };
  });
  if (target.projectCount === 0) {
    // A former client: meeting them is not billable work on any project.
    console.log(`Skipping ${event.id} (${event.summary}): ${client.name} has no active project`);
    return { skipped: "client-has-no-active-project", eventId: event.id, client: client.name };
  }
  if (target.projectId === null) {
    throw new Error(
      `${client.name} has ${target.projectCount} active Harvest projects, so "${event.summary}" ` +
        `(${event.id}) cannot be filed automatically; log it by hand.`,
    );
  }
  if (target.taskId === null) {
    throw new Error(
      `Harvest project "${target.projectName}" has no active "${MEETING_TASK_NAME}" task; ` +
        `add it to the project, then replay this run.`,
    );
  }

  const spentDate = event.startDateTime!.slice(0, 10); // calendar-local date
  const hours = Math.round((event.durationMinutes! / 60) * 100) / 100;

  // Already logged? By this Zap (external reference = event id), or by hand via
  // Harvest's own calendar import, which stores only the title as notes.
  const existing = await ctx.step("find-existing-entry", async () => {
    const byRef = await findEntryByReference(event.id);
    if (byRef !== null) return { entryId: byRef, how: "external-reference" };
    const body = await harvestGet(
      `/time_entries?project_id=${target.projectId}&from=${spentDate}&to=${spentDate}`,
    );
    const title = event.summary.trim().toLowerCase();
    const hit = (body?.time_entries ?? []).find(
      (t: any) => typeof t?.notes === "string" && t.notes.trim().toLowerCase() === title,
    );
    return hit ? { entryId: hit.id as number, how: "same-title-same-day" } : null;
  });
  if (existing) {
    console.log(`Skipping ${event.id} (${event.summary}): already logged (${existing.how})`);
    return { skipped: "already-logged", eventId: event.id, ...existing };
  }

  const created = await ctx.step("create-time-entry", async () => {
    // A step retry after an ambiguous failure must not double-log.
    const replayed = await findEntryByReference(event.id);
    if (replayed !== null) return { entryId: replayed, replayed: true, rejected: null };
    const res = await sdk.fetch(`${HARVEST_API}/time_entries`, {
      method: "POST",
      connection: HARVEST_CONNECTION,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: target.projectId,
        task_id: target.taskId,
        spent_date: spentDate,
        hours,
        notes: event.summary,
        external_reference: {
          id: event.id,
          group_id: event.seriesId,
          ...(event.htmlLink ? { permalink: event.htmlLink } : {}),
        },
      }),
    });
    // A 4xx is Harvest refusing the entry: return it rather than throw, so the
    // step does not retry and exhaust, which would hide Harvest's message.
    if (res.status >= 400 && res.status < 500) {
      return { entryId: null, replayed: false, rejected: `${res.status}: ${await res.text()}` };
    }
    if (!res.ok) throw new Error(`[Harvest] create time entry -> ${res.status}: ${await res.text()}`);
    const body: any = await res.json();
    return { entryId: body.id as number, replayed: false, rejected: null };
  });
  if (created.rejected) {
    throw new Error(`[Harvest] refused the time entry for "${event.summary}": ${created.rejected}`);
  }

  return {
    logged: true,
    eventId: event.id,
    client: client.name,
    project: target.projectName,
    spentDate,
    hours,
    ...created,
  };
});

export default workflow;
