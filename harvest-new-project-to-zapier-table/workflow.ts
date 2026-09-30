// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/harvest-new-project-to-zapier-table
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";

const sdk = createZapierSdk();

// Zapier Table "Harvest Projects (New)" — maps a Harvest project to the Notion
// Projects page it bills for. Columns:
//   f1 project_id  f2 client_id  f3 is_active  f4 Name  f5 Project Page ID
// This workflow owns f1–f4. f5 is filled in by hand, outside this repo, and is
// never written here: a new row starts with it empty.
const PROJECT_TABLE = "01K8A2KV9X1W95GAB6Y69D7G4C";

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

type Project = {
  projectId: string;
  clientId: string | null;
  isActive: boolean;
  name: string | null;
};

/** The Harvest "New Project" trigger record. The classic Zap mapped the id as
 *  `record_id` and the client as `client.id`; accept the plain API shape too. */
function extractProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, any>;
  const projectId = firstString(o.record_id, o.id);
  // A Harvest project id is numeric. Anything else is not a project record.
  if (!projectId || !/^\d+$/.test(projectId)) return null;
  if (typeof o.is_active !== "boolean") return null;
  return {
    projectId,
    clientId: firstString(o.client?.id, o.client_id),
    isActive: o.is_active,
    name: firstString(o.name),
  };
}

/** `find_record` wraps each hit as `{ new, old, record_id, table_id }` and
 *  returns `{ data: [] }` on a miss. */
function firstRecordId(res: unknown): string | null {
  const rows = (res as any)?.data;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return firstString(rows[0]?.record_id, rows[0]?.old?.id, rows[0]?.id);
}

// --- Workflow --------------------------------------------------------------
const workflow = defineDurable(
  "harvest-new-project-to-zapier-table",
  async (ctx, rawInput) => {
    const payload = normalizeInput(rawInput);
    const project = extractProject(payload);
    if (!project) {
      // A polling trigger never sends an empty ping, so anything unreadable is
      // a real record whose shape we failed to understand.
      throw new Error(
        `Unrecognized Harvest project payload: ${JSON.stringify(payload).slice(0, 500)}`,
      );
    }

    // Upsert on project_id rather than blindly creating, so a replay (or a
    // trigger that re-delivers existing projects) cannot duplicate a row.
    const existing = await ctx.step("find-project-row", async () => {
      const res = await sdk.runAction({
        appKey: "TableCLIAPI",
        actionType: "search",
        actionKey: "find_record",
        inputs: {
          table_id: PROJECT_TABLE,
          filter_count: "1",
          use_stored_order: false,
          field_data_key: "data__f1",
          operator: "exact",
          lookup_value: project.projectId,
        },
      });
      return firstRecordId(res);
    });

    if (existing) {
      await ctx.step("update-project-row", async () =>
        sdk.runAction({
          appKey: "TableCLIAPI",
          actionType: "write",
          actionKey: "update_record",
          inputs: {
            table_id: PROJECT_TABLE,
            record_id: existing,
            new__data__f2: project.clientId ?? "",
            new__data__f3: project.isActive,
            new__data__f4: project.name ?? "",
          },
        }),
      );
      console.log(`project ${project.projectId} already had row ${existing}; refreshed it`);
      return { action: "updated", recordId: existing, ...project };
    }

    await ctx.step("create-project-row", async () =>
      sdk.runAction({
        appKey: "TableCLIAPI",
        actionType: "write",
        actionKey: "create_record",
        inputs: {
          table_id: PROJECT_TABLE,
          new__data__f1: project.projectId,
          new__data__f2: project.clientId ?? "",
          new__data__f3: project.isActive,
          new__data__f4: project.name ?? "",
        },
      }),
    );
    console.log(`added Harvest project ${project.projectId} (${project.name})`);
    return { action: "created", ...project };
  },
);

export default workflow;
