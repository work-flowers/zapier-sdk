// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/xero-invoice-alerts
//
// Preparing a Wise payout for an approved (AUTHORISED) Xero bill.
//
// Shipped as a CHANNEL of xero-invoice-alerts rather than its own Zap. The
// design in ../xero-bill-approved-to-wise-transfer/ settled on a
// `XeroCLIAPI bill status=authorised` POLLING trigger, verified 2026-07-30 to
// fire on the DRAFT -> AUTHORISED transition. Six days later, on 2026-08-06,
// five Xero pollers on this tenant exhausted Xero's 5,000-calls/day limit and
// took every Xero Zap in the workspace down for ~10 hours — and the poller
// retired in that clean-up was `xero-bill-approved-to-subcontractor-email`,
// carrying the exact same trigger this design wanted. Adding it back would have
// put ~1,440 calls/day onto the tenant that went down.
//
// xero-invoice-alerts already classifies ACCPAY + AUTHORISED, already re-reads
// the invoice, and already runs hourly for ~24 calls/day. So the payout
// preparation rides along on a read that has already been paid for: this
// channel costs ZERO additional Xero calls.
//
// WHAT IT DOES, AND WHERE IT STOPS. It reads the vendor's stored payment
// instruction, reuses or creates the matching Wise recipient, takes a quote,
// and creates an UNFUNDED transfer. Then it stops. A human funds it in Wise.
// Nothing here moves money — the same house style as drive-invoice-to-xero
// stopping at a draft bill and xero-overdue-invoice-to-gmail-reminder stopping
// at a Gmail draft. Wise documents that Singapore business accounts CAN fund
// over the API, so this is a choice, not a limit.
import { createZapierSdk } from "@zapier/zapier-sdk";
import { buildRecipient, describeMissing, type Rail, type RecipientPlan, type VendorRow } from "./recipient.ts";

const sdk = createZapierSdk();

// --- Bindings ---------------------------------------------------------------

/**
 * Wise has NO first-party Zapier app, so every call goes through API by Zapier
 * on the `Wise - workFlowers` connection. Auth is injected by the connection —
 * a probe sending `headers: {}` came back 200, so nothing here sets an
 * Authorization header.
 */
const WISE_APP_KEY = "App235435CLIAPI";
const WISE_CONNECTION = "wise_wf";
const WISE_API = "https://api.wise.com";

/**
 * Company Flow Pte. Ltd., `type: BUSINESS`. A module constant rather than a
 * per-run lookup, the same treatment XERO_ORGANIZATION gets — a stale constant
 * fails loudly on the next call. The account's other profile (`80913698`) is
 * PERSONAL and HIDDEN and is never a payment source.
 */
const WISE_PROFILE_ID = 80913588;

/** One row per Xero contact. Written by drive-invoice-to-xero; read here. */
const VENDOR_PAYMENT_TABLE = "01KYR653H04DNMKKYAZ72534YG";

/** One row per Xero bill. This module is its only writer. */
const TRANSFERS_TABLE = "01KYR680X3GNT4PE1YYDMM43HJ";

/**
 * Balances Wise holds for this profile. A bill in one of these is funded from
 * the matching balance; anything else converts from SGD.
 *
 * UNVERIFIED against live balance data — the design read recipients, not
 * balances. Getting it wrong costs an avoidable conversion, never a misrouted
 * payment, and the quote response reports the real source amount either way.
 */
const FUNDING_CURRENCIES = ["SGD", "USD"];
const DEFAULT_SOURCE_CURRENCY = "SGD";

/**
 * THE FINAL POST IS GATED. Everything up to and including the quote is
 * non-committal, so a DRY_RUN pass still proves the corridor mapping, the
 * requirement reconciliation and the real FX numbers with nothing irreversible.
 *
 * Note what dry run does NOT gate: creating a Wise recipient. That is a real,
 * persistent record in Wise. It is deliberate — a recipient is inert until a
 * transfer names it, and letting the dry run mint one is the only way to prove
 * the `details` keys satisfied Wise's requirements.
 *
 * Flip to `false` once a real bill has been through this end to end.
 */
const DRY_RUN = true;

/** Wise rejects a reference this long; it is the bank-feed matching key. */
const MAX_REFERENCE_LENGTH = 40;

