// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/notion-project-to-harvest-client-project
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
// Zapier Tables needs no connection and costs no tasks.
const NOTION_CONNECTION = "notion_wf"; // work.flowers workspace connection
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";
const NOTION_APP_KEY = "NotionCLIAPI";

const HARVEST_APP_KEY = "HarvestCLIAPI";
const HARVEST_CONNECTION = "harvest_wf";

// --- Notion data sources ------------------------------------------------------
// The Companies relation can only point at Companies (21991b07-11ac-80b0-b787-000b3d3995f6),
// so only the Projects side is worth asserting.
const PROJECTS_DS = "407ac9c1-7045-4529-acde-6d71f3b288d5";

// --- Notion property names ----------------------------------------------------
// NOTE: the relation on Projects is "Companies" (plural). The classic Zap this
// replaces tested "Company" — a leftover from the Deals Zap it was copied from
// — so its "Company Linked" path never matched and every run fell through to
// the "No Company linked" comment. See README.
const PROJECT_TITLE_PROP = "Project name";
const PROJECT_COMPANIES_PROP = "Companies";
const PROJECT_UID_PROP = "Project ID";

const COMPANY_TITLE_PROP = "Company Name";
const COMPANY_HARVEST_ID_PROP = "Harvest Client ID";

/** Posted back on the Project page when there is nothing to bill against. */
const NO_COMPANY_COMMENT = "No Company linked. Please link and resubmit.";

// --- Zapier Tables ------------------------------------------------------------
// "Harvest Projects (New)" — one row per Notion Projects page, mapping it to
// the Harvest project to bill against. Columns:
//   f1 project_id  f2 client_id  f3 is_active  f4 Name  f5 Project Page ID
// `start-a-timer-from-notion-task` reads this table on (f5, f3=true), so f3
// must reflect Harvest's real is_active rather than a hardcoded true.
const PROJECT_TABLE = "01K8A2KV9X1W95GAB6Y69D7G4C";

// The trigger delivers whatever the Notion button / DB automation posts.
// Accept anything and extract defensively.
const InputSchema = z.unknown();

/** `defineDurable`'s input generic is constrained to an object type; the loose
 *  runtime shapes (bare id string, double-encoded body) are handled by
 *  `normalizeInput` / `extractPageId` rather than by the type. */
type Input = Record<string, unknown>;
type Outcome = Record<string, unknown>;

// --- Pure helpers --------------------------------------------------------------

function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline may deliver the body double-encoded; run-durable
  // delivers it single. Unwrap up to four times, and only when the string
  // actually looks like JSON.
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

/** Notion page ids reach us dashed and undashed depending on the source
 *  (webhook payload vs REST response). Compare and store dashed. */
function dashUuid(id: string): string {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (hex.length !== 32) return id.trim();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function plainText(rich: unknown): string {
  if (!Array.isArray(rich)) return "";
  return rich
    .map((r: any) => firstString(r?.plain_text, r?.text?.content))
    .join("")
    .trim();
}

function relationIds(prop: unknown): string[] {
  const rel = (prop as any)?.relation;
  if (!Array.isArray(rel)) return [];
  return rel
    .map((r: any) => firstString(r?.id))
    .filter((id) => id.length > 0)
    .map(dashUuid);
}

/** A Notion unique_id property rendered the way Harvest wants it: "WF-26". */
function uniqueIdCode(prop: unknown): string {
  const uid = (prop as any)?.unique_id ?? prop;
  const num = firstString((uid as any)?.number);
  if (!num) return "";
  const prefix = firstString((uid as any)?.prefix);
  return prefix ? `${prefix}-${num}` : num;
}

/**
 * Pull the Notion page id out of whatever the trigger delivered.
 *
 * The Projects "Create Harvest Project" button and a Notion database
 * automation both post `{ data: { id, properties, ... } }`. `run-durable` /
 * `trigger-workflow` take a bare id or `{ pageId }` so a run can be replayed
 * by hand.
 */
function extractPageId(raw: unknown): string {
  if (!raw) throw new Error("No input provided to workflow.");
  if (typeof raw === "string") return dashUuid(raw.trim());
  const o = raw as Record<string, any>;
  const candidate =
    o.pageId ||
    o.page_id ||
    (o.data && (o.data.id || o.data.page_id)) ||
    o.id ||
    (o.page && o.page.id) ||
    o["data.id"];
  const id = firstString(candidate);
  if (!id) {
    throw new Error(
      `Could not find a Notion page id in the payload: ${JSON.stringify(raw).slice(0, 400)}`,
    );
  }
  return dashUuid(id);
}

/**
 * True when the payload carries no event at all — an empty POST or a bare GET
 * of the catch URL.
 *
 * A catch hook is a public URL: pasting it into a Notion button property,
 * hitting "test", opening it in a browser or curling it all deliver a body
 * like `{"querystring":{}}`. Those are pings, not events, and failing the run
 * on them means a Zapier error alert every time someone touches the URL.
 *
 * A payload that DOES carry content but no page id is a different thing: a
 * real event we failed to understand. That still throws, loudly.
 */
function isEmptyPing(raw: unknown): boolean {
  if (raw === null || raw === undefined || raw === "") return true;
  if (typeof raw !== "object") return false;
  const WRAPPER_KEYS = new Set(["querystring", "headers", "params", "body", "query"]);
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!WRAPPER_KEYS.has(key)) return false;
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object" && Object.keys(value as object).length === 0) continue;
    return false; // a wrapper with something in it — treat as a real event
  }
  return true;
}

