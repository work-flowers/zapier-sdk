// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/notion-company-renamed-to-xero-harvest-drive
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
const NOTION_CONNECTION = "notion_wf"; // work.flowers workspace connection
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

const XERO_APP_KEY = "XeroCLIAPI";
const XERO_CONNECTION = "xero_wf";
/** Xero organisation ("tenant") — work.flowers. */
const XERO_ORGANIZATION = "62699a8c-3351-40e8-9265-bdca5e037b03";
/** "Update Contact Name" custom action on the Xero app. */
const XERO_RENAME_CONTACT = "ae:515080";

const HARVEST_APP_KEY = "HarvestCLIAPI";
const HARVEST_CONNECTION = "harvest_wf";
/** "Update Client Name" custom action on the Harvest app. */
const HARVEST_RENAME_CLIENT = "ae:541562";

const DRIVE_APP_KEY = "GoogleDriveCLIAPI";
const DRIVE_CONNECTION = "gdrive";

/** [Table] Company IDs — the Notion Companies mirror owned by
 *  notion-companies-to-zapier-table. Written here too so the rename lands
 *  immediately rather than waiting on the mirror's own webhook. */
const TABLE_ID = "01JM8PH8YM93A482M8BFZ6WKW6";
const TABLE_KEY_FIELD = "Notion Page ID";
const TABLE_NAME_FIELD = "Company Name";

// Notion Companies properties this workflow reads.
const NAME_PROP = "Company Name";
const XERO_ID_PROP = "Xero Contact ID";
const HARVEST_ID_PROP = "Harvest Client ID";
const DRIVE_FOLDER_PROP = "Google Drive Folder ID";

const InputSchema = z.unknown();

// --- Helpers -----------------------------------------------------------------
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

function extractPageId(raw: unknown): string {
  if (!raw) throw new Error("No input provided to workflow.");
  if (typeof raw === "string") return raw.trim();
  const o = raw as Record<string, any>;
  const candidate =
    o.page_id ||
    o.pageId ||
    (o.data && (o.data.id || o.data.page_id)) ||
    o.id ||
    (o.page && o.page.id);
  if (!candidate) {
    throw new Error(
      `Could not find a Notion page id in the trigger payload: ${JSON.stringify(raw).slice(0, 300)}`,
    );
  }
  return String(candidate).trim();
}

/** Notion page ids must be dashed wherever they are used as a key. */
function dashUuid(id: string): string {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return id;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function plainText(rich: any): string {
  return (Array.isArray(rich) ? rich : []).map((t) => t?.plain_text ?? "").join("").trim();
}

type Company = {
  pageId: string;
  name: string;
  xeroContactId: string;
  harvestClientId: string;
  driveFolderId: string;
};

async function fetchCompany(pageId: string): Promise<Company> {
  const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
    connection: NOTION_CONNECTION,
    headers: { "Notion-Version": NOTION_VERSION },
  });
  if (!res.ok) {
    throw new Error(`Notion get page ${pageId} failed (${res.status}): ${await res.text()}`);
  }
  const page: any = await res.json();
  const props = page.properties || {};
  return {
    pageId: dashUuid(String(page.id)),
    name: plainText(props[NAME_PROP]?.title),
    xeroContactId: plainText(props[XERO_ID_PROP]?.rich_text),
    harvestClientId: plainText(props[HARVEST_ID_PROP]?.rich_text),
    driveFolderId: plainText(props[DRIVE_FOLDER_PROP]?.rich_text),
  };
}

