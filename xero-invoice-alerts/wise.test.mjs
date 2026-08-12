// Offline assertions for the Wise channel's pure logic.
//
// Run against tsc's OWN emitted output (`npm test` compiles first), not against
// a hand-written copy of the logic — the point is to exercise the code that
// actually ships. Nothing here touches Wise, Xero or a Table.
//
// The fixtures are the real shapes read off the live Wise account on
// 2026-07-30 and recorded in
// ../xero-bill-approved-to-wise-transfer/payment-details-design.md.
import assert from "node:assert/strict";
import { fillRequirements, selectRecipient, cacheBindingHolds, buildReference, readRecipient } from "./dist/wise.js";
import { buildRecipient } from "./dist/recipient.js";

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`FAIL: ${name}\n  ${err.message}`);
    process.exitCode = 1;
  }
}

// --- fixtures ---------------------------------------------------------------

const SG_ROW = {
  accountHolderName: "Eugene Thuraisingam Asia LLC",
  legalType: "BUSINESS",
  accountNumber: "072-144543-3",
  iban: null,
  swiftBic: null,
  bankCode: "7171",
  bankCodeLabel: "Bank Code",
  branchCode: null,
  accountType: null,
  bankCountryCode: "SG",
  payNowIdentifier: null,
  payNowIdentifierType: null,
  beneficiaryAddressLine1: null,
  beneficiaryAddressLine2: null,
  beneficiaryCity: null,
  beneficiaryState: null,
  beneficiaryPostcode: null,
};

const PAYNOW_ROW = { ...SG_ROW, accountNumber: null, bankCode: null, payNowIdentifier: "202442050M", payNowIdentifierType: "UEN" };

/** Wise's real answer shape for the `singapore` corridor. */
const SG_REQUIREMENTS = [
  {
    type: "singapore",
    fields: [
      { name: "Legal type", group: [{ key: "legalType", required: true, valuesAllowed: [{ key: "BUSINESS" }, { key: "PRIVATE" }] }] },
      { name: "Bank code", group: [{ key: "bankCode", required: true }] },
      { name: "Account number", group: [{ key: "accountNumber", required: true }] },
    ],
  },
];

// --- fillRequirements -------------------------------------------------------

check("fills the keys Wise ASKED for, not the ones the corridor table guessed", () => {
  const built = buildRecipient(SG_ROW, "SGD", "BANK");
  assert.equal(built.ok, true);
  const fill = fillRequirements(SG_REQUIREMENTS, built.plan);
  assert.equal(fill.ok, true, `unmet: ${fill.unmet} rejected: ${fill.rejected}`);
  // The invoice printed `072-144543-3`; Wise stores `0721445433`. The separators
  // are formatting, and sending them through is how a good payment gets a 422.
  assert.deepEqual(fill.details, { legalType: "BUSINESS", bankCode: "7171", accountNumber: "0721445433" });
  assert.equal(fill.type, "singapore");
});