/**
 * `previewOnly` resolves the whole chain and reports what WOULD be created,
 * writing nothing — no Harvest client, no Harvest project, no Notion comment,
 * no Table row. Every Harvest write here is effectively permanent (a stray
 * client or project has to be archived by hand), so this is how the Notion
 * side gets validated against real pages. Only `run-durable` /
 * `trigger-workflow` set it; a Notion button never does.
 */
function previewOnlyFlag(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, any>;
  return o.previewOnly === true || o.previewOnly === "true";
}

/** Data source a page belongs to, when the API says so. Empty when it doesn't. */
function parentDataSource(page: any): string {
  const parent = page?.parent ?? {};
  return dashUuid(firstString(parent.data_source_id, parent.database_id));
}

/** First row of a Tables result. `find_record` returns `{ data: [] }` when
 *  nothing matches — not a row of nulls. Searches put the row under `old`,
 *  writes under `new`. */
function firstRow(res: unknown): Record<string, any> | null {
  const rows = (res as any)?.data;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return (rows[0]?.old ?? rows[0]?.new ?? rows[0]) as Record<string, any>;
}

/** The row object a Harvest write action returns. */
function harvestRow(res: unknown): Record<string, any> {
  const rows = (res as any)?.data;
  const row = Array.isArray(rows) ? rows[0] : rows;
  return row && typeof row === "object" ? (row as Record<string, any>) : {};
}

// --- Workflow -------------------------------------------------------------------

