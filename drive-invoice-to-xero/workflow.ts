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
 * How far behind today the NEWEST row in the bank-transaction Table may fall
 * before its feeder workflow is called stale.
 *
 * This measures the Table as a whole, not the invoice's match window. The
 * previous tripwire asked "did the match window come back empty?", which is a
 * different and much weaker question: the window is
 * `[min(invoiceDate, dueDate) - 7, max(invoiceDate, dueDate) + 7]`, so for a
 * freshly received invoice on 31-day terms roughly 39 of its 46 days lie in the
 * FUTURE, where no transaction can exist. It therefore only ever inspected an
 * ~8-day slice of the past, in which "nothing was paid that week" and "the
 * feeder is dead" are indistinguishable. On 2026-07-29 that misfired both ways
 * in a single day: INV-26-0007 flagged stale against a healthy feeder, while
 * INV-26-0006 stayed quiet only because one row happened to sit on its
 * boundary date.
 *
 * 14 days is deliberately above the largest legitimate quiet stretch observed
 * (8 days, 2026-07-21..2026-07-29, feeder verified healthy throughout). It buys
 * silence at the cost of detection latency, which is the right trade for a
 * warning nobody can action twice.
 */
const TABLE_STALE_AFTER_DAYS = 14;

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

/**
 * Currency symbols seen on these invoices, mapped to their ISO-4217 code.
 * `$` alone is deliberately absent — it is ambiguous and falls back to the
 * organisation default rather than guessing between USD and SGD.
 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  "US$": "USD",
  USD$: "USD",
  "S$": "SGD",
  SGD$: "SGD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "A$": "AUD",
  "NZ$": "NZD",
  "HK$": "HKD",
  "C$": "CAD",
  "₹": "INR",
  RM: "MYR",
};

/**
 * Coerce whatever the model returned into an ISO-4217 code.
 *
 * The prompt asks for three letters, and usually gets them — but `standard/auto`
 * returned `US$` for a Lantern Labs invoice that it had read as `USD` on a
 * previous run, so this is not hypothetical. An unnormalised `US$` would fail
 * the bank-transaction currency comparison (raising a duplicate draft bill for
 * an invoice already paid) and then go to Xero as the bill's currency. Prompt
 * wording alone can't be trusted with something this load-bearing.
 *
 * Returns null when nothing usable can be salvaged, so the caller applies its
 * own default.
 */
