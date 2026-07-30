# Wise payment preparation — design notes

Companion to [`README.md`](README.md), in the spirit of
[`drive-invoice-to-xero/vendor-contact-design.md`](../drive-invoice-to-xero/vendor-contact-design.md):
the evidence and the reasoning behind the Table schemas and the fraud semantics, kept
separate from the operational README so neither has to carry both jobs.

Nothing here is speculative unless it says so. Every Wise fact below was read off the live
work.flowers account on 2026-07-30 via GET-only probes through the API by Zapier
connection, and the probe output is quoted.

---

## Verified account facts

| Fact | Value | How |
| --- | --- | --- |
| Wise business profile | **`80913588`** — `Company Flow Pte. Ltd.`, `type: BUSINESS`, `currentState: VISIBLE`, reg. no. `202442050M` | `GET /v2/profiles` |
| Second profile | `80913698`, `type: PERSONAL`, `currentState: HIDDEN` — never a payment source | same |
| Source currency | SGD (and a USD balance exists) | recipient rails below |
| Domain filter | admits `https://api.wise.com` | probe returned 200 |
| Auth | injected by the connection; **no `Authorization` header was set by the caller** | probe sent `headers: {}` |
| Recipients | 14 active, single page (`size: 14`, `seekPositionForNext: null`) | `GET /v2/accounts?profileId=80913588&active=true` |

`WISE_PROFILE_ID = 80913588` is therefore a module constant, not a per-run lookup — the same
treatment `XERO_ORGANIZATION` gets. A stale constant fails loudly on the next call.

## The response envelope

`sdk.runAction` on `App235435CLIAPI` / `write` / `request` returns:

```
result.data[0].response.status     // HTTP status, number
result.data[0].response.data       // the PARSED JSON body — read this
result.data[0].response.body       // the same thing as a raw string
result.data[0].request.url         // the final serialized URL, query string included
result.data[0].request.headers     // what was actually sent
```

`request.url` is the debugging surface for `query_params`: the array-of-`"key=value"`-strings
form is confirmed working, and the echoed URL is how you check serialization rather than
guessing. Note this is **not** the shape Xero's `_zap_raw_request` returns, and the input
field is `query_params` (ARRAY) here versus `querystring` (OBJECT) there. Do not copy-paste
between the two.

---

## The finding that reshapes the design: PayNow is the dominant rail

Of the 14 active recipients, **9 are PayNow-style alias recipients**, not bank accounts:

```
details: { identifierNetwork: …, identifierAliasHash: … }
commonFieldMap: { branchCodeField: "branchCode" }        // no accountNumberField
accountSummary: ""                                       // empty
```

Only 5 carry a readable account number. The bank-account recipients look like:

```
1414779013 | SGD | SingaporeLocal | INSTITUTION | Eugene Thuraisingam Asia LLC | (7171) 0721445433
      details: { accountNumber, bankCode }
      commonFieldMap: { accountNumberField: "accountNumber", bankCodeField: "bankCode", branchCodeField: "branchCode" }
1501977189 | USD | Aba            | INSTITUTION | Company Flow Pte. Ltd.       | (026073150) 8*******76
      details: { abartn, accountNumber, isSmartRouting, accountType }
1398635273 | USD | FedWireLocal   | PERSON      | Ernest Choo Rui En           | (101019628) 214342208954
      details: { abartn, accountNumber, accountType, balanceAccountProfileId }
```

Three consequences, and the first is the important one:

**1. The cache-validity test as planned cannot work for PayNow recipients.** The plan's
`wise_recipient_account_number` column, and the
`normalizeAccountNumber(stored) === normalizeAccountNumber(invoice)` equality that gates
reuse, both assume a readable account number. A PayNow recipient has none — the alias is
**hashed** (`identifierAliasHash`) and Wise never returns the plaintext UEN or phone number.

So the cache binding needs two shapes, and the rail decides which:

| Rail | Bound by | Column |
| --- | --- | --- |
| Bank account | normalised account number | `wise_recipient_account_number` |
| PayNow alias | `identifierAliasHash` verbatim | `wise_recipient_alias_hash` *(new column)* |

