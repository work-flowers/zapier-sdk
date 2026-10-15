// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/luma-hosted-event-to-notion
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

// Marketing Events workspace data source (same one the retired
// luma-event-to-notion wrote to).
const EVENTS_DS = "65490a1e-aa79-4884-932b-60e88db67042";

// Zapier Tables (free ops, no connection).
// Luma event id -> Notion Event page id. Shared with the guest workflow and the
// retired Luma Zaps. Columns: "Luma Event ID", "Page ID", "Event Name".
const LUMA_EVENT_TABLE = "01KY6MEV55JF723XYDEE4EP0T6";
// Events Dennis manages. Written by luma-manager-email-to-table from Luma's
// "Please join me as a host for …" / "… is live on Luma" emails. An event not
// listed here is skipped: the trigger emits EVERY event on the Notion Singapore
// calendar, because Luma's API does not list hidden hosts.
const MANAGED_EVENTS_TABLE = "01M4ZRWQAHCB41XGGJ263S9BDH";

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

/** First item of a runAction result ({ data: [...] } or a bare array). */
function firstResult(res: any): any {
  if (res && Array.isArray(res.data)) return res.data[0] ?? null;
  if (Array.isArray(res)) return res[0] ?? null;
  return res ?? null;
}

export interface LumaEvent {
  id: string;
  name: string | null;
  startAt: string | null;
  endAt: string | null;
  url: string | null;
  coverUrl: string | null;
  type: "In-person" | "Virtual";
}

/**
 * The `new_event` item from the private "Luma Calendar API" integration
 * (App247901CLIAPI). It is the flat Luma event object: `id` (evt-…), `name`,
 * `start_at`, `end_at`, `url`, `cover_url`, `location_type`, `geo_address_json`,
 * plus the integration's own `full_address`. Luma's events LIST omits the
 * description, so unlike the retired luma-event-to-notion there is no page body
 * to sync.
 *
 * Returns null when the payload has no `evt-` id — the caller throws on that,
 * because a non-empty payload we cannot read is a real event we failed to
 * understand (repo rule: never a silent skip).
 */
export function extractEvent(raw: unknown): LumaEvent | null {
  const o = (raw ?? {}) as Record<string, any>;
  const ev = (o.event && typeof o.event === "object" && !o.guest_id ? o.event : o) as Record<
    string,
    any
  >;
  const id = firstString(ev.id);
  if (!id || !id.startsWith("evt-")) return null;
  const locationType = (firstString(ev.location_type) ?? "").toLowerCase();
  const hasAddress =
    firstString(ev.full_address, ev.geo_address_json?.full_address, ev.geo_address_json?.address) !==
      null || ev.coordinate?.latitude != null;
  const type: LumaEvent["type"] =
    locationType === "offline" ? "In-person" : locationType ? "Virtual" : hasAddress ? "In-person" : "Virtual";
  return {
    id,
    name: firstString(ev.name),
    startAt: firstString(ev.start_at),
    endAt: firstString(ev.end_at),
    url: firstString(ev.url),
    coverUrl: firstString(ev.cover_url),
    type,
  };
}

/** Shared Notion property inputs for create/update of the Event page. */
export function eventProps(ev: LumaEvent): Record<string, unknown> {
  const props: Record<string, unknown> = {
    datasource: EVENTS_DS,
    "properties|||Event|||title": ev.name ?? `Luma event ${ev.id}`,
    "properties|||Luma ID|||rich_text": ev.id,
    "properties|||Type|||select": ev.type,
  };
  if (ev.url) props["properties|||Event page|||url"] = ev.url;
  if (ev.startAt) {
    props["use_zapier_datetime_fields"] = true;
    props["properties|||Date|||date__start"] = ev.startAt;
    if (ev.endAt) props["properties|||Date|||date__end"] = ev.endAt;
  }
  return props;
}

/**
 * Create a Notion data source item, applying the data source's DEFAULT TEMPLATE
 * when one exists (repo rule 5). `template_mode: "default"` throws on a data
 * source with no default template, so that one error is caught and the create
 * retried plain — inside the step, so a template miss doesn't spin the step's
 * retry loop. (Events has no default template today.)
 */
async function createItemWithTemplate(
  ctx: any,
  stepPrefix: string,
  datasource: string,
  props: Record<string, unknown>,
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
  return {
    pageId: firstResult(created?.res)?.id ?? null,
    usedTemplate: Boolean(created?.usedTemplate),
  };
}

