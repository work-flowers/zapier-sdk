// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/drive-invoice-to-xero
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
// The Google Drive credential is needed in BOTH places: on the TRIGGER
// (publish --trigger authentication_id, which is what polls the folder) and as
// the `gdrive` alias here, because the code renames the file. AI by Zapier and
// Zapier Tables both run without a connection.
const DRIVE_APP_KEY = "GoogleDriveCLIAPI";
const DRIVE_CONNECTION = "gdrive";

const XERO_APP_KEY = "XeroCLIAPI";
const XERO_CONNECTION = "xero_wf";

const AI_APP_KEY = "AICLIAPI";

/** Xero organisation ("tenant") — work.flowers. Both the Zapier actions'
 *  `organization` input and the raw request's `Xero-Tenant-Id` header. */
const XERO_ORGANIZATION = "62699a8c-3351-40e8-9265-bdca5e037b03";
const XERO_API = "https://api.xero.com/api.xro/2.0";

/**
 * "Xero Bank Transactions" Zapier Table — a mirror of reconciled Xero bank
 * transactions kept up to date by a separate Zap. Table reads cost no tasks,
 * which is why the match runs against this rather than Xero's API.
 *
 * The coupling is real and worth knowing about: this workflow is only as
 * correct as that Zap is current. When it was accidentally paused, the Table
 * silently fell ~5 days behind and this match started missing payments that
 * existed in Xero — producing duplicate draft bills with no error anywhere.
 * `tableStale` in the output is the tripwire for that; see the README.
 */
const BANK_TXN_TABLE = "01KCDV6Y17F31J2Q6S1EMYZC8K";

// AI by Zapier on Zapier's built-in credentials ("0" = Included in Plan).
//
// TIER = TASK COST: `standard/auto` / `advanced/auto` / `premium/auto` bill at
// 1x / 3x / 5x tasks per run (those three sentinels are the only valid values).
// Standard was verified to read these invoice PDFs correctly — vendor, number,
// dates, currency, total, tax flag and the full line-item table — across the
// cases in the README's verified table. This step makes no tool calls, which is
// the main reason Zapier's own default is Advanced. Re-run those cases before
// changing this.
const AI_MODEL = "standard/auto";
const AI_AUTHENTICATION = "0";

/**
 * Xero tax types for a bill line, Singapore chart of accounts.
 * `INPUTY24` is "Standard-Rated Purchases"; carried over from the classic Zap.
 */
const TAX_TYPE_STANDARD = "INPUTY24";
const TAX_TYPE_NONE = "NONE";

/** Bills are created for review, never posted automatically. */
const BILL_STATUS = "draft";

/**
 * How far from the invoice date (or its due date) a bank transaction may sit
 * and still be considered the same payment. Wide enough to catch a card charge
 * that clears a few days either side; safe at this width only because an exact
 * amount + currency match is also required.
 */
const MATCH_WINDOW_DAYS = 7;

/** Amounts are compared to the cent. */
const AMOUNT_EPSILON = 0.005;

/**
 * A bill whose line items sum to within this of the invoice's own total is
 * trusted; anything further out falls back to a single line for the total, so
 * the draft bill always adds up to what the invoice actually says.
 */
const RECONCILE_EPSILON = 0.02;

/**
 * Plausible tax multiplier when line amounts are tax-exclusive. Used only to
 * sanity-check that a subtotal + tax could produce the stated total, without
 * hardcoding a jurisdiction's rate.
 */
const MAX_TAX_MULTIPLIER = 1.3;

/** Legal-entity suffixes stripped before comparing vendor names. Order matters
 *  only in that longer forms are tried first; see `normalizeVendor`. */
const VENDOR_SUFFIXES = [
  "pte ltd",
  "pty ltd",
  "private limited",
  "incorporated",
  "corporation",
  "company",
  "limited",
  "gmbh",
  "s a r l",
  "sarl",
  "b v",
  "bv",
  "n v",
  "nv",
  "s a",
  "sa",
  "ag",
  "plc",
  "llp",
  "llc",
  "lp",
  "ltd",
  "inc",
  "corp",
  "co",
  "pbc",
];

/** A normalised vendor name shorter than this is too generic to match on. */
const MIN_VENDOR_TOKEN_LENGTH = 3;

/**
 * Contacts pulled per page when resolving a vendor. The org holds 130 today, so
 * one page covers it. Xero refuses `where=IsSupplier==true` here outright
 * ("Due to the high number of contacts being processed, this filter cannot be
 * used"), which is why the whole list comes back and the filtering happens in
 * code. If this ever paginates, `contactsTruncated` suppresses contact creation
 * rather than risk a duplicate — see the design note.
 */
const CONTACT_PAGE_SIZE = 200;

// The Google Drive "New File in Folder" trigger delivers a file object.
// Accept anything and extract defensively.
const InputSchema = z.unknown();

// --- Pure helpers ----------------------------------------------------------

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

/** First item of a runAction result ({ data: [...] } or a bare array). */
function firstResult(res: any): any {
  if (!res) return null;
  if (Array.isArray(res)) return res[0] ?? null;
  if (Array.isArray(res.data)) return res.data[0] ?? null;
  return res.data ?? res;
}

