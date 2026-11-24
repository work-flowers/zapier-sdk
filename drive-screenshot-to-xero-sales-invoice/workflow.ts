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
const XERO_API = "https://api.xero.com/api.xro/2.0";

// --- Consultant bills (TKT-1075) ----------------------------------------------
// The same run that drafts the Notion Labs invoice drafts one Xero BILL per
// consultant for their share, so the payable lands in the month the sessions
// happened and the consultant no longer has to invoice us.

const GMAIL_APP_KEY = "GoogleMailV2CLIAPI";
const GMAIL_CONNECTION = "gmail_wf";

/** Gmail label "Send to Notion" on dennis@work.flowers, applied to each payout draft. */
const GMAIL_SEND_TO_NOTION_LABEL = "Label_10";

/** "Subcontractors" expense account, as on every past consultant bill (e.g. NIT-19). */
const BILL_ACCOUNT_CODE = "490";

/** Bills are drafts: Dennis reviews them alongside the invoice. Payment stays manual. */
const BILL_STATUS = "draft";

interface Consultant {
  /** Exact Xero contact name — `new_bill` binds by name, there is no contact id input. */
  xeroContactName: string;
  /** Checked against the created bill, so a by-name miss that forks a new contact fails loudly. */
  xeroContactId: string;
  /** workFlowers' share of the gross, in whole percent. */
  platformFeePercent: number;
  email: string;
  /** Upper-case surname for the bill number SS-YYYY-MM-{SURNAME}. */
  billSurname: string;
}

/**
 * Keyed by the consultant name as it appears after stripPeriodSuffix, lower-cased.
 * A consultant with billable lines who is neither here nor in BILL_EXEMPT fails the
 * run after the invoice and the other bills are created, so nobody goes unpaid quietly.
 */
const CONSULTANTS: Record<string, Consultant> = {
  "nasri nasir": {
    xeroContactName: "Nasri Nasir",
    xeroContactId: "e2e623af-408b-4d11-941b-a015ef031f0e",
    platformFeePercent: 10,
    email: "nasri@work.flowers",
    billSurname: "NASIR",
  },
};

/** Rows that never get a bill: Dennis is the PartnerStack payee, so no bill to himself. */
const BILL_EXEMPT = new Set(["dennis chiuten"]);

/** Bill line wording per session type, mirroring the consultant's past invoices. */
const BILL_LINE_LABEL_BY_SESSION_TYPE: Record<string, string> = {
  "Calls Completed": "Notion Setup Sessions — Completed",
  "No-Shows": "Notion Setup Sessions — No-shows",
  "Late Cancellations": "Notion Setup Sessions — Late cancellations",
  "Workspace Conversions": "Bonuses — Workspace conversions",
  "Seats Added": "Bonuses — Seat bonuses",
  "Referral Bonuses": "Bonuses — Referral bonuses",
};

const MONTH_ABBREV = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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
): {
  lines: SessionLine[];
  periodsSeen: string[];
  totalPayout: number;
  /** Total Payout per consultant (consultantKey), in cents. Absent when the column is. */
  payoutCentsByConsultant: Record<string, number>;
} {
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
  const payoutCentsByConsultant: Record<string, number> = {};
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

    if (col.has(CSV_TOTAL_COLUMN)) {
      const payout = toNumber(cell(r, CSV_TOTAL_COLUMN)) ?? 0;
      totalPayout += payout;
      const key = consultantKey(consultantName);
      payoutCentsByConsultant[key] = (payoutCentsByConsultant[key] ?? 0) + Math.round(payout * 100);
    }
  }
  return { lines, periodsSeen, totalPayout, payoutCentsByConsultant };
}

// --- Consultant bill helpers -----------------------------------------------------

/** Lower-cased, whitespace-collapsed consultant name, period suffix removed. */
export function consultantKey(name: string): string {
  return stripPeriodSuffix(name).replace(/\s+/g, " ").trim().toLowerCase();
}

/** The sales-invoice line description; also the key that ties a priced line back to its session. */
function invoiceLineDescription(l: SessionLine, invoicePeriod: string): string {
  return `${l.consultantName} - ${l.sessionType} (Month Ending ${invoicePeriod})`;
}

/** "2026-10-31" -> "Oct 2026". */
export function monthLabel(isoDate: string): string {
  const [y, m] = isoDate.split("-").map(Number);
  return `${MONTH_ABBREV[m - 1]} ${y}`;
}