// --- Workflow ----------------------------------------------------------------
const workflow = defineDurable({
  name: "notion-company-renamed-to-xero-harvest-drive",
  description:
    "When a Notion Companies record is renamed, push the new name to its Xero contact, Harvest client, Google Drive client folder and its [Table] Company IDs row — each only if that system's id is on the page.",
  inputSchema: InputSchema,
  run: async (ctx, rawInput) => {
    const pageId = dashUuid(extractPageId(normalizeInput(rawInput)));

    // 1. Read the page's CURRENT state rather than trusting the trigger payload:
    //    the polling trigger can lag, and every downstream write is a rename.
    const company = await ctx.step("fetch-notion-company", () => fetchCompany(pageId));

    if (!company.name) {
      // A blank title is a real Notion state (a freshly created row). Renaming a
      // Xero contact, Harvest client or Drive folder to "" would be destructive.
      console.log(`company ${pageId} has no name — nothing safe to propagate`);
      return { skipped: "company-has-no-name", pageId };
    }

    // 2. Fan out. The classic Zap ran these as four independent paths, so one
    //    failing never blocked the others; `allSettled` keeps that property
    //    while still failing the run loudly at the end.
    const targets: string[] = [];
    const jobs: Array<Promise<unknown>> = [];

    // [Table] Company IDs — free (Tables API), so it goes first and always runs.
    targets.push("table");
    jobs.push(
      ctx.step("rename-in-company-ids-table", async () => {
        const found = await sdk.listTableRecords({
          table: TABLE_ID,
          keyMode: "names",
          filters: [{ fieldKey: TABLE_KEY_FIELD, operator: "exact", value: company.pageId }],
          pageSize: 100,
        });
        const records = (found.data ?? []).slice().sort((a: any, b: any) => (a.id < b.id ? -1 : 1));
        if (!records.length) return { skipped: "no-table-row" };
        if (String(records[0].data?.[TABLE_NAME_FIELD] ?? "") === company.name) {
          return { skipped: "already-current" };
        }
        await sdk.updateTableRecords({
          table: TABLE_ID,
          keyMode: "names",
          records: [{ id: records[0].id, data: { [TABLE_NAME_FIELD]: company.name } }],
        });
        return { updated: records[0].id };
      }),
    );

    if (company.xeroContactId) {
      targets.push("xero");
      jobs.push(
        ctx.step({
          name: "rename-xero-contact",
          maxAttempts: 3,
          retryDelaySeconds: 15,
          run: async () =>
            sdk.runAction({
              appKey: XERO_APP_KEY,
              actionType: "write",
              actionKey: XERO_RENAME_CONTACT,
              connection: XERO_CONNECTION,
              inputs: {
                contactId: company.xeroContactId,
                newName: company.name,
                xeroTenantId: XERO_ORGANIZATION,
              },
            }),
        }),
      );
    }

    if (company.harvestClientId) {
      targets.push("harvest");
      jobs.push(
        ctx.step({
          name: "rename-harvest-client",
          maxAttempts: 3,
          retryDelaySeconds: 15,
          run: async () =>
            sdk.runAction({
              appKey: HARVEST_APP_KEY,
              actionType: "write",
              actionKey: HARVEST_RENAME_CLIENT,
              connection: HARVEST_CONNECTION,
              inputs: { clientId: company.harvestClientId, newName: company.name },
            }),
        }),
      );
    }

    if (company.driveFolderId) {
      targets.push("drive");
      jobs.push(
        ctx.step({
          name: "rename-drive-folder",
          maxAttempts: 3,
          retryDelaySeconds: 15,
          run: async () =>
            sdk.runAction({
              appKey: DRIVE_APP_KEY,
              actionType: "write",
              actionKey: "update_file_name",
              connection: DRIVE_CONNECTION,
              inputs: {
                rename_folder: true,
                folder: company.driveFolderId,
                new_name: company.name,
              },
            }),
        }),
      );
    }

    const settled = await Promise.allSettled(jobs);

    const failures = settled
      .map((r, i) => ({ target: targets[i], reason: r.status === "rejected" ? r.reason : null }))
      .filter((f) => f.reason !== null);

    const renamed = settled
      .map((r, i) => (r.status === "fulfilled" ? targets[i] : null))
      .filter((t): t is string => t !== null);

    console.log(
      `company "${company.name}" (${pageId}) renamed in: ${renamed.join(", ") || "nothing"}` +
        (failures.length ? ` — failed: ${failures.map((f) => f.target).join(", ")}` : ""),
    );

    if (failures.length) {
      throw new Error(
        `Renamed "${company.name}" in ${renamed.join(", ") || "nothing"} but failed in ` +
          failures
            .map((f) => `${f.target} (${String((f.reason as Error)?.message ?? f.reason).slice(0, 200)})`)
            .join("; "),
      );
    }

    return { pageId, company: company.name, renamed };
  },
});

export default workflow;
