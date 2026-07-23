// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/notion-companies-to-zapier-table
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
const NOTION_CONNECTION = "notion_wf"; // work.flowers workspace connection
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

// Zapier Table mirroring the Notion Companies data source
// (21991b07-11ac-80b0-b787-000b3d3995f6). One row per company, keyed on
// "Notion Page ID" (dashed UUID).
const TABLE_ID = "01JM8PH8YM93A482M8BFZ6WKW6";
const KEY_FIELD = "Notion Page ID";
const LAST_EDITED_FIELD = "Notion Last Edited";

// Notion property -> table column. All mirrored 1:1 as plain strings; empty in
// Notion clears the table value (true mirror). "Slack Channel Is Archived" is
// deliberately NOT managed here (populated by other Zaps).
const RICH_TEXT_PROPS = [
  "Harvest Client ID",
  "Google Drive Folder ID",
  "Slack Channel ID",
  "Xero Contact ID",
  "Linear Customer ID",
  "Linear Team ID",
] as const;

const InputSchema = z.unknown();

// --- Helpers -------------------------------------------------------------------
function normalizeInput(rawInput: unknown): unknown {
  // Trigger pipeline may deliver the body double-encoded; run_workflow single.
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

function extractPageId(raw: unknown): string {
  if (!raw) throw new Error("No input provided to workflow.");
  if (typeof raw === "string") return raw.trim();
  const o = raw as Record<string, any>;
  const candidate =
    o.page_id ||
    o.pageId ||
    (o.data && (o.data.id || o.data.page_id)) ||
    o.id ||
    (o.page && o.page.id) ||
    o["data.id"] ||
    o["data__id"];
  if (!candidate) {
    throw new Error(
      "Could not find a Notion page id in webhook payload: " +
        JSON.stringify(raw).slice(0, 300),
    );
  }
  return String(candidate).trim();
}

// Normalize a page id to the dashed-UUID form used as the table key.
function dashUuid(id: string): string {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return id;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function plainText(rich: any): string {
  return (Array.isArray(rich) ? rich : []).map((t) => t?.plain_text ?? "").join("").trim();
}

type PageSnapshot = {
  pageId: string;
  archived: boolean;
  lastEdited: string; // ISO timestamp from Notion
  data: Record<string, string>;
};

async function fetchPageSnapshot(pageId: string): Promise<PageSnapshot> {
  const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
    connection: NOTION_CONNECTION,
    headers: { "Notion-Version": NOTION_VERSION },
  });
  if (!res.ok) {
    throw new Error(`Notion get page failed (${res.status}): ${await res.text()}`);
  }
  const p: any = await res.json();
  const props = p.properties || {};
  const uid = props["ID"]?.unique_id;
  const data: Record<string, string> = {
    "Company Name": plainText(props["Company Name"]?.title),
    "Notion Company ID":
      uid?.number != null ? `${uid.prefix ?? "COM"}-${uid.number}` : "",
    [LAST_EDITED_FIELD]: String(p.last_edited_time ?? ""),
  };
  const website = String(props["Website"]?.url ?? "").trim();
  if (website) data["Domain"] = website; // link field: leave untouched when empty
  for (const f of RICH_TEXT_PROPS) data[f] = plainText(props[f]?.rich_text);
  return {
    pageId: dashUuid(String(p.id)),
    archived: Boolean(p.archived || p.in_trash),
    lastEdited: String(p.last_edited_time ?? ""),
    data,
  };
}

async function findRecords(pageId: string) {
  const res = await sdk.listTableRecords({
    table: TABLE_ID,
    keyMode: "names",
    filters: [{ fieldKey: KEY_FIELD, operator: "exact", value: pageId }],
    pageSize: 100,
  });
  // Keep deterministic winner: earliest ULID sorts first.
  return (res.data ?? []).slice().sort((a: any, b: any) => (a.id < b.id ? -1 : 1));
}

