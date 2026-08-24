// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/company-ids-table-to-fivetran-sheet
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
const SHEETS_APP_KEY = "GoogleSheetsV2CLIAPI";
const SHEETS_CONNECTION = "gsheets";

/** [Table] Company IDs — the Notion Companies mirror owned by
 *  notion-companies-to-zapier-table. Read-only here. */
const TABLE_ID = "01JM8PH8YM93A482M8BFZ6WKW6";
const KEY_FIELD = "Notion Page ID";

/** "Fivetran Sync Jobs" spreadsheet on the Work.Flowers HQ shared drive, tab
 *  "Company IDs" (gid 288457717). Fivetran reads this tab into the warehouse.
 *  The tab NAME is the contract, not the gid: the Sheets values API only takes
 *  A1 notation, and renaming the tab would break Fivetran's own config too. */
const SPREADSHEET_ID = "1PzAG_XWwwmxFKo2LW9S8sJAnp8QVGndsnVhrSL8iQbo";
const SHEET_TITLE = "Company IDs";

/** Column order of the tab's header row, A -> L. Table field name per column;
 *  `null` is the Table's own record id, which the sheet calls
 *  "tables_record_id" and Fivetran uses as the primary key. */
const COLUMNS: Array<{ header: string; field: string | null }> = [
  { header: "tables_record_id", field: null },
  { header: "Harvest Client ID", field: "Harvest Client ID" },
  { header: "Google Drive Folder ID", field: "Google Drive Folder ID" },
  { header: "Company Name", field: "Company Name" },
  { header: "Slack Channel ID", field: "Slack Channel ID" },
  { header: "Linear Customer ID", field: "Linear Customer ID" },
  { header: "Domain", field: "Domain" },
  { header: "Slack Channel Is Archived", field: "Slack Channel Is Archived" },
  { header: "Notion Company ID", field: "Notion Company ID" },
  { header: "Linear Team ID", field: "Linear Team ID" },
  { header: "Notion Page ID", field: "Notion Page ID" },
  { header: "Xero Contact ID", field: "Xero Contact ID" },
];

const LAST_COLUMN = "L"; // COLUMNS.length -> A..L

const InputSchema = z.unknown();

// --- Helpers -----------------------------------------------------------------
/** Render a Zapier Tables cell as the flat string the sheet holds. Link fields
 *  arrive as `{ link }` objects and booleans as real booleans; the tab's
 *  existing contents use TRUE/FALSE for the latter. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "object") {
    const link = (value as Record<string, unknown>).link;
    if (typeof link === "string") return link;
    const text = (value as Record<string, unknown>).text;
    if (typeof text === "string") return text;
    return "";
  }
  return String(value);
}

/** Every mirrored company, oldest record id first so the sheet's row order is
 *  stable between refreshes. Table reads consume no Zapier tasks. */
