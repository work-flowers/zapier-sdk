// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/drive-screenshot-to-xero-sales-invoice
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections. The
// Google Drive credential is needed in BOTH places: on the TRIGGER (which
// polls the folder) and as the `gdrive` alias here, because the code renames
// the file — same shape as drive-invoice-to-xero. AI by Zapier runs on
// built-in credentials and needs no connection binding at all.
const DRIVE_APP_KEY = "GoogleDriveCLIAPI";
const DRIVE_CONNECTION = "gdrive";

const XERO_APP_KEY = "XeroCLIAPI";
const XERO_CONNECTION = "xero_wf";

const AI_APP_KEY = "AICLIAPI";

/** Xero organisation ("tenant") — work.flowers. Same org drive-invoice-to-xero writes bills into. */
const XERO_ORGANIZATION = "62699a8c-3351-40e8-9265-bdca5e037b03";

/** "USD Payments" branding theme, verified live against this organization. */
const XERO_BRANDING_THEME = "742441f1-81a7-498b-9f8b-bc685bb0183c";

const XERO_CURRENCY = "USD";

/** "Affiliate / Referral Income" — verified live against this organization's chart of accounts. */
const XERO_LINE_ACCOUNT_CODE = "460";

/** "No Tax" — verified live against this organization's tax types. */
const XERO_LINE_TAX_TYPE = "NONE";

/** Line amounts are the final billed amount; nothing to gross up or strip tax from. */
const XERO_LINE_ITEMS_TYPE = "NoTax";

/** Invoices are always created as drafts for review, never auto-approved or emailed. */
const INVOICE_STATUS = "draft";

/**
 * The customer being billed. A fixed literal, not anything read off the
 * screenshot — so unlike a vendor name extracted from a scanned invoice
 * (see drive-invoice-to-xero's vendor-contact problem), there is no spelling
 * drift here for Xero's by-name contact match to trip over. Every run binds
 * to the same existing Xero contact.
 */
const CONTACT_NAME = "Notion Labs, Inc.";

/**
 * Fixed per Dennis (the classic Zap held this in a Zap Component variable
 * whose value wasn't included in the exported Zap JSON).
 */
const INVOICE_REFERENCE = "PO #8900";

/**
 * AI by Zapier tier for the line-item extraction. NOT the repo's default
 * standard/auto — A/B'd across three real screenshots (2026-04, 2026-05,
 * 2026-06) before publishing: standard/auto silently DROPPED a real line
 * (Ernest Choo, Calls Completed: 2) on the 2026-06 screenshot, reproduced on
 * a second run of the same file, while advanced/auto caught it both times.
 * All three tiers agreed exactly on the other two screenshots. A dropped
 * line here is under-billed revenue with no error anywhere, so the extra
 * task cost is the right trade. Re-run this comparison before downgrading.
 */
const AI_MODEL = "advanced/auto";
const AI_AUTHENTICATION = "0";

/**
 * Session Type -> Xero item code, from the classic Zap's Formatter "Lookup
 * Table" step (util_line_item / util.lookup transform).
 */
const ITEM_CODE_BY_SESSION_TYPE: Record<string, string> = {
  "Calls Completed": "NOTION-CALL",
  "No-Shows": "NOTION-NOSHOW",
  "Seats Added": "NOTION-SEATS",
  "Late Cancellations": "NOTION-CANCEL",
  "Workspace Conversions": "NOTION-UPGRADE",
  "Referral Bonuses": "NOTION-REFERRAL",
};

const SESSION_TYPES = Object.keys(ITEM_CODE_BY_SESSION_TYPE);

/**
 * CSV export column -> Session Type (the ITEM_CODE_BY_SESSION_TYPE key). The
 * CSV is Notion's own export of the monthly payouts view, one row per
 * consultant with one column per session type. Every column here must be
 * present — a missing one means the export's shape changed, and silently
 * treating it as zero would under-bill. The CSV has no Referral Bonuses
 * column; that type only ever comes off a screenshot.
 */
const SESSION_TYPE_BY_CSV_COLUMN: Record<string, string> = {
  "Calls Completed": "Calls Completed",
  "No Shows": "No-Shows",
  "Late Cancellations": "Late Cancellations",
  "Workspace Conversions": "Workspace Conversions",
  "Seats Added": "Seats Added",
};

