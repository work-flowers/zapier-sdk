// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/xero-bill-approved-to-wise-transfer
//
// Turning a `Vendor Payment Details` row into a Wise recipient payload.
//
// Split out of `workflow.ts` because it is pure: no `sdk`, no `ctx`, no clock.
// That is what lets it be exercised offline against the real recipient shapes
// read off the live Wise account, rather than only in production.
//
// The corridor table below is a FREE pre-check, not the authority. Wise's
// `GET /v1/quotes/{quoteId}/account-requirements` decides the real `type` and
// required keys at run time, and Wise is explicit that hardcoding them "may
// result in your application breaking upon a requirements change". The table
// exists so an unbuildable vendor is rejected at 0 tasks instead of paying for
// a quote in order to be told 422.

/** The columns of a Vendor Payment Details row this module reads. */
export interface VendorRow {
  accountHolderName: string | null;
  legalType: string | null;
  accountNumber: string | null;
  iban: string | null;
  swiftBic: string | null;
  bankCode: string | null;
  bankCodeLabel: string | null;
  branchCode: string | null;
  accountType: string | null;
  bankCountryCode: string | null;
  payNowIdentifier: string | null;
  payNowIdentifierType: string | null;
  beneficiaryAddressLine1: string | null;
  beneficiaryAddressLine2: string | null;
  beneficiaryCity: string | null;
  beneficiaryState: string | null;
  beneficiaryPostcode: string | null;
}

export type Rail = "BANK" | "PAYNOW";

export interface RecipientPlan {
  rail: Rail;
  /** Wise's snake_case create-time type. NOT the PascalCase form reads return. */
  type: string;
  currency: string;
  accountHolderName: string;
  /**
   * A PROPOSED `details` body. The key names here are a best reading of Wise's
   * corridor documentation and must be reconciled against
   * `GET /v1/quotes/{quoteId}/account-requirements` before being POSTed — that
   * endpoint is the authority, and Wise warns that hardcoding requirements
   * "may result in your application breaking upon a requirements change".
   *
   * There is already one live disagreement to prove the point: the documented
   * `singapore` shape takes `bic`, but the real recipient on this account
   * (`1505954755`, Private Venue Management) stores `{accountNumber, bankCode}`,
   * and its `commonFieldMap` names `bankCode` as the bank-code field. So the
   * values below are trustworthy; the labels on them are not.
   */
  details: Record<string, unknown>;
  /**
   * The same values keyed semantically, for reconciliation against the
   * requirement field keys Wise actually returns. This is the reliable half.
   */
  values: {
    accountNumber: string | null;
    iban: string | null;
    swiftCode: string | null;
    bankCode: string | null;
    branchCode: string | null;
    accountType: string | null;
    legalType: string;
    address: { country: string | null; firstLine: string | null; city: string | null; postCode: string | null; state: string | null };
  };
  /** What binds this recipient to the row, for the cache-validity test. */
  binding: { accountNumber: string | null };
}

export type RecipientOutcome =
  | { ok: true; plan: RecipientPlan }
  | { ok: false; reason: string; missing: string[] };

/**
 * Wise wants `SG`, `US`, `GB`. An invoice may have printed a country name that
 * the extraction failed to code, or nothing at all — in which case a SWIFT/BIC
 * still settles it, since characters 5-6 ARE the ISO-3166 code by definition.
 */
export function resolveCountry(row: VendorRow): string | null {
  const stated = (row.bankCountryCode ?? "").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(stated)) return stated;
  const swift = (row.swiftBic ?? "").trim().toUpperCase();
  if (/^[A-Z]{6}/.test(swift)) return swift.slice(4, 6);
  return null;
}

/** An IBAN is self-identifying: two letters, two check digits, then the account. */
export function looksLikeIban(v: string | null): boolean {
  if (!v) return false;
  return /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(v.replace(/\s+/g, "").toUpperCase());
}

/**
 * Which printed code is this? A 6-digit UK sort code and a 6-digit Australian
 * BSB are indistinguishable by shape, so the LABEL the invoice printed beside
 * the number is what disambiguates them — the whole reason `bank_code_label`
 * is captured. Country is the fallback when the label is unhelpful.
 */