async function readAllCompanies(): Promise<string[][]> {
  const rows: string[][] = [];
  let cursor: string | undefined = undefined;
  // Bounded: ~1k rows today at 1000/page. The cap is a runaway guard, not a limit
  // we expect to reach — hitting it would silently truncate the sheet, so throw.
  for (let page = 0; page < 25; page++) {
    const res: any = await sdk.listTableRecords({
      table: TABLE_ID,
      keyMode: "names",
      // Mirror the classic Zap's filter: only companies that exist in Notion.
      filters: [{ fieldKey: KEY_FIELD, operator: "isnull", value: false }],
      pageSize: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const record of res.data ?? []) {
      rows.push(
        COLUMNS.map((c) => (c.field === null ? String(record.id) : cell(record.data?.[c.field]))),
      );
    }
    cursor = res.nextCursor ?? undefined;
    if (!cursor) return rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
  throw new Error(
    `[Table] Company IDs did not finish paginating in 25 pages (${rows.length} rows read) — ` +
      `refusing to rewrite the sheet from a truncated read.`,
  );
}

/** A Sheets API call routed through the Zapier connection's API Request action,
 *  so it stays inside Zapier's auth and audit layer.
 *  Query parameters must be passed as `querystring` — the _zap_raw_request
 *  action strips them from the URL string before forwarding to Google. */
async function sheetsRequest(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
  querystring?: Record<string, string>,
): Promise<any> {
  const inputs: Record<string, unknown> = {
    fail_on_errors: true,
    method,
    url: `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/${path}`,
  };
  if (querystring !== undefined) {
    inputs.querystring = querystring;
  }
  if (body !== undefined) {
    inputs.body = JSON.stringify(body);
    inputs.headers = { "Content-Type": "application/json" };
  }
  const res: any = await sdk.runAction({
    appKey: SHEETS_APP_KEY,
    actionType: "write",
    actionKey: "_zap_raw_request",
    connection: SHEETS_CONNECTION,
    inputs,
  });
  const first = res?.data?.[0] ?? res?.[0] ?? res;
  const status = Number(first?.response?.status ?? 0);
  if (status < 200 || status >= 300) {
    throw new Error(
      `Sheets ${method} ${path} failed (${status}): ${String(first?.response?.body ?? "").slice(0, 400)}`,
    );
  }
  const raw = first?.response?.body;
  if (typeof raw !== "string" || raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** A1 notation for a range on the target tab, quoted because the title has a space. */
function range(a1: string): string {
  return encodeURIComponent(`'${SHEET_TITLE}'!${a1}`);
}

// --- Workflow ----------------------------------------------------------------
const workflow = defineDurable({
  name: "company-ids-table-to-fivetran-sheet",
  description:
    "Weekly full refresh of the 'Company IDs' tab of the Fivetran Sync Jobs spreadsheet from [Table] Company IDs. Clears the data rows and rewrites every mirrored company, so the tab Fivetran syncs matches the Table.",
  inputSchema: InputSchema,
  run: async (ctx) => {
    // One step on purpose. The 1,000-plus-row payload is never checkpointed —
    // only the summary is — and a retry simply redoes the whole refresh, which
    // is idempotent because the Table is the source of truth.
    const result = await ctx.step("refresh-fivetran-sheet", async () => {
      // 1. Read the whole mirror. Free (Tables API), and the sheet is only
      //    touched once this succeeds: a failed read must never blank the tab.
      const rows = await readAllCompanies();
      if (rows.length === 0) {
        // The Table is never legitimately empty. Refuse rather than wipe the tab.
        throw new Error(
          "[Table] Company IDs returned no rows — refusing to clear the Fivetran sheet. " +
            "Check the Table and the notion-companies-to-zapier-table mirror.",
        );
      }

      // 2. Clear the existing data rows, keeping the header. `values:clear`
      //    empties the cells but leaves the rows, so nothing below shifts.
      await sheetsRequest("POST", `values/${range(`A2:${LAST_COLUMN}`)}:clear`, {});

      // 3. Append every row back. `:append` anchors after the last populated
      //    row — the header, post-clear — and grows the grid if the Table
      //    outgrew it, which a plain `values.update` would reject.
      //    `valueInputOption` must go through `querystring`, not in the URL:
      //    `_zap_raw_request` strips URL query params before forwarding.
      const res = await sheetsRequest(
        "POST",
        `values/${range("A1")}:append`,
        { values: rows },
        { valueInputOption: "RAW" },
      );
      const updatedRows = Number(res?.updates?.updatedRows ?? 0);
      if (updatedRows !== rows.length) {
        throw new Error(
          `Wrote ${updatedRows} row(s) to the Fivetran sheet but had ${rows.length} to write — ` +
            `the tab is now incomplete and needs a manual re-run.`,
        );
      }
      return {
        companies: rows.length,
        updatedRange: String(res?.updates?.updatedRange ?? ""),
        updatedRows,
      };
    });

    console.log(
      `refreshed "${SHEET_TITLE}" with ${result.companies} companies (${result.updatedRange})`,
    );
    return result;
  },
});

export default workflow;