Both remain equalities that must **pass** to proceed, so both still fail closed. What
changes is that a PayNow row's binding is opaque to a human reading the Table — the hash
means nothing to the eye. That is a real loss of legibility on the exact column whose job is
fraud detection, and it must be stated plainly in the README rather than glossed: for PayNow
vendors, the Table can prove *"this is the same alias we paid last time"* but cannot show a
human *which* alias. Verifying a PayNow recipient means opening Wise.

**2. Duplicate recipients per vendor are the norm, not an edge case.** Two vendors already
have one of each rail:

- `Insur-Asia Pte Ltd` — `1448529758` (bank, `(7171) 2889047123`) and `1449908367` (PayNow)
- `Eugene Thuraisingam Asia LLC` — `1414779013` (bank, `(7171) 0721445433`) and `1385900269` (PayNow)

Note also the casing and punctuation drift between the pairs (`Insur-Asia Pte Ltd` vs
`INSUR-ASIA PTE. LTD.`), which is exactly what `normalizeVendor` exists to absorb. The plan
said a multi-match should stop and ask a human; that is now known to fire on a meaningful
share of real vendors, so "ask a human" cannot be the whole answer or the Zap will be a
nuisance. Two options, to decide before building the matcher:

- **(a) Prefer the bank-account rail** when a vendor has both, and only stop when two
  recipients share a rail. Predictable, and the bank rail is the one whose details a human
  can actually verify.
- **(b) Let `payment_method` on the vendor row choose.** More precise, and it makes the
  extracted column load-bearing rather than advisory — but it fails when the invoice's stated
  method and the existing recipients disagree.

**3. `ownedByCustomer: true` marks our own accounts.** `1501977189` (USD ABA) and
`1413979073` (SGD) are Company Flow's own — both named `Company Flow Pte. Ltd.`. A vendor
match must filter `ownedByCustomer === false`. Without that guard, a Xero contact that
normalises anywhere near our own entity name could resolve to our own account and the
workflow would prepare a transfer to ourselves. It costs one predicate; add it.

### The extraction implication

`invoice-extraction-prompt.md:56` currently says, correctly for Xero, that a PayNow QR is not
a bank account and that all three bank fields stay blank. But a PayNow **UEN** is precisely
what Wise needs to build the dominant rail, and invoices do print it — often twice, since a
Singapore vendor's UEN doubles as its tax number (the prompt already notes this at `:44`).
So the field set needs a **PayNow identifier** field (UEN / phone / NRIC) plus its type, and
the prompt must keep the Xero rule intact while allowing the alias to be captured separately.

Lantern Labs INV-26-0007 is the worked case: `drive-invoice-to-xero/zap.json:93` records that
it offers *only* a PayNow QR and a Wise payment link. Under the current field set that
invoice yields no payable details at all. Under the amended set it yields a PayNow recipient.

---

## Type and enum mapping — read differs from write

Two asymmetries, both confirmed against live data, both silent if got wrong:

| Concept | On read (`GET /v2/accounts`) | On create (`POST /v1/accounts`) |
| --- | --- | --- |
| Legal entity | `legalEntityType`: `INSTITUTION` \| `PERSON` | `details.legalType`: `BUSINESS` \| `PRIVATE` |
| Rail | `type`: `SingaporeLocal`, `Aba`, `FedWireLocal` (PascalCase) | `type`: `singapore`, `aba`, … (snake_case) |

So `vendor_legal_type` stores Wise's **create** enum (`BUSINESS`/`PRIVATE`/`UNKNOWN`), and any
comparison against a listed recipient maps `INSTITUTION → BUSINESS`, `PERSON → PRIVATE`.
`FedWireLocal` is a rail the corridor table did not anticipate; the runtime `type` decision
comes from `GET /v1/quotes/{quoteId}/account-requirements`, never from a hardcoded table,
which is what makes an unanticipated rail a non-event.

## Confirmations of existing repo assumptions

- **The DBS normalisation case is real.** `Eugene Thuraisingam Asia LLC` is stored as
  `accountNumber: 0721445433`, `bankCode: 7171` — the same account
  `vendor-contact-design.md:218` records an invoice printing as `072-144543-3`. Comparing
  without `normalizeAccountNumber` (`drive-invoice-to-xero/workflow.ts:474-479`) would raise a
  false fraud alert on the second invoice from this vendor.