/** Last day of the month after `isoDate`'s month, by integer maths (no `Date` — see toIsoDate). */
export function lastDayOfNextMonth(isoDate: string): string {
  let [y, m] = isoDate.split("-").map(Number);
  m += 1;
  if (m > 12) {
    m = 1;
    y += 1;
  }
  return `${y}-${String(m).padStart(2, "0")}-${String(daysInMonth(y, m)).padStart(2, "0")}`;
}

/** "SS-2026-10-NASIR". */
export function billNumber(invoicePeriod: string, c: Consultant): string {
  return `SS-${invoicePeriod.slice(0, 7)}-${c.billSurname}`;
}

/** 90000 -> "US$900.00", -9000 -> "-US$90.00", 106050 -> "US$1,060.50". */
export function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}US$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * description -> unit price in cents, from a Xero invoice. Accepts both shapes
 * seen here: the Zapier action's `LineItems.LineItem` (an array, or one object
 * when there is a single line) and the raw API's `LineItems` array.
 */
export function unitCentsByDescription(invoice: any): Map<string, number> {
  const raw = invoice?.LineItems;
  const items: any[] = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.LineItem)
      ? raw.LineItem
      : raw?.LineItem
        ? [raw.LineItem]
        : [];
  const out = new Map<string, number>();
  for (const li of items) {
    const desc = firstString(li?.Description);
    const unit = toNumber(li?.UnitAmount);
    if (desc && unit !== null) out.set(desc, Math.round(unit * 100));
  }
  return out;
}

interface BillLine {
  sessionType: string;
  label: string;
  quantity: number;
  unitCents: number;
  amountCents: number;
}

interface ConsultantBill {
  key: string;
  consultantName: string;
  consultant: Consultant;
  number: string;
  lines: BillLine[];
  grossCents: number;
  feeCents: number;
  netCents: number;
}

/** Sessions × rate grouped by consultant, in first-seen order. */
export function groupPricedLines(
  lines: SessionLine[],
  invoicePeriod: string,
  unitCents: Map<string, number>,
): { key: string; consultantName: string; lines: BillLine[]; grossCents: number; unpriced: string[] }[] {
  const groups = new Map<
    string,
    { key: string; consultantName: string; lines: BillLine[]; grossCents: number; unpriced: string[] }
  >();
  for (const l of lines) {
    const key = consultantKey(l.consultantName);
    let g = groups.get(key);
    if (!g) {
      g = { key, consultantName: stripPeriodSuffix(l.consultantName), lines: [], grossCents: 0, unpriced: [] };
      groups.set(key, g);
    }
    const desc = invoiceLineDescription(l, invoicePeriod);
    const unit = unitCents.get(desc);
    if (unit === undefined) {
      g.unpriced.push(desc);
      continue;
    }
    const amountCents = Math.round(l.quantity * unit);
    g.lines.push({
      sessionType: l.sessionType,
      label: BILL_LINE_LABEL_BY_SESSION_TYPE[l.sessionType] ?? l.sessionType,
      quantity: l.quantity,
      unitCents: unit,
      amountCents,
    });
    g.grossCents += amountCents;
  }
  return [...groups.values()];
}

/** Platform fee rounded to the cent; net is what the consultant is paid. */
export function feeSplit(grossCents: number, feePercent: number): { feeCents: number; netCents: number } {
  const feeCents = Math.round((grossCents * feePercent) / 100);
  return { feeCents, netCents: grossCents - feeCents };
}

/** Escape text for the HTML email body. Labels and names come from code and the CSV. */
function escapeHtml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Payout email, as HTML: a padded plain-text table doesn't survive Gmail
 * (proportional font, and the first live test came back with its spacing
 * collapsed). Draft only; Dennis sends it.
 */