check("Wise's own validationRegexp rejects a bad value for free", () => {
  const built = buildRecipient(SG_ROW, "SGD", "BANK");
  const reqs = [
    { type: "singapore", fields: [{ group: [{ key: "accountNumber", required: true, validationRegexp: "^\\d{4}$" }] }] },
  ];
  const fill = fillRequirements(reqs, built.plan);
  assert.equal(fill.ok, false);
  assert.match(fill.rejected[0], /fails Wise's own format check/);
});

check("an un-compilable regexp from Wise must not block a good payment", () => {
  const built = buildRecipient(SG_ROW, "SGD", "BANK");
  const reqs = [{ type: "singapore", fields: [{ group: [{ key: "accountNumber", required: true, validationRegexp: "([" }] }] }];
  assert.equal(fillRequirements(reqs, built.plan).ok, true);
});

check("a PayNow mobile alias keeps its + rather than being normalised", () => {
  const built = buildRecipient({ ...PAYNOW_ROW, payNowIdentifier: "+6591234567", payNowIdentifierType: "MOBILE" }, "SGD", "PAYNOW");
  assert.equal(built.ok, true, built.reason);
  const reqs = [
    { type: "singapore_paynow", fields: [{ group: [{ key: "identifierValue", required: true }] }] },
  ];
  assert.equal(fillRequirements(reqs, built.plan).details.identifierValue, "+6591234567");
});

check("a required key we cannot supply is reported, not silently dropped", () => {
  const built = buildRecipient(SG_ROW, "SGD", "BANK");
  const reqs = [{ type: "singapore", fields: [{ group: [{ key: "email", required: true }] }] }];
  const fill = fillRequirements(reqs, built.plan);
  assert.equal(fill.ok, false);
  assert.deepEqual(fill.unmet, ["email"]);
});

check("a value outside Wise's valuesAllowed is rejected before the 422", () => {
  const built = buildRecipient({ ...SG_ROW, legalType: "PRIVATE" }, "SGD", "BANK");
  const reqs = [{ type: "singapore", fields: [{ group: [{ key: "legalType", required: true, valuesAllowed: [{ key: "BUSINESS" }] }] }] }];
  const fill = fillRequirements(reqs, built.plan);
  assert.equal(fill.ok, false);
  assert.deepEqual(fill.rejected, ['legalType="PRIVATE"']);
});

check("an unanticipated rail name is a non-event when Wise offers exactly one", () => {
  const built = buildRecipient(SG_ROW, "SGD", "BANK");
  // `FedWireLocal` is the rail the corridor table did not predict.
  const reqs = [{ type: "fedwire_local", fields: [{ group: [{ key: "accountNumber", required: true }] }] }];
  const fill = fillRequirements(reqs, built.plan);
  assert.equal(fill.ok, true);
  assert.equal(fill.type, "fedwire_local");
});

check("dotted requirement keys become a nested address object", () => {
  const row = {
    ...SG_ROW,
    bankCountryCode: "US",
    accountNumber: "214342208954",
    bankCode: "101019628",
    bankCodeLabel: "Routing number",
    accountType: "CHECKING",
    beneficiaryAddressLine1: "1 Market St",
    beneficiaryCity: "San Francisco",
    beneficiaryPostcode: "94105",
  };
  const built = buildRecipient(row, "USD", "BANK");
  assert.equal(built.ok, true, built.reason);
  const reqs = [
    {
      type: "aba",
      fields: [
        { group: [{ key: "abartn", required: true }] },
        { group: [{ key: "address.country", required: true }] },
        { group: [{ key: "address.city", required: true }] },
      ],
    },
  ];
  const fill = fillRequirements(reqs, built.plan);
  assert.equal(fill.ok, true, `unmet: ${fill.unmet}`);
  assert.deepEqual(fill.details.address, { country: "US", city: "San Francisco" });
  assert.equal(fill.details.abartn, "101019628");
});

// --- selectRecipient --------------------------------------------------------

const OUR_OWN = readRecipient({
  id: 1501977189,
  currency: "USD",
  type: "Aba",
  legalEntityType: "INSTITUTION",
  name: { fullName: "Company Flow Pte. Ltd." },
  details: { accountNumber: "8000000076", abartn: "026073150" },
  ownedByCustomer: true,
});
const INSUR_BANK = readRecipient({
  id: 1448529758,
  currency: "SGD",
  type: "SingaporeLocal",
  legalEntityType: "INSTITUTION",
  name: { fullName: "Insur-Asia Pte Ltd" },
  details: { accountNumber: "2889047123", bankCode: "7171" },
  ownedByCustomer: false,
});
const INSUR_PAYNOW = readRecipient({
  id: 1449908367,
  currency: "SGD",
  type: "SingaporeLocal",
  legalEntityType: "INSTITUTION",
  name: { fullName: "INSUR-ASIA PTE. LTD." },
  details: { identifierNetwork: "PAYNOW", identifierAliasHash: "abc123hash" },
  ownedByCustomer: false,
});

check("our own accounts are never a payee", () => {
  const got = selectRecipient([OUR_OWN], "Company Flow Pte. Ltd.", "USD", "BANK");
  assert.equal(got.recipient, null);
  assert.equal(got.ambiguous.length, 0);
});

check("a vendor with both rails resolves to the bank one rather than stopping", () => {
  const got = selectRecipient([INSUR_PAYNOW, INSUR_BANK], "Insur-Asia Pte. Ltd.", "SGD", "BANK");
  assert.equal(got.recipient?.id, 1448529758);
  assert.equal(got.ambiguous.length, 0);
});

check("casing and punctuation drift between the pair still matches", () => {
  const got = selectRecipient([INSUR_PAYNOW], "Insur-Asia Pte Ltd", "SGD", "PAYNOW");
  assert.equal(got.recipient?.id, 1449908367);
});

check("two recipients on the SAME rail is the one genuinely ambiguous case", () => {
  const twin = readRecipient({
    id: 1448529759,
    currency: "SGD",
    type: "SingaporeLocal",
    legalEntityType: "INSTITUTION",
    name: { fullName: "Insur-Asia Pte Ltd" },
    details: { accountNumber: "9999999999", bankCode: "7171" },
    ownedByCustomer: false,
  });
  const got = selectRecipient([INSUR_BANK, twin], "Insur-Asia", "SGD", "BANK");
  assert.equal(got.recipient, null);
  assert.equal(got.ambiguous.length, 2);
});

check("a recipient in the wrong currency is not a match", () => {
  const got = selectRecipient([INSUR_BANK], "Insur-Asia Pte Ltd", "USD", "BANK");
  assert.equal(got.recipient, null);
});

check("read-side legal type is mapped to the create-side enum", () => {
  assert.equal(INSUR_BANK.legalType, "BUSINESS");
  assert.equal(readRecipient({ legalEntityType: "PERSON" }).legalType, "PRIVATE");
});

check("a hashed alias identifies the PayNow rail", () => {
  assert.equal(INSUR_PAYNOW.rail, "PAYNOW");
  assert.equal(INSUR_PAYNOW.aliasHash, "abc123hash");
  assert.equal(INSUR_BANK.rail, "BANK");
});

// --- cacheBindingHolds ------------------------------------------------------

check("the DBS normalisation case does not raise a false alarm", () => {
  const built = buildRecipient(SG_ROW, "SGD", "BANK");
  const stored = { wise_recipient_rail: "BANK", wise_recipient_account_number: "0721445433" };
  assert.equal(cacheBindingHolds(stored, built.plan, null).ok, true);
});

check("a changed account number fails CLOSED", () => {
  const built = buildRecipient({ ...SG_ROW, accountNumber: "999-999999-9" }, "SGD", "BANK");
  const stored = { wise_recipient_rail: "BANK", wise_recipient_account_number: "0721445433" };
  const got = cacheBindingHolds(stored, built.plan, null);
  assert.equal(got.ok, false);
  assert.match(got.reason, /0721445433/);
});

check("a PayNow cache binds on the hash, and a missing hash fails closed", () => {
  const built = buildRecipient(PAYNOW_ROW, "SGD", "PAYNOW");
  assert.equal(built.ok, true, built.reason);
  assert.equal(cacheBindingHolds({ wise_recipient_rail: "PAYNOW", wise_recipient_alias_hash: "h" }, built.plan, null).ok, true);
  assert.equal(cacheBindingHolds({ wise_recipient_rail: "PAYNOW" }, built.plan, null).ok, false);
});

check("a rail change invalidates the cache", () => {
  const built = buildRecipient(SG_ROW, "SGD", "BANK");
  const got = cacheBindingHolds({ wise_recipient_rail: "PAYNOW", wise_recipient_alias_hash: "h" }, built.plan, null);
  assert.equal(got.ok, false);
});

// --- buildReference ---------------------------------------------------------

check("the reference falls back through number, then Reference, then contact+date", () => {
  assert.equal(buildReference("INV-0044", "ignored", "Insur-Asia", "2026-08-11"), "INV-0044");
  assert.equal(buildReference(null, "PO-99", "Insur-Asia", "2026-08-11"), "PO-99");
  assert.equal(buildReference(null, null, "Insur-Asia", "2026-08-11"), "Insur-Asia 2026-08-11");
  assert.equal(buildReference(null, null, null, null), "Xero bill");
});

check("the reference is truncated to what Wise accepts", () => {
  const got = buildReference("X".repeat(80), null, null, null);
  assert.equal(got.length, 40);
});

// --- buildRecipient guards --------------------------------------------------

check("PayNow only settles SGD", () => {
  const got = buildRecipient(PAYNOW_ROW, "USD", "PAYNOW");
  assert.equal(got.ok, false);
  assert.match(got.reason, /PayNow only settles SGD/);
});

check("a vendor with no payable details at all is declined, not guessed at", () => {
  const bare = { ...SG_ROW, accountNumber: null, iban: null, bankCode: null };
  const got = buildRecipient(bare, "SGD", "BANK");
  assert.equal(got.ok, false);
  assert.match(got.reason, /no payment details stored/);
});

check("an unknown legal type blocks rather than being coerced", () => {
  const got = buildRecipient({ ...SG_ROW, legalType: null }, "SGD", "BANK");
  assert.equal(got.ok, false);
  assert.match(got.reason, /business or an individual/);
});

check("the bank rail is preferred but falls back to PayNow when unbankable", () => {
  const got = buildRecipient(PAYNOW_ROW, "SGD", "BANK");
  assert.equal(got.ok, true, got.reason);
  assert.equal(got.plan.rail, "PAYNOW");
  assert.equal(got.plan.values.identifierType, "SG_UEN");
});

console.log(`${passed} assertions passed`);