// --- Local helpers ----------------------------------------------------------
//
// Deliberately duplicated from workflow.ts rather than imported: this module is
// published alongside it but stays self-contained, so it can be exercised
// offline without dragging the whole alerting Zap in.

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
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

/** A Zapier Table `labeled_string` cell is `{ value, label }`. */
function labeledValue(cell: unknown): string | null {
  if (cell && typeof cell === "object" && "value" in (cell as any)) {
    return firstString((cell as any).value);
  }
  return firstString(cell);
}

function firstResult(res: any): any {
  if (!res) return null;
  if (Array.isArray(res)) return res[0] ?? null;
  if (Array.isArray(res.data)) return res.data[0] ?? null;
  return res.data ?? res;
}

/**
 * `072-144543-3` and `0721445433` are the same DBS account. Without this, every
 * Singapore vendor's second invoice would fail the cache-validity test and stop
 * a legitimate payment.
 */
function normalizeAccountNumber(v: unknown): string | null {
  const s = firstString(v);
  if (!s) return null;
  const cleaned = s.replace(/[\s-]/g, "").toUpperCase();
  return cleaned === "" ? null : cleaned;
}

/** Lowercase, strip punctuation, peel legal-entity suffixes. */
const VENDOR_SUFFIXES = [
  "pte ltd", "pte", "pty ltd", "pty", "ltd", "limited", "llc", "llp", "lp",
  "inc", "incorporated", "corp", "corporation", "gmbh", "ag", "bv", "nv",
  "sa", "srl", "plc", "co", "company", "pbc",
];

function normalizeVendor(name: unknown): string {
  let s = (firstString(name) ?? "").toLowerCase();
  s = s.replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
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

function vendorMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < 3) return false;
  return longer.startsWith(`${shorter} `) || longer === shorter;
}