- **`customerTransactionId` survives into list results**, so the belt-and-braces idempotency
  guard can match on it client-side (there is no server-side filter for it):

  ```
  1985782006 | outgoing_payment_sent | SGD 6294.66 | cti='005f8365-93e0-c4cb-507e-4639dd9292e7' | ref='INV-0044'
  1875754306 | outgoing_payment_sent | SGD 99      | cti='9632a2da-1acb-4fe3-a324-b0bfe2ec5fdf' | ref='invoice-23028887'
  ```

  Invoice-number references are already the established habit on this account, which is what
  the plan relies on for one-click bank-feed reconciliation in Xero. `reference` appears both
  top-level and at `details.reference` on a transfer.

## The trigger question, settled empirically

**`XeroCLIAPI@2.20.5` trigger `bill` with `status: "authorised"` DOES fire when an existing
DRAFT bill transitions to AUTHORISED.** Measured 2026-07-30, not inferred.

This was the load-bearing unknown in the design. The trigger's own description says "when you
**add** a new bill" and promises nothing about transitions — and it mattered enormously, because
`drive-invoice-to-xero` creates every bill as DRAFT, so DRAFT → AUTHORISED *is* the main path. Had
it not fired, the whole Zap would have needed a scheduled sweep of
`GET /Invoices?where=Type=="ACCPAY" AND Status=="AUTHORISED"` with Table dedupe instead.

Method: two **trigger inboxes** rather than the throwaway probe durable the plan proposed —
`create-trigger-inbox` subscribes to a trigger directly, so nothing had to be published and the
only cleanup was deleting the inboxes. A second inbox on `status: "all"` ran alongside, to
distinguish "never fires on a transition" from "the status filter is applied after dedupe".

| Step | `status: all` | `status: authorised` |
| --- | --- | --- |
| Bill saved as DRAFT | **fired** in ~1 min | silent — correctly filtered |
| Same bill approved | — | **fired** in ~1 min |

So the status filter is applied per poll against the record's *current* state, and a bill the
inbox has already seen and filtered out is re-emitted when it later matches. Both observations
were needed: the draft firing on `all` proves the subscription was live and the silence on
`authorised` was a real filter rather than a dead inbox.

### What the payload carries

Enough that **no `find_invoice_by_id` re-read step is needed**, which saves a task per run:

```
InvoiceID          "6bd4d924-9ec9-441b-a4c1-f7975eabbfe9"   ← already a GUID
Type               "ACCPAY"        Status      "AUTHORISED"
AmountDue          "1.00"          AmountPaid  "0.00"    Total "1.00"
CurrencyCode       "SGD"           Date        "2026-07-30T00:00:00"
DueDate            "2026-08-31T00:00:00"
Contact.ContactID  "996c642d-…"    Contact.Name "…"
InvoicePDF         hydrate|||…                  ← the bill's PDF, as a file ref
```

Three things to build on:

- **Amounts arrive as strings.** `"1.00"`, not `1`. Coerce before comparing.
- **`DueDate` is always present on an AUTHORISED bill** — Xero refuses to approve without one. It
  is absent on drafts, but drafts never reach this Zap.
- **`InvoiceNumber` is absent entirely when the bill has none** — the key is missing, not null.
  Same for `Reference`. The plan puts the invoice number into the Wise transfer's
  `details.reference`, which is what makes the payout self-reconcile against the bill on the Xero
  bank feed, so that needs a **fallback chain**: `InvoiceNumber` → `Reference` → a value derived
  from the contact name and date. Bills raised by `drive-invoice-to-xero` always carry a number;
  hand-entered ones may not.

## The Tables as built

Created 2026-07-30. The live type vocabulary is `string | datetime | labeled_string | decimal |
boolean` — **not** `number`, whatever the SDK reference implies. `labeled_string` *is* creatable via
the CLI, so the plan's fallback-to-`string` contingency was not needed. CLI shapes, none of which
are guessable from `--help`: `create-table-fields` takes `{"name","type"}` (not `"label"`),
`create-table-records` takes `[{"data":{…}}]` with `--key-mode names`, and
`delete-table-records` takes a **bare** record id.

| Table | Id | Key | Fields |
| --- | --- | --- | --- |
| Vendor Payment Details | `01KYR653H04DNMKKYAZ72534YG` | `xero_contact_id` | 38 |
| Wise Transfers Prepared | `01KYR680X3GNT4PE1YYDMM43HJ` | `xero_invoice_id` | 16 |