/**
 * CSV columns that carry billable activity this Zap has no Xero item code
 * for. A non-zero value throws rather than being dropped: an invoice missing
 * a line is under-billed revenue with no error anywhere. Add an item code
 * (and a SESSION_TYPE_BY_CSV_COLUMN entry) before letting these through.
 */
const UNMAPPED_CSV_COLUMNS = ["AE Assist Calls Completed", "Custom Adjustment Amount"];

const CSV_NAME_COLUMN = "Name";
const CSV_TIMEFRAME_COLUMN = "TIMEFRAME";
const CSV_TOTAL_COLUMN = "Total Payout";

const DRIVE_API = "https://www.googleapis.com/drive/v3";

// The Google Drive "New File in Folder" trigger delivers a file object.
// Accept anything and extract defensively.
const InputSchema = z.unknown();

// --- Pure helpers --------------------------------------------------------------

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

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^0-9.+-]/g, "");
    if (cleaned === "" || cleaned === "-" || cleaned === "+") return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Days in a month, proleptic Gregorian. Used only to validate the AI's
 * "Invoice Period" date is a real calendar date before it reaches Xero —
 * see the determinism note below for why this can't be `new Date`.
 */
function daysInMonth(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/**
 * `YYYY-MM-DD` from an ISO-ish date string, or null if it isn't a real date.
 *
 * The durable runtime runs the workflow body in GUARDED mode and throws
 * `DeterminismViolation` from a `new Date()` Proxy trap that fires before it
 * even inspects the arguments — so `new Date(Date.UTC(y, m, d))` is rejected
 * exactly as hard as a clock read (see drive-invoice-to-xero's determinism_note
 * for the production incident this caused). This workflow does no calendar
 * arithmetic at all — the AI already returns the month-end date — so all that's
 * needed is validating it's a real date via integer math, with `Date` never
 * referenced anywhere in this file.
 */
function toIsoDate(v: unknown): string | null {
  const s = firstString(v);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const [, y, mo, d] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(Number(y), month)) return null;
  return `${y}-${mo}-${d}`;
}

/** First item of a runAction result ({ data: [...] } or a bare array). */
function firstResult(res: any): any {
  if (!res) return null;
  if (Array.isArray(res)) return res[0] ?? null;
  if (Array.isArray(res.data)) return res.data[0] ?? null;
  return res.data ?? res;
}

/** Extract the Drive trigger's file fields. */
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

interface SessionLine {
  consultantName: string;
  sessionType: string;
  quantity: number;
}

/**
 * Parse the AI step's structured array output into clean, chargeable lines,
 * and separately collect every "Invoice Period" value seen (see
 * `resolveInvoicePeriod`). The classic Zap's own instruction — "exclude any
 * line items where the session quantity is either empty or 0" — is enforced
 * here again defensively, since `outputSchema` marks the field required but
 * cannot itself forbid zero.
 */
function parseSessionLines(rawItems: unknown): { lines: SessionLine[]; periodsSeen: string[] } {
  const lines: SessionLine[] = [];
  const periodsSeen: string[] = [];
  if (!Array.isArray(rawItems)) return { lines, periodsSeen };
  for (const row of rawItems) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const period = toIsoDate(r["Invoice Period"]);
    if (period) periodsSeen.push(period);

    const consultantName = firstString(r["Consultant Name"]);
    const sessionType = firstString(r["Session Type"]);
    const quantity = toNumber(r["Session Quantity"]);
    if (!consultantName || !sessionType || !quantity || quantity <= 0) continue;
    if (!(sessionType in ITEM_CODE_BY_SESSION_TYPE)) continue;
    lines.push({ consultantName, sessionType, quantity });
  }
  return { lines, periodsSeen };
}

/**
 * Every row on one screenshot reports the same reporting month, so this is
 * one value, not a per-line one — mirrors the classic Zap's Formatter
 * "Line-item to Text" step, which collapsed the AI's per-row Invoice Period
 * array down to a single string for the Xero invoice's `date` field.
 *
 * Takes the most-common value rather than assuming perfect agreement, and
 * logs when the AI didn't actually agree with itself — real disagreement here
 * means the extraction misread the screenshot, not that this code is wrong.
 */