// --- Workflow ----------------------------------------------------------------
// Fired two ways, with the same item shape:
//   1. the `new_event` polling trigger (once per event id, ever — durables dedupe
//      on the raw top-level id, so an event is delivered once);
//   2. luma-manager-email-to-table's backfill, via sdk.triggerWorkflow, when Dennis
//      becomes a manager of an event the trigger already delivered (and this
//      workflow skipped) before he was one. That input carries `source: "backfill"`.
// Either way it is an idempotent upsert keyed on the Luma event id.
const workflow = defineDurable("luma-hosted-event-to-notion", async (ctx, rawInput: unknown) => {
  const payload = normalizeInput(rawInput);
  if (isEmptyPing(payload)) {
    console.log("skipping: empty payload (manual test or ping)");
    return { skipped: "empty-payload" };
  }
  const ev = extractEvent(payload);
  if (!ev) {
    const keys = payload && typeof payload === "object" ? Object.keys(payload).slice(0, 20).join(", ") : typeof payload;
    throw new Error(`Unrecognised Luma event payload: no evt- id. Keys: ${keys}`);
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
    console.log(`skipping ${ev.id} (${ev.name ?? "unnamed"}): not in Luma Managed Events`);
    return { skipped: "not-managed", lumaEventId: ev.id, eventName: ev.name };
  }

  // 1. Resolve the Event page id via the free Zapier Table first.
  const tableHit = await ctx.step("find-event-in-table", async () =>
    sdk.listTableRecords({
      table: LUMA_EVENT_TABLE,
      keyMode: "names",
      filters: [{ fieldKey: "Luma Event ID", operator: "exact", value: ev.id }],
      pageSize: 1,
    }),
  );
  let eventPageId: string | null = firstString(tableHit?.data?.[0]?.data?.["Page ID"]);
  const foundViaTable = eventPageId !== null;

  // 2. Fall back to a Notion search on the "Luma ID" property.
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

  // 3. Create or update the Notion Event page.
  let eventCreated = false;
  let usedTemplate = false;
  if (!eventPageId) {
    const created = await createItemWithTemplate(ctx, "event", EVENTS_DS, eventProps(ev));
    eventPageId = created.pageId;
    usedTemplate = created.usedTemplate;
    eventCreated = true;
    if (!eventPageId) throw new Error("Event creation returned no page id");
  } else {
    const pageId = eventPageId;
    await ctx.step("update-event", async () =>
      sdk.runAction({
        appKey: NOTION_APP_KEY,
        actionType: "write",
        actionKey: "update_database_item",
        connection: NOTION_CONNECTION,
        inputs: { ...eventProps(ev), page: pageId },
      }),
    );
  }

  // 4. Page cover from the Luma cover image (best-effort; the create/update
  // actions can't set covers, so PATCH the page directly).
  let coverSet = false;
  if (ev.coverUrl) {
    const pageId = eventPageId;
    const coverUrl = ev.coverUrl;
    const cover = await ctx.step("set-event-cover", async () => {
      try {
        const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
          connection: NOTION_CONNECTION,
          method: "PATCH",
          headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
          body: JSON.stringify({ cover: { type: "external", external: { url: coverUrl } } }),
        });
        if (!res.ok) {
          return { ok: false as const, error: `cover PATCH ${res.status}: ${(await res.text()).slice(0, 200)}` };
        }
        return { ok: true as const };
      } catch (err) {
        return { ok: false as const, error: String((err as Error)?.message ?? err) };
      }
    });
    coverSet = cover.ok;
    if (!cover.ok) console.log("cover not set:", cover.error);
  }

  // 5. Index the event (free Table op) so the guest workflow resolves it
  // without a Notion call.
  if (!foundViaTable) {
    const pageId = eventPageId;
    await ctx.step("index-event-in-table", async () =>
      sdk.createTableRecords({
        table: LUMA_EVENT_TABLE,
        keyMode: "names",
        records: [{ data: { "Luma Event ID": ev.id, "Page ID": pageId, "Event Name": ev.name ?? "" } }],
      }),
    );
  }

  return {
    lumaEventId: ev.id,
    eventName: ev.name,
    eventPageId,
    eventType: ev.type,
    eventCreated,
    usedTemplate,
    coverSet,
  };
});

export default workflow;