function toCurrencyCode(v: unknown): string | null {
  const s = firstString(v);
  if (!s) return null;
  const upper = s.toUpperCase().trim();
  if (/^[A-Z]{3}$/.test(upper)) return upper;
  for (const [symbol, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (upper.startsWith(symbol.toUpperCase())) return code;
  }
  // "USD 7,750" / "7750 USD" — take a standalone three-letter token.
  const token = /\b([A-Z]{3})\b/.exec(upper);
  return token ? token[1] : null;
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
  /**
   * `Contact.ContactID` as mirrored on the bank-transaction row. Free here and
   * an exact bind, so the already-paid branch can write the vendor's payment
   * details without paying for the contact lookup the create-bill branch needs.
   * Bank TRANSFERS carry `""` rather than a contact, hence nullable.
   */
  contactId: string | null;
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

// --- Vendor payment details -------------------------------------------------
//
// The payment instruction, bound for the `Vendor Payment Details` Table and
// from there to a Wise recipient in `xero-bill-approved-to-wise-transfer`.
//
// Deliberately NOT part of `VendorDetails`: that shape drives the Xero contact
// write, and `hasVendorDetails` treats any non-null field as reason to write a
// contact. Folding payment fields in would make an invoice carrying nothing but
// a remittance block raise a Xero contact update.

/** One row per Xero contact. Key `xero_contact_id`. */
const VENDOR_PAYMENT_TABLE = "01KYR653H04DNMKKYAZ72534YG";

interface PaymentDetails {
  method: string | null;
  accountHolderName: string | null;
  legalType: string | null;
  accountNumber: string | null;
  iban: string | null;
  swiftBic: string | null;
  bankName: string | null;
  bankCode: string | null;
  bankCodeLabel: string | null;
  branchCode: string | null;
  accountType: string | null;
  accountCurrency: string | null;
  bankAddress: string | null;
  bankCountryCode: string | null;
  payNowIdentifier: string | null;
  payNowIdentifierType: string | null;
}

/**
 * `Unknown` and `None` are answers the prompt asks for when the invoice does not
 * state a value — they are not data, so they never reach the Table. Without this
 * the Wise payload builder would have to treat the literal string "Unknown" as a
 * legal type.
 */
function meaningful(v: unknown): string | null {
  const s = firstString(v);
  if (!s) return null;
  return /^(unknown|none|n\/a)$/i.test(s) ? null : s;
}

/** Model-facing option labels -> the enum values Wise's create API takes. */
const LEGAL_TYPES: Record<string, string> = { business: "BUSINESS", private: "PRIVATE" };
const ACCOUNT_TYPES: Record<string, string> = { checking: "CHECKING", savings: "SAVINGS" };
const PAYMENT_METHODS: Record<string, string> = {
  banktransfer: "BANK_TRANSFER",
  paynow: "PAYNOW",
  both: "BOTH",
  cardlink: "CARD_LINK",
  portal: "PORTAL",
  directdebit: "DIRECT_DEBIT",
  cheque: "CHEQUE",
  none: "NONE",
};
const PAYNOW_TYPES: Record<string, string> = {
  uen: "UEN",
  mobile: "MOBILE",
  nric: "NRIC",
  vpa: "VPA",
};

function mapEnum(table: Record<string, string>, v: unknown): string | null {
  const s = meaningful(v);
  return s ? (table[s.toLowerCase().replace(/[^a-z]/g, "")] ?? null) : null;
}

/** Company-suffix test, for inferring a legal type the model left Unknown. */
const COMPANY_SUFFIX =
  /\b(pte\.?\s*ltd|pty\.?\s*ltd|ltd|limited|llc|llp|lp|inc|incorporated|corp|corporation|gmbh|ag|bv|nv|sa|srl|plc|co|company|pbc)\.?$/i;

function extractPaymentDetails(raw: Record<string, unknown>): PaymentDetails {
  const swiftBic = meaningful(raw["Vendor Bank SWIFT/BIC"]);
  const accountHolderName = meaningful(raw["Vendor Account Holder Name"]);

  // Two derivations done here rather than by loosening the prompt, because both
  // are exact and the prompt's job is to refuse to guess.
  //
  // 1. A SWIFT/BIC's 5th and 6th characters ARE the ISO-3166 country code, by
  //    definition — `CMFGUS33` is US. The prompt forbids inferring a country
  //    from a SWIFT code (rightly: it must not infer from a currency or phone
  //    code either), which left Lantern Labs with no corridor at all. Decoding
  //    a fixed-position field is not an inference.
  // 2. The model answers `Unknown` for the legal type even when the account
  //    holder it just read is plainly a `Pte. Ltd.`. A company suffix settles
  //    it. Only ever upgrades Unknown -> BUSINESS; never contradicts a stated
  //    answer, and never guesses PRIVATE from the absence of a suffix, since a
  //    business can trade under a bare name.
  let bankCountryCode = meaningful(raw["Vendor Bank Country Code"]);
  if (!bankCountryCode && swiftBic && /^[A-Za-z]{6}/.test(swiftBic)) {
    bankCountryCode = swiftBic.slice(4, 6).toUpperCase();
  }

  let legalType = mapEnum(LEGAL_TYPES, raw["Vendor Legal Type"]);
  if (!legalType && accountHolderName && COMPANY_SUFFIX.test(accountHolderName.trim())) {
    legalType = "BUSINESS";
  }

  return {
    method: mapEnum(PAYMENT_METHODS, raw["Payment Method Offered"]),
    accountHolderName,
    legalType,
    accountNumber: meaningful(raw["Vendor Bank Account Number"]),
    iban: meaningful(raw["Vendor Bank IBAN"])?.replace(/\s+/g, "") ?? null,
    swiftBic,
    bankName: meaningful(raw["Vendor Bank Name"]),
    bankCode: meaningful(raw["Vendor Bank Code"]),
    bankCodeLabel: meaningful(raw["Vendor Bank Code Label"]),
    branchCode: meaningful(raw["Vendor Bank Branch Code"]),
    accountType: mapEnum(ACCOUNT_TYPES, raw["Vendor Bank Account Type"]),
    accountCurrency: toCurrencyCode(raw["Vendor Bank Account Currency"]),
    bankAddress: meaningful(raw["Vendor Bank Address"]),
    bankCountryCode,
    payNowIdentifier: meaningful(raw["Vendor PayNow Identifier"]),
    payNowIdentifierType: mapEnum(PAYNOW_TYPES, raw["Vendor PayNow Identifier Type"]),
  };
}

/**
 * The money-identity fields. A stored value disagreeing with a new invoice on
 * ANY of these is a possible invoice redirection, so it sets `needs_review` and
 * nothing is overwritten. Compared normalised: `072-144543-3` and `0721445433`
 * are the same DBS account, and a false alarm on every Singapore vendor's second
 * invoice would train a human to ignore the flag.
 */
const IDENTITY_FIELDS = [
  "account_number",
  "iban",
  "swift_bic",
  "bank_code",
  "branch_code",
  "paynow_identifier",
] as const;

/**
 * Filled when empty, never overwritten, and a disagreement is reported in the
 * run output WITHOUT raising `needs_review`. None of these can redirect a
 * payment on its own, and all of them change legitimately — a vendor
 * restructures, or a country is stated for the first time. Treating them as
 * fraud signals would bury the six above in noise.
 */
const DESCRIPTIVE_FROZEN = [
  "account_holder_name",
  "vendor_legal_type",
  "account_type",
  "account_currency",
  "bank_country_code",
  "paynow_identifier_type",
  "bank_code_label",
] as const;

/** Fill a gap or fix drift, never blank. Cannot redirect money. */
const CORRECTABLE = [
  "xero_contact_name",
  "bank_name",
  "bank_address",
  "payment_method",
  "beneficiary_address_line1",
  "beneficiary_address_line2",
  "beneficiary_city",
  "beneficiary_state",
  "beneficiary_postcode",
] as const;

/** Written once, with the tuple they are the provenance of. */
const FILL_ONLY = ["source_file_id", "source_file_name", "source_invoice_number", "first_seen"] as const;

/** A Zapier Table datetime read in the account's timezone unless pinned to UTC. */
function toTableDate(iso: string): string {
  return `${iso}T00:00:00Z`;
}

interface VendorPaymentUpsert {
  contactId: string;
  contactName: string | null;
  payment: PaymentDetails;
  vendor: VendorDetails;
  fileId: string;
  fileName: string;
  invoiceNumber: string | null;
  today: string;
}

type VendorPaymentOutcome =
  | "created"
  | "corroborated"
  | "filled"
  | "conflict-reported"
  | "conflict-blocked"
  | "unchanged";

/**
 * Upsert this vendor's payment instruction.
 *
 * Read and write live in ONE `ctx.step` so a retry re-reads rather than writing
 * a merge computed from stale state — the same reason the contact enrichment
 * above does it.
 *
 * Never throws on a Table error: an invoice must not fail to become a bill
 * because this bookkeeping could not be written.
 */
async function upsertVendorPaymentRow(
  ctx: { step<T>(name: string, run: () => Promise<T>): Promise<T> },
  label: string,
  args: VendorPaymentUpsert,
): Promise<{
  outcome: VendorPaymentOutcome | "error" | "skipped";
  reason?: string;
  filled?: string[];
  conflicts?: { field: string; stored: string; invoice: string }[];
  drifted?: { field: string; stored: string; invoice: string }[];
  recipientCached?: boolean;
  confirmations?: number | null;
}> {
  return ctx.step(`${label}-vendor-payment-row`, async () => {
    try {
      const found = await sdk.listTableRecords({
        table: VENDOR_PAYMENT_TABLE,
        keyMode: "names",
        filters: [{ fieldKey: "xero_contact_id", operator: "exact", value: args.contactId }],
        pageSize: 10,
      });
      const rows = (found?.data ?? []) as any[];
      // Oldest ULID first, so two concurrent runs independently agree on which
      // row is canonical.
      rows.sort((a, b) => String(a?.id ?? "").localeCompare(String(b?.id ?? "")));
      const row = rows[0] ?? null;
      const stored: Record<string, unknown> = (row?.data ?? {}) as Record<string, unknown>;

      const p = args.payment;
      const v = args.vendor;
      const incoming: Record<string, string | null> = {
        account_number: p.accountNumber,
        iban: p.iban,
        swift_bic: p.swiftBic,
        bank_code: p.bankCode,
        branch_code: p.branchCode,
        paynow_identifier: p.payNowIdentifier,
        account_holder_name: p.accountHolderName,
        vendor_legal_type: p.legalType,
        account_type: p.accountType,
        account_currency: p.accountCurrency,
        bank_country_code: p.bankCountryCode,
        paynow_identifier_type: p.payNowIdentifierType,
        bank_code_label: p.bankCodeLabel,
        xero_contact_name: args.contactName,
        bank_name: p.bankName,
        bank_address: p.bankAddress,
        payment_method: p.method,
        beneficiary_address_line1: v.addressLine1,
        beneficiary_address_line2: v.addressLine2,
        beneficiary_city: v.city,
        beneficiary_state: v.region,
        beneficiary_postcode: v.postalCode,
      };

      const readStored = (field: string): string | null =>
        field === "vendor_legal_type" ||
        field === "account_type" ||
        field === "account_currency" ||
        field === "paynow_identifier_type" ||
        field === "payment_method"
          ? labeledValue(stored[field])
          : firstString(stored[field]);

      /** Same account / same alias, punctuation and case aside. */
      const sameValue = (field: string, a: string, b: string): boolean => {
        if (field === "account_number" || field === "iban" || field === "paynow_identifier") {
          return normalizeAccountNumber(a) === normalizeAccountNumber(b);
        }
        return a.replace(/[\s-]/g, "").toUpperCase() === b.replace(/[\s-]/g, "").toUpperCase();
      };

      const conflicts: { field: string; stored: string; invoice: string }[] = [];
      const drifted: { field: string; stored: string; invoice: string }[] = [];
      for (const field of IDENTITY_FIELDS) {
        const was = readStored(field);
        const now = incoming[field];
        if (was && now && !sameValue(field, was, now)) conflicts.push({ field, stored: was, invoice: now });
      }
      for (const field of DESCRIPTIVE_FROZEN) {
        const was = readStored(field);
        const now = incoming[field];
        if (was && now && !sameValue(field, was, now)) drifted.push({ field, stored: was, invoice: now });
      }

      const recipientCached = toNumber(stored["wise_recipient_id"]) != null;
      const nowStamp = toTableDate(args.today);

      // A disagreement on a money-identity field is never applied and never
      // filled around: an emailed invoice asking to be paid somewhere new is
      // what invoice redirection looks like. Only the flags are written, so a
      // human decides. `confirmations` is deliberately NOT bumped — this
      // invoice did not corroborate the stored tuple, it contradicted it.
      if (conflicts.length > 0) {
        const note =
          conflicts.map((c) => `${c.field}: stored "${c.stored}" vs invoice "${c.invoice}"`).join("; ") +
          ` (${args.fileName}${args.invoiceNumber ? ` / ${args.invoiceNumber}` : ""})`;
        if (row) {
          await sdk.updateTableRecords({
            table: VENDOR_PAYMENT_TABLE,
            keyMode: "names",
            records: [
              {
                id: row.id,
                data: { needs_review: true, conflict_note: note, conflict_detected_at: nowStamp, last_seen: nowStamp },
              },
            ],
          });
        }
        return {
          outcome: recipientCached ? ("conflict-blocked" as const) : ("conflict-reported" as const),
          conflicts,
          recipientCached,
          reason: note,
        };
      }

      if (!row) {
        const data: Record<string, unknown> = { xero_contact_id: args.contactId };
        for (const [k, val] of Object.entries(incoming)) if (val != null) data[k] = val;
        data.source_file_id = args.fileId;
        data.source_file_name = args.fileName;
        if (args.invoiceNumber) data.source_invoice_number = args.invoiceNumber;
        data.first_seen = nowStamp;
        data.last_seen = nowStamp;
        data.confirmations = 1;
        data.needs_review = false;
        await sdk.createTableRecords({ table: VENDOR_PAYMENT_TABLE, keyMode: "names", records: [{ data }] });
        return {
          outcome: "created" as const,
          filled: Object.keys(incoming).filter((k) => incoming[k] != null),
          drifted,
          recipientCached: false,
          confirmations: 1,
        };
      }

      const changes: Record<string, unknown> = {};
      const filled: string[] = [];

      // Frozen: fill a gap, never overwrite. Applies to the identity fields and
      // the descriptive ones alike — the whole tuple is one payment instruction,
      // and "correcting" one member of it while the rest stand produces an
      // instruction that matches no invoice ever issued.
      for (const field of [...IDENTITY_FIELDS, ...DESCRIPTIVE_FROZEN]) {
        const now = incoming[field];
        if (now != null && !readStored(field)) {
          changes[field] = now;
          filled.push(field);
        }
      }
      for (const field of CORRECTABLE) {
        const now = incoming[field];
        if (now == null) continue;
        const was = readStored(field);
        if (was == null) filled.push(field);
        else if (sameValue(field, was, now)) continue;
        changes[field] = now;
      }
      for (const field of FILL_ONLY) {
        if (firstString(stored[field])) continue;
        const val =
          field === "source_file_id" ? args.fileId
          : field === "source_file_name" ? args.fileName
          : field === "source_invoice_number" ? args.invoiceNumber
          : nowStamp;
        if (val != null) changes[field] = val;
      }

      const confirmations = (toNumber(stored["confirmations"]) ?? 0) + 1;
      changes.last_seen = nowStamp;
      changes.confirmations = confirmations;

      await sdk.updateTableRecords({
        table: VENDOR_PAYMENT_TABLE,
        keyMode: "names",
        records: [{ id: row.id, data: changes }],
      });

      return {
        outcome: filled.length > 0 ? ("filled" as const) : ("corroborated" as const),
        filled,
        drifted,
        recipientCached,
        confirmations,
      };
    } catch (err) {
      // Bookkeeping must never cost a bill.
      return { outcome: "error" as const, reason: String((err as Error)?.message ?? err) };
    }
  });
}

type VendorPaymentRowResult = Awaited<ReturnType<typeof upsertVendorPaymentRow>> | { outcome: "skipped"; reason: string };

/**
 * Narrate the vendor row. A bank-detail conflict is the one outcome here a human
 * must actually see, so it gets the WARNING prefix and prints BOTH values in
 * full — someone deciding whether they are being defrauded needs to compare the
 * two account numbers, not a masked summary of them.
 */
function logVendorPaymentRow(res: VendorPaymentRowResult, vendorName: string, fileName: string): void {
  switch (res.outcome) {
    case "conflict-blocked":
    case "conflict-reported":
      console.log(
        `WARNING: ${vendorName}'s stored payment details disagree with ${fileName} — ${res.reason}. ` +
          `Nothing was overwritten and needs_review is set on table ${VENDOR_PAYMENT_TABLE}. ` +
          (res.outcome === "conflict-blocked"
            ? `A Wise recipient is already cached for this vendor, so xero-bill-approved-to-wise-transfer ` +
              `will refuse to prepare a payment until a human clears the flag. `
            : ``) +
          `Verify out of band — phone the vendor on a number you already had, never one printed on this invoice.`,
      );
      break;
    case "error":
      console.log(
        `WARNING: could not write ${vendorName}'s row in table ${VENDOR_PAYMENT_TABLE}: ${res.reason}. ` +
          `The bill is unaffected; the vendor's payment details simply were not recorded.`,
      );
      break;
    case "skipped":
      console.log(`vendor payment row skipped for ${vendorName}: ${res.reason}`);
      break;
    case "created":
      console.log(`recorded payment details for ${vendorName} (${(res.filled ?? []).length} field(s) from ${fileName})`);
      break;
    case "filled":
      console.log(`filled ${(res.filled ?? []).join(", ")} on ${vendorName}'s payment details from ${fileName}`);
      break;
    default:
      console.log(
        `${vendorName}'s payment details corroborated by ${fileName} (confirmation ${res.confirmations ?? "?"})`,
      );
  }
  if ("drifted" in res && res.drifted && res.drifted.length > 0) {
    console.log(
      `note: ${vendorName} — ${res.drifted
        .map((d) => `${d.field} stored "${d.stored}", invoice says "${d.invoice}"`)
        .join("; ")}. Left as stored; these cannot redirect a payment.`,
    );
  }
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
- \`Currency\` is the ISO-4217 code of that total: exactly three letters, such as \`USD\`, \`SGD\`, \`EUR\`. Never a symbol and never a mixture of the two — an invoice printing \`US$7,750\` is \`USD\`, one printing \`S$12.00\` is \`SGD\`. Use the code implied by what the invoice actually states; only fall back to \`SGD\` when the document gives no indication at all.
- \`Tax Applied\` is true only when the invoice actually charges a tax line (GST, VAT, sales tax). A zero-rated, exempt, or reverse-charge invoice is false.
- \`Line Amounts Are\` describes the unit prices in the line-item table: \`Inclusive\` when they already contain the tax, \`Exclusive\` when tax is added on top, \`NoTax\` when the invoice charges no tax at all. This decides whether Xero adds tax on top of the figures you return, so read the table's own labelling rather than assuming.

## Vendor details

These populate the vendor's contact record in Xero. They describe **the vendor** — the party issuing the invoice — and never the recipient (Company Flow Pte. Ltd. / workFlowers), whose own address and bank account also appear on many invoices. When a document shows two addresses, the vendor's is the one next to the vendor's name in the header or footer, not the one under "Bill to", "Sold to" or "Customer".

**Return an empty string rather than guessing.** Every one of these fields is required, but an empty string is always an acceptable answer and is the RIGHT answer whenever the invoice does not state the value plainly. An empty field is written to nobody's record; a wrong one is written to Xero and reused. Never assemble a value from fragments on different parts of the page, and never carry a detail over from another invoice you have seen.

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
- \`Vendor Bank Name\` — the bank holding that account, **only if the invoice prints it**. This is a bank, never the vendor: a remittance block usually leads with the account holder's name, which is the vendor's own name, and that does not belong here. Do not derive the bank from a SWIFT/BIC code, an account-number format or the vendor's country. Many invoices give an account number and a SWIFT code without ever naming the bank; empty is the correct answer there.
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
    description: "Official email address of the vendor, typically in the header or footer. Empty string if absent.",
    type: "text",
    isRequired: true,
  },
  // Vendor contact details.
  //
  // EVERY field here is `isRequired: true`, including `Vendor Email Address`,
  // and that is not cosmetic. AI by Zapier drops a non-required output field
  // from the structured response ENTIRELY — the model is never asked for it.
  // Verified against real invoices: with these marked optional, the response
  // came back with exactly the nine required fields and nothing else, on an
  // invoice that plainly prints an address, a phone number, a UEN and a bank
  // account. `Vendor Email Address` shipped optional in the deployed version,
  // which is why it has never been populated.
  //
  // Required does not mean "invent something": the prompt says an empty string
  // is always acceptable and is the right answer when the invoice doesn't state
  // the value. Confirmed on Anthropic's invoice, which has no remittance block
  // — all three bank fields came back empty rather than borrowing the cheque
  // "PAYMENT ADDRESS" PO Box.
  {
    name: "Vendor Address Line 1",
    description:
      "Vendor's street address, first line, as printed. Never the recipient's address. Excludes city, state, postal code and country.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Vendor Address Line 2",
    description: "Vendor's street address, second line, when the invoice splits it across two. Blank otherwise.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Vendor City",
    description: "Vendor's city or town.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Vendor State/Region",
    description: "Vendor's state, province or region. Blank where the address has none.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Vendor Postal Code",
    description: "Vendor's postal or ZIP code, exactly as printed.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Vendor Country",
    description:
      "Vendor's country as stated on the invoice. Blank when not stated — never inferred from currency, phone code or postal format.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Vendor Phone",
    description: "Vendor's telephone number, digits and separators as printed.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Vendor Tax Number",
    description:
      "The vendor's own tax registration number (GST, VAT, UEN, ABN, EIN or local equivalent). Never the recipient's, never the invoice number.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Vendor Bank Account Number",
    description:
      "Account the vendor asks to be paid into, read only from an explicit remittance block. IBAN when stated, else the plain account number. Blank for card links, payment portals, direct debits, or an already-paid invoice.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Vendor Bank Name",
    description: "Bank holding the vendor's account, from the same remittance block.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Vendor Bank SWIFT/BIC",
    description: "SWIFT or BIC code for the vendor's account, from the same remittance block.",
    type: "text",
    isRequired: true,
  },
];

// --- Payment-instruction prompt --------------------------------------------
// Verbatim copy of payment-extraction-prompt.md (repo rule 6).
//
// A SECOND AI call, not more fields on the first one. Folding these into
// `OUTPUT_FIELDS` took that schema from 21 fields to 34 and measurably broke the
// header: on `2026-07-02 Slack Technologies Limited`, same tier and same PDF,
// the correct vendor name came back 6/6 at 21 fields and 2/6 at 34 — the
// failures returning `Company Flow Pte. Ltd.`, our own entity, as the vendor.
// `Vendor Name` binds the Xero contact and the draft bill, so that error is far
// more expensive than a missing bank detail. Worth 1 extra task per invoice.
const PAYMENT_PROMPT = `You are an expert accounts-payable analyst. Read the attached purchase invoice PDF and extract **only how the vendor wants to be paid**, so a payment can be prepared.

The vendor — the party issuing the invoice, the party we owe — is given to you in the \`Vendor\` input. Everything you return must describe **that** party's payment details.

## The one rule that matters

We are recording where to send money. A wrong value sends money to the wrong place, and no downstream check will catch it. So:

**Return an empty string rather than guessing.** Every field below is required, but an empty string is always an acceptable answer and is the RIGHT answer whenever the invoice does not state the value plainly. Never assemble a value from fragments on different parts of the page, never derive one field from another, and never carry a detail over from another invoice you have seen.

Read payment details **only** from an explicit remittance block — a "Pay to", "Bank details", "Remittance advice", "Payment instructions", "How to pay" or "Bank transfer" section. Figures elsewhere on the invoice are not payment instructions.

Two traps to watch for, both common:

- **The invoice usually prints our details too.** The recipient (Company Flow Pte. Ltd. / workFlowers) appears under "Bill to", "Sold to", "Customer" or in a two-column header, and its bank account or UEN may be printed as well. Never return the recipient's details. When you cannot tell whose account a block describes, return empty.
- **A postal address is not a bank account.** A "Payment address" or "Remit to" block giving only a street or PO Box is a cheque-mailing address. Return empty for every bank field in that case.

Blank every field in this response when the invoice states it has already been paid.

## Payment method

- \`Payment Method Offered\` — how this invoice asks to be paid, judged only on what it prints. \`BankTransfer\` when it gives account details for a transfer. \`PayNow\` when it gives a PayNow QR, UEN, mobile or NRIC and no transfer details. \`Both\` when it offers a bank transfer **and** a PayNow alias. \`CardLink\` for a "pay online" / Stripe / PayPal button or URL. \`Portal\` for "log in to our billing portal". \`DirectDebit\` when the amount will be collected automatically from a card or account already on file. \`Cheque\` when the only instruction is to mail a cheque. \`None\` when the invoice gives no payment instruction at all.

## Bank transfer

- \`Vendor Bank Account Number\` — the plain domestic account number, exactly as printed, including any dashes or spaces the invoice uses. **Never an IBAN** — that has its own field.
- \`Vendor Bank IBAN\` — the International Bank Account Number when the invoice prints one: a two-letter country code, two check digits, then the account. Give it without spaces. Blank when no IBAN is printed; never construct one from an account number.
- \`Vendor Bank SWIFT/BIC\` — the SWIFT or BIC code for that account, 8 or 11 characters, letters and digits.
- \`Vendor Bank Name\` — the bank holding the account, **only if the invoice prints it**. This is a bank, never the vendor: a remittance block usually leads with the account holder's name, which is the vendor's own name, and that does not belong here. Do not derive the bank from a SWIFT/BIC code, an account-number format or a country. Many invoices give an account number and a SWIFT code without ever naming the bank; empty is correct there.
- \`Vendor Bank Code\` — a code that identifies the **bank or its clearing route**, printed *separately from* the account number: a US routing/ABA number, a UK sort code, an Australian BSB, an Indian IFSC, a Singapore bank code, a Canadian institution number. Digits and separators as printed.

  This field is **not** the account number. If the only number printed is the account, leave this blank. Never return the same digits here that you returned for \`Vendor Bank Account Number\` or \`Vendor Bank IBAN\` — a value labelled "Account No.", "Ac No.", "A/C", "Acct" or similar is an account number, whatever else is nearby. When in doubt, blank.
- \`Vendor Bank Code Label\` — the literal words the invoice prints beside that code: \`Routing number\`, \`ABA\`, \`Sort Code\`, \`BSB\`, \`IFSC\`, \`Bank Code\`, \`Institution Number\`. Copy the invoice's own wording rather than normalising it; several of these codes share a length, so this is what identifies which kind we hold. Give it whenever \`Vendor Bank Code\` is non-empty, and leave it blank whenever \`Vendor Bank Code\` is blank.
- \`Vendor Bank Branch Code\` — a separate branch, transit or sub-code printed **in addition** to the bank code. Singapore prints a bank code and a branch code as distinct values (DBS \`7171\` / \`001\`); Japan, Brazil and Canada do likewise. Blank when the invoice prints only one code.
- \`Vendor Bank Account Type\` — \`Checking\` or \`Savings\` when the invoice states which, otherwise \`Unknown\`. US invoices often state it; most others do not. Never guess.
- \`Vendor Bank Account Currency\` — the ISO-4217 code of the currency **that account holds**, when the remittance block states it — a block headed "USD account", or several accounts listed by currency. This is not always the invoice's own currency. Blank when the block does not say.
- \`Vendor Bank Address\` — the bank's own address as printed, on one line. Often given for international transfers. The bank's address, never the vendor's and never the recipient's.
- \`Vendor Bank Country Code\` — the ISO-3166 alpha-2 code of the country the **account** is held in: \`SG\`, \`US\`, \`GB\`, \`AU\`, \`DE\`. Take it from the bank's stated address or country when the remittance block gives one; otherwise from the vendor's own stated country. Writing the code for a country the invoice names is a transliteration, not an inference, so \`Singapore\` is \`SG\`. What is never allowed is deriving a country from a currency, a phone code, a postal format or a SWIFT code. Blank when the invoice names no country at all.

## Account holder

- \`Vendor Account Holder Name\` — the name the account is held in, exactly as printed in the remittance block. This is frequently **not** identical to the vendor's invoicing name: a sole trader bills as a business and banks in a personal name, and a group company banks under a holding entity. Copy it as printed. Blank when the block names no account holder.
- \`Vendor Legal Type\` — \`Business\` when the account holder is a company, \`Private\` when it is an individual person, \`Unknown\` when the document does not settle it. A name carrying \`Pte. Ltd.\`, \`Ltd\`, \`LLC\`, \`Inc.\`, \`GmbH\`, \`LLP\` is a business; a personal name is private. When no account holder is named at all, answer \`Unknown\` — do not fall back to the vendor's own name.

## PayNow (Singapore)

A PayNow instruction pays an **alias** rather than an account number. It appears as a QR code, or as a line like "PayNow UEN: 202442050M", "PayNow to +65 9366 2865", or "PayNow NRIC".

- \`Vendor PayNow Identifier\` — the alias itself, exactly as printed: the UEN, mobile number, NRIC/FIN or virtual payment address, including a country code on a mobile when the invoice prints one. Blank when the invoice offers no PayNow option, and blank when it shows **only** a QR image with no alias printed in text — a QR is not readable text, and inventing the alias behind it is exactly the guess that sends money to a stranger.
- \`Vendor PayNow Identifier Type\` — \`UEN\` for a business registration number, \`Mobile\` for a phone number, \`NRIC\` for an NRIC/FIN, \`VPA\` for a virtual payment address, \`Unknown\` when an alias is printed unlabelled and its kind is not obvious from its shape. Answer \`None\` — not \`Unknown\` — whenever \`Vendor PayNow Identifier\` is blank.

A Singapore vendor's UEN is often printed twice: once as its tax number and once as its PayNow UEN. Returning the same value for the PayNow identifier is correct **only when the invoice actually presents it as a PayNow alias**. A UEN printed solely as a tax registration number is not a payment instruction — leave the PayNow fields blank in that case.`;

/**
 * Fields for the payment-instruction call. Same `isRequired: true` rule as
 * `OUTPUT_FIELDS` and for the same reason: AI by Zapier drops a non-required
 * output field from the response entirely, so the model is never asked for it.
 *
 * These do NOT go to Xero — its `BankAccountDetails` is a single free-text
 * field, which is why the tuple is stored in the `Vendor Payment Details` Table
 * for `xero-bill-approved-to-wise-transfer` to build a Wise recipient from.
 * Account number and IBAN are separate fields because Wise's
 * `details.accountNumber` and `details.iban` are different keys on different
 * account types, so one field meaning "IBAN when stated, else account number"
 * cannot build either payload without being re-parsed.
 */
const PAYMENT_OUTPUT_FIELDS = [
  {
    name: "Payment Method Offered",
    description:
      "How this invoice asks to be paid, judged only on what it prints. BankTransfer, PayNow, Both, CardLink, Portal, DirectDebit, Cheque, or None when it gives no payment instruction at all.",
    type: "category_single",
    isRequired: true,
    options: ["BankTransfer", "PayNow", "Both", "CardLink", "Portal", "DirectDebit", "Cheque", "None"],
  },
  {
    name: "Vendor Bank Account Number",
    description:
      "The plain domestic account number from an explicit remittance block, exactly as printed including dashes or spaces. NEVER an IBAN — that has its own field.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Vendor Bank IBAN",
    description:
      "International Bank Account Number when the invoice prints one: two-letter country code, two check digits, then the account, given without spaces. Blank when no IBAN is printed — never constructed from an account number.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Vendor Bank SWIFT/BIC",
    description: "SWIFT or BIC code for that account, 8 or 11 characters, letters and digits.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Vendor Bank Name",
    description:
      "Bank holding the account, only if the invoice prints it. A bank, never the vendor — a remittance block usually leads with the account holder's name. Never derived from a SWIFT/BIC, an account-number format or a country.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Vendor Bank Code",
    description:
      "A code identifying the BANK or its clearing route, printed separately from the account number: US routing/ABA, UK sort code, Australian BSB, Indian IFSC, Singapore bank code, Canadian institution number. Never the same digits as the account number or IBAN; a value labelled 'Account No.', 'Ac No.', 'A/C' or 'Acct' is an account number. Blank when the only number printed is the account.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Vendor Bank Code Label",
    description:
      "The literal words printed beside that code — 'Routing number', 'ABA', 'Sort Code', 'BSB', 'IFSC', 'Bank Code', 'Institution Number' — in the invoice's own wording. Several of these codes share a length, so this identifies which kind we hold. Non-empty exactly when Vendor Bank Code is non-empty.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Vendor Bank Branch Code",
    description:
      "A separate branch, transit or sub-code printed IN ADDITION to the bank code (Singapore DBS 7171/001; also Japan, Brazil, Canada). Blank when the invoice prints only one code.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Vendor Bank Account Type",
    description: "Checking or Savings when the invoice states which, otherwise Unknown. Never guessed.",
    type: "category_single",
    isRequired: true,
    options: ["Checking", "Savings", "Unknown"],
  },
  {
    name: "Vendor Bank Account Currency",
    description:
      "ISO-4217 code of the currency that account holds, when the remittance block states it. Not always the invoice's own currency. Blank when the block does not say.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Vendor Bank Address",
    description:
      "The bank's own address as printed, on one line. Often given for international transfers. The bank's address, never the vendor's and never the recipient's.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Vendor Bank Country Code",
    description:
      "ISO-3166 alpha-2 code of the country the ACCOUNT is held in, from the bank's stated address or country, else the vendor's stated country. A code for a named country is a transliteration (Singapore -> SG); never derived from a currency, phone code, postal format or SWIFT code. Blank when no country is named.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Vendor Account Holder Name",
    description:
      "The name the account is held in, exactly as printed in the remittance block. Frequently NOT the vendor's invoicing name — a sole trader banks personally, a group banks under a holding entity. Blank when the block names no account holder.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Vendor Legal Type",
    description:
      "Business when the account holder is a company (Pte. Ltd., Ltd, LLC, Inc., GmbH, LLP), Private when it is an individual person, Unknown when the document does not settle it or names no account holder at all.",
    type: "category_single",
    isRequired: true,
    options: ["Business", "Private", "Unknown"],
  },
  {
    name: "Vendor PayNow Identifier",
    description:
      "The PayNow alias exactly as printed — UEN, mobile number, NRIC/FIN or virtual payment address — including a country code on a mobile when printed. Blank when no PayNow option is offered, AND blank when only a QR image is shown with no alias in text.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Vendor PayNow Identifier Type",
    description:
      "UEN for a business registration number, Mobile for a phone number, NRIC for an NRIC/FIN, VPA for a virtual payment address, Unknown when an alias is printed unlabelled and its kind is not obvious. None — not Unknown — whenever Vendor PayNow Identifier is blank.",
    type: "category_single",
    isRequired: true,
    options: ["UEN", "Mobile", "NRIC", "VPA", "Unknown", "None"],
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
    // step — fixing it for every retry of this run. It runs unconditionally
    // because the Table-freshness check below needs today even when the invoice
    // carried its own date; the step costs no task.
    const today = await ctx.step("today", async () => isoDateFromEpochMs(Date.now()));
    const extractedInvoiceDate = toIsoDate(raw["Invoice Date"]);
    const invoiceDate = extractedInvoiceDate ?? today;
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
      currency: toCurrencyCode(raw["Currency"]) ?? "SGD",
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
      candidates.push({
        bankTransactionId,
        contactName,
        date,
        currency,
        total,
        lagDays,
        contactId: firstString(cell.contact_id),
      });
    }

    const match = selectMatch(candidates);
    if (candidates.length > 1) {
      console.log(
        `${candidates.length} bank transactions matched ${header.vendor} ${header.currency} ${header.total}; ` +
          `attaching to the nearest (${match?.date})`,
      );
    }

    // Is the Table itself current? Measured against the newest row in the WHOLE
    // Table rather than the emptiness of this invoice's window — see
    // TABLE_STALE_AFTER_DAYS for why the window is the wrong thing to ask.
    // One more free Table read: no filters, newest first, a single row.
    const newestRow = await ctx.step("latest-bank-transaction", async () =>
      sdk.listTableRecords({
        table: BANK_TXN_TABLE,
        keyMode: "names",
        sort: { fieldKey: "date", direction: "desc" },
        pageSize: 1,
      }),
    );
    const latestRowDate = toIsoDate((newestRow?.data ?? [])[0]?.data?.date);
    // A Table with no readable newest row is a harder fault than a stale one:
    // an empty table, a renamed column or a failed read all land here, and none
    // of them can be distinguished from this side. Treat it as stale.
    const tableLagDays = latestRowDate == null ? null : dayNumber(today) - dayNumber(latestRowDate);
    const tableStale = tableLagDays == null || tableLagDays > TABLE_STALE_AFTER_DAYS;
    if (tableStale) {
      console.log(
        `WARNING: the Xero Bank Transactions table looks stale — ` +
          (latestRowDate == null
            ? `no newest row could be read at all.`
            : `its newest row is ${latestRowDate}, ${tableLagDays} days behind ${today} ` +
              `(threshold ${TABLE_STALE_AFTER_DAYS}d).`) +
          ` Check that the workflow populating table ${BANK_TXN_TABLE} ` +
          `(xero-bank-transactions-to-zapier-table) is still enabled and has recent runs. ` +
          `A stale table makes an already-paid invoice look unpaid, which raises a duplicate draft bill.`,
      );
    }

    // How the vendor wants to be paid. A SECOND AI call rather than more fields
    // on the first one — see PAYMENT_PROMPT for the measurement that forced the
    // split. The vendor name goes in as its own input field so a prompt that
    // never reasons about the header can still tell the vendor's remittance
    // block from ours, which most invoices also print.
    //
    // Placed here so BOTH outcomes that write a vendor row share one call: the
    // already-paid branch below and the create-bill branch further down. The
    // duplicate-bill guard in between returns without using it, so a redelivered
    // PDF spends this task for nothing — rare enough to be worth the simplicity
    // of a single call site.
    const paymentCompletion = await ctx.step("extract-payment-details", async () =>
      sdk.runAction({
        appKey: AI_APP_KEY,
        actionType: "write",
        actionKey: "get_completion",
        inputs: {
          authentication_id: AI_AUTHENTICATION,
          model_id: AI_MODEL,
          isOutputArray: false,
          instructions: PAYMENT_PROMPT,
          inputFields: { Invoice: file.fileRef, Vendor: header.vendor },
          inputFieldConfig_Invoice_isFileUrl: true,
          outputFields: PAYMENT_OUTPUT_FIELDS,
        },
      }),
    );
    const paymentRaw = firstResult(paymentCompletion)?.result ?? firstResult(paymentCompletion) ?? {};
    const payment = extractPaymentDetails(paymentRaw);

    // Pure read of the completion already in hand, hoisted above the branch so
    // the already-paid path can write a vendor row too. Costs nothing.
    const vendorDetails = extractVendorDetails(raw);

    const base = {
      file: { id: file.id, title: file.title, originalFilename: file.originalFilename, renamedTo: newName },
      invoice: header,
      payment: {
        method: payment.method,
        rails: [
          payment.accountNumber || payment.iban ? "bank" : null,
          payment.payNowIdentifier ? "paynow" : null,
        ].filter(Boolean),
        bankCountryCode: payment.bankCountryCode,
        legalType: payment.legalType,
      },
      renameOk: Boolean(firstResult(renamed)),
      candidatesConsidered: candidates.length,
      tableStale,
      // The raw numbers behind `tableStale`, so a run can be judged without
      // re-querying: how far behind the Table's newest row is, what that row is
      // dated, and how many rows this invoice's own window returned (the signal
      // the old tripwire used, kept as context rather than as the verdict).
      tableLagDays,
      tableLatestRowDate: latestRowDate,
      windowRowsConsidered: (txnRows?.data ?? []).length,
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
      // This invoice is settled, but it still tells us where this vendor banks,
      // which is what the NEXT one will be paid into. The contact id comes free
      // off the matched Table row, so no contact lookup is needed on this branch.
      const paidRow = match.contactId
        ? await upsertVendorPaymentRow(ctx, "attach", {
            contactId: match.contactId,
            contactName: match.contactName,
            payment,
            vendor: vendorDetails,
            fileId: file.id,
            fileName: newName,
            invoiceNumber: header.invoiceNumber,
            today,
          })
        : { outcome: "skipped" as const, reason: "bank transaction carries no contact id" };
      logVendorPaymentRow(paidRow, match.contactName, newName);
      return {
        ...base,
        outcome: "attached-to-existing-transaction",
        bankTransaction: match,
        attachmentOk: Boolean(firstResult(attached)),
        vendorPaymentRow: paidRow,
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

    // Record where this vendor wants to be paid, keyed on the Xero contact.
    //
    // No contact id means no key, so no row: that covers the `ambiguous`,
    // `deferred-to-new-bill` and `suppressed-*` paths. `deferred-to-new-bill` is
    // the one worth naming — it fires only when the invoice yielded nothing at
    // all for the contact record, and any bank account present forces a create,
    // so the loss is limited to a brand-new vendor whose invoice prints a PayNow
    // alias and literally nothing else. The next invoice from them picks it up.
    const resolvedContactId = firstString(contactReport.contactId);
    const vendorRow = resolvedContactId
      ? await upsertVendorPaymentRow(ctx, "bill", {
          contactId: resolvedContactId,
          contactName: firstString(contactReport.matchedName) ?? header.vendor,
          payment,
          vendor: vendorDetails,
          fileId: file.id,
          fileName: newName,
          invoiceNumber: header.invoiceNumber,
          today,
        })
      : {
          outcome: "skipped" as const,
          reason: `no Xero contact id in hand (${String(contactReport.creation ?? contactReport.tier)})`,
        };
    logVendorPaymentRow(vendorRow, header.vendor, newName);

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
      vendorPaymentRow: vendorRow,
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