function resolveInvoicePeriod(periodsSeen: string[]): { period: string | null; unanimous: boolean } {
  if (periodsSeen.length === 0) return { period: null, unanimous: false };
  const counts = new Map<string, number>();
  for (const p of periodsSeen) counts.set(p, (counts.get(p) ?? 0) + 1);
  const [period] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return { period, unanimous: counts.size === 1 };
}

/** Is this Drive file the CSV export rather than a screenshot? */
function isCsvFile(file: { title: string; mimeType: string }): boolean {
  return file.mimeType.includes("csv") || /\.csv$/i.test(file.title);
}

/**
 * RFC 4180 CSV: quoted fields may hold commas, newlines and doubled quotes
 * (Notion quotes multi-person cells like "Ernest Choo, Dennis"). Strips a
 * leading BOM, which Notion exports carry.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

const MONTH_BY_ABBREV: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * The END date of a Notion timeframe like "Sep 1 - 30 2026" (or a span
 * crossing a month, "Aug 31 - Sep 30 2026"), as YYYY-MM-DD. That end date is
 * the invoice period, same as the screenshot path's "last day of the month".
 */
export function timeframeEndDate(v: unknown): string | null {
  const s = firstString(v);
  if (!s) return null;
  const m =
    /([A-Za-z]{3})[a-z]*\.?\s+\d{1,2}\s*[-–]\s*(?:([A-Za-z]{3})[a-z]*\.?\s+)?(\d{1,2}),?\s+(\d{4})/.exec(s);
  if (!m) return null;
  const [, startMonth, endMonth, endDay, year] = m;
  const month = MONTH_BY_ABBREV[(endMonth ?? startMonth).toLowerCase()];
  if (!month) return null;
  return toIsoDate(`${year}-${String(month).padStart(2, "0")}-${endDay.padStart(2, "0")}`);
}

/**
 * "Ernest Choo (WF) (Sep 2026)" -> "Ernest Choo (WF)". Only the trailing
 * reporting-month suffix goes; "(WF)" is part of the name as it has always
 * appeared on these invoices.
 */
function stripPeriodSuffix(name: string): string {
  return name.replace(/\s*\([A-Za-z]{3,9}\.? \d{4}\)\s*$/, "").trim();
}

/**
 * Parse the CSV export into the same SessionLine shape the screenshot path
 * produces. Deterministic, so unlike the AI path any surprise THROWS: a
 * missing column, a non-zero value in a column with no item code, or rows
 * reporting different periods. `fallbackPeriodSource` is the file name
 * (Notion names the export after the timeframe), used only when a row's
 * TIMEFRAME cell is blank.
 */
export function parseSetupSessionCsv(
  text: string,
  fallbackPeriodSource: string,
): { lines: SessionLine[]; periodsSeen: string[]; totalPayout: number } {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Error("CSV is empty");
  const col = new Map(header.map((h, i) => [h.trim(), i]));
  const required = [
    CSV_NAME_COLUMN,
    CSV_TIMEFRAME_COLUMN,
    ...Object.keys(SESSION_TYPE_BY_CSV_COLUMN),
    ...UNMAPPED_CSV_COLUMNS,
  ];
  const missing = required.filter((h) => !col.has(h));
  if (missing.length > 0) {
    throw new Error(`CSV is missing expected column(s): ${missing.join(", ")} — has the Notion export changed?`);
  }
  const cell = (r: string[], h: string) => (r[col.get(h)!] ?? "").trim();
  const fallbackPeriod = timeframeEndDate(fallbackPeriodSource);

  const lines: SessionLine[] = [];
  const periodsSeen: string[] = [];
  let totalPayout = 0;
  for (const r of rows) {
    const consultantName = stripPeriodSuffix(cell(r, CSV_NAME_COLUMN));
    if (!consultantName) continue;

    const period = timeframeEndDate(cell(r, CSV_TIMEFRAME_COLUMN)) ?? fallbackPeriod;
    if (!period) throw new Error(`CSV row "${consultantName}": unreadable TIMEFRAME "${cell(r, CSV_TIMEFRAME_COLUMN)}"`);
    periodsSeen.push(period);

    for (const h of UNMAPPED_CSV_COLUMNS) {
      const n = toNumber(cell(r, h));
      if (n) {
        throw new Error(
          `CSV row "${consultantName}" has ${h} = ${cell(r, h)}, which has no Xero item code — invoice this month by hand, or add the item code`,
        );
      }
    }

    for (const [h, sessionType] of Object.entries(SESSION_TYPE_BY_CSV_COLUMN)) {
      const raw = cell(r, h);
      const quantity = toNumber(raw);
      if (raw !== "" && quantity === null) throw new Error(`CSV row "${consultantName}": ${h} is not a number ("${raw}")`);
      if (quantity && quantity > 0) lines.push({ consultantName, sessionType, quantity });
    }

    if (col.has(CSV_TOTAL_COLUMN)) totalPayout += toNumber(cell(r, CSV_TOTAL_COLUMN)) ?? 0;
  }
  return { lines, periodsSeen, totalPayout };
}