/** One API-by-Zapier request. Body is a string; Wise wants JSON. */
async function wiseRequest(method: string, path: string, body?: unknown): Promise<any> {
  const res = await sdk.runAction({
    appKey: WISE_APP_KEY,
    actionType: "write",
    actionKey: "request",
    connection: WISE_CONNECTION,
    inputs: {
      method,
      url: `${WISE_API}${path}`,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  });
  const row = firstResult(res);
  const status = toNumber(row?.response?.status);
  const data = row?.response?.data ?? (typeof row?.response?.body === "string" ? safeParse(row.response.body) : null);
  if (status == null || status >= 300) {
    // Wise's error body is the only useful diagnostic; surface it rather than a
    // bare status. Truncated because it lands in a Table column.
    throw new Error(`Wise ${method} ${path} -> ${status ?? "no status"}: ${JSON.stringify(data ?? row?.response?.body ?? null).slice(0, 400)}`);
  }
  return data;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// --- Requirement reconciliation ---------------------------------------------
//
// `recipient.ts` proposes `details` key names from Wise's corridor docs, and
// there is already a live disagreement proving those labels are not
// trustworthy: the documented `singapore` shape takes `bic`, but the real
// recipient on this account (1505954755) stores `{accountNumber, bankCode}`.
//
// So the keys come from Wise at run time. `GET /v1/quotes/{id}/account-requirements`
// returns, per account type, a list of fields; each field's `group` holds the
// actual keys, their `required` flags and their `valuesAllowed`. We fill those
// keys from `plan.values`, which is the half that survives.

/** Semantic value for a requirement key Wise asked for, or undefined. */
function valueForRequirementKey(key: string, plan: RecipientPlan): unknown {
  const v = plan.values;
  const k = key.toLowerCase();
  switch (k) {
    case "legaltype":
      return v.legalType;
    case "accountnumber":
      return v.accountNumber;
    case "iban":
      return v.iban;
    case "bic":
    case "swiftcode":
      return v.swiftCode;
    // Every national clearing code lives in one column on our side; which one
    // it is was decided by the LABEL printed next to it on the invoice.
    case "bankcode":
    case "sortcode":
    case "abartn":
    case "bsbcode":
    case "ifsccode":
    case "institutionnumber":
    case "clabe":
      return v.bankCode;
    case "transitnumber":
    case "branchcode":
      return v.branchCode ?? v.bankCode;
    case "accounttype":
      return v.accountType ? v.accountType.toLowerCase() : null;
    case "identifiertype":
      return v.identifierType;
    case "identifiervalue":
    case "phonenumber":
      return v.identifierValue;
    case "address.country":
    case "country":
      return v.address.country;
    case "address.firstline":
      return v.address.firstLine;
    case "address.city":
      return v.address.city;
    case "address.postcode":
      return v.address.postCode;
    case "address.state":
      return v.address.state;
    default:
      return undefined;
  }
}

/**
 * Keys holding a machine identifier, where the separators an invoice prints are
 * formatting rather than data. Eugene Thuraisingam's account prints
 * `072-144543-3` and Wise stores `0721445433`; a UK sort code prints `12-34-56`
 * and settles as `123456`.
 *
 * Deliberately excludes `identifierValue`: a PayNow mobile alias is
 * `+6591234567` and stripping its `+` would change what it means.
 */
const NORMALIZED_KEYS = new Set([
  "accountnumber", "iban", "bic", "swiftcode", "bankcode", "sortcode", "abartn",
  "bsbcode", "ifsccode", "institutionnumber", "transitnumber", "branchcode", "clabe",
]);

function setDeep(target: Record<string, any>, key: string, value: unknown): void {
  const parts = key.split(".");
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== "object" || node[parts[i]] == null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

export interface RequirementFill {
  ok: boolean;
  /** The `details` body to POST, built from Wise's own key names. */
  details: Record<string, unknown>;
  /** Required keys Wise asked for that we could not fill. */
  unmet: string[];
  /** Keys whose value is not in Wise's `valuesAllowed` list. */
  rejected: string[];
  /** The requirement type actually matched, which may differ from plan.type. */
  type: string | null;
}

/**
 * Reconcile a proposed recipient against what Wise actually requires.
 *
 * Matches the requirement entry whose `type` equals the plan's, falling back to
 * the only entry when Wise offers exactly one — an unanticipated rail name
 * (the design already met `FedWireLocal`, which the corridor table did not
 * predict) is then a non-event rather than a hard failure.
 */
export function fillRequirements(requirements: any, plan: RecipientPlan): RequirementFill {
  const list: any[] = Array.isArray(requirements) ? requirements : Array.isArray(requirements?.content) ? requirements.content : [];
  const wanted = String(plan.type).toLowerCase();
  const match =
    list.find((r) => String(r?.type ?? "").toLowerCase() === wanted) ?? (list.length === 1 ? list[0] : null);
  if (!match) {
    return { ok: false, details: {}, unmet: [`no account requirement of type "${plan.type}"`], rejected: [], type: null };
  }

  const details: Record<string, unknown> = {};
  const unmet: string[] = [];
  const rejected: string[] = [];

  for (const field of Array.isArray(match.fields) ? match.fields : []) {
    for (const g of Array.isArray(field?.group) ? field.group : []) {
      const key = firstString(g?.key);
      if (!key) continue;
      const raw = valueForRequirementKey(key, plan);
      if (raw === undefined || raw === null || raw === "") {
        if (g?.required === true) unmet.push(key);
        continue;
      }
      const leaf = key.split(".").pop()!.toLowerCase();
      const value = NORMALIZED_KEYS.has(leaf) ? (normalizeAccountNumber(raw) ?? String(raw)) : raw;

      // `valuesAllowed` is Wise's own enum for the field. Sending something
      // outside it is a 422 we can predict for free.
      const allowed = Array.isArray(g?.valuesAllowed) ? g.valuesAllowed : null;
      if (allowed && allowed.length > 0) {
        const ok = allowed.some((a: any) => String(a?.key ?? a).toLowerCase() === String(value).toLowerCase());
        if (!ok) {
          if (g?.required === true) rejected.push(`${key}="${value}"`);
          continue;
        }
      }
      // Wise ships the field's own regexp. Checking it here turns a 422 into a
      // free, specific rejection that names the field.
      const pattern = firstString(g?.validationRegexp);
      if (pattern) {
        let re: RegExp | null = null;
        try {
          re = new RegExp(pattern);
        } catch {
          re = null; // An un-compilable pattern must not block a good payment.
        }
        if (re && !re.test(String(value))) {
          if (g?.required === true) rejected.push(`${key}="${value}" (fails Wise's own format check)`);
          continue;
        }
      }
      setDeep(details, key, value);
    }
  }

  return { ok: unmet.length === 0 && rejected.length === 0, details, unmet, rejected, type: firstString(match.type) };
}

// --- Reading listed recipients ----------------------------------------------

export interface WiseRecipient {
  id: number | null;
  currency: string | null;
  type: string | null;
  rail: Rail;
  legalType: string | null;
  holderName: string | null;
  accountNumber: string | null;
  aliasHash: string | null;
  ownedByCustomer: boolean;
}

/** Read differs from write: `INSTITUTION`/`PERSON` on the way out, `BUSINESS`/`PRIVATE` on the way in. */
function legalTypeFromRead(v: unknown): string | null {
  const s = (firstString(v) ?? "").toUpperCase();
  if (s === "INSTITUTION") return "BUSINESS";
  if (s === "PERSON") return "PRIVATE";
  return s || null;
}

export function readRecipient(r: any): WiseRecipient {
  const details = r?.details ?? {};
  const aliasHash = firstString(details?.identifierAliasHash);
  return {
    id: toNumber(r?.id),
    currency: firstString(r?.currency),
    type: firstString(r?.type),
    rail: aliasHash || firstString(details?.identifierNetwork) ? "PAYNOW" : "BANK",
    legalType: legalTypeFromRead(r?.legalEntityType ?? details?.legalType),
    holderName: firstString(r?.name?.fullName, r?.accountHolderName, r?.name),
    accountNumber: normalizeAccountNumber(details?.accountNumber ?? details?.iban),
    aliasHash,
    ownedByCustomer: r?.ownedByCustomer === true,
  };
}

/**
 * Pick this vendor's recipient from the live list.
 *
 * Three rules, all evidenced on the live account:
 *  - `ownedByCustomer` must be false. Two of the 14 recipients are Company
 *    Flow's own accounts; without this a vendor normalising near our own entity
 *    name resolves to us and we prepare a transfer to ourselves.
 *  - Currency must match the bill.
 *  - A vendor legitimately having BOTH rails is normal (Insur-Asia and Eugene
 *    Thuraisingam each do), so the bank rail wins by default rather than
 *    stopping. Only a SAME-rail collision is genuinely ambiguous.
 */
export function selectRecipient(
  all: WiseRecipient[],
  vendorName: string,
  currency: string,
  preferredRail: Rail,
): { recipient: WiseRecipient | null; ambiguous: WiseRecipient[] } {
  const target = normalizeVendor(vendorName);
  const matches = all.filter(
    (r) =>
      !r.ownedByCustomer &&
      r.id != null &&
      (r.currency ?? "").toUpperCase() === currency.toUpperCase() &&
      vendorMatches(target, normalizeVendor(r.holderName)),
  );
  if (matches.length === 0) return { recipient: null, ambiguous: [] };

  const byRail = matches.filter((r) => r.rail === preferredRail);
  const pool = byRail.length > 0 ? byRail : matches;
  const sameRail = pool.filter((r) => r.rail === pool[0].rail);
  if (sameRail.length > 1) return { recipient: null, ambiguous: sameRail };
  return { recipient: pool[0], ambiguous: [] };
}

// --- The vendor row ---------------------------------------------------------

function readVendorRow(stored: Record<string, unknown>): VendorRow {
  return {
    accountHolderName: firstString(stored.account_holder_name),
    legalType: labeledValue(stored.vendor_legal_type),
    accountNumber: firstString(stored.account_number),
    iban: firstString(stored.iban),
    swiftBic: firstString(stored.swift_bic),
    bankCode: firstString(stored.bank_code),
    bankCodeLabel: firstString(stored.bank_code_label),
    branchCode: firstString(stored.branch_code),
    accountType: labeledValue(stored.account_type),
    bankCountryCode: firstString(stored.bank_country_code),
    payNowIdentifier: firstString(stored.paynow_identifier),
    payNowIdentifierType: labeledValue(stored.paynow_identifier_type),
    beneficiaryAddressLine1: firstString(stored.beneficiary_address_line1),
    beneficiaryAddressLine2: firstString(stored.beneficiary_address_line2),
    beneficiaryCity: firstString(stored.beneficiary_city),
    beneficiaryState: firstString(stored.beneficiary_state),
    beneficiaryPostcode: firstString(stored.beneficiary_postcode),
  };
}

/**
 * Is the cached recipient still bound to the details we hold?
 *
 * Both shapes are equalities that must PASS, so both fail closed: drift
 * degrades to "stops paying", never to "pays the wrong account". A PayNow
 * row's binding is opaque to a human reading the Table — the hash means
 * nothing to the eye — so verifying a PayNow recipient means opening Wise.
 */
export function cacheBindingHolds(
  stored: Record<string, unknown>,
  plan: RecipientPlan,
  listed: WiseRecipient | null,
): { ok: boolean; reason?: string } {
  const rail = (labeledValue(stored.wise_recipient_rail) ?? "").toUpperCase();
  if (rail && rail !== plan.rail) {
    return { ok: false, reason: `cached recipient is ${rail} but this payment needs ${plan.rail}` };
  }
  if (plan.rail === "BANK") {
    const cached = normalizeAccountNumber(stored.wise_recipient_account_number);
    const now = normalizeAccountNumber(plan.binding.accountNumber);
    if (!cached || !now) return { ok: false, reason: "no account number to bind the cached recipient to" };
    if (cached !== now) {
      return { ok: false, reason: `cached recipient is bound to account ${cached}, the stored details now say ${now}` };
    }
    return { ok: true };
  }
  const cachedHash = firstString(stored.wise_recipient_alias_hash);
  if (!cachedHash) return { ok: false, reason: "no alias hash stored for the cached PayNow recipient" };
  if (listed && listed.aliasHash && listed.aliasHash !== cachedHash) {
    return { ok: false, reason: "the cached PayNow recipient's alias hash no longer matches Wise" };
  }
  return { ok: true };
}

// --- The reference ----------------------------------------------------------

/**
 * What the vendor sees on their statement, and what makes the payout
 * self-reconcile against the bill on Xero's bank feed. `InvoiceNumber` is an
 * ABSENT KEY on a bill that has none — not null — and `Reference` likewise, so
 * this is a chain rather than a field read. Invoice-number references are
 * already the established habit on this account (`ref='INV-0044'`).
 */
export function buildReference(invoiceNumber: string | null, reference: string | null, contactName: string | null, isoDate: string | null): string {
  const chosen =
    firstString(invoiceNumber) ??
    firstString(reference) ??
    [firstString(contactName)?.slice(0, 24), firstString(isoDate)].filter(Boolean).join(" ") ??
    "";
  const cleaned = chosen.replace(/\s+/g, " ").trim();
  return (cleaned || "Xero bill").slice(0, MAX_REFERENCE_LENGTH);
}

// --- The channel -------------------------------------------------------------

export interface WiseBill {
  invoiceId: string;
  invoiceNumber: string | null;
  reference: string | null;
  contactId: string | null;
  contactName: string | null;
  currencyCode: string | null;
  amountDue: number | null;
  date: string | null;
  dueDate: string | null;
}

export type WiseOutcome =
  | "prepared"
  | "dry-run"
  | "already-claimed"
  | "nothing-due"
  | "no-vendor-row"
  | "needs-review"
  | "not-payable-by-transfer"
  | "ambiguous-recipient"
  | "cache-mismatch"
  | "requirements-unmet"
  | "error";

export interface WiseResult {
  outcome: WiseOutcome;
  reason?: string;
  transferId?: number | null;
  quoteId?: string | null;
  recipientId?: number | null;
  sourceAmount?: number | null;
  sourceCurrency?: string | null;
  reference?: string | null;
  tasksSpent: number;
}

interface StepCtx {
  step<T>(name: string, run: () => Promise<T>): Promise<T>;
}

function sourceCurrencyFor(target: string): string {
  return FUNDING_CURRENCIES.includes(target.toUpperCase()) ? target.toUpperCase() : DEFAULT_SOURCE_CURRENCY;
}

/**
 * Prepare an unfunded Wise transfer for one approved bill.
 *
 * Every rejection below the Wise calls is FREE — Table reads and pure code
 * consume no tasks — so a bill this Zap cannot pay costs nothing to decline.
 *
 * Never throws. A Wise or Table failure is recorded on the claim row and
 * returned as `error`, because a payment that could not be prepared must not
 * take down the Slack and email alerts running in the same pass.
 */
export async function prepareWiseTransfer(
  ctx: StepCtx,
  tag: string,
  args: { bill: WiseBill; nowIso: string; dryRun: boolean },
): Promise<WiseResult> {
  const { bill, nowIso } = args;
  const dryRun = args.dryRun || DRY_RUN;
  let tasks = 0;

  try {
    // 1. Claim. Read both Tables and take the claim row in ONE step, so a retry
    //    re-reads rather than acting on stale state, and two concurrent runs
    //    cannot both decide this bill is unclaimed.
    const claim = await ctx.step(`wise-claim-${tag}`, async () => {
      const existing = await sdk.listTableRecords({
        table: TRANSFERS_TABLE,
        keyMode: "names",
        filters: [{ fieldKey: "xero_invoice_id", operator: "exact", value: bill.invoiceId }],
        pageSize: 10,
      });
      const claimed = [...((existing?.data ?? []) as any[])].sort((a, b) =>
        String(a?.id ?? "").localeCompare(String(b?.id ?? "")),
      );
      type Blocked = { proceed: false; status: string; rowId: string | null; vendor: null };
      if (claimed.length > 0) {
        const status = labeledValue(claimed[0]?.data?.status) ?? "unknown";
        return { proceed: false, status, rowId: String(claimed[0].id), vendor: null } as Blocked;
      }

      const amountDue = bill.amountDue;
      if (amountDue == null || amountDue <= 0) {
        return { proceed: false, status: "nothing-due", rowId: null, vendor: null } as Blocked;
      }
      if (!bill.contactId) {
        return { proceed: false, status: "no-contact-id", rowId: null, vendor: null } as Blocked;
      }

      const vendorHit = await sdk.listTableRecords({
        table: VENDOR_PAYMENT_TABLE,
        keyMode: "names",
        filters: [{ fieldKey: "xero_contact_id", operator: "exact", value: bill.contactId }],
        pageSize: 10,
      });
      const vendorRows = [...((vendorHit?.data ?? []) as any[])].sort((a, b) =>
        String(a?.id ?? "").localeCompare(String(b?.id ?? "")),
      );
      const vendorRow = vendorRows[0] ?? null;

      // Take the claim BEFORE any Wise call. Wise's own dedupe on
      // `customerTransactionId` is documented but its repeat response is not,
      // which is exactly why the Table row is the primary guard.
      const created = await sdk.createTableRecords({
        table: TRANSFERS_TABLE,
        keyMode: "names",
        records: [
          {
            data: {
              xero_invoice_id: bill.invoiceId,
              xero_invoice_number: bill.invoiceNumber ?? "",
              xero_contact_id: bill.contactId,
              xero_contact_name: bill.contactName ?? "",
              status: "preparing",
              target_currency: (bill.currencyCode ?? "").toUpperCase(),
              target_amount: amountDue,
              prepared_at: nowIso,
              ...(bill.dueDate ? { bill_due_date: `${bill.dueDate}T00:00:00Z` } : {}),
            },
          },
        ],
      });
      const rowId = firstString((created as any)?.data?.[0]?.id, (created as any)?.[0]?.id);
      return {
        proceed: true as const,
        status: "preparing",
        rowId,
        vendor: vendorRow
          ? { id: String(vendorRow.id), data: (vendorRow.data ?? {}) as Record<string, unknown> }
          : null,
      };
    });

    if (!claim.proceed) {
      const outcome: WiseOutcome =
        claim.status === "nothing-due" ? "nothing-due"
        : claim.status === "no-contact-id" ? "no-vendor-row"
        : "already-claimed";
      return {
        outcome,
        reason:
          outcome === "already-claimed"
            ? `already claimed with status "${claim.status}"`
            : outcome === "nothing-due"
              ? `AmountDue is ${bill.amountDue ?? "absent"} — nothing to pay`
              : "the bill carries no Xero contact id, so no vendor row can be keyed",
        tasksSpent: tasks,
      };
    }

    const rowId = claim.rowId;

    /**
     * Record the verdict on the claim row and return it.
     *
     * The claim row's columns and the returned shape are deliberately built
     * separately: the Table takes snake_case column names, the run output is
     * read by a human in the run history. Conflating them is how a column name
     * ends up in a report and a report field ends up rejected by the Table.
     */
    const finish = async (
      outcome: WiseOutcome,
      reason: string | undefined,
      got: Partial<WiseResult> = {},
    ): Promise<WiseResult> => {
      if (rowId) {
        const data: Record<string, unknown> = {
          status: outcome,
          last_error: (reason ?? "").slice(0, 250),
        };
        if (got.transferId != null) data.wise_transfer_id = got.transferId;
        if (got.quoteId) data.wise_quote_id = got.quoteId;
        if (got.recipientId != null) data.wise_recipient_id = got.recipientId;
        if (got.reference) data.wise_reference = got.reference;
        if (got.sourceCurrency) data.source_currency = got.sourceCurrency;
        if (got.sourceAmount != null) data.source_amount_quoted = got.sourceAmount;
        await ctx.step(`wise-record-${tag}`, async () =>
          sdk.updateTableRecords({
            table: TRANSFERS_TABLE,
            keyMode: "names",
            records: [{ id: rowId, data }],
          }),
        );
      }
      return { outcome, reason, tasksSpent: tasks, ...got };
    };

    // 2. Free guards on the stored payment instruction.
    const vendorRowId = claim.vendor?.id ?? null;
    const stored = claim.vendor?.data ?? null;
    if (!stored) {
      return finish(
        "no-vendor-row",
        `no Vendor Payment Details row for contact ${bill.contactId} — drive-invoice-to-xero has not seen an invoice from this vendor since the payment extraction shipped`,
        {},
      );
    }
    if (stored.needs_review === true || firstString(stored.needs_review) === "true") {
      return finish(
        "needs-review",
        `needs_review is set on this vendor's payment details: ${firstString(stored.conflict_note) ?? "(no note)"}. ` +
          `Refusing to prepare a payment until a human clears it.`,
        {},
      );
    }

    const currency = (bill.currencyCode ?? "").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      return finish("not-payable-by-transfer", `the bill has no usable currency code (${bill.currencyCode ?? "absent"})`, {});
    }

    const row = readVendorRow(stored);
    const built = buildRecipient(row, currency, "BANK");
    if (!built.ok) {
      return finish("not-payable-by-transfer", built.reason);
    }
    const plan = built.plan;

    const reference = buildReference(bill.invoiceNumber, bill.reference, bill.contactName, bill.date);
    const amount = bill.amountDue as number;
    const source = sourceCurrencyFor(currency);

    // 3. Resolve the recipient. The cached id is tried first and costs nothing;
    //    only an uncached vendor pays for a list.
    const cachedId = toNumber(stored.wise_recipient_id);
    let recipientId: number | null = null;
    let listed: WiseRecipient | null = null;

    if (cachedId != null) {
      const holds = cacheBindingHolds(stored, plan, null);
      if (!holds.ok) {
        return finish("cache-mismatch", holds.reason, {});
      }
      recipientId = cachedId;
    } else {
      const all = await ctx.step(`wise-list-recipients-${tag}`, async () =>
        wiseRequest("GET", `/v2/accounts?profileId=${WISE_PROFILE_ID}&active=true`),
      );
      tasks++;
      const rows: any[] = Array.isArray(all?.content) ? all.content : Array.isArray(all) ? all : [];
      const picked = selectRecipient(rows.map(readRecipient), plan.accountHolderName, currency, plan.rail);
      if (picked.ambiguous.length > 0) {
        return finish(
          "ambiguous-recipient",
          `${picked.ambiguous.length} existing ${plan.rail} recipients in Wise match "${plan.accountHolderName}" ` +
            `(ids ${picked.ambiguous.map((r) => r.id).join(", ")}). Merge or retire one in Wise, then re-run.`,
          {},
        );
      }
      listed = picked.recipient;
      recipientId = listed?.id ?? null;
    }

    // 4. Quote. Non-committal, and it is what account-requirements is keyed on.
    const quote = await ctx.step(`wise-quote-${tag}`, async () =>
      wiseRequest("POST", `/v3/profiles/${WISE_PROFILE_ID}/quotes`, {
        sourceCurrency: source,
        targetCurrency: currency,
        targetAmount: amount,
        payOut: "BALANCE",
      }),
    );
    tasks++;
    const quoteId = firstString(quote?.id);
    if (!quoteId) {
      return finish("error", `Wise returned a quote with no id: ${JSON.stringify(quote).slice(0, 300)}`);
    }
    const sourceAmount = toNumber(quote?.sourceAmount);

    // 5. Create the recipient only if neither the cache nor the list produced
    //    one. The keys come from Wise's own requirements, never from the
    //    corridor table — that table is a free pre-check, not the authority.
    if (recipientId == null) {
      const requirements = await ctx.step(`wise-requirements-${tag}`, async () =>
        wiseRequest("GET", `/v1/quotes/${quoteId}/account-requirements`),
      );
      tasks++;
      const fill = fillRequirements(requirements, plan);
      if (!fill.ok) {
        return finish(
          "requirements-unmet",
          `Wise requires ${[...fill.unmet, ...fill.rejected].join(", ")} for a ${fill.type ?? plan.type} recipient ` +
            `and the stored details do not supply it (${describeMissing(fill.unmet)})`,
          { quoteId, sourceCurrency: source, sourceAmount },
        );
      }
      const created = await ctx.step(`wise-create-recipient-${tag}`, async () =>
        wiseRequest("POST", "/v1/accounts", {
          currency,
          type: fill.type ?? plan.type,
          profile: WISE_PROFILE_ID,
          accountHolderName: plan.accountHolderName,
          ownedByCustomer: false,
          details: fill.details,
        }),
      );
      tasks++;
      listed = readRecipient(created);
      recipientId = listed.id;
      if (recipientId == null) {
        return finish("error", `Wise created a recipient with no id: ${JSON.stringify(created).slice(0, 300)}`, {
          quoteId,
        });
      }
    }

    // 6. Cache the recipient on the vendor row. Free, and single-writer: this
    //    module owns the five wise_recipient_* columns.
    if (listed && listed.id != null) {
      const cache: Record<string, unknown> = {
        wise_recipient_id: listed.id,
        wise_recipient_currency: currency,
        wise_recipient_rail: plan.rail,
        wise_recipient_created_at: nowIso,
      };
      if (plan.rail === "BANK") cache.wise_recipient_account_number = plan.binding.accountNumber ?? "";
      else cache.wise_recipient_alias_hash = listed.aliasHash ?? "";
      if (vendorRowId) {
        await ctx.step(`wise-cache-recipient-${tag}`, async () =>
          sdk.updateTableRecords({
            table: VENDOR_PAYMENT_TABLE,
            keyMode: "names",
            records: [{ id: vendorRowId, data: cache }],
          }),
        );
      }
    }

    // 7. The transfer. UNFUNDED — Wise creates it, a human funds it.
    if (dryRun) {
      console.log(
        `DRY RUN: would create an unfunded Wise transfer of ${currency} ${amount.toFixed(2)} to ` +
          `${plan.accountHolderName} (recipient ${recipientId}, ${plan.rail}) for bill ` +
          `${bill.invoiceNumber ?? bill.invoiceId}, reference "${reference}", quote ${quoteId}.`,
      );
      return finish("dry-run", undefined, {
        quoteId,
        recipientId,
        reference,
        sourceCurrency: source,
        sourceAmount,
      });
    }

    const transfer = await ctx.step(`wise-transfer-${tag}`, async () =>
      wiseRequest("POST", "/v1/transfers", {
        targetAccount: recipientId,
        quoteUuid: quoteId,
        // The Xero InvoiceID is already a GUID, so the free Table guard and
        // Wise's own dedupe key are ONE identifier rather than two that can
        // disagree.
        customerTransactionId: bill.invoiceId,
        details: { reference },
      }),
    );
    tasks++;
    const transferId = toNumber(transfer?.id);

    console.log(
      `prepared an UNFUNDED Wise transfer ${transferId} — ${currency} ${amount.toFixed(2)} to ` +
        `${plan.accountHolderName} for bill ${bill.invoiceNumber ?? bill.invoiceId}, reference "${reference}". ` +
        `Fund it in Wise; nothing here moves money.`,
    );

    return finish("prepared", undefined, {
      transferId,
      quoteId,
      recipientId,
      reference,
      sourceCurrency: source,
      sourceAmount,
    });
  } catch (err) {
    const reason = String((err as Error)?.message ?? err);
    console.log(
      `WARNING: could not prepare a Wise payment for bill ${bill.invoiceNumber ?? bill.invoiceId}: ${reason}. ` +
        `The bill is unaffected and the alerts in this run are unaffected; no transfer exists.`,
    );
    return { outcome: "error", reason, tasksSpent: tasks };
  }
}
