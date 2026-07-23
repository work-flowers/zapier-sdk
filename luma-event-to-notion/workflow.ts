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

// Marketing Events workspace data source.
const EVENTS_DS = "65490a1e-aa79-4884-932b-60e88db67042";

// Zapier Table indexing Luma event id -> Notion Event page id.
// Columns: "Luma Event ID" (string), "Page ID" (string), "Event Name" (string).
// Table ops are free, so events resolve through here first. No connection needed.
const LUMA_EVENT_TABLE = "01KY6MEV55JF723XYDEE4EP0T6";

// The Luma "Event Created"/"Event Updated" triggers deliver the event object.
// Accept anything and extract defensively (payload may also be wrapped).
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

function extractEvent(raw: unknown): LumaEvent {
  const o = (raw ?? {}) as Record<string, any>;
  // event_* triggers send the event at the top level; guest triggers nest it
  // under `event`. Support both, plus a `data` wrapper just in case.
  const ev = (o.event ?? o.data?.event ?? o.data ?? o) as Record<string, any>;
  const id = firstString(ev.id, ev.event_id, ev.api_id);
  if (!id) {
    throw new Error(
      "No event id in Luma event payload: " + JSON.stringify(raw).slice(0, 300),
    );
  }
  // In-person if the event carries a physical location; otherwise Virtual.
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

/** Shared Notion property inputs for create/update of the Event page. */
function eventProps(ev: LumaEvent): Record<string, unknown> {
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

// --- Workflow ----------------------------------------------------------------
const workflow = defineDurable<unknown, unknown>(
  "luma-event-to-notion",
  async (ctx, rawInput) => {
    const ev = extractEvent(InputSchema.parse(normalizeInput(rawInput)));

    // 1. Resolve the Event page id via the free Zapier Table first.
    const tableHit = await ctx.step("find-event-in-table", async () =>
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
      firstString(tableHit?.data?.[0]?.data?.["Page ID"]) ?? null;

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
    let eventUpdated = false;
    if (!eventPageId) {
      const created = await ctx.step("create-event", async () =>
        sdk.runAction({
          appKey: NOTION_APP_KEY,
          actionType: "write",
          actionKey: "create_database_item",
          connection: NOTION_CONNECTION,
          inputs: eventProps(ev),
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
      eventUpdated = true;
    }

    // 4. Set the page cover from the Luma cover image (best-effort — the
    // create/update actions can't set covers, so PATCH the page directly).
    let coverSet = false;
    if (ev.coverUrl) {
      const pageId = eventPageId;
      const coverUrl = ev.coverUrl;
      const cover = await ctx.step("set-event-cover", async () => {
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
          if (!res.ok) {
            return {
              ok: false as const,
              error: `Notion cover PATCH failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
            };
          }
          return { ok: true as const };
        } catch (err) {
          return { ok: false as const, error: String((err as Error)?.message ?? err) };
        }
      });
      coverSet = cover.ok;
      if (!cover.ok) console.log("cover not set:", cover.error);
    }

    // 5. Upsert the Luma Event ID -> Page ID row (free Table op) so guest
    // workflows resolve the event without a Notion call.
    await ctx.step("index-event-in-table", async () => {
      try {
        const existing = await sdk.listTableRecords({
          table: LUMA_EVENT_TABLE,
          keyMode: "names",
          filters: [
            { fieldKey: "Luma Event ID", operator: "exact", value: ev.id },
          ],
          pageSize: 1,
        });
        const found = existing.data?.[0];
        const data = {
          "Luma Event ID": ev.id,
          "Page ID": eventPageId,
          "Event Name": ev.name ?? "",
        };
        if (found) {
          await sdk.updateTableRecords({
            table: LUMA_EVENT_TABLE,
            keyMode: "names",
            records: [{ id: found.id, data }],
          });
          return { logged: "updated" as const };
        }
        await sdk.createTableRecords({
          table: LUMA_EVENT_TABLE,
          keyMode: "names",
          records: [{ data }],
        });
        return { logged: "created" as const };
      } catch (err) {
        return { logged: "error" as const, error: String((err as Error)?.message ?? err) };
      }
    });

    return {
      lumaEventId: ev.id,
      eventName: ev.name,
      eventPageId,
      eventType: ev.type,
      eventCreated,
      eventUpdated,
      coverSet,
    };
  },
);

export default workflow;