const workflow = defineDurable<Input, unknown>(
  "notion-project-to-harvest-client-project",
  async (ctx, rawInput) => {
    const payload = normalizeInput(InputSchema.parse(rawInput));

    // Someone pinged the catch URL rather than sending an event.
    if (isEmptyPing(payload)) {
      console.log("empty payload — treating as a ping of the catch URL, not an event");
      return { skipped: "empty-payload" } satisfies Outcome;
    }

    const projectPageId = extractPageId(payload);
    const previewOnly = previewOnlyFlag(payload);

    // 1. Never trust the payload's property snapshot — a button click delivers
    //    values that may already be stale. Re-read the page.
    const projectPage = await ctx.step("fetch-project-page", async () => {
      const res = await sdk.fetch(`${NOTION_API}/pages/${projectPageId}`, {
        connection: NOTION_CONNECTION,
        headers: { "Notion-Version": NOTION_VERSION },
      });
      if (!res.ok) {
        throw new Error(
          `Notion get project page ${projectPageId} failed (${res.status}): ${await res.text()}`,
        );
      }
      return res.json();
    });

    if ((projectPage as any)?.archived || (projectPage as any)?.in_trash) {
      return { skipped: "project-page-archived", projectPageId } satisfies Outcome;
    }

    const parentDs = parentDataSource(projectPage);
    const projectProps = (projectPage as any)?.properties ?? {};
    if (parentDs && parentDs !== PROJECTS_DS) {
      return {
        skipped: "not-a-projects-page",
        projectPageId,
        parentDataSource: parentDs,
      } satisfies Outcome;
    }

    const projectName = plainText(projectProps[PROJECT_TITLE_PROP]?.title);
    const projectCode = uniqueIdCode(projectProps[PROJECT_UID_PROP]);
    const companyPageId = relationIds(projectProps[PROJECT_COMPANIES_PROP])[0] ?? null;

    // 2. Nothing to bill against. Tell the human on the page, the way the
    //    classic Zap's Fallback path did, and stop.
    if (!companyPageId) {
      if (!previewOnly) {
        await ctx.step("comment-no-company", async () =>
          sdk.runAction({
            appKey: NOTION_APP_KEY,
            actionType: "write",
            actionKey: "comment",
            connection: NOTION_CONNECTION,
            inputs: { page_id: projectPageId, comment: NO_COMPANY_COMMENT },
          }),
        );
        console.log(`no Companies relation on ${projectCode || projectPageId} — commented and stopped`);
      }
      return {
        previewOnly,
        skipped: "no-company-linked",
        projectPageId,
        project: projectName,
        projectCode,
        commented: !previewOnly,
      } satisfies Outcome;
    }

    // 3. Idempotence. One Harvest project per Notion Projects page: if this
    //    page already has a row carrying a Harvest project id, we are done.
    //    A permanent condition, so return rather than throw — a throw would
    //    spin the durable's step-retry loop.
    const existingRow = await ctx.step("find-project-row", async () => {
      const res = await sdk.runAction({
        appKey: "TableCLIAPI",
        actionType: "search",
        actionKey: "find_record",
        inputs: {
          table_id: PROJECT_TABLE,
          filter_count: "1",
          use_stored_order: false,
          field_data_key: "data__f5",
          operator: "exact",
          lookup_value: projectPageId,
        },
      });
      const row = firstRow(res);
      if (!row) return null;
      return {
        recordId: firstString(row.id, row.record_id),
        harvestProjectId: firstString(row.data?.f1),
      };
    });

    // `previewOnly` walks PAST this guard and reports it as `wouldSkip`
    // instead, so an already-mapped project can still be used to exercise the
    // company-resolution path below.
    if (existingRow?.harvestProjectId && !previewOnly) {
      console.log(
        `${projectCode || projectPageId} already maps to Harvest project ${existingRow.harvestProjectId}`,
      );
      return {
        skipped: "harvest-project-already-exists",
        projectPageId,
        project: projectName,
        harvestProjectId: existingRow.harvestProjectId,
      } satisfies Outcome;
    }

    // 4. Resolve the Harvest client. The Notion Company page is the source of
    //    truth for Harvest Client ID — `notion-companies-to-zapier-table`
    //    mirrors it into the Company IDs Table, so reading and writing the
    //    page keeps that Table correct with no work here.
    const companyPage = await ctx.step("fetch-company-page", async () => {
      const res = await sdk.fetch(`${NOTION_API}/pages/${companyPageId}`, {
        connection: NOTION_CONNECTION,
        headers: { "Notion-Version": NOTION_VERSION },
      });
      if (!res.ok) {
        throw new Error(
          `Notion get company page ${companyPageId} failed (${res.status}): ${await res.text()}`,
        );
      }
      return res.json();
    });

    const companyProps = (companyPage as any)?.properties ?? {};
    const companyName = plainText(companyProps[COMPANY_TITLE_PROP]?.title);
    const existingClientId = plainText(companyProps[COMPANY_HARVEST_ID_PROP]?.rich_text);

    // Harvest needs a name for both the client and the project. Missing either
    // is a real data problem on a page a human just clicked a button on, so
    // surface it rather than creating an unnamed record in Harvest.
    if (!companyName) {
      throw new Error(
        `Notion company ${companyPageId} has no ${COMPANY_TITLE_PROP} — cannot create a Harvest client.`,
      );
    }
    if (!projectName) {
      throw new Error(
        `Notion project ${projectPageId} has no ${PROJECT_TITLE_PROP} — cannot create a Harvest project.`,
      );
    }

    if (previewOnly) {
      return {
        previewOnly: true,
        wouldSkip: existingRow?.harvestProjectId ? "harvest-project-already-exists" : null,
        existingHarvestProjectId: existingRow?.harvestProjectId || null,
        existingTableRecordId: existingRow?.recordId || null,
        projectPageId,
        project: projectName,
        projectCode,
        companyPageId,
        company: companyName,
        existingHarvestClientId: existingClientId || null,
        wouldCreateClient: !existingClientId,
        wouldCreateClientInputs: existingClientId ? null : { name: companyName },
        wouldCreateProjectInputs: {
          client_id: existingClientId || "<new client id>",
          name: projectName,
          code: projectCode,
        },
      } satisfies Outcome;
    }

    let harvestClientId = existingClientId;
    let clientCreated = false;

    if (!harvestClientId) {
      const createdClient = await ctx.step("create-harvest-client", async () =>
        sdk.runAction({
          appKey: HARVEST_APP_KEY,
          actionType: "write",
          actionKey: "create_client",
          connection: HARVEST_CONNECTION,
          inputs: { name: companyName },
        }),
      );

      harvestClientId = firstString(harvestRow(createdClient).id);
      if (!harvestClientId) {
        // The client IS created — we just can't reference it, so creating the
        // project would bind it to nothing and the next run would duplicate
        // the client. Fail loudly.
        throw new Error(
          `Harvest create_client returned no client id for "${companyName}": ` +
            `${JSON.stringify(createdClient).slice(0, 500)}`,
        );
      }
      clientCreated = true;

      // 5. Write it back so step 4's guard has teeth on the next run.
      await ctx.step("write-client-id-to-notion", async () => {
        const res = await sdk.fetch(`${NOTION_API}/pages/${companyPageId}`, {
          connection: NOTION_CONNECTION,
          method: "PATCH",
          headers: {
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            properties: {
              [COMPANY_HARVEST_ID_PROP]: {
                rich_text: [{ text: { content: harvestClientId } }],
              },
            },
          }),
        });
        if (!res.ok) {
          throw new Error(
            `Notion write-back of ${COMPANY_HARVEST_ID_PROP} to ${companyPageId} failed ` +
              `(${res.status}): ${await res.text()}`,
          );
        }
        return res.json();
      });
      console.log(`created Harvest client ${harvestClientId} for "${companyName}"`);
    }

    // 6. Create the Harvest project against that client.
    const createdProject = await ctx.step("create-harvest-project", async () =>
      sdk.runAction({
        appKey: HARVEST_APP_KEY,
        actionType: "write",
        actionKey: "create_project",
        connection: HARVEST_CONNECTION,
        inputs: {
          client_id: harvestClientId,
          name: projectName,
          code: projectCode,
        },
      }),
    );

    const projectRow = harvestRow(createdProject);
    const harvestProjectId = firstString(projectRow.id);
    if (!harvestProjectId) {
      // Same reasoning as the client: without an id we cannot index the
      // project, so the next click would create a duplicate.
      throw new Error(
        `Harvest create_project returned no project id for "${projectName}": ` +
          `${JSON.stringify(createdProject).slice(0, 500)}`,
      );
    }
    const isActive = projectRow.is_active !== false;

    // 7. Record the mapping. Update the row this page already has if there is
    //    one (a half-written row from an earlier failed run), else create it.
    const tableInputs = {
      new__data__f1: harvestProjectId,
      new__data__f2: harvestClientId,
      new__data__f3: isActive,
      new__data__f4: projectName,
      new__data__f5: projectPageId,
    };

    if (existingRow?.recordId) {
      await ctx.step("update-project-row", async () =>
        sdk.runAction({
          appKey: "TableCLIAPI",
          actionType: "write",
          actionKey: "update_record",
          inputs: {
            table_id: PROJECT_TABLE,
            record_id: existingRow.recordId,
            ...tableInputs,
          },
        }),
      );
    } else {
      await ctx.step("create-project-row", async () =>
        sdk.runAction({
          appKey: "TableCLIAPI",
          actionType: "write",
          actionKey: "create_record",
          inputs: { table_id: PROJECT_TABLE, ...tableInputs },
        }),
      );
    }

    console.log(
      `created Harvest project ${harvestProjectId} (${projectCode}) "${projectName}" ` +
        `for client ${harvestClientId} "${companyName}"`,
    );

    return {
      created: true,
      projectPageId,
      project: projectName,
      projectCode,
      companyPageId,
      company: companyName,
      harvestClientId,
      clientCreated,
      harvestProjectId,
      isActive,
    } satisfies Outcome;
  },
);

export default workflow;
