// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/drive-paid-receipts-to-table
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// The Google Drive credential is needed in BOTH places: on the TRIGGER
// (publish --trigger authentication_id, which is what polls the folder) and
// as the `gdrive` alias here, because the code renames the file. AI by
// Zapier and Zapier Tables both run without a connection.
const DRIVE_APP_KEY = "GoogleDriveCLIAPI";
const DRIVE_CONNECTION = "gdrive";

const AI_APP_KEY = "AICLIAPI";

// AI by Zapier on Zapier's built-in credentials ("0" = Included in Plan).
//
// TIER = TASK COST: `standard/auto` / `advanced/auto` / `premium/auto` bill at
// 1x / 3x / 5x tasks per run (those three sentinels are the only valid
// values). Standard correctly extracted vendor, date, currency and amount
// from a real receipt in the Paid Receipts folder (Anthropic, PBC, verified
// 2026-07-28) — see the README's verified-cases table. This step makes no
// tool calls, which is the main reason Zapier's own default is Advanced.
const AI_MODEL = "standard/auto";
const AI_AUTHENTICATION = "0";

const TABLE_APP_KEY = "TableCLIAPI";

/** "[Table] Receipts" — File ID (f1), File Name (f2), Currency (f3), Amount
 *  (f4), Date (f5), Vendor Name (f6). Keyed on File ID (f1). */
const RECEIPTS_TABLE = "01KJKDRB9P8ZP7NP9HE6NS3YFQ";

// The Google Drive "New File in Folder" trigger delivers a file object.
// Accept anything and extract defensively.
const InputSchema = z.unknown();

// --- Pure helpers ------------------------------------------------------------