Round-trip verified against the live table, confirming all three gotchas the plan flagged:
`keyMode: "names"` works in both directions; a `labeled_string` written as a plain string reads back
as `{value, label}`, so `labeledValue()` is mandatory on read; and a datetime written as
`2026-07-30T00:00:00Z` survives verbatim, so the `T00:00:00Z` pinning does its job.

### Two extra columns the PayNow finding forced

`wise_recipient_rail` (`BANK` / `PAYNOW`) and `wise_recipient_alias_hash`. The plan's cache-validity
test assumed a readable account number; a PayNow recipient has none. The rail column says which
binding applies, and the hash column holds the opaque one:

| Rail | Cache binds on |
| --- | --- |
| Bank account | `normalizeAccountNumber(wise_recipient_account_number)` |
| PayNow alias | `wise_recipient_alias_hash` verbatim |

Both remain equalities that must **pass** for the cache to be reused, so both fail closed: drift
degrades to "stops paying", never to "pays the wrong account".

## Write classes — a refinement of the plan

The plan said freeze the payment tuple as a unit and report any disagreement. Built as: **nothing
frozen is ever overwritten** — that part stands unchanged — but *which* disagreements raise
`needs_review` is split in two.

- **Money identity** — `account_number`, `iban`, `swift_bic`, `bank_code`, `branch_code`,
  `paynow_identifier`. A disagreement sets `needs_review` and changes nothing else, not even other
  empty fields, and does not increment `confirmations`: a contradiction is not a corroboration.
- **Descriptive** — `account_holder_name`, `vendor_legal_type`, `account_type`, `account_currency`,
  `bank_country_code`, `paynow_identifier_type`, `bank_code_label`. Filled when empty, never
  overwritten, drift reported in the run output only.

Freezing everything *and* alarming on everything sounds safer and is worse. A vendor reformatting
its own name would raise a fraud alert, and an alert that fires on formatting is an alert nobody
reads — which costs you the one signal that matters. The split keeps the alarm rare enough to be
believed.

The full matrix, the clearing runbook and the known gaps live in
[`../drive-invoice-to-xero/README.md`](../drive-invoice-to-xero/README.md), since that is the Zap
that writes them. Verified by 39 offline assertions against `tsc`'s own emitted output.

## Where the payment tuple comes from

A **second** AI call in `drive-invoice-to-xero`, not extra fields on the existing one. Folding them
in took that call from 21 output fields to 34 and broke the header — 6/6 correct vendor names at 21
fields, 2/6 at 34, the failures naming Company Flow Pte. Ltd. as the vendor. Full evidence in
[`../drive-invoice-to-xero/payment-extraction-prompt.md`](../drive-invoice-to-xero/payment-extraction-prompt.md).

Worth knowing here because it sets what this Zap can expect to find in a row: the tuple is only as
good as one focused call on one PDF, and several real vendors legitimately yield **nothing** payable
— an invoice offering only a Stripe link, or a PayNow QR with no alias printed in text. Those are
correct answers, not extraction failures, and this Zap must return `not-payable-by-transfer` for
them rather than treating an empty row as a bug.

## Cleared: no payment-approval rule

Checked in the Wise UI, 2026-07-30. *Settings → Payment approvals* is in its empty state, and
structurally has to be: Wise's own copy says *"to set a payment approval for yourself, you need
another team member with the permission to approve payments"*, and this account has no other
members.

This mattered because Wise documents that approvals configured on wise.com are **not compatible**
with creating transfers over the API — a personal token against a business account with approvals
gets `Quote cannot be accepted with this request due to missing approval`, with no code
workaround. Re-check it if a team member is ever added with payment permissions; that is the one
change that would break this Zap from outside the codebase.

## Still unverified

- Wise's behaviour on a **repeat `POST /v1/transfers` with the same `customerTransactionId`** —
  documented as deduped, but the response is unspecified. The Table claim row is the primary
  guard for this reason.
- Same `customerTransactionId` with a **different `quoteUuid`** — unspecified, and the reason
  quote and transfer creation must not re-mint a quote for an already-attempted transfer.
- Any **web deep link** to a transfer. Wise documents none.