// --- Prompt --------------------------------------------------------------------
// Verbatim copy of drive-screenshot-to-xero-sales-invoice-prompt.md (repo rule 6).
// Edit the markdown, then run `node scripts/check-prompts.mjs --fix`.
const SETUP_SESSION_INVOICE_PROMPT = `Please carefully analyze the attached screenshot, which provides a comprehensive breakdown of sessions organized by consultant and session type. For each entry, create detailed line items that include the following information:

- Consultant Name: Clearly specify the name of the consultant linked to each session.
- Session Type: Identify and categorize the sessions into one of the following types: Calls Completed, No-Shows, Late Cancellations, Workspace Conversions, Referral Bonuses, and Seats Added.
- Session Quantity: State the total number of sessions for each category per consultant.
- Invoice Period: Indicate the last day of the month for which the provided screenshot is reporting.

Ensure that you exclude any line items where the session quantity is either empty or 0. Present the results in a clear and organized format.`;

const workflow = defineDurable<Record<string, unknown>, unknown>(
  "drive-screenshot-to-xero-sales-invoice",
  async (ctx, rawInput) => {
    const file = extractFile(InputSchema.parse(normalizeInput(rawInput)));
    if (!file) {
      console.log("skipping: no file in payload (empty/test delivery)");
      return { skipped: true, reason: "no file in payload" };
    }

    if (file.trashed) {
      console.log(`skipping ${file.title}: file is in the trash`);
      return { skipped: true, reason: "file is in the trash", file: file.title };
    }

    // Two accepted inputs: the Notion CSV export (parsed in code, no AI task)
    // or a screenshot (AI extraction). Anything else is skipped — the classic
    // Zap's "Image Only" filter, widened to CSVs. Plain code, no task cost.
    const source = isCsvFile(file) ? "csv" : file.mimeType.includes("image") ? "screenshot" : null;
    if (!source) {
      console.log(`skipping ${file.title}: not an image or CSV (${file.mimeType || "unknown"})`);
      return { skipped: true, reason: `not an image or CSV (${file.mimeType || "unknown"})`, file: file.title };
    }

    let lines: SessionLine[];
    let invoicePeriod: string;
    let unanimous: boolean;
    let csvTotalPayout: number | null = null;

    if (source === "csv") {
      const csvText = await ctx.step("download-csv", async () => {
        const res = await sdk.fetch(
          `${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`,
          { connection: DRIVE_CONNECTION },
        );
        if (!res.ok) throw new Error(`Drive download of ${file.title} failed (${res.status}): ${await res.text()}`);
        return res.text();
      });

      const parsed = parseSetupSessionCsv(csvText, file.title);
      if (parsed.lines.length === 0) {
        throw new Error(`CSV ${file.title} has no rows with a non-zero session count — check the export`);
      }
      const resolved = resolveInvoicePeriod(parsed.periodsSeen);
      // Unlike the AI path, a disagreement here isn't a misread — the export
      // really spans two periods, and one invoice date can't cover both.
      if (!resolved.period || !resolved.unanimous) {
        throw new Error(
          `CSV ${file.title} reports more than one period (${[...new Set(parsed.periodsSeen)].join(", ")}) — export one month at a time`,
        );
      }
      lines = parsed.lines;
      invoicePeriod = resolved.period;
      unanimous = true;
      csvTotalPayout = parsed.totalPayout;
    } else {
      const completion = await ctx.step("extract-line-items", async () =>
        sdk.runAction({
          appKey: AI_APP_KEY,
          actionType: "write",
          actionKey: "get_completion",
          inputs: {
            authentication_id: AI_AUTHENTICATION,
            model_id: AI_MODEL,
            isOutputArray: true,
            instructions: SETUP_SESSION_INVOICE_PROMPT,
            inputFields: { Screenshot: file.fileRef },
            inputFieldConfig_Screenshot_isImageUrl: true,
            outputSchema: {
              "Consultant Name": "The name of the consultant associated with each session entry",
              "Session Type":
                "The category of the session which can be Calls Completed, No-Shows, Late Cancellations, Workspace Conversions, Referral Bonuses, or Seats Added",
              "Session Quantity": "The total number of sessions for each type linked to the consultant",
              "Invoice Period": "The last day of the month for which the sessions are being reported",
            },
            "required_Consultant Name": true,
            "type_Consultant Name": "text",
            "required_Session Type": true,
            "type_Session Type": "category_single",
            "options_Session Type": SESSION_TYPES,
            "required_Session Quantity": true,
            "type_Session Quantity": "number",
            "required_Invoice Period": true,
            "type_Invoice Period": "date",
          },
        }),
      );

      const rawItems = firstResult(completion)?.result?.items ?? [];
      const parsed = parseSessionLines(rawItems);
      if (parsed.lines.length === 0) {
        throw new Error(`AI extraction returned no usable line items for ${file.title} — check the screenshot`);
      }

      const resolved = resolveInvoicePeriod(parsed.periodsSeen);
      if (!resolved.period) {
        throw new Error(`AI extraction returned no valid Invoice Period for ${file.title}`);
      }
      if (!resolved.unanimous) {
        console.log(
          `WARNING: ${file.title} — Invoice Period disagreed across line items (${[...new Set(parsed.periodsSeen)].join(", ")}); using the majority value ${resolved.period}`,
        );
      }
      lines = parsed.lines;
      invoicePeriod = resolved.period;
      unanimous = resolved.unanimous;
    }

    const xeroLineItems = lines.map((l) => ({
      line_item_code: ITEM_CODE_BY_SESSION_TYPE[l.sessionType],
      line_description: `${l.consultantName} - ${l.sessionType} (Month Ending ${invoicePeriod})`,
      line_quantity: l.quantity,
      line_account_code: XERO_LINE_ACCOUNT_CODE,
      line_tax_type: XERO_LINE_TAX_TYPE,
      line_items_type: XERO_LINE_ITEMS_TYPE,
    }));

    const invoice = await ctx.step("create-sales-invoice", async () =>
      sdk.runAction({
        appKey: XERO_APP_KEY,
        actionType: "write",
        actionKey: "new_sales_invoice",
        connection: XERO_CONNECTION,
        inputs: {
          organization: XERO_ORGANIZATION,
          contact_name: CONTACT_NAME,
          contact_address__type_of: "POBOX",
          status: INVOICE_STATUS,
          date: invoicePeriod,
          currency: XERO_CURRENCY,
          branding_theme: XERO_BRANDING_THEME,
          reference: INVOICE_REFERENCE,
          sent_to_contact: false,
          line_items: xeroLineItems,
        },
      }),
    );

    const created = firstResult(invoice);
    // The CSV keeps its extension so it isn't mistaken for the screenshot.
    const newName = `${invoicePeriod} Notion Setup Sessions${source === "csv" ? ".csv" : ""}`;
    await ctx.step("rename-screenshot", async () =>
      sdk.runAction({
        appKey: DRIVE_APP_KEY,
        actionType: "write",
        actionKey: "update_file_name",
        connection: DRIVE_CONNECTION,
        // `file` here is the plain Drive file ID, NOT the AI step's hydrate
        // token (file.fileRef) — passing the hydrate token 404s, confirmed
        // live. drive-invoice-to-xero's rename step uses the same file.id.
        inputs: { file: file.id, new_name: newName, rename_folder: "false" },
      }),
    );

    console.log(
      `created draft sales invoice for ${CONTACT_NAME} from ${source}: ${xeroLineItems.length} line(s), period ${invoicePeriod}, renamed to "${newName}"` +
        (csvTotalPayout !== null ? `; CSV Total Payout US$${csvTotalPayout} — should equal the invoice total` : ""),
    );
    return {
      source,
      invoiceId: firstString(created?.InvoiceID, created?.invoice_id, created?.id),
      invoicePeriod,
      lineItemCount: xeroLineItems.length,
      periodUnanimous: unanimous,
      renamedTo: newName,
      ...(csvTotalPayout !== null ? { csvTotalPayout } : {}),
    };
  },
);

export default workflow;
