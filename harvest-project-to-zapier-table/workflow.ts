// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/harvest-project-to-zapier-table
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
// Harvest supplies the trigger; Zapier Tables needs no connection and costs no
// tasks, so the workflow body binds nothing.
const HARVEST_CONNECTION = "harvest_wf";

// Zapier Table "Harvest Projects (New)" — one row per Harvest project:
//   f1 project_id  f2 client_id  f3 is_active  f4 Name  f5 Project Page ID
//
// Two writers share this table. `notion-project-to-harvest-client-project`
// creates a row (with f5) when a project is created from a Notion Projects
// page; this workflow's Harvest poll then fires minutes later for that same
// project. So it UPSERTS on f1 rather than blind-creating the way the classic
// Zap did — see README for the 16 duplicate pairs that produced.
const PROJECT_TABLE = "01K8A2KV9X1W95GAB6Y69D7G4C";

const InputSchema = z.unknown();

/** `defineDurable`'s input generic is constrained to an object type; loose
 *  runtime shapes are handled by `normalizeInput` / `extractProject`. */
type Input = Record<string, unknown>;
type Outcome = Record<string, unknown>;

// --- Pure helpers --------------------------------------------------------------

function normalizeInput(rawInput: unknown): unknown {
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

function firstString(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

/**
 * Harvest's `is_active`, read defensively.
 *
 * The classic Zap mapped `{{=gives[...]['is_active']}}` straight into the
 * Table's boolean column and recorded **false** for projects that were active
 * at the time — every one of the 16 duplicate rows says `is_active: false`,
 * including ones whose Notion-side twin, written 30 seconds earlier, says
 * true. An unresolved template coerces to false, and false is the dangerous
 * direction: `start-a-timer-from-notion-task` looks projects up on
 * `(f5, f3 = true)`, so a spurious false silently stops timers from starting.
 *
 * A brand-new Harvest project is active, so absent/unparseable means TRUE.
 * Only an explicit falsey value is honoured.
 */
function readIsActive(...vals: unknown[]): boolean {
  for (const v of vals) {
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") {
      const t = v.trim().toLowerCase();
      if (["false", "0", "no", "n", "off"].includes(t)) return false;
      if (["true", "1", "yes", "y", "on"].includes(t)) return true;
    }
  }
  return true;
}

type HarvestProject = {
  projectId: string;
  clientId: string;
  name: string;
  isActive: boolean;
};

/**
 * Pull the Harvest project out of the trigger row.
 *
 * The classic Zap read `record_id` for the project id and `client.id` for the
 * client; both are proven against the rows it wrote (f1 holds real Harvest
 * project ids). `id` / `client_id` are accepted as alternatives so a manual
 * `run-durable` replay, or a change in how the trigger row is flattened,
 * doesn't silently write blanks.
 */
function extractProject(raw: unknown): HarvestProject | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, any>;
  const row = (o.data && typeof o.data === "object" && !Array.isArray(o.data) ? o.data : o) as Record<
    string,
    any
  >;

  const projectId = firstString(row.record_id, row.id, row.project_id);
  if (!projectId) return null;

  return {
    projectId,
    clientId: firstString(row.client?.id, row.client_id, row.clientId),
    name: firstString(row.name, row.project_name),
    isActive: readIsActive(row.is_active, row.active),
  };
}

/**
 * True when the payload carries no event at all.
 *
 * This is a polling trigger, not a public catch URL, so it should never
 * deliver one in production — but `run-durable` and `trigger-workflow` do
 * while testing, and an empty test delivery is not worth an error alert. A
 * payload carrying content but no project id is a different thing: a real
 * event whose shape we failed to understand. That still throws, loudly.
 */
function isEmptyPing(raw: unknown): boolean {
  if (raw === null || raw === undefined || raw === "") return true;
  if (typeof raw !== "object") return false;
  const WRAPPER_KEYS = new Set(["querystring", "headers", "params", "body", "query", "data"]);
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!WRAPPER_KEYS.has(key)) return false;
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object" && Object.keys(value as object).length === 0) continue;
    return false; // a wrapper with something in it — treat as a real event
  }
  return true;
}

/** First row of a Tables result. `find_record` returns `{ data: [] }` on a
 *  miss. Searches put the row under `old`, writes under `new`. */
function firstRow(res: unknown): Record<string, any> | null {
  const rows = (res as any)?.data;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return (rows[0]?.old ?? rows[0]?.new ?? rows[0]) as Record<string, any>;
}

// --- Workflow -------------------------------------------------------------------

const workflow = defineDurable<Input, unknown>(
  "harvest-project-to-zapier-table",
  async (ctx, rawInput) => {
    const payload = normalizeInput(InputSchema.parse(rawInput));

    if (isEmptyPing(payload)) {
      console.log("empty payload — nothing to log");
      return { skipped: "empty-payload" } satisfies Outcome;
    }

    const project = extractProject(payload);
    if (!project) {
      throw new Error(
        `Harvest new_project payload carried content but no project id: ` +
          `${JSON.stringify(payload).slice(0, 400)}`,
      );
    }

    // Does this project already have a row? It will whenever the project was
    // created from a Notion Projects page — that durable writes the row (with
    // f5) seconds after creating the project, and this poll follows minutes
    // later.
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
      const row = firstRow(res);
      if (!row) return null;
      return {
        recordId: firstString(row.id, row.record_id),
        projectPageId: firstString(row.data?.f5),
      };
    });

    // f1 and f5 are deliberately NOT in this payload: f1 is the match key and
    // does not change, and f5 belongs to the Notion side. `update_record`
    // leaves unlisted fields alone, so an existing Project Page ID survives.
    const fields = {
      new__data__f2: project.clientId,
      new__data__f3: project.isActive,
      new__data__f4: project.name,
    };

    if (existing?.recordId) {
      await ctx.step("update-project-row", async () =>
        sdk.runAction({
          appKey: "TableCLIAPI",
          actionType: "write",
          actionKey: "update_record",
          inputs: {
            table_id: PROJECT_TABLE,
            record_id: existing.recordId,
            ...fields,
          },
        }),
      );
      console.log(
        `enriched existing row ${existing.recordId} for Harvest project ${project.projectId} ` +
          `"${project.name}"${existing.projectPageId ? ` (Notion page ${existing.projectPageId} preserved)` : ""}`,
      );
      return {
        action: "updated",
        recordId: existing.recordId,
        projectPageIdPreserved: existing.projectPageId || null,
        ...project,
      } satisfies Outcome;
    }

    const created = await ctx.step("create-project-row", async () =>
      sdk.runAction({
        appKey: "TableCLIAPI",
        actionType: "write",
        actionKey: "create_record",
        inputs: {
          table_id: PROJECT_TABLE,
          new__data__f1: project.projectId,
          ...fields,
        },
      }),
    );

    const recordId = firstString(firstRow(created)?.id);
    console.log(`logged Harvest project ${project.projectId} "${project.name}" as row ${recordId}`);
    return { action: "created", recordId: recordId || null, ...project } satisfies Outcome;
  },
);

export default workflow;