function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline can deliver input double-encoded (a JSON string of a
  // JSON string), while run-durable delivers it single-encoded. Parse until
  // we reach a non-string, or stop on parse failure.
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
  if (!res) return null;
  if (Array.isArray(res)) return res[0] ?? null;
  if (Array.isArray(res.data)) return res.data[0] ?? null;
  return res.data ?? res;
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    // Tolerate thousands separators and currency symbols the model may leave in.
    const cleaned = v.replace(/[^0-9.+-]/g, "");
    if (cleaned === "" || cleaned === "-" || cleaned === "+") return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** `YYYY-MM-DD` from an ISO-ish date string, or null. */
function toIsoDate(v: unknown): string | null {
  const s = firstString(v);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const [, y, mo, d] = m;
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (Number.isNaN(dt.getTime())) return null;
  return `${y}-${mo}-${d}`;
}

/** Google Drive rejects `/` in a name; keep it tidy otherwise. */
function buildFileName(invoiceDate: string, vendor: string): string {
  const cleanVendor = vendor.replace(/[/\\]/g, "-").replace(/\s+/g, " ").trim();
  return `${invoiceDate} ${cleanVendor}`.trim();
}

/** Extract the trigger's file fields. */
function extractFile(payload: unknown): {
  id: string;
  title: string;
  mimeType: string;
  fileRef: string;
  trashed: boolean;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, any>;
  const id = firstString(p.id, p.fileId);
  const fileRef = firstString(p.file);
  if (!id || !fileRef) return null;
  return {
    id,
    title: firstString(p.title, p.name, p.originalFilename) ?? "(untitled)",
    mimeType: (firstString(p.mimeType) ?? "").toLowerCase(),
    fileRef,
    trashed: Boolean(p.labels?.trashed || p.explicitlyTrashed),
  };
}

// --- Prompt ------------------------------------------------------------------
// Verbatim copy of receipt-extraction-prompt.md (repo rule 6).
// Edit the markdown, then run `node scripts/check-prompts.mjs --fix`.
const RECEIPT_PROMPT = `As a data extraction specialist, your task is to analyze the provided invoice document and extract specific information. Please identify and extract the vendor name, date, currency, and total amount due from the receipt.

The date should be formatted in ISO8601 format (YYYY-MM-DD). Ensure that the extracted information is accurate and clearly presented.

**Expected Output Format:**
- Vendor Name: [Extracted Vendor Name]
- Date: [Extracted Date in ISO8601 format]
- Currency: [Extracted Currency]
- Amount Due: [Extracted Total Amount Due]

**Example:**
- Vendor Name: Acme Corp
- Date: 2023-10-15
- Currency: SGD
- Amount Due: 65.05`;

const OUTPUT_FIELDS = [
  { name: "Vendor Name", description: "The name of the vendor from the invoice document", type: "text", isRequired: true },
  { name: "Invoice Date", description: "The date of the invoice in ISO8601 format (YYYY-MM-DD)", type: "date", isRequired: true },
  { name: "Currency", description: "The currency in which the total amount due is specified", type: "text", isRequired: true },
  { name: "Total Amount Due", description: "The total amount due from the invoice", type: "number", isRequired: true },
];

const workflow = defineDurable<Record<string, unknown>, unknown>(
  "drive-paid-receipts-to-table",
  async (ctx, rawInput) => {
    const file = extractFile(InputSchema.parse(normalizeInput(rawInput)));
    if (!file) {
      console.log("skipping: no file in payload (empty/test delivery)");
      return { skipped: true, reason: "no file in payload" };
    }

    // The classic Zap's "PDFs only" filter. Plain code, no task cost.
    if (!file.mimeType.includes("application/pdf")) {
      console.log(`skipping ${file.title}: not a PDF (${file.mimeType || "unknown"})`);
      return { skipped: true, reason: `not a PDF (${file.mimeType || "unknown"})`, file: file.title };
    }
    if (file.trashed) {
      console.log(`skipping ${file.title}: file is in the trash`);
      return { skipped: true, reason: "file is in the trash", file: file.title };
    }

    // 1. Analyze the receipt — a single AI by Zapier call.
    const completion = await ctx.step("analyze-receipt", async () =>
      sdk.runAction({
        appKey: AI_APP_KEY,
        actionType: "write",
        actionKey: "get_completion",
        inputs: {
          authentication_id: AI_AUTHENTICATION,
          model_id: AI_MODEL,
          isOutputArray: false,
          instructions: RECEIPT_PROMPT,
          inputFields: { Invoice: file.fileRef },
          inputFieldConfig_Invoice_isFileUrl: true,
          outputFields: OUTPUT_FIELDS,
        },
      }),
    );

    const raw = firstResult(completion)?.result ?? firstResult(completion) ?? {};
    const vendor = firstString(raw["Vendor Name"]) ?? "Unknown Vendor";
    const invoiceDate = toIsoDate(raw["Invoice Date"]) ?? new Date().toISOString().slice(0, 10);
    const currency = firstString(raw["Currency"]);
    const amount = toNumber(raw["Total Amount Due"]);

    // 2. Rename the Drive file to "<invoice date> <vendor>", as the classic
    //    Zap did.
    const newName = buildFileName(invoiceDate, vendor);
    const renamed = await ctx.step("rename-receipt-file", async () =>
      sdk.runAction({
        appKey: DRIVE_APP_KEY,
        actionType: "write",
        actionKey: "update_file_name",
        connection: DRIVE_CONNECTION,
        inputs: { file: file.id, new_name: newName, rename_folder: "false" },
      }),
    );
    // Drive may append "(1)" etc. on a name collision, so the file's actual
    // post-rename title can differ from what was requested.
    const renamedTitle = firstString(firstResult(renamed)?.title) ?? newName;

    // 3. Find-or-create the Table record, keyed on File ID. Pin midnight UTC
    //    on the date — a bare YYYY-MM-DD is read in the account's local
    //    timezone and silently shifts.
    const upserted = await ctx.step("find-or-create-receipt-record", async () =>
      sdk.runAction({
        appKey: TABLE_APP_KEY,
        actionType: "search_or_write",
        actionKey: "find_record",
        inputs: {
          table_id: RECEIPTS_TABLE,
          filter_count: "1",
          use_stored_order: false,
          field_data_key: "data__f1",
          operator: "exact",
          lookup_value: file.id,
          new__data__f1: file.id,
          new__data__f2: newName,
          new__data__f3: currency ?? "",
          new__data__f4: amount ?? undefined,
          new__data__f5: `${invoiceDate}T00:00:00Z`,
          new__data__f6: vendor,
        },
      }),
    );
    const recordId = firstString(firstResult(upserted)?.record_id);

    // 4. Sync the Table's File Name field to the file's actual post-rename
    //    title (may differ from `newName` on a collision).
    let updatedRecord = false;
    if (recordId) {
      await ctx.step("update-receipt-record-name", async () =>
        sdk.runAction({
          appKey: TABLE_APP_KEY,
          actionType: "write",
          actionKey: "update_record",
          inputs: { table_id: RECEIPTS_TABLE, record_id: recordId, new__data__f2: renamedTitle },
        }),
      );
      updatedRecord = true;
    } else {
      console.log(`WARNING: find-or-create returned no record_id for file ${file.id}; name sync skipped`);
    }

    console.log(`processed ${file.title} -> ${renamedTitle} (${vendor}, ${currency ?? "?"} ${amount ?? "?"})`);

    return {
      file: { id: file.id, originalTitle: file.title, renamedTo: renamedTitle },
      extracted: { vendor, invoiceDate, currency, amount },
      tableRecordId: recordId,
      updatedRecord,
    };
  },
);

export default workflow;