export function payoutEmail(bill: ConsultantBill, period: string): { subject: string; body: string } {
  const month = monthLabel(period);
  const firstName = escapeHtml(bill.consultantName.split(" ")[0]);
  const cell = "padding:4px 12px;border-bottom:1px solid #e5e5e5";
  const num = `${cell};text-align:right;white-space:nowrap`;
  const row = (cells: string[], bold = false) =>
    `<tr${bold ? ' style="font-weight:bold"' : ""}>` +
    cells.map((c, i) => `<td style="${i === 0 ? cell : num}">${escapeHtml(c)}</td>`).join("") +
    "</tr>";
  const table =
    '<table style="border-collapse:collapse;font-size:14px">' +
    `<tr>${["Item", "Qty", "Rate", "Amount"].map((h, i) => `<th style="${i === 0 ? `${cell};text-align:left` : num}">${h}</th>`).join("")}</tr>` +
    bill.lines.map((l) => row([l.label, String(l.quantity), formatUsd(l.unitCents), formatUsd(l.amountCents)])).join("") +
    row(["Gross", "", "", formatUsd(bill.grossCents)]) +
    row([`Platform fee (${bill.consultant.platformFeePercent}%)`, "", "", formatUsd(-bill.feeCents)]) +
    row(["Net payout", "", "", formatUsd(bill.netCents)], true) +
    "</table>";
  return {
    subject: `Notion Setup Sessions payout — ${month}`,
    body:
      `<p>Hi ${firstName},</p>` +
      `<p>Here's your Notion Setup Sessions payout for ${month}, taken from Notion's payouts report:</p>` +
      table +
      `<p>This replaces your monthly invoice for setup sessions, so there's no need to send one. ` +
      `We've recorded it on our side as ${escapeHtml(bill.number)}, and it's paid once Notion's PartnerStack payout for ${month} lands.</p>` +
      `<p>Thanks,<br>Dennis</p>`,
  };
}

/** Bills Xero already holds under this number, ignoring deleted and voided ones. */
function liveBills(body: any): { id: string; status: string }[] {
  const rows: any[] = Array.isArray(body?.Invoices) ? body.Invoices : [];
  return rows
    .map((b) => ({ id: firstString(b?.InvoiceID) ?? "", status: (firstString(b?.Status) ?? "").toUpperCase() }))
    .filter((b) => b.id && b.status !== "DELETED" && b.status !== "VOIDED");
}