/** A Zapier Table `labeled_string` cell is `{ value, label }`. */
function labeledValue(cell: unknown): string | null {
  if (cell && typeof cell === "object" && "value" in (cell as any)) {
    return firstString((cell as any).value);
  }
  return firstString(cell);
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

// --- Dates, without touching `Date` ----------------------------------------
//
// The durable runtime runs the workflow body in GUARDED mode and throws
// `DeterminismViolation: Non-deterministic API "new Date()" called` from the
// Date constructor's Proxy. That trap asserts *before* it inspects its
// arguments, so it rejects every construction — including `new Date(ms)` and
// `new Date(Date.UTC(y, m, d))`, which are perfectly deterministic. Reading
// the clock is the thing that actually breaks replay, and that genuinely
// belongs in a step (see the `today` step below); calendar arithmetic does
// not, and paying a task for it would be absurd.
//
// So the date maths here is done in integers and `Date` is not referenced
// anywhere in this file. `Date.UTC` happens to be unguarded today — the
// Proxy's `get` trap only special-cases `now` — but relying on that is how
// this comes back, so it is gone too.
//
// `daysFromCivil` / `isoDateFromEpochMs` are Hinnant's civil-from-days pair,
// as already used in `xero-overdue-invoice-to-gmail-reminder`.

/** Days in a month, proleptic Gregorian. */
function daysInMonth(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Days since the Unix epoch for a `YYYY-MM-DD` triple. */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** `YYYY-MM-DD` from epoch milliseconds. */
function isoDateFromEpochMs(ms: number): string {
  let z = Math.floor(ms / 86400000) + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` from an ISO-ish date string, or null.
 *
 *  Now genuinely rejects an impossible date. The previous version checked
 *  `new Date(Date.UTC(...))` for NaN, which never fired: `Date.UTC` normalises
 *  overflow rather than failing, so `2026-13-05` rolled into 2027 and the
 *  original string was handed back and passed on to Xero as a bill date. An
 *  out-of-range month or day now falls through to the caller's fallback. */
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

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return daysFromCivil(y, m, d);
}

function shiftIsoDate(iso: string, days: number): string {
  return isoDateFromEpochMs((dayNumber(iso) + days) * 86400000);
}

/**
 * Lowercase, strip punctuation, then peel legal-entity suffixes off the end.
 * `Aspire FT Pte. Ltd.` and `Aspire FT` both become `aspire ft`, which is the
 * whole reason the classic Zap needed an AI agent for this comparison.
 */
function normalizeVendor(name: unknown): string {
  let s = (firstString(name) ?? "").toLowerCase();
  s = s.replace(/&/g, " and ");
  s = s.replace(/[^a-z0-9]+/g, " ").trim();
  // Peel repeatedly: "Foo Pte. Ltd." leaves "foo pte ltd" -> "foo pte" -> "foo".
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const suffix of VENDOR_SUFFIXES) {
      if (s === suffix) continue;
      if (s.endsWith(` ${suffix}`)) {
        s = s.slice(0, -(suffix.length + 1)).trim();
        changed = true;
      }
    }
    if (!changed) break;
  }
  return s.replace(/\s+/g, " ").trim();
}

/** Do two normalised vendor names refer to the same counterparty? */
function vendorMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  // Containment covers "wise" vs "wise asia pacific". Guard against a token so
  // short it would match half the ledger.
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < MIN_VENDOR_TOKEN_LENGTH) return false;
  return longer.startsWith(`${shorter} `) || longer === shorter;
}

interface InvoiceHeader {
  vendor: string;
  invoiceNumber: string | null;
  invoiceDate: string;
  dueDate: string;
  currency: string;
  total: number | null;
  taxApplied: boolean;
  lineBasis: "Inclusive" | "Exclusive" | "NoTax";
  vendorEmail: string | null;
}

interface LineItem {
  description: string;
  quantity: number;
  unitPrice: number;
}

interface Candidate {
  bankTransactionId: string;
  contactName: string;
  date: string;
  currency: string;
  total: number;
  lagDays: number;
}

// --- Vendor contacts -------------------------------------------------------
//
// See vendor-contact-design.md for the evidence behind all of this. The short
// version: `new_bill` binds a bill to a contact by NAME and creates a bare one
// when nothing matches exactly, which is how the ledger ended up with
// "Aspire FT" alongside "Aspire FT Pte. Ltd." (and three more pairs). Xero's
// own `searchTerm` is an unranked substring match — it returns both
// "Olar Software, Inc." and "Polar Software, Inc." for `olar` — so the whole
// contact list is fetched once and matched here with `normalizeVendor` /
// `vendorMatches`, the same pair already used against bank transactions.

/** Vendor contact details read off the invoice. Every one is optional. */
interface VendorDetails {
  email: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  phone: string | null;
  taxNumber: string | null;
  bankAccount: string | null;
  bankName: string | null;
  bankSwift: string | null;
}

interface ContactSummary {
  contactId: string;
  name: string;
  normalized: string;
  email: string | null;
}

type ContactResolution =
  | { tier: "matched"; contact: ContactSummary; via: "exact" | "email-corroborated" }
  | { tier: "ambiguous"; candidates: ContactSummary[] }
  | { tier: "unmatched"; nearMisses: ContactSummary[] };

function extractVendorDetails(raw: Record<string, unknown>): VendorDetails {
  return {
    email: firstString(raw["Vendor Email Address"]),
    addressLine1: firstString(raw["Vendor Address Line 1"]),
    addressLine2: firstString(raw["Vendor Address Line 2"]),
    city: firstString(raw["Vendor City"]),
    region: firstString(raw["Vendor State/Region"]),
    postalCode: firstString(raw["Vendor Postal Code"]),
    country: firstString(raw["Vendor Country"]),
    phone: firstString(raw["Vendor Phone"]),
    taxNumber: firstString(raw["Vendor Tax Number"]),
    bankAccount: firstString(raw["Vendor Bank Account Number"]),
    bankName: firstString(raw["Vendor Bank Name"]),
    bankSwift: firstString(raw["Vendor Bank SWIFT/BIC"]),
  };
}

/** Is there anything here worth writing to a contact record? */
function hasVendorDetails(d: VendorDetails): boolean {
  return Object.values(d).some((v) => v != null);
}

function emailDomain(email: unknown): string | null {
  const s = firstString(email);
  if (!s) return null;
  const at = s.lastIndexOf("@");
  if (at < 1 || at === s.length - 1) return null;
  return s.slice(at + 1).toLowerCase();
}

/** Account numbers are compared ignoring spaces, dashes and case. */
function normalizeAccountNumber(v: unknown): string | null {
  const s = firstString(v);
  if (!s) return null;
  const cleaned = s.replace(/[^a-z0-9]/gi, "").toUpperCase();
  return cleaned === "" ? null : cleaned;
}

/** Contacts out of a raw `GET /Contacts` response body. */
function parseContactSummaries(body: unknown): ContactSummary[] {
  const rows = (body as any)?.Contacts;
  if (!Array.isArray(rows)) return [];
  const out: ContactSummary[] = [];
  for (const row of rows) {
    const contactId = firstString(row?.ContactID);
    const name = firstString(row?.Name);
    if (!contactId || !name) continue;
    // An ARCHIVED contact still blocks a same-name create in Xero, so it has to
    // stay in the candidate set rather than being filtered out here.
    out.push({ contactId, name, normalized: normalizeVendor(name), email: firstString(row?.EmailAddress) });
  }
  return out;
}

/**
 * Which Xero contact is this vendor?
 *
 * Exact (normalised) match wins. Several of them is an ambiguity the workflow
 * refuses to guess at. Containment — "Wise" against "Wise Asia-Pacific Pte
 * Ltd." — only binds when the vendor's email domain agrees, because unlike the
 * bank-transaction match there is no amount or date here to corroborate it:
 * the same rule would otherwise merge "LinkedIn" with "LinkedIn Ads" and
 * "PayPal" with "PAYPAL *FACEBOOK 35314369001 IE".
 */
function resolveContact(
  vendorName: string,
  vendorEmail: string | null,
  contacts: ContactSummary[],
): ContactResolution {
  const key = normalizeVendor(vendorName);
  const exact = contacts.filter((c) => c.normalized === key);
  if (exact.length === 1) return { tier: "matched", contact: exact[0], via: "exact" };
  if (exact.length > 1) return { tier: "ambiguous", candidates: exact };

  const nearMisses = contacts.filter((c) => vendorMatches(key, c.normalized));
  if (nearMisses.length === 0) return { tier: "unmatched", nearMisses: [] };

  const domain = emailDomain(vendorEmail);
  if (domain) {
    const corroborated = nearMisses.filter((c) => emailDomain(c.email) === domain);
    if (corroborated.length === 1) {
      return { tier: "matched", contact: corroborated[0], via: "email-corroborated" };
    }
  }
  return { tier: "unmatched", nearMisses };
}

interface ContactWrite {
  /** Body for `POST /Contacts` — a create when there is no `ContactID`. */
  payload: Record<string, unknown>;
  /** Field groups this write actually adds, for the log line. */
  filled: string[];
  /** Set when the invoice's bank account disagrees with the stored one. */
  bankConflict: { stored: string; invoice: string } | null;
}

/**
 * Build the `POST /Contacts` body, filling only fields that are currently
 * empty. `filled` is empty when there is nothing to add, and the caller then
 * skips the write — a bare create is exactly what `new_bill` would have done
 * anyway, so it isn't worth a task. `bankConflict` is reported either way: a
 * contact whose only news is a changed bank account is precisely the case the
 * tripwire exists for.
 *
 * Existing values are re-sent alongside the new ones rather than omitted. Xero's
 * merge semantics for absent elements aren't verified (notably whether posting
 * one address type clears the other), and read-modify-write makes the answer
 * irrelevant.
 *
 * The raw endpoint is used in preference to Zapier's `contact` action because
 * that action can only express a SINGLE address, so preserving a contact that
 * has both a STREET and a POBOX address is impossible through it.
 */
function buildContactWrite(name: string, details: VendorDetails, existing: any | null): ContactWrite {
  const filled: string[] = [];
  const contact: Record<string, unknown> = {};
  const existingId = firstString(existing?.ContactID);
  if (existingId) contact.ContactID = existingId;
  contact.Name = firstString(existing?.Name) ?? name;

  const storedEmail = firstString(existing?.EmailAddress);
  if (storedEmail) contact.EmailAddress = storedEmail;
  else if (details.email) {
    contact.EmailAddress = details.email;
    filled.push("email");
  }

  const storedTax = firstString(existing?.TaxNumber);
  if (storedTax) contact.TaxNumber = storedTax;
  else if (details.taxNumber) {
    contact.TaxNumber = details.taxNumber;
    filled.push("tax number");
  }

  // Bank details are write-once. An emailed invoice is the classic
  // invoice-redirection vector, and a contact's account number outlives the
  // bill, so a stored value is never overwritten — a disagreement is reported.
  let bankConflict: ContactWrite["bankConflict"] = null;
  const storedBank = firstString(existing?.BankAccountDetails);
  if (storedBank) {
    contact.BankAccountDetails = storedBank;
    if (details.bankAccount && normalizeAccountNumber(storedBank) !== normalizeAccountNumber(details.bankAccount)) {
      bankConflict = { stored: storedBank, invoice: details.bankAccount };
    }
  } else if (details.bankAccount) {
    contact.BankAccountDetails = details.bankAccount;
    filled.push("bank account");
  }

  const addresses: any[] = Array.isArray(existing?.Addresses) ? existing.Addresses.map((a: any) => ({ ...a })) : [];
  const addressPopulated = addresses.some(
    (a) => firstString(a?.AddressLine1, a?.AddressLine2, a?.City, a?.Region, a?.PostalCode, a?.Country) != null,
  );
  const newAddress: Record<string, string | null> = {
    AddressLine1: details.addressLine1,
    AddressLine2: details.addressLine2,
    City: details.city,
    Region: details.region,
    PostalCode: details.postalCode,
    Country: details.country,
  };
  if (!addressPopulated && Object.values(newAddress).some((v) => v != null)) {
    // POBOX is the contact's primary address in Xero's UI. Any STREET entry
    // already on the record is carried through untouched.
    let postal = addresses.find((a) => (firstString(a?.AddressType) ?? "").toUpperCase() === "POBOX");
    if (!postal) {
      postal = { AddressType: "POBOX" };
      addresses.push(postal);
    }
    for (const [key, value] of Object.entries(newAddress)) if (value != null) postal[key] = value;
    filled.push("address");
  }
  if (addresses.length > 0) contact.Addresses = addresses;

  const phones: any[] = Array.isArray(existing?.Phones) ? existing.Phones.map((p: any) => ({ ...p })) : [];
  if (!phones.some((p) => firstString(p?.PhoneNumber) != null) && details.phone) {
    let def = phones.find((p) => (firstString(p?.PhoneType) ?? "").toUpperCase() === "DEFAULT");
    if (!def) {
      def = { PhoneType: "DEFAULT" };
      phones.push(def);
    }
    def.PhoneNumber = details.phone;
    filled.push("phone");
  }
  if (phones.length > 0) contact.Phones = phones;

  return { payload: { Contacts: [contact] }, filled, bankConflict };
}

/** Parse the AI step's `Line Items` JSON string into clean, chargeable lines. */
function parseLineItems(raw: unknown): { items: LineItem[]; parseFailed: boolean; droppedZeroLines: number } {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    if (trimmed === "") return { items: [], parseFailed: false, droppedZeroLines: 0 };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { items: [], parseFailed: true, droppedZeroLines: 0 };
    }
  }
  if (!Array.isArray(parsed)) {
    return { items: [], parseFailed: parsed != null, droppedZeroLines: 0 };
  }

  const items: LineItem[] = [];
  let droppedZeroLines = 0;
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const description = firstString(r.description, r.Description) ?? "";
    const quantity = toNumber(r.quantity ?? r.Quantity) ?? 1;
    const unitPrice = toNumber(r.unitPrice ?? r.UnitPrice ?? r.unit_price) ?? 0;
    // A line worth nothing is noise in Xero — a 0-quantity row, or an
    // "included in your plan" row priced at zero. The PDF is attached to the
    // bill, so nothing is actually lost by leaving them off.
    if (Math.abs(quantity * unitPrice) < AMOUNT_EPSILON) {
      droppedZeroLines += 1;
      continue;
    }
    items.push({ description: description.replace(/\s+/g, " ").trim(), quantity, unitPrice });
  }
  return { items, parseFailed: false, droppedZeroLines };
}

/**
 * Do these line items add up to the invoice's own total?
 *
 * Tax-inclusive and no-tax lines must equal the total outright. Tax-exclusive
 * lines only have to be a plausible pre-tax subtotal, since the rate isn't
 * known here. Returns null when there is nothing to check against.
 */
function lineItemsReconcile(items: LineItem[], header: InvoiceHeader): boolean | null {
  if (items.length === 0 || header.total == null) return null;
  const subtotal = items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
  if (header.taxApplied && header.lineBasis === "Exclusive") {
    if (subtotal <= 0) return false;
    const ratio = header.total / subtotal;
    return ratio >= 1 - RECONCILE_EPSILON && ratio <= MAX_TAX_MULTIPLIER;
  }
  return Math.abs(subtotal - header.total) <= RECONCILE_EPSILON;
}

/** Pick the single best bank transaction for this invoice, or nothing. */
function selectMatch(candidates: Candidate[]): Candidate | null {
  if (candidates.length === 0) return null;
  // Nearest in time wins; ties broken by the earlier date for determinism.
  const sorted = [...candidates].sort(
    (a, b) => a.lagDays - b.lagDays || a.date.localeCompare(b.date),
  );
  return sorted[0];
}

/** Google Drive rejects `/` in a name; keep it tidy otherwise. */
function buildFileName(header: InvoiceHeader): string {
  const vendor = header.vendor.replace(/[/\\]/g, "-").replace(/\s+/g, " ").trim();
  return `${header.invoiceDate} ${vendor}`.trim();
}

/** Extract the trigger's file fields. */
function extractFile(payload: unknown): {
  id: string;
  title: string;
  mimeType: string;
  fileRef: string;
  originalFilename: string | null;
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
    originalFilename: firstString(p.originalFilename),
    trashed: Boolean(p.labels?.trashed || p.explicitlyTrashed),
  };
}

// --- Prompt ----------------------------------------------------------------
// Verbatim copy of invoice-extraction-prompt.md (repo rule 6).
// Edit the markdown, then run `node scripts/check-prompts.mjs --fix`.
const INVOICE_PROMPT = `You are an expert accounts-payable analyst. Extract billing details from the attached purchase invoice PDF so a draft bill can be raised in Xero.

## What to extract

Read the whole document before answering. Every figure you return must appear on the invoice — never infer, estimate, or convert a currency.

- The **vendor** is the party issuing the invoice, the party we owe. It is never the recipient (Company Flow Pte. Ltd. / workFlowers). Give the complete legal name including any designation such as \`Inc.\`, \`Pte. Ltd.\`, \`LLC\`.
- Dates are ISO-8601 \`YYYY-MM-DD\`. When no due date is stated, repeat the invoice date.
- \`Total Amount\` is the final payable figure after all taxes, discounts and charges: digits and decimal point only.
- \`Currency\` is the ISO-4217 code of that total. Use the code the invoice actually states; only fall back to \`SGD\` when the document gives no indication at all.
- \`Tax Applied\` is true only when the invoice actually charges a tax line (GST, VAT, sales tax). A zero-rated, exempt, or reverse-charge invoice is false.
- \`Line Amounts Are\` describes the unit prices in the line-item table: \`Inclusive\` when they already contain the tax, \`Exclusive\` when tax is added on top, \`NoTax\` when the invoice charges no tax at all. This decides whether Xero adds tax on top of the figures you return, so read the table's own labelling rather than assuming.

## Vendor details

These populate the vendor's contact record in Xero. They describe **the vendor** — the party issuing the invoice — and never the recipient (Company Flow Pte. Ltd. / workFlowers), whose own address and bank account also appear on many invoices. When a document shows two addresses, the vendor's is the one next to the vendor's name in the header or footer, not the one under "Bill to", "Sold to" or "Customer".

**Leave a field blank rather than guessing.** A blank field is written to nobody's record; a wrong one is written to Xero and reused. Never assemble a value from fragments on different parts of the page, and never carry a detail over from another invoice you have seen.

Almost every invoice prints **both** parties' details, and a two-column header often sets them side by side so that the vendor's street and the recipient's street alternate line by line. Read the layout, not the reading order. The same goes for tax numbers: two on one page is normal. The vendor's is the one that belongs to the issuing entity — it frequently reappears in the payment instructions, for instance as a PayNow UEN — and it can be printed right next to the recipient's name, so proximity alone does not settle it.

- \`Vendor Address Line 1\` / \`Vendor Address Line 2\` — the street address as printed, split across the two lines the way the invoice splits it. Do not repeat the city, state, postal code or country here; they have their own fields.
- \`Vendor City\` — city or town.
- \`Vendor State/Region\` — state, province or region. Blank where the address has none.
- \`Vendor Postal Code\` — postal or ZIP code, exactly as printed.
- \`Vendor Country\` — country name. Blank when the invoice does not state one; do not infer it from a currency, phone code or postal format.
- \`Vendor Phone\` — the vendor's telephone number, digits and separators as printed.
- \`Vendor Tax Number\` — the vendor's own tax registration number: GST, VAT, UEN, ABN, EIN or the local equivalent, whatever the invoice calls it. Never the recipient's, and never the invoice number.

Bank details are for paying the vendor, so read them only from an explicit remittance block — a "Pay to", "Bank details", "Remittance advice" or "Payment instructions" section:

- \`Vendor Bank Account Number\` — the account the vendor is asking to be paid into. Give the IBAN when the invoice states one, otherwise the plain account number. Blank on an invoice that offers only a card link, a payment portal or a direct-debit notice, and blank when the invoice says it has already been paid. A postal **address** for mailing a cheque — often headed "Payment address" — is not a bank account: leave all three bank fields blank unless an actual account number or IBAN is printed. A routing, sort or ABA code is not an account number either.
- \`Vendor Bank Name\` — the bank holding that account, **only if the invoice prints it**. Do not derive it from a SWIFT/BIC code, an account-number format or the vendor's country. Many invoices give an account number and a SWIFT code without ever naming the bank; blank is the correct answer there.
- \`Vendor Bank SWIFT/BIC\` — the SWIFT or BIC code for that account.

## Line items

\`Line Items\` must be a **JSON array only** — no prose, no markdown fence, no trailing commas. One object per billable line in the invoice's line-item table, in the order printed, each with exactly these keys:

- \`description\` — the line's text, trimmed to a single line.
- \`quantity\` — number. Use \`1\` when the invoice states no quantity.
- \`unitPrice\` — number, the price for ONE unit, matching the \`Line Amounts Are\` basis above.

Rules:

- Return \`[]\` if the invoice has no itemised table at all.
- Include only lines that are actually charged. Skip subtotal, tax, total, rounding, balance-carried-forward and payment/credit rows — Xero derives those.
- A discount shown as its own negative line is a real line: keep it, with a negative \`unitPrice\`.
- \`quantity * unitPrice\` summed across the array should reconcile to the invoice's own subtotal on the same tax basis. If your first pass doesn't reconcile, re-read the table before answering.`;

/**
 * Structured output for the single extraction call. Descriptions are kept in
 * step with the wording in invoice-extraction-prompt.md.
 */
const OUTPUT_FIELDS = [
  {
    name: "Vendor Name",
    description:
      "Complete exact legal name of the vendor issuing the invoice, including designations such as Inc., Pte. Ltd., LLC. Never the recipient.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Invoice Number",
    description: "The unique identifier assigned to this invoice, often labelled 'Invoice No.' or 'Invoice ID'.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Invoice Date",
    description: "The date the invoice was issued, ISO-8601 YYYY-MM-DD.",
    type: "date",
    isRequired: true,
  },
  {
    name: "Invoice Due Date",
    description: "The date payment is due, ISO-8601 YYYY-MM-DD. Repeat the invoice date when none is stated.",
    type: "date",
    isRequired: true,
  },
  {
    name: "Currency",
    description: "ISO-4217 3-letter code of the invoice total, as stated on the invoice. SGD only when the document gives no indication.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Total Amount",
    description: "The final payable total after all taxes, discounts and charges. Digits and decimal point only.",
    type: "number",
    isRequired: true,
  },
  {
    name: "Tax Applied",
    description: "True only when the invoice actually charges a tax line (GST, VAT, sales tax). Zero-rated, exempt and reverse-charge are false.",
    type: "boolean",
    isRequired: true,
  },
  {
    name: "Line Amounts Are",
    description:
      "Whether the line-item unit prices are Inclusive of tax, Exclusive of tax, or NoTax when the invoice charges no tax at all.",
    type: "category_single",
    isRequired: true,
    options: ["Inclusive", "Exclusive", "NoTax"],
  },
  {
    name: "Line Items",
    description:
      "JSON array only, one object per charged line, each with description, quantity and unitPrice. Empty array when the invoice has no itemised table.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Vendor Email Address",
    description: "Official email address of the vendor, typically in the header or footer. Blank if absent.",
    type: "email",
    isRequired: false,
  },
  // Vendor contact details. All optional: a blank field is written to nobody's
  // record, a wrong one is written to Xero and reused, so the prompt tells the
  // model to leave them blank rather than guess.
  {
    name: "Vendor Address Line 1",
    description:
      "Vendor's street address, first line, as printed. Never the recipient's address. Excludes city, state, postal code and country.",
    type: "text",
    isRequired: false,
  },
  {
    name: "Vendor Address Line 2",
    description: "Vendor's street address, second line, when the invoice splits it across two. Blank otherwise.",
    type: "text",
    isRequired: false,
  },
  {
    name: "Vendor City",
    description: "Vendor's city or town.",
    type: "text",
    isRequired: false,
  },
  {
    name: "Vendor State/Region",
    description: "Vendor's state, province or region. Blank where the address has none.",
    type: "text",
    isRequired: false,
  },
  {
    name: "Vendor Postal Code",
    description: "Vendor's postal or ZIP code, exactly as printed.",
    type: "text",
    isRequired: false,
  },
  {
    name: "Vendor Country",
    description:
      "Vendor's country as stated on the invoice. Blank when not stated — never inferred from currency, phone code or postal format.",
    type: "text",
    isRequired: false,
  },
  {
    name: "Vendor Phone",
    description: "Vendor's telephone number, digits and separators as printed.",
    type: "text",
    isRequired: false,
  },
  {
    name: "Vendor Tax Number",
    description:
      "The vendor's own tax registration number (GST, VAT, UEN, ABN, EIN or local equivalent). Never the recipient's, never the invoice number.",
    type: "text",
    isRequired: false,
  },
  {
    name: "Vendor Bank Account Number",
    description:
      "Account the vendor asks to be paid into, read only from an explicit remittance block. IBAN when stated, else the plain account number. Blank for card links, payment portals, direct debits, or an already-paid invoice.",
    type: "text",
    isRequired: false,
  },
  {
    name: "Vendor Bank Name",
    description: "Bank holding the vendor's account, from the same remittance block.",
    type: "text",
    isRequired: false,
  },
  {
    name: "Vendor Bank SWIFT/BIC",
    description: "SWIFT or BIC code for the vendor's account, from the same remittance block.",
    type: "text",
    isRequired: false,
  },
];

const workflow = defineDurable<Record<string, unknown>, unknown>(
  "drive-invoice-to-xero",
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

    // 1. Read the invoice. ONE call returns the header and the line items; the
    //    classic Zap used two, the second only on the create-a-bill branch.
    const completion = await ctx.step("extract-invoice", async () =>
      sdk.runAction({
        appKey: AI_APP_KEY,
        actionType: "write",
        actionKey: "get_completion",
        inputs: {
          authentication_id: AI_AUTHENTICATION,
          model_id: AI_MODEL,
          isOutputArray: false,
          instructions: INVOICE_PROMPT,
          inputFields: { Invoice: file.fileRef },
          inputFieldConfig_Invoice_isFileUrl: true,
          outputFields: OUTPUT_FIELDS,
        },
      }),
    );

    const raw = firstResult(completion)?.result ?? firstResult(completion) ?? {};
    const vendor = firstString(raw["Vendor Name"]);
    if (!vendor) {
      // Without a counterparty there is nothing to match on and nothing Xero
      // will accept as a bill. Surface it rather than guessing.
      console.log(`WARNING: no vendor extracted from ${file.title}; leaving the file alone`);
      return { skipped: true, reason: "no vendor name extracted", file: file.title };
    }

    // Reading the clock IS non-deterministic, so today's date comes from a
    // step — fixing it for every retry of this run. The step only runs when
    // the model failed to give a usable invoice date, which is the one case
    // where there is nothing on the invoice to fall back to.
    const extractedInvoiceDate = toIsoDate(raw["Invoice Date"]);
    const invoiceDate =
      extractedInvoiceDate ?? (await ctx.step("today", async () => isoDateFromEpochMs(Date.now())));
    if (!extractedInvoiceDate) {
      console.log(
        `WARNING: no usable invoice date extracted from ${file.title}; falling back to today (${invoiceDate})`,
      );
    }
    const basis = firstString(raw["Line Amounts Are"]);
    const header: InvoiceHeader = {
      vendor,
      invoiceNumber: firstString(raw["Invoice Number"]),
      invoiceDate,
      dueDate: toIsoDate(raw["Invoice Due Date"]) ?? invoiceDate,
      currency: (firstString(raw["Currency"]) ?? "SGD").toUpperCase(),
      total: toNumber(raw["Total Amount"]),
      taxApplied: raw["Tax Applied"] === true || firstString(raw["Tax Applied"])?.toLowerCase() === "true",
      lineBasis: basis === "Inclusive" || basis === "Exclusive" ? basis : "NoTax",
      vendorEmail: firstString(raw["Vendor Email Address"]),
    };

    // 2. Rename the Drive file to "<invoice date> <vendor>", as the classic Zap
    //    did (minus its leading space).
    const newName = buildFileName(header);
    const renamed = await ctx.step("rename-drive-file", async () =>
      sdk.runAction({
        appKey: DRIVE_APP_KEY,
        actionType: "write",
        actionKey: "update_file_name",
        connection: DRIVE_CONNECTION,
        inputs: { file: file.id, new_name: newName, rename_folder: "false" },
      }),
    );

    // 3. Has this already been paid? Look for the bank transaction in the free
    //    Zapier Table, over a date window around the invoice and its due date.
    const windowStart = shiftIsoDate(
      header.invoiceDate <= header.dueDate ? header.invoiceDate : header.dueDate,
      -MATCH_WINDOW_DAYS,
    );
    const windowEnd = shiftIsoDate(
      header.invoiceDate >= header.dueDate ? header.invoiceDate : header.dueDate,
      MATCH_WINDOW_DAYS,
    );
    // Pin midnight UTC on both bounds: a bare YYYY-MM-DD is read in the
    // account's local timezone and silently shifts the window.
    const txnRows = await ctx.step("find-bank-transactions", async () =>
      sdk.listTableRecords({
        table: BANK_TXN_TABLE,
        keyMode: "names",
        filters: [
          { fieldKey: "date", operator: "gte", value: `${windowStart}T00:00:00Z` },
          { fieldKey: "date", operator: "lte", value: `${windowEnd}T00:00:00Z` },
        ],
        pageSize: 200,
      }),
    );

    const normalizedVendor = normalizeVendor(header.vendor);
    const candidates: Candidate[] = [];
    for (const row of txnRows?.data ?? []) {
      const cell = (row as any)?.data ?? {};
      if ((labeledValue(cell.type) ?? "").toUpperCase() !== "SPEND") continue;
      const contactName = firstString(cell.contact_name);
      const date = toIsoDate(cell.date);
      const total = toNumber(cell.total);
      const currency = (labeledValue(cell.currency_code) ?? "").toUpperCase();
      const bankTransactionId = firstString(cell.bank_transaction_id);
      if (!contactName || !date || total == null || !bankTransactionId) continue;
      if (!vendorMatches(normalizedVendor, normalizeVendor(contactName))) continue;
      // Amount and currency are required, not tiebreakers. Without them a
      // vendor billed several times in one week matches the wrong payment —
      // and a split payment (two transactions settling one invoice) correctly
      // fails to match instead of attaching to half of it.
      if (currency !== header.currency) continue;
      if (header.total == null || Math.abs(total - header.total) > AMOUNT_EPSILON) continue;
      const lagDays = Math.min(
        Math.abs(dayNumber(date) - dayNumber(header.invoiceDate)),
        Math.abs(dayNumber(date) - dayNumber(header.dueDate)),
      );
      if (lagDays > MATCH_WINDOW_DAYS) continue;
      candidates.push({ bankTransactionId, contactName, date, currency, total, lagDays });
    }

    const match = selectMatch(candidates);
    if (candidates.length > 1) {
      console.log(
        `${candidates.length} bank transactions matched ${header.vendor} ${header.currency} ${header.total}; ` +
          `attaching to the nearest (${match?.date})`,
      );
    }

    // A window that came back completely empty is the signature of the Table's
    // feeder Zap being paused. It is not proof — a quiet week looks the same —
    // but it is the only cheap tripwire available, so surface it.
    const tableStale = (txnRows?.data ?? []).length === 0;
    if (tableStale) {
      console.log(
        `WARNING: the Xero Bank Transactions table returned no rows at all for ${windowStart}..${windowEnd}. ` +
          `If that looks wrong, check that the Zap populating table ${BANK_TXN_TABLE} is still enabled.`,
      );
    }

    const base = {
      file: { id: file.id, title: file.title, originalFilename: file.originalFilename, renamedTo: newName },
      invoice: header,
      renameOk: Boolean(firstResult(renamed)),
      candidatesConsidered: candidates.length,
      tableStale,
    };

    // 4a. Already paid — attach the invoice to the transaction and stop.
    if (match) {
      const attached = await ctx.step("attach-to-bank-transaction", async () =>
        sdk.runAction({
          appKey: XERO_APP_KEY,
          actionType: "write",
          actionKey: "upload_attachment",
          connection: XERO_CONNECTION,
          inputs: {
            organization: XERO_ORGANIZATION,
            endpoint: "BankTransactions",
            guid: match.bankTransactionId,
            file: file.fileRef,
          },
        }),
      );
      console.log(
        `attached ${newName} to bank transaction ${match.bankTransactionId} ` +
          `(${match.contactName} ${match.date} ${match.currency} ${match.total})`,
      );
      return {
        ...base,
        outcome: "attached-to-existing-transaction",
        bankTransaction: match,
        attachmentOk: Boolean(firstResult(attached)),
      };
    }

    // 4b. Not paid yet — raise a draft bill. Guard against doing it twice
    //     first: a redelivered or duplicated PDF would otherwise produce a
    //     second bill. Costs one task, on this branch only.
    let duplicateOf: { invoiceId: string | null; status: string | null } | null = null;
    if (header.invoiceNumber && !/["\\]/.test(header.invoiceNumber)) {
      const existing = await ctx.step("find-existing-bill", async () =>
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
            querystring: { where: `Type=="ACCPAY" AND InvoiceNumber=="${header.invoiceNumber}"` },
          },
        }),
      );
      let bills: any[] = [];
      try {
        bills = JSON.parse(firstResult(existing)?.response?.body ?? "{}")?.Invoices ?? [];
      } catch {
        console.log("WARNING: could not parse the existing-bill lookup; proceeding to create");
      }
      // DELETED and VOIDED bills are gone from the ledger, so they must not
      // block a legitimate re-create.
      const live = bills.filter((b) => !["DELETED", "VOIDED"].includes((b?.Status ?? "").toUpperCase()));
      if (live.length > 0) {
        duplicateOf = { invoiceId: firstString(live[0]?.InvoiceID), status: firstString(live[0]?.Status) };
        console.log(
          `skipping bill creation: Xero already has bill ${header.invoiceNumber} ` +
            `(${duplicateOf.status}) for ${header.vendor}`,
        );
        return { ...base, outcome: "duplicate-bill-skipped", duplicateOf };
      }
    }

    // 4c. Resolve the vendor to a Xero contact, and create or top up that
    //     contact before the bill is raised. See vendor-contact-design.md.
    //
    //     This matters for correctness, not just tidiness: `new_bill` binds by
    //     NAME, so the bill must be created with the name of the contact that
    //     was resolved, not the invoice's spelling of it. Passing the invoice's
    //     spelling is what produced the duplicate contact pairs already in the
    //     ledger.
    const vendorDetails = extractVendorDetails(raw);
    const contactsResponse = await ctx.step("list-xero-contacts", async () =>
      sdk.runAction({
        appKey: XERO_APP_KEY,
        actionType: "write",
        actionKey: "_zap_raw_request",
        connection: XERO_CONNECTION,
        inputs: {
          method: "GET",
          url: `${XERO_API}/Contacts`,
          fail_on_errors: true,
          headers: { "Xero-Tenant-Id": XERO_ORGANIZATION, Accept: "application/json" },
          // summaryOnly keeps the payload small; it drops Addresses, Phones and
          // TaxNumber, which is why a matched contact is re-read in full below.
          querystring: { summaryOnly: "true", pageSize: String(CONTACT_PAGE_SIZE), order: "Name" },
        },
      }),
    );

    let contactsBody: any = null;
    try {
      contactsBody = JSON.parse(firstResult(contactsResponse)?.response?.body ?? "{}");
    } catch {
      console.log("WARNING: could not parse the contact list; leaving the vendor contact alone");
    }
    const contacts = parseContactSummaries(contactsBody);
    // A second page means the match ran against a subset, so "no match" is no
    // longer evidence that the contact is absent. Resolve, but never create.
    const contactsTruncated = Number(contactsBody?.pagination?.pageCount ?? 1) > 1;
    const contactsUsable = contactsBody != null && contacts.length > 0;
    if (contactsTruncated) {
      console.log(
        `WARNING: Xero returned ${contactsBody?.pagination?.itemCount} contacts across ` +
          `${contactsBody?.pagination?.pageCount} pages; only the first ${CONTACT_PAGE_SIZE} were matched. ` +
          `Skipping contact creation so this can't mint a duplicate — raise CONTACT_PAGE_SIZE or paginate.`,
      );
    }

    const resolution = contactsUsable
      ? resolveContact(header.vendor, header.vendorEmail, contacts)
      : ({ tier: "unmatched", nearMisses: [] } as ContactResolution);

    let billContactName = header.vendor;
    const contactReport: Record<string, unknown> = { tier: resolution.tier };

    if (resolution.tier === "matched") {
      // Bind the bill to the contact that was actually resolved.
      billContactName = resolution.contact.name;
      contactReport.contactId = resolution.contact.contactId;
      contactReport.matchedName = resolution.contact.name;
      contactReport.via = resolution.via;
      if (resolution.via === "email-corroborated") {
        console.log(
          `matched ${header.vendor} to existing contact "${resolution.contact.name}" on the ` +
            `${emailDomain(header.vendorEmail)} email domain (names differ)`,
        );
      }

      if (hasVendorDetails(vendorDetails)) {
        // summaryOnly omitted the fields we might fill, so read this one in full.
        const fullResponse = await ctx.step("read-xero-contact", async () =>
          sdk.runAction({
            appKey: XERO_APP_KEY,
            actionType: "write",
            actionKey: "_zap_raw_request",
            connection: XERO_CONNECTION,
            inputs: {
              method: "GET",
              url: `${XERO_API}/Contacts/${resolution.contact.contactId}`,
              fail_on_errors: true,
              headers: { "Xero-Tenant-Id": XERO_ORGANIZATION, Accept: "application/json" },
            },
          }),
        );
        let existingContact: any = null;
        try {
          existingContact = JSON.parse(firstResult(fullResponse)?.response?.body ?? "{}")?.Contacts?.[0] ?? null;
        } catch {
          existingContact = null;
        }

        // Without the existing record there is no way to tell an empty field
        // from a populated one, and a payload with no ContactID would CREATE a
        // duplicate rather than update. Skip rather than guess.
        if (!firstString(existingContact?.ContactID)) {
          console.log(
            `WARNING: could not re-read contact ${resolution.contact.contactId}; skipping enrichment`,
          );
          contactReport.enrichment = "skipped-unreadable";
        } else {
          const write = buildContactWrite(resolution.contact.name, vendorDetails, existingContact);
          if (write.bankConflict) {
            // Never auto-applied. An emailed invoice asking to be paid somewhere
            // new is what invoice-redirection fraud looks like.
            console.log(
              `WARNING: ${resolution.contact.name} has bank account "${write.bankConflict.stored}" in Xero but ` +
                `${file.title} asks for "${write.bankConflict.invoice}". Left unchanged — verify before paying.`,
            );
            contactReport.bankConflict = write.bankConflict;
          }
          if (write.filled.length === 0) {
            contactReport.enrichment = "nothing-to-add";
          } else {
            await ctx.step("update-xero-contact", async () =>
              sdk.runAction({
                appKey: XERO_APP_KEY,
                actionType: "write",
                actionKey: "_zap_raw_request",
                connection: XERO_CONNECTION,
                inputs: {
                  method: "POST",
                  url: `${XERO_API}/Contacts`,
                  fail_on_errors: true,
                  headers: {
                    "Xero-Tenant-Id": XERO_ORGANIZATION,
                    Accept: "application/json",
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify(write.payload),
                },
              }),
            );
            console.log(`filled ${write.filled.join(", ")} on existing contact ${resolution.contact.name}`);
            contactReport.enrichment = "updated";
            contactReport.filled = write.filled;
          }
        }
      } else {
        contactReport.enrichment = "no-details-extracted";
      }
    } else if (resolution.tier === "ambiguous") {
      // Two contacts already answer to this name. Picking one silently puts the
      // bill on a coin flip, so behave exactly as before and say so.
      contactReport.candidates = resolution.candidates.map((c) => ({ id: c.contactId, name: c.name }));
      console.log(
        `WARNING: ${resolution.candidates.length} Xero contacts normalise to the same name as ` +
          `"${header.vendor}" (${resolution.candidates.map((c) => `"${c.name}"`).join(", ")}). ` +
          `Leaving contacts untouched — merge them in Xero.`,
      );
    } else if (contactsUsable && !contactsTruncated) {
      if (resolution.nearMisses.length > 0) {
        contactReport.nearMisses = resolution.nearMisses.map((c) => ({ id: c.contactId, name: c.name }));
        console.log(
          `note: "${header.vendor}" resembles ${resolution.nearMisses.map((c) => `"${c.name}"`).join(", ")} ` +
            `but the email domain doesn't corroborate it; creating a separate contact`,
        );
      }
      const write = buildContactWrite(header.vendor, vendorDetails, null);
      if (write.filled.length === 0) {
        // Nothing to say about them beyond the name — `new_bill` will make the
        // same bare contact for free.
        contactReport.creation = "deferred-to-new-bill";
      } else {
        const created = await ctx.step("create-xero-contact", async () =>
          sdk.runAction({
            appKey: XERO_APP_KEY,
            actionType: "write",
            actionKey: "_zap_raw_request",
            connection: XERO_CONNECTION,
            inputs: {
              method: "POST",
              url: `${XERO_API}/Contacts`,
              fail_on_errors: true,
              headers: {
                "Xero-Tenant-Id": XERO_ORGANIZATION,
                Accept: "application/json",
                "Content-Type": "application/json",
              },
              body: JSON.stringify(write.payload),
            },
          }),
        );
        let createdId: string | null = null;
        try {
          createdId = firstString(
            JSON.parse(firstResult(created)?.response?.body ?? "{}")?.Contacts?.[0]?.ContactID,
          );
        } catch {
          createdId = null;
        }
        console.log(`created Xero contact "${header.vendor}" with ${write.filled.join(", ")}`);
        contactReport.creation = "created";
        contactReport.contactId = createdId;
        contactReport.filled = write.filled;
      }
    } else {
      contactReport.creation = contactsTruncated ? "suppressed-truncated-list" : "suppressed-unreadable-list";
    }

    const parsedLines = parseLineItems(raw["Line Items"]);
    const reconciles = lineItemsReconcile(parsedLines.items, header);
    let lines = parsedLines.items;
    let lineSource: "extracted" | "single-line-fallback" = "extracted";
    if (lines.length === 0 || reconciles === false) {
      // Either nothing usable came back, or the lines don't add up to the
      // invoice's own total. A single line for the stated total is always
      // right in aggregate, and the PDF rides along as the attachment.
      lineSource = "single-line-fallback";
      lines = [
        {
          description: header.invoiceNumber
            ? `${header.vendor} invoice ${header.invoiceNumber}`
            : `${header.vendor} invoice`,
          quantity: 1,
          unitPrice: header.total ?? 0,
        },
      ];
      if (reconciles === false) {
        const subtotal = parsedLines.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
        console.log(
          `WARNING: extracted line items sum to ${subtotal.toFixed(2)} but the invoice total is ` +
            `${header.total} (${header.lineBasis}); falling back to a single line for the total`,
        );
      }
    }

    // On the fallback the amount IS the stated total, so Xero must not add tax
    // on top of it — the total is already tax-inclusive by definition.
    const effectiveBasis =
      lineSource === "single-line-fallback"
        ? header.taxApplied
          ? "Inclusive"
          : "NoTax"
        : header.taxApplied
          ? header.lineBasis === "Inclusive"
            ? "Inclusive"
            : "Exclusive"
          : "NoTax";
    const taxType = header.taxApplied ? TAX_TYPE_STANDARD : TAX_TYPE_NONE;

    const bill = await ctx.step("create-xero-bill", async () =>
      sdk.runAction({
        appKey: XERO_APP_KEY,
        actionType: "write",
        actionKey: "new_bill",
        connection: XERO_CONNECTION,
        inputs: {
          organization: XERO_ORGANIZATION,
          // The RESOLVED contact's name, not the invoice's spelling of it —
          // this is what stops Xero minting a near-duplicate contact.
          contact_name: billContactName,
          // Only offered when the contact wasn't resolved above. `new_bill`
          // writes this onto the contact, and an existing contact's address
          // must not be overwritten from an invoice.
          email_address: resolution.tier === "matched" ? "" : (header.vendorEmail ?? ""),
          status: BILL_STATUS,
          date: header.invoiceDate,
          due_date: header.dueDate,
          currency: header.currency,
          number: header.invoiceNumber ?? "",
          attachment: file.fileRef,
          line_items: lines.map((l) => ({
            line_description: l.description || header.vendor,
            line_quantity: l.quantity,
            line_unit_amount: l.unitPrice,
            line_items_type: effectiveBasis,
            line_tax_type: taxType,
          })),
        },
      }),
    );

    const created = firstResult(bill);
    console.log(
      `created draft bill for ${billContactName} ${header.currency} ${header.total} ` +
        `(${lines.length} line(s), ${lineSource}, ${effectiveBasis}/${taxType})`,
    );
    return {
      ...base,
      contact: contactReport,
      outcome: "draft-bill-created",
      bill: {
        invoiceId: firstString(created?.InvoiceID, created?.invoice_id, created?.id),
        lineCount: lines.length,
        lineSource,
        lineBasisUsed: effectiveBasis,
        taxType,
        lineItemsReconciled: reconciles,
        lineItemsParseFailed: parsedLines.parseFailed,
        zeroValueLinesDropped: parsedLines.droppedZeroLines,
      },
    };
  },
);

export default workflow;