export function classifyBankCode(row: VendorRow, country: string | null): string | null {
  const label = (row.bankCodeLabel ?? "").toLowerCase();
  if (/rout|aba|ach/.test(label)) return "abartn";
  if (/sort/.test(label)) return "sortCode";
  if (/bsb/.test(label)) return "bsbCode";
  if (/ifsc/.test(label)) return "ifscCode";
  if (/institution/.test(label)) return "institutionNumber";
  if (/transit/.test(label)) return "transitNumber";
  if (/bank\s*code|bank\s*id/.test(label)) {
    // "Bank Code" is generic; the corridor decides what it means.
    if (country === "SG") return "bankCode";
    if (country === "JP") return "bankCode";
    return "bankCode";
  }
  return null;
}

const MISSING_LABELS: Record<string, string> = {
  accountNumber: "bank account number",
  iban: "IBAN",
  swiftCode: "SWIFT/BIC",
  abartn: "US routing (ABA) number",
  sortCode: "UK sort code",
  bsbCode: "Australian BSB",
  ifscCode: "Indian IFSC code",
  bankCode: "bank code",
  branchCode: "branch code",
  accountType: "account type (checking or savings)",
  legalType: "whether the payee is a business or an individual",
  accountHolderName: "the name on the account",
  country: "the country the account is held in",
  "address.firstLine": "beneficiary street address",
  "address.city": "beneficiary city",
  "address.postCode": "beneficiary post code",
  "address.country": "beneficiary country",
};

export function describeMissing(keys: string[]): string {
  return keys.map((k) => MISSING_LABELS[k] ?? k).join(", ");
}

/**
 * Build the recipient payload, or say precisely what is missing.
 *
 * `preferredRail` exists because a vendor can legitimately have both. The
 * settled default is BANK: it is deterministic, and it is the rail whose stored
 * details a human can actually verify — a PayNow alias comes back from Wise
 * hashed, so a cached PayNow recipient can be proved identical to last time but
 * never displayed.
 */