/** Body of a `_zap_raw_request` result, parsed. */
function rawBody(res: any): any {
  const body = firstResult(res)?.response?.body;
  if (typeof body !== "string") return body ?? {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

interface BillOutcome {
  consultant: string;
  billNumber: string;
  outcome: "draft-bill-created" | "existing-bill-skipped";
  billId: string | null;
  grossUsd: number;
  feeUsd: number;
  netUsd: number;
  emailDraftId: string | null;
  /** Set when the bill landed on a contact other than the configured one. */
  contactMismatch?: string;
}

/**
 * Find-or-create one consultant's draft bill, then draft their payout email.
 * Takes `ctx` so its step ids can carry the consultant (the publish-time
 * analyzer only allows string-literal ids in the workflow body itself).
 */
async function raiseConsultantBill(ctx: any, bill: ConsultantBill, period: string): Promise<BillOutcome> {
  const slug = bill.consultant.billSurname.toLowerCase();
  const month = monthLabel(period);
  const base = {
    consultant: bill.consultantName,
    billNumber: bill.number,
    grossUsd: bill.grossCents / 100,
    feeUsd: bill.feeCents / 100,
    netUsd: bill.netCents / 100,
  };

  // Re-uploading a month (a CSV after a screenshot, or a replay) must not
  // raise a second bill. Skipping also skips the email, which went out with
  // the first bill.
  const existing = liveBills(
    rawBody(
      await ctx.step(`find-bill-${slug}`, async () =>
        sdk.runAction({
          appKey: XERO_APP_KEY,
          actionType: "write",
          actionKey: "_zap_raw_request",
          connection: XERO_CONNECTION,
          inputs: {
            method: "GET",
            url: `${XERO_API}/Invoices`,
            fail_on_errors: true,
            headers: { "Xero-Tenant-Id": XERO_ORGANIZATION, Accept: "application/json" },
            querystring: { where: `Type=="ACCPAY" AND InvoiceNumber=="${bill.number}"` },
          },
        }),
      ),
    ),
  );
  if (existing.length > 0) {
    console.log(`bill ${bill.number} already exists (${existing[0].status}); not raising another or emailing again`);
    return { ...base, outcome: "existing-bill-skipped", billId: existing[0].id, emailDraftId: null };
  }

  const created = firstResult(
    await ctx.step(`create-bill-${slug}`, async () =>
      sdk.runAction({
        appKey: XERO_APP_KEY,
        actionType: "write",
        actionKey: "new_bill",
        connection: XERO_CONNECTION,
        inputs: {
          organization: XERO_ORGANIZATION,
          contact_name: bill.consultant.xeroContactName,
          status: BILL_STATUS,
          date: period,
          due_date: lastDayOfNextMonth(period),
          currency: XERO_CURRENCY,
          number: bill.number,
          line_items_type: XERO_LINE_ITEMS_TYPE,
          // Spread, deliberately: the publish-time analyzer reads line_items'
          // children as flat required fields and refuses ("leaves required input
          // 'Quantity' unset") even though every entry sets line_quantity and
          // the action takes the array (verified live). A spread in `inputs`
          // makes it skip that check, as in expense-claim-to-xero-bill.
          ...{ line_items: [
            ...bill.lines.map((l) => ({
              line_description: `${l.label} (${month})`,
              line_quantity: l.quantity,
              line_unit_amount: l.unitCents / 100,
              line_account_code: BILL_ACCOUNT_CODE,
              line_tax_type: XERO_LINE_TAX_TYPE,
              line_items_type: XERO_LINE_ITEMS_TYPE,
            })),
            {
              line_description: `Platform fee (${bill.consultant.platformFeePercent}%)`,
              line_quantity: 1,
              line_unit_amount: -bill.feeCents / 100,
              line_account_code: BILL_ACCOUNT_CODE,
              line_tax_type: XERO_LINE_TAX_TYPE,
              line_items_type: XERO_LINE_ITEMS_TYPE,
            },
          ] },
        },
      }),
    ),
  );
  const billId = firstString(created?.InvoiceID, created?.invoice_id, created?.id);
  const landedOn = firstString(created?.Contact?.ContactID);
  if (landedOn && landedOn !== bill.consultant.xeroContactId) {
    // `new_bill` matches the contact by name. A miss creates a new contact;
    // don't email off a bill on the wrong contact.
    return {
      ...base,
      outcome: "draft-bill-created",
      billId,
      emailDraftId: null,
      contactMismatch: `bill ${bill.number} landed on Xero contact ${landedOn} ("${firstString(created?.Contact?.Name)}"), not ${bill.consultant.xeroContactId} — move it to the right contact, delete the stray contact, and send the payout email by hand`,
    };
  }

  const email = payoutEmail(bill, period);
  const draft = firstResult(
    await ctx.step(`draft-email-${slug}`, async () =>
      sdk.runAction({
        appKey: GMAIL_APP_KEY,
        actionType: "write",
        actionKey: "draft_v2",
        connection: GMAIL_CONNECTION,
        inputs: {
          to: [bill.consultant.email],
          subject: email.subject,
          body: email.body,
          body_type: "html",
          label_ids: [GMAIL_SEND_TO_NOTION_LABEL],
        },
      }),
    ),
  );
  return {
    ...base,
    outcome: "draft-bill-created",
    billId,
    emailDraftId: firstString(draft?.id, draft?.message_id, draft?.threadId),
  };
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
    let csvPayoutCents: Record<string, number> | null = null;

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
      csvPayoutCents = parsed.payoutCentsByConsultant;
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
          // Spread, deliberately: the publish-time analyzer reads line_items'
          // children as flat required fields and refuses ("leaves required input
          // 'Quantity' unset") even though every entry sets line_quantity and
          // the action takes the array (verified live). A spread in `inputs`
          // makes it skip that check, as in expense-claim-to-xero-bill.
          ...{ line_items: lines.map((l) => ({
            line_item_code: ITEM_CODE_BY_SESSION_TYPE[l.sessionType],
            line_description: invoiceLineDescription(l, invoicePeriod),
            line_quantity: l.quantity,
            line_account_code: XERO_LINE_ACCOUNT_CODE,
            line_tax_type: XERO_LINE_TAX_TYPE,
            line_items_type: XERO_LINE_ITEMS_TYPE,
          })) },
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

    const invoiceId = firstString(created?.InvoiceID, created?.invoice_id, created?.id);
    console.log(
      `created draft sales invoice for ${CONTACT_NAME} from ${source}: ${lines.length} line(s), period ${invoicePeriod}, renamed to "${newName}"` +
        (csvTotalPayout !== null ? `; CSV Total Payout US$${csvTotalPayout} — should equal the invoice total` : ""),
    );

    // --- Consultant bills ------------------------------------------------------
    // Priced from the invoice Xero just created, so Xero's items stay the only
    // rate card and CSV and screenshot runs price identically. The create
    // response carries the resolved UnitAmount per line; read the invoice back
    // only if it didn't.
    let unitCents = unitCentsByDescription(created);
    const priced = (m: Map<string, number>) =>
      lines.every((l) => m.has(invoiceLineDescription(l, invoicePeriod)));
    if (!priced(unitCents)) {
      if (!invoiceId) throw new Error(`Xero returned no InvoiceID for the ${invoicePeriod} invoice, so the consultant bills can't be priced`);
      const reread = await ctx.step("read-sales-invoice", async () =>
        sdk.runAction({
          appKey: XERO_APP_KEY,
          actionType: "write",
          actionKey: "_zap_raw_request",
          connection: XERO_CONNECTION,
          inputs: {
            method: "GET",
            url: `${XERO_API}/Invoices/${invoiceId}`,
            fail_on_errors: true,
            headers: { "Xero-Tenant-Id": XERO_ORGANIZATION, Accept: "application/json" },
          },
        }),
      );
      const body = rawBody(reread);
      unitCents = unitCentsByDescription(Array.isArray(body?.Invoices) ? body.Invoices[0] : null);
    }

    const groups = groupPricedLines(lines, invoicePeriod, unitCents);
    const unpriced = groups.flatMap((g) => (BILL_EXEMPT.has(g.key) ? [] : g.unpriced));
    if (unpriced.length > 0) {
      throw new Error(`invoice ${invoiceId} has no unit price for: ${unpriced.join("; ")} — consultant bills not raised`);
    }

    // A mismatch means Notion's payout rates and Xero's item prices have
    // drifted apart. Checked for everyone before any bill is raised.
    if (csvPayoutCents) {
      const drift = groups
        .filter((g) => (csvPayoutCents![g.key] ?? 0) !== g.grossCents)
        .map((g) => `${g.consultantName}: invoice prices give ${formatUsd(g.grossCents)}, CSV Total Payout is ${formatUsd(csvPayoutCents![g.key] ?? 0)}`);
      if (drift.length > 0) {
        throw new Error(
          `Xero item prices and Notion's payout rates disagree (${drift.join("; ")}). The invoice was created; no consultant bills were raised. Fix the rates, then raise the bills by hand or replay.`,
        );
      }
    }

    const bills: BillOutcome[] = [];
    const unknown: string[] = [];
    for (const g of groups) {
      if (BILL_EXEMPT.has(g.key)) continue;
      const consultant = CONSULTANTS[g.key];
      if (!consultant) {
        unknown.push(`${g.consultantName} (${formatUsd(g.grossCents)})`);
        continue;
      }
      const { feeCents, netCents } = feeSplit(g.grossCents, consultant.platformFeePercent);
      const bill: ConsultantBill = {
        key: g.key,
        consultantName: g.consultantName,
        consultant,
        number: billNumber(invoicePeriod, consultant),
        lines: g.lines,
        grossCents: g.grossCents,
        feeCents,
        netCents,
      };
      const outcome = await raiseConsultantBill(ctx, bill, invoicePeriod);
      bills.push(outcome);
      console.log(
        `${outcome.outcome} ${outcome.billNumber} for ${outcome.consultant}: gross ${formatUsd(bill.grossCents)}, ` +
          `fee ${formatUsd(-bill.feeCents)}, net ${formatUsd(bill.netCents)}, bill ${outcome.billId ?? "?"}` +
          (outcome.emailDraftId ? `, email draft ${outcome.emailDraftId}` : ""),
      );
    }

    const result = {
      source,
      invoiceId,
      invoicePeriod,
      lineItemCount: lines.length,
      periodUnanimous: unanimous,
      renamedTo: newName,
      ...(csvTotalPayout !== null ? { csvTotalPayout } : {}),
      bills,
    };

    // Fail visibly, after everything else is done, rather than leave anyone unpaid.
    const problems = [
      ...bills.flatMap((b) => (b.contactMismatch ? [b.contactMismatch] : [])),
      ...(unknown.length > 0
        ? [`no bill raised for ${unknown.join(", ")}: not in CONSULTANTS in workflow.ts — add them, then raise the bill by hand or replay`]
        : []),
    ];
    if (problems.length > 0) {
      throw new Error(`Invoice ${invoiceId} and ${bills.length} bill(s) done (${JSON.stringify(bills)}), but: ${problems.join("; ")}`);
    }
    return result;
  },
);

export default workflow;
