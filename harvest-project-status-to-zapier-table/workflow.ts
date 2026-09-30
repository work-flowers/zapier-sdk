// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/harvest-project-status-to-zapier-table
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";

const sdk = createZapierSdk();

// Zapier Table "Harvest Projects (New)". Columns:
//   f1 project_id  f2 client_id  f3 is_active  f4 Name  f5 Project Page ID
// This workflow writes only f3. Rows are created by
// harvest-new-project-to-zapier-table.
const PROJECT_TABLE = "01K8A2KV9X1W95GAB6Y69D7G4C";

// A brand-new project fires both this trigger and Harvest's "New Project"
// trigger, which poll independently, so the row may not exist yet. Waiting is
// free, so give the other workflow one generous window to create it before
// treating a miss as real.
const NEW_ROW_GRACE_SECONDS = 1800;

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

type StatusEvent = { projectId: string; isActive: boolean; name: string | null };

/** A record from the private "Harvest Project Status" app's
 *  project_active_status_changed trigger (id = `{project_id}-{is_active}`). */
function extractStatusEvent(raw: unknown): StatusEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, any>;
  const projectId = firstString(o.project_id);
  if (!projectId || !/^\d+$/.test(projectId)) return null;
  if (typeof o.is_active !== "boolean") return null;
  return { projectId, isActive: o.is_active, name: firstString(o.name) };
}

type Row = { recordId: string; isActive: unknown };

/** `find_record` wraps each hit as `{ new, old, record_id, table_id }` and
 *  returns `{ data: [] }` on a miss. */
function firstRow(res: unknown): Row | null {
  const rows = (res as any)?.data;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const recordId = firstString(rows[0]?.record_id, rows[0]?.old?.id);
  if (!recordId) return null;
  return { recordId, isActive: rows[0]?.old?.data?.f3 };
}

function findInputs(projectId: string) {
  return {
    table_id: PROJECT_TABLE,
    filter_count: "1",
    use_stored_order: false,
    field_data_key: "data__f1",
    operator: "exact",
    lookup_value: projectId,
  };
}

// --- Workflow --------------------------------------------------------------
const workflow = defineDurable(
  "harvest-project-status-to-zapier-table",
  async (ctx, rawInput) => {
    const payload = normalizeInput(rawInput);
    const event = extractStatusEvent(payload);
    if (!event) {
      // A polling trigger never sends an empty ping, so anything unreadable is
      // a real record whose shape we failed to understand.
      throw new Error(
        `Unrecognized project status payload: ${JSON.stringify(payload).slice(0, 500)}`,
      );
    }

    let row = await ctx.step("find-project-row", async () => {
      const res = await sdk.runAction({
        appKey: "TableCLIAPI",
        actionType: "search",
        actionKey: "find_record",
        inputs: findInputs(event.projectId),
      });
      return firstRow(res);
    });

    if (!row) {
      console.log(
        `no row yet for project ${event.projectId}; waiting ${NEW_ROW_GRACE_SECONDS}s for harvest-new-project-to-zapier-table`,
      );
      await ctx.wait("wait-for-new-project-row", NEW_ROW_GRACE_SECONDS);
      row = await ctx.step("find-project-row-again", async () => {
        const res = await sdk.runAction({
          appKey: "TableCLIAPI",
          actionType: "search",
          actionKey: "find_record",
          inputs: findInputs(event.projectId),
        });
        return firstRow(res);
      });
    }

    if (!row) {
      // Still missing after the grace window: the Table is out of step with
      // Harvest. Surface it — a silent skip would leave the status stale forever.
      throw new Error(
        `Harvest project ${event.projectId} (${event.name}) has no row in Table ${PROJECT_TABLE}`,
      );
    }

    if (row.isActive === event.isActive) {
      console.log(`project ${event.projectId} already is_active=${event.isActive}`);
      return { action: "unchanged", recordId: row.recordId, ...event };
    }

    const recordId = row.recordId;
    await ctx.step("update-is-active", async () =>
      sdk.runAction({
        appKey: "TableCLIAPI",
        actionType: "write",
        actionKey: "update_record",
        inputs: {
          table_id: PROJECT_TABLE,
          record_id: recordId,
          new__data__f3: event.isActive,
        },
      }),
    );
    console.log(`project ${event.projectId} is_active -> ${event.isActive}`);
    return { action: "updated", recordId, ...event };
  },
);

export default workflow;