export function buildRecipient(
  row: VendorRow,
  currency: string,
  preferredRail: Rail = "BANK",
): RecipientOutcome {
  const holder = (row.accountHolderName ?? "").trim();
  const country = resolveCountry(row);
  const legalType = (row.legalType ?? "").toUpperCase();

  const bankable = Boolean(row.accountNumber || row.iban);
  const paynowable = Boolean(row.payNowIdentifier);
  if (!bankable && !paynowable) {
    return { ok: false, reason: "no payment details stored for this vendor", missing: ["accountNumber"] };
  }

  const rail: Rail = preferredRail === "BANK" ? (bankable ? "BANK" : "PAYNOW") : paynowable ? "PAYNOW" : "BANK";

  // Common to every route. `legalType` has no safe default — Wise requires it
  // and guessing it wrong misroutes a payment — so UNKNOWN fails here rather
  // than being coerced.
  const missing: string[] = [];
  if (!holder) missing.push("accountHolderName");
  if (legalType !== "BUSINESS" && legalType !== "PRIVATE") missing.push("legalType");

  if (rail === "PAYNOW") {
    // Singapore PayNow. Wise's own type key for an alias payout.
    const alias = (row.payNowIdentifier ?? "").trim();
    const kind = (row.payNowIdentifierType ?? "").toUpperCase();
    if (!alias) missing.push("paynowIdentifier");
    if (currency !== "SGD") {
      return {
        ok: false,
        reason: `PayNow only settles SGD, but this bill is ${currency}`,
        missing: [],
      };
    }
    if (missing.length > 0) {
      return { ok: false, reason: `cannot build a PayNow recipient: missing ${describeMissing(missing)}`, missing };
    }
    const identifierType =
      kind === "UEN" ? "SG_UEN" : kind === "MOBILE" ? "SG_MOBILE" : kind === "NRIC" ? "SG_NRIC" : null;
    if (!identifierType) {
      return {
        ok: false,
        reason: `PayNow alias "${alias}" has no usable type (stored: ${kind || "none"})`,
        missing: ["paynowIdentifierType"],
      };
    }
    return {
      ok: true,
      plan: {
        rail: "PAYNOW",
        type: "singapore_paynow",
        currency: "SGD",
        accountHolderName: holder,
        details: { legalType, identifierType, identifierValue: alias },
        binding: { accountNumber: null },
      },
    };
  }

  // ---- bank rails -----------------------------------------------------------
  const iban = looksLikeIban(row.iban) ? (row.iban ?? "").replace(/\s+/g, "").toUpperCase() : null;
  const account = (row.accountNumber ?? "").trim() || null;
  const swift = (row.swiftBic ?? "").trim().toUpperCase() || null;
  const codeKey = classifyBankCode(row, country);
  const code = (row.bankCode ?? "").trim() || null;

  const address = {
    country,
    firstLine: [row.beneficiaryAddressLine1, row.beneficiaryAddressLine2].filter(Boolean).join(", ") || null,
    city: row.beneficiaryCity,
    postCode: row.beneficiaryPostcode,
    state: row.beneficiaryState,
  };
  const requireAddress = () => {
    if (!address.firstLine) missing.push("address.firstLine");
    if (!address.city) missing.push("address.city");
    if (!address.postCode) missing.push("address.postCode");
    if (!address.country) missing.push("address.country");
  };

  let type: string | null = null;
  const details: Record<string, unknown> = { legalType };

  if (iban) {
    // SEPA and the other IBAN corridors. Wise resolves the BIC itself, so a
    // missing SWIFT is not a blocker here.
    type = "iban";
    details.iban = iban;
  } else if (country === "SG" && currency === "SGD") {
    type = "singapore";
    if (!account) missing.push("accountNumber");
    if (!swift && !code) missing.push("bankCode");
    details.accountNumber = account;
    if (swift) details.bic = swift;
    else if (code) details.bankCode = code;
    if (row.branchCode) details.branchCode = row.branchCode;
  } else if (country === "US" && currency === "USD") {
    type = "aba";
    if (!account) missing.push("accountNumber");
    if (codeKey !== "abartn" || !code) missing.push("abartn");
    if (row.accountType !== "CHECKING" && row.accountType !== "SAVINGS") missing.push("accountType");
    requireAddress();
    details.abartn = code;
    details.accountNumber = account;
    details.accountType = (row.accountType ?? "").toLowerCase();
    details.address = address;
  } else if (country === "GB" && currency === "GBP") {
    type = "sort_code";
    if (!account) missing.push("accountNumber");
    if (codeKey !== "sortCode" || !code) missing.push("sortCode");
    details.sortCode = (code ?? "").replace(/-/g, "");
    details.accountNumber = account;
  } else if (country === "AU" && currency === "AUD") {
    type = "australian";
    if (!account) missing.push("accountNumber");
    if (codeKey !== "bsbCode" || !code) missing.push("bsbCode");
    details.bsbCode = code;
    details.accountNumber = account;
  } else if (country === "HK" && currency === "HKD") {
    type = "hongkong";
    if (!account) missing.push("accountNumber");
    if (!swift) missing.push("swiftCode");
    details.bic = swift;
    details.accountNumber = account;
  } else if (country === "IN" && currency === "INR") {
    type = "indian";
    if (!account) missing.push("accountNumber");
    if (codeKey !== "ifscCode" || !code) missing.push("ifscCode");
    details.ifscCode = code;
    details.accountNumber = account;
  } else {
    // Anything else goes over SWIFT. Costs more and intermediary banks may
    // deduct fees, which is worth surfacing to whoever funds it.
    type = "swift_code";
    if (!account) missing.push("accountNumber");
    if (!swift) missing.push("swiftCode");
    details.swiftCode = swift;
    details.accountNumber = account;
    if (currency === "USD" || country === null) requireAddress();
  }

  if (missing.length > 0) {
    return {
      ok: false,
      reason: `cannot build a ${type} recipient for ${currency}${country ? ` (${country})` : ""}: missing ${describeMissing(missing)}`,
      missing,
    };
  }

  for (const k of Object.keys(details)) if (details[k] == null) delete details[k];

  return {
    ok: true,
    plan: {
      rail: "BANK",
      type: type as string,
      currency,
      accountHolderName: holder,
      details,
      binding: { accountNumber: account ?? iban },
    },
  };
}
