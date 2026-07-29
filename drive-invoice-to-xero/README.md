# Drive Invoice → Xero

Durable workflow (trigger **`read`** — "New File in Folder" — `GoogleDriveCLIAPI@1.22.0`) that
takes a purchase-invoice PDF dropped into the Google Drive **Invoices** folder and lands it in
Xero the right way round: attached to the payment if it has already been paid, or raised as a
draft bill if it hasn't. Migrated from the classic Zap *"Record New Bills in Xero"*.

Its upstream is [`gmail-attachments-to-drive-by-type`](../gmail-attachments-to-drive-by-type/),
which is what files invoice PDFs into that folder in the first place.

> **Bills are always created as `draft`.** Nothing here posts to the ledger or pays anything.
> Every outcome is meant to be reviewed in Xero.

> ⚠️ **The vendor-contact handling described below is committed but NOT yet published.** The
> deployed version is `019faae7`, which still passes the invoice's own spelling of the vendor
> straight to `new_bill`. `zap.json` deliberately still records `019faae7`; it is refreshed only
> once a version is actually live. See [Publishing this change](#publishing-this-change).

## What it does

1. **Trigger** — Google Drive *New File in Folder* on **Invoices**, one run per file.
2. **PDF gate** (plain code, no task cost) — anything that isn't `application/pdf`, or is in the
   trash, is skipped. Carried over from the classic Zap's "PDFs only" filter.
3. **Extract — a single AI call.** The PDF itself goes to AI by Zapier (`standard/auto`, built-in
   credentials) as a file input, and one call returns **both** the invoice header and the full
   line-item table. The classic Zap used two calls. The prompt lives in
   [`invoice-extraction-prompt.md`](invoice-extraction-prompt.md).
4. **Rename** — the Drive file becomes `<invoice date> <vendor>`.
5. **Match** — look for a `SPEND` bank transaction for the same vendor, total and currency in the
   *Xero Bank Transactions* Zapier Table. See [Matching](#matching).
6. **Either / or:**
   - **Matched** → upload the PDF as an attachment on that Xero bank transaction. Done.
   - **Not matched** → check Xero for an existing bill with this invoice number, and if there
     isn't one, resolve the vendor's **contact** (see [Vendor contacts](#vendor-contacts)) and
     create a **draft bill** against it. See [Line items](#line-items).

```mermaid
flowchart TD
    T["📄 Google Drive: New File in Folder<br/><i>Invoices · one run per file</i>"] --> G{"PDF?<br/>not trashed?"}
    G -- no --> X["⏹ skip"]
    G -- yes --> AI["🤖 AI by Zapier · get_completion<br/><b>ONE call, PDF as file input</b><br/>→ vendor · number · dates · currency · total<br/>· tax flag · tax basis · line items<br/>· vendor address · phone · tax no. · bank"]
    AI --> V{"vendor<br/>extracted?"}
    V -- no --> X2["⏹ skip — file left alone"]
    V -- yes --> R["Google Drive<br/>rename → '&lt;invoice date&gt; &lt;vendor&gt;'"]
    R --> Q["🔎 Zapier Table<br/><i>Xero Bank Transactions</i><br/>±7d window · free read"]
    Q --> M{"SPEND match?<br/>vendor + total + currency"}

    M -- yes --> A["📎 Xero · upload_attachment<br/>on the bank transaction"]
    M -- no --> D{"bill already in Xero<br/>with this invoice number?"}
    D -- "yes, live" --> X3["⏹ skip — duplicate"]
    D -- no --> C["📇 GET /Contacts<br/>resolve the vendor"]
    C --> CT{"how did it<br/>resolve?"}
    CT -- "one match" --> CE["fill only its EMPTY fields<br/><i>bill binds to the STORED name</i>"]
    CT -- "several" --> CA["⚠️ change nothing<br/>log for a human merge"]
    CT -- "none" --> CC["🆕 create the contact<br/>with address · phone · tax no. · bank"]
    CE --> L{"line items reconcile<br/>to the invoice total?"}
    CA --> L
    CC --> L
    L -- yes --> B["🧾 Xero · new_bill (draft)<br/>extracted lines"]
    L -- "no / none" --> B2["🧾 Xero · new_bill (draft)<br/>single line for the total"]
```

## Matching

The rule is **vendor AND exact total AND same currency AND `SPEND`**, within **±7 days** of the
invoice date or its due date. Vendor names are compared after normalising away legal-entity
suffixes, so `Aspire FT Pte. Ltd.` and `Aspire FT` are the same counterparty — that comparison is
the only thing the classic Zap's AI Agent was really there for, and `normalizeVendor` does it in
code for nothing.

**Amount and currency are required, not tiebreakers.** The classic Zap's Agent was instructed to
"compare transaction amounts if available for additional verification", which is too weak:

| Why it matters | Real case |
| --- | --- |
| A vendor billed several times in one week | Anthropic had **3** transactions within 4 days of one invoice — 104.58 / 133.58 / 99.00. Only the amount picks the right one. |
| A subscription at a fixed price | SimplePay bills **SGD 12 every month**. The ±7d window is what stops a July invoice matching the August payment. |
| One invoice settled by two payments | Aspire FT's 45.90 invoice was paid as **4.92 + 40.98**. Requiring the amount makes this correctly *fail* to match, rather than attaching the invoice to half of it. |

A window this wide is only safe *because* the amount must match exactly. When more than one
transaction still qualifies, the nearest by date wins and the count is logged.

## Vendor contacts

Full rationale and evidence: [`vendor-contact-design.md`](vendor-contact-design.md).

`new_bill` binds a bill to a contact **by name**, and Xero creates a bare contact when nothing
matches exactly. That is how the ledger acquired four duplicate pairs — `Aspire FT` alongside
`Aspire FT Pte. Ltd.`, and the same for `Linear Orbit`, `N9 Offices` and `Private Venue Management`
— and why contacts this Zap created carry no address, bank details or email at all.

Before raising a bill the workflow now pulls the contact list (one `GET /Contacts`, 130 rows in a
single page) and resolves the vendor with the **same** `normalizeVendor` / `vendorMatches` pair used
for bank transactions:

| Resolution | Contact action | Name used on the bill |
| --- | --- | --- |
| Exactly one normalised match | Fill **empty** fields only | The contact's **stored** name |
| Several matches | **Nothing**, logged for a human merge | The invoice's spelling (unchanged behaviour) |
| Containment match + vendor email domain agrees | Fill **empty** fields only | The contact's **stored** name |
| No match | Create the contact with everything extracted | The invoice's spelling |

Two things about this are load-bearing:

- **The bill is created with the resolved contact's stored name.** Resolving a `ContactID` achieves
  nothing on its own, because `new_bill` has no contact-id input — only `contact_name`. Passing the
  invoice's spelling is exactly what mints the duplicates.
- **Containment alone never binds.** Against bank transactions it is safe because an exact amount,
  currency and date must also match. A contact has no such corroboration, and the same rule would
  otherwise merge `LinkedIn` with `LinkedIn Ads`, or `PayPal` with `PAYPAL *FACEBOOK 35314369001 IE`.
  The vendor email domain has to agree, or it is treated as no match.

Xero's own search can't make this decision: `searchTerm` is an unranked substring `contains`, so
`olar` returns both `Olar Software, Inc.` and `Polar Software, Inc.` — two unrelated companies.
Suffix-stripped comparison keeps them apart; similarity scoring would not.

### ⚠️ Bank details are write-once

An emailed invoice asking to be paid into a new account is what invoice-redirection fraud looks
like, and a contact's bank account outlives the bill that introduced it. So:

- Bank details are written **only when creating a new contact**.
- A stored account is **never** overwritten. When the invoice disagrees with it, the workflow leaves
  the record alone and logs a warning naming both — the cheap tripwire — and surfaces it as
  `contact.bankConflict` in the run output.

The same fill-empty-only rule covers address, phone, tax number and email. Existing values are
re-sent with every update, so a contact holding both a `STREET` and a `POBOX` address keeps both.
Bank name and SWIFT/BIC are extracted but have nowhere to go: Xero's `BankAccountDetails` is one
free-text field. They appear in the log and the run output only.

### Cost

Per run, on top of what this Zap already spends. The attach branch is unchanged at zero.

| Case | Added tasks |
| --- | --- |
| Contact matched, nothing to add | +1 |
| Contact matched, fields to fill | +3 (list, full read, write) |
| No match, details extracted | +2 (list, create) |
| No match, nothing extracted | +1 — the create is skipped, since `new_bill` would make the same bare contact for free |

## Line items

The AI returns the line-item table as JSON, and the workflow then checks its own work: the lines
must add up to the total the model read off the same invoice. Tax-inclusive and no-tax lines have
to equal it outright; tax-exclusive lines only have to be a plausible pre-tax subtotal, since the
rate isn't known here.

- **Reconciles** → the extracted lines are used.
- **Doesn't reconcile, or nothing usable came back** → one line for the invoice total, described
  as `<vendor> invoice <number>`.

The fallback matters because a draft bill that doesn't equal the invoice is worse than a bill
without itemisation — the PDF is attached either way, so no detail is actually lost. Grab's
e-receipt is the live example: its four lines sum to 41.20 against a 36.70 total, so it falls back.

Lines worth nothing (a zero quantity, or an "included in your plan" row priced at 0.00) are
dropped so they don't clutter Xero. Vanta's 19-row invoice becomes 10 real lines.

**Tax basis.** The model reports whether unit prices are `Inclusive`, `Exclusive` or `NoTax`, and
that drives Xero's `line_items_type`. The classic Zap never set it, so Xero applied its
`Exclusive` default and could add tax on top of amounts that already contained it. On the
single-line fallback the basis is forced to `Inclusive` (or `NoTax`), because the figure used *is*
the final total. `line_tax_type` is `INPUTY24` (Standard-Rated Purchases) when tax applies, else
`NONE` — as in the classic Zap.

## Duplicate guard

Before creating a bill, Xero is queried for an existing `ACCPAY` invoice with the same
`InvoiceNumber`. `DELETED` and `VOIDED` bills don't count — they're gone from the ledger and must
not block a legitimate re-create. This is the one extra task cost, and only on the create branch.

It exists because the Invoices folder does accumulate duplicates: it currently holds two identical
`2026-07-15 Vanta Inc` files.

## ⚠️ The Table is a dependency, and it fails silently

The match reads the **Xero Bank Transactions** Zapier Table
(`01KCDV6Y17F31J2Q6S1EMYZC8K`), not Xero's API, because Table reads cost no tasks. That Table is
populated by a **separate Zap** ("Process New Reconciled Transactions"), so:

> **This workflow is only as correct as that Zap is current.**

On 2026-07-28 that Zap's create step was paused and the Table had quietly fallen ~5 days behind —
**7 of 43** live `SPEND` transactions over 2026-06-01..2026-07-28 were missing, all of them the
newest ones. Nothing errored. The only visible symptom was duplicate draft bills appearing in
Xero and being deleted by hand.

Because the transaction that matters is almost always the *most recent* one, staleness in this
Table converts directly into duplicate bills. The run output carries **`tableStale`** — true when
the date window came back with no rows at all — as the cheap tripwire, and the same condition is
logged as a warning. It is not proof (a genuinely quiet week looks identical), so if duplicate
bills start appearing, check that the populating Zap is enabled first.

Querying Xero live instead would remove the coupling at the cost of ~1 task per invoice; that
trade-off was considered and the Table was chosen deliberately.

## Verified behaviour

Extracted with `standard/auto` from the real PDFs in the Invoices folder, matched against the real
Table contents (2026-07-28). "Outcome" is what the deployed matcher decides.

| Invoice | Extracted | Table candidates | Outcome |
| --- | --- | --- | --- |
| `2026-07-19 SimplePay Pte Ltd` | SGD 12.00, no tax, 1 line | SGD 12 on 2026-07-19, **lag 0d** | ✅ **Attach** to `487b3963` |
| `2026-07-24 Anthropic, PBC` | SGD 104.58, no tax, 2 lines → 1 (one 0-qty dropped) | none — newest Anthropic row in the Table is USD 99 (2026-07-20) | ⚠️ **Draft bill** — the SGD 104.58 payment *does* exist in Xero (2026-07-25); it is missing from the Table. This is the staleness above, not a matcher fault. |
| `2026-07-07 Aspire FT Pte. Ltd.` | SGD 45.90, tax | 4.92 and 40.98 on 2026-07-06 — neither equals 45.90 | ✅ **Draft bill** (split payment correctly declined) |
| `2026-07-14 Brilliant Color Printing Services LLP` | SGD 384.00, no tax | SGD 228 on 2026-07-07 — amount differs | ✅ **Draft bill** |
| `2026-07-16 Grab` | SGD 36.70, no tax, 4 lines summing to 41.20 | no vendor match | ✅ **Draft bill**, single-line fallback at 36.70 |
| `2026-07-14 Private Venue Management Pte Ltd` | SGD 1362.50, **tax**, `Exclusive`, 4 lines summing to 1250.00 | no vendor match | ✅ **Draft bill**, extracted lines (1250 × 1.09 = 1362.50 ✓) |
| `2026-07-15 Vanta Inc` | USD 18178.94, `Exclusive`, 19 lines → 10 (9 zero-value dropped), reconciles | no vendor match | ✅ **Draft bill**, extracted lines |
| `2026-07-15 Vanta Inc` | SGD 8389.27, `Inclusive`, 1 line | no vendor match | ✅ **Draft bill**, extracted lines |
| `2026-07-06 MyRepublic Limited` | SGD 8.71, tax | no vendor match | ✅ **Draft bill** |
| `2026-07-02 Slack Technologies Limited` | USD 82.24, no tax | no vendor match | ✅ **Draft bill** |

Vendor-suffix normalisation, line-item parsing, reconciliation and the match rule are covered by
unit checks run against this same data; all passed. A non-PDF payload was run through the deployed
runtime (`run-durable`) and skipped correctly.

### Contact resolution

Checked offline against the **real** 130-contact ledger (2026-07-28), with the resolver and payload
builder transpiled straight out of `workflow.ts` rather than re-implemented — 47 assertions, all
passing. What they establish:

| Case | Result |
| --- | --- |
| The 8 unambiguous invoice vendors above | Resolve to exactly one contact |
| `Aspire FT Pte. Ltd.`, `Private Venue Management Pte Ltd` | Correctly **ambiguous** — contacts left alone |
| `Olar Software, Inc.` vs `Polar Software, Inc.` | Stay distinct |
| `Wise Business Ltd` with no email | Containment found, **not** bound |
| Same, with a `wise.com` email on both sides | Bound, `via: email-corroborated` |
| Same, with a disagreeing domain | Not bound |
| Enriching the real bare `Lantern Labs` record | Fills address/phone/bank/tax; both address types and all four phone rows survive |
| A fully populated contact (`Ernest Choo`'s real shape) | Nothing written at all |
| Invoice bank account differs from the stored one | Stored value kept, conflict reported |
| Same account, different punctuation | Not a conflict |
| Bank mismatch with nothing else to fill | Still reported |

### Vendor-detail extraction, `standard/auto`

Run against the real PDFs through a throwaway extraction-only durable (see
[`vendor-contact-design.md`](vendor-contact-design.md)). Ground truth was read off the documents
first, so these are scored, not eyeballed.

| | `2026-07-28 Lantern Labs Pte. Ltd.` | `2026-07-24 Anthropic, PBC` |
| --- | --- | --- |
| Address | `11 COLLYER QUAY` / `#17-00`, SINGAPORE 049317 ✅ | `548 Market Street` / `PMB 90375`, San Francisco, California 94104, United States ✅ |
| Phone | `+65 8801 4107` ✅ | empty ✅ (none printed) |
| Tax number | `202117064E` ✅ (the vendor's UEN) | `M90375715E` ✅ — Anthropic's, **not** workFlowers' `202442050M` |
| Bank account | `8311123520` ✅ | **empty** ✅ — the cheque "PAYMENT ADDRESS" PO Box was correctly *not* treated as a remittance block |
| SWIFT | `CMFGUS33` ✅ | empty ✅ |
| Bank name | ⚠️ `Lantern Labs Pte. Ltd.` — the account **holder**, not the bank. Prompt now says so explicitly. Log-only field, never written to Xero. | empty ✅ |
| Currency | ⚠️ `US$` on one run, `USD` on another | `SGD` ✅ |

Anthropic's invoice is the hard case for **layout** and it passed: the vendor and recipient
addresses interleave line-by-line in a two-column header, and two tax numbers sit on the page. Both
were attributed correctly, and that result holds regardless of anything else about the document.

> **It is not a valid control for the bank fields, though.** That invoice was already paid by card
> the moment it was issued and should never have reached the Invoices folder at all — the gap that
> let it through has since been closed in
> [`gmail-attachments-to-drive-by-type`](../gmail-attachments-to-drive-by-type/), which now
> classifies per email and files a settled invoice as a receipt. So "no remittance block, bank
> fields correctly empty" was demonstrated on a document outside this Zap's real population.
>
> **The control still needs running on a genuinely outstanding invoice that offers only a portal or
> card link** — `2026-07-02 Slack Technologies Limited` or `2026-07-15 Vanta Inc` are the
> candidates. Until then, treat "does not invent a bank account" as untested for the invoices that
> actually reach the create-bill branch.

Which cuts the other way too, and matters for the write-once rule: the invoices that reach this
branch are by definition **unpaid**, and an unpaid invoice usually prints the account it wants
paying into. Both genuinely outstanding invoices read for ground truth (Lantern Labs, Eugene
Thuraisingam) carry a full remittance block. The bank-detail path will fire often, not rarely.

> ### ⚠️ Non-required output fields are silently dropped
>
> The first run of this harness returned **only the nine `isRequired: true` fields** — no address,
> no phone, no tax number, no bank details — from an invoice that plainly prints all of them. AI by
> Zapier omits an `isRequired: false` output field from the structured response entirely; the model
> is never asked for it.
>
> **Every vendor-detail field is therefore `isRequired: true`,** and the prompt carries the
> counterweight: an empty string is always acceptable and is the right answer when the invoice
> doesn't state the value. Anthropic's run is the evidence that this doesn't induce invention — all
> three bank fields came back empty.
>
> This also explains a **pre-existing** gap: `Vendor Email Address` shipped as optional in version
> `019faae7`, so `header.vendorEmail` has always been null in production. It is required now.

**Currency is normalised in code, not trusted from the model.** `toCurrencyCode` maps `US$` → `USD`,
`S$` → `SGD` and friends, takes a standalone three-letter token out of something like `USD 7,750`,
and falls back to the org default on a bare `$`. An unnormalised `US$` would fail the
bank-transaction currency comparison — raising a duplicate draft bill for an already-paid invoice —
and then reach Xero as the bill's currency.

## ⚠️ `new Date()` in the workflow body is a hard error

The first published version (`019fa878`) **failed on every PDF invoice** with:

```
DeterminismViolation: Non-deterministic API "new Date()" called in GUARDED mode.
  at toIsoDate (workflow.ts:187)
```

The durable runtime replaces `Date` with a Proxy before your code runs, and its `construct` trap
calls `assert()` **before** it looks at the arguments — so `new Date(Date.UTC(y, m, d))`, which is
perfectly deterministic, is rejected exactly as hard as a clock read. `Date.now()` is guarded too
(via the `get` trap); `Date.UTC` happens not to be, but this file no longer relies on that.

The fix, and the rule for anything added here:

- **Calendar arithmetic is integer arithmetic.** `daysFromCivil` / `isoDateFromEpochMs` (Hinnant's
  civil-from-days pair, also in [`xero-overdue-invoice-to-gmail-reminder`](../xero-overdue-invoice-to-gmail-reminder/))
  and `daysInMonth`. **`Date` is not referenced anywhere in this file.** Don't reintroduce it.
- **Reading the clock goes in a `ctx.step`.** The `today` step is the only place a current time is
  obtained, so its value is fixed for every retry of a run. It runs only when the model gave no
  usable invoice date.

Two things made this invisible until production, both worth remembering:

1. **Nothing upstream catches it.** The guard is a runtime component of `@zapier/zapier-durable`,
   not a lint or a publish-time check, so `tsc` passed and `publish-workflow-version` succeeded.
2. **The pre-publish test missed it by construction.** The only end-to-end `run-durable` test was a
   non-PDF payload, which returns at the PDF gate — before the AI step, and therefore before the
   line that threw. A skip-path test cannot exercise the main path. Test with a real PDF payload.

`toIsoDate` also got stricter as a side effect. Its old NaN check never actually fired: `Date.UTC`
normalises overflow instead of failing, so `2026-13-05` rolled into 2027 and the *original* string
was returned and passed to Xero as a bill date. An impossible month or day is now rejected and
falls through to the `today` fallback.

**Replayed after the fix.** The failed Lantern Labs run was re-fired with its original trigger
payload on version `019faae7`: all five steps completed, the file was renamed to
`2026-07-28 Lantern Labs Pte. Ltd.`, no bank-transaction match was found (correctly — the invoice
is unpaid, due 2026-08-28), and draft bill `99ea5905-aa60-4327-bcb7-984c1013e3e3` was raised for
USD 7,750.00 with the PDF attached.

## Model tier

`standard/auto` — 1× tasks per run. Standard read every invoice above correctly, including
Vanta's 19-row table and the tax-basis judgement, so there was no reason to inherit Zapier's
Advanced default (which exists mainly to enable tool calls; this step makes none). The classic Zap
pinned `google/gemini-2.5-flash-lite` explicitly; the tier sentinel on built-in credentials
replaces that. Re-run the table above before changing tier.

## Publishing this change

There were no Zapier CLI credentials on the machine this was written on, so the contact work is
committed but unpublished. To ship it, from this directory:

```bash
SOURCE_FILES="$(jq -n --rawfile workflow workflow.ts '{"workflow.ts": $workflow}')"

npx zapier-sdk --experimental publish-workflow-version 019fa877-c2c2-72aa-962d-525aa58ebf0e "$SOURCE_FILES" \
  --dependencies '{"zod":"4.4.3","@zapier/zapier-sdk":"0.91.0"}' \
  --zapier-durable-version 0.10.1 \
  --connections '{"gdrive":{"connectionId":"02eb8724-3fc7-8edc-9b30-be83af0b327f"},"xero_wf":{"connectionId":"02336808-1736-878b-a0a8-87e02bb0aec3"}}' \
  --trigger '<the trigger object from get-workflow-version>' \
  --enabled --json
```

Then refresh `zap.json` (`current_version_id`, `version_created_at`, a `version_history` entry) and
drop the "not yet published" banner at the top of this file.

- **Flag names are kebab-case** — `--zapier-durable-version`, `--app-versions`. The `workflows-*`
  skills were validated against SDK CLI 0.54.3 and document the snake_case spellings; 0.67.5's own
  `--help` is the authority.
- **Fetch the trigger object rather than retyping it** — `get-workflow-version <workflow-id>
  019faae7-848d-764e-b6a3-075e28c77566 --json` — and pass it through unchanged. Dropping it
  silently unbinds the Drive poll.
- **Test with a real PDF payload, not a skip-path one.** The determinism bug below survived
  publishing precisely because the only end-to-end test returned at the PDF gate.
- A polling trigger consumes each file once, so pair any failed run with a manual replay.

## Maintainer notes

- **`new_bill` has no contact-id input.** `contact_name` is the only handle it offers, so a resolved
  `ContactID` has to be turned back into a name before the bill is created. This is the single
  easiest thing to break here — resolve the contact correctly, pass `header.vendor` anyway, and Xero
  quietly creates the duplicate you just went to the trouble of avoiding.
- **Contacts are written through `_zap_raw_request`, not Zapier's `contact` action.** That action
  flattens to a **single** address (`address__line1`, one `address__type_of`), so preserving a
  contact that holds both a `STREET` and a `POBOX` address is impossible through it. The raw
  endpoint takes the whole `Addresses` array, which makes read-modify-write safe.
- **Xero's update-merge semantics are unverified** — specifically whether posting one address type
  clears the other. Every update re-sends the existing values, so the answer doesn't change the
  outcome. Confirm it against a throwaway contact before relaxing that.
- **`where=IsSupplier==true` is rejected** by this org: *"Due to the high number of contacts being
  processed, this filter cannot be used"*. The full list comes back instead and is filtered in code.
- **`summaryOnly=true` omits `Addresses`, `Phones` and `TaxNumber`** but does return `EmailAddress`
  and `BankAccountDetails`. That's why a matched contact is re-read in full before enrichment.
- **A second page suppresses contact creation.** At 130 contacts one page covers it; if the ledger
  outgrows `CONTACT_PAGE_SIZE`, "no match" stops being evidence that a contact is absent, so the
  workflow declines to create rather than risk a duplicate.
- **The Drive connection is bound twice** — on the trigger (which polls the folder) *and* as the
  `gdrive` alias, because the code renames the file. Both are the same connection id.
- **`_zap_raw_request` on Xero needs the `Xero-Tenant-Id` header.** Its input schema has no
  `organization` field and silently strips one, so an org-scoped call otherwise fails with
  *"Please select an organization to perform this step on."*
- **`new_bill`'s `number` maps to Xero's `InvoiceNumber`**, not `Reference` — verified against
  bills the classic Zap created.
- **No catch URL.** This is a polling trigger, so there is nothing external to repoint; the
  cutover is just turning the classic Zap off. Disabling the workflow moves the trigger to
  `released` and re-enabling reclaims it as `active`.
- **`@zapier/zapier-durable` is pinned to 0.10.1.** 0.11.0 was npm-latest at build time but only
  ~20h old, and the runtime rejects dependencies younger than 24h at *run* time, not publish.
- The classic Zap renamed files to `" <date> <vendor>"` with a leading space; this one doesn't,
  and strips `/` from vendor names.
- **Never write `new Date` in the workflow body** — see the determinism section above. Integer date
  helpers are already here; use them.
- **A polling trigger consumes a file once.** A run that fails is not retried (a
  `DeterminismViolation` is a terminal *user* error, not a transient one) and the trigger will not
  re-deliver that file, so a fix has to be paired with a manual replay: re-fire the workflow with
  the failed run's original trigger payload. The `file` hydrate reference in that payload was still
  valid ~7 hours later.