// Upsert the snapshot into the table with an optimistic-concurrency guard:
// only write when the snapshot's last_edited_time is >= the stored one, so an
// older event that lost a race can never overwrite a newer write. Returns what
// happened so the reconcile pass (and run output) can report it.
async function upsertSnapshot(snap: PageSnapshot): Promise<string> {
  const existing = await findRecords(snap.pageId);

  if (snap.archived) {
    if (!existing.length) return "archived-noop";
    await sdk.deleteTableRecords({
      table: TABLE_ID,
      records: existing.map((r: any) => r.id),
    });
    return `archived-deleted-${existing.length}`;
  }

  if (!existing.length) {
    await sdk.createTableRecords({
      table: TABLE_ID,
      keyMode: "names",
      records: [{ data: { [KEY_FIELD]: snap.pageId, ...snap.data } }],
    });
    // Re-query: if a concurrent run also created, every racer converges on the
    // earliest ULID as winner and deletes the rest (deletes are idempotent).
    const after = await findRecords(snap.pageId);
    if (after.length > 1) {
      await sdk.deleteTableRecords({
        table: TABLE_ID,
        records: after.slice(1).map((r: any) => r.id),
      });
      // Make sure the surviving record carries this snapshot (the winner may
      // have been written by the other racer with equally-current data, but a
      // guarded update is cheap and safe).
      await guardedUpdate(after[0], snap);
      return "created-deduped";
    }
    return "created";
  }

  // Existing record(s): dedupe strays, then guarded update of the winner.
  if (existing.length > 1) {
    await sdk.deleteTableRecords({
      table: TABLE_ID,
      records: existing.slice(1).map((r: any) => r.id),
    });
  }
  return guardedUpdate(existing[0], snap);
}

async function guardedUpdate(record: any, snap: PageSnapshot): Promise<string> {
  const storedTs = String(record.data?.[LAST_EDITED_FIELD] ?? "");
  if (storedTs && snap.lastEdited && snap.lastEdited < storedTs) {
    return "skipped-stale"; // a newer event already wrote; do not regress
  }
  // Skip no-op writes so idle webhooks don't touch edited_at. Link fields are
  // compared scheme-insensitively: Zapier Tables normalizes bare domains to
  // https://, so "acme.com" and a stored "https://acme.com" are the same value.
  const dirty = Object.entries(snap.data).some(([k, v]) => {
    const cur = record.data?.[k];
    const curStr = cur && typeof cur === "object" ? String(cur.link ?? "") : String(cur ?? "");
    if (curStr === v) return false;
    if (curStr === `https://${v}` || curStr === `http://${v}`) return false;
    return true;
  });
  if (!dirty) return "unchanged";
  await sdk.updateTableRecords({
    table: TABLE_ID,
    keyMode: "names",
    records: [{ id: record.id, data: snap.data }],
  });
  return "updated";
}

// --- Workflow ------------------------------------------------------------------
const workflow = defineDurable({
  name: "notion-companies-to-zapier-table",
  description:
    "Mirror a Notion Companies record into the company-ID Zapier Table, keyed on Notion Page ID. Race-safe: re-fetches current page state (webhook is a ping), guards updates on last_edited_time, dedupes racing creates, and reconciles after a short delay.",
  inputSchema: InputSchema,
  run: async (ctx, rawInput) => {
    const norm = normalizeInput(rawInput);
    const pageId = dashUuid(extractPageId(norm));
    const previewOnly = Boolean(
      norm && typeof norm === "object" && (norm as any).previewOnly,
    );

    // 1. Fetch the page's CURRENT state — never trust the webhook payload.
    const snap = await ctx.step("fetch-notion-page", () => fetchPageSnapshot(pageId));

    if (previewOnly) {
      return { previewOnly: true, snapshot: snap };
    }

    // 2. Guarded upsert (create / update / dedupe / archive-delete).
    const outcome = await ctx.step("upsert-table-record", () => upsertSnapshot(snap));

    // 3. Reconcile: wait out the race window, then re-check Notion vs the
    //    table and re-write if anything drifted. The last-finishing run always
    //    leaves the table matching Notion — same end-state guarantee as a
    //    Delay-queue serialized on page_id, without the queue.
    await ctx.wait("reconcile-delay", 20);
    const reconcile = await ctx.step("reconcile", async () => {
      const fresh = await fetchPageSnapshot(pageId);
      const result = await upsertSnapshot(fresh);
      return { lastEdited: fresh.lastEdited, result };
    });

    return {
      pageId,
      company: snap.data["Company Name"],
      outcome,
      reconcile,
    };
  },
});

export default workflow;

