# Xero bill approved → Wise transfer

> ## 🗄️ Shelved design record. There is no Zap, and no code in production.
>
> This workflow was designed, built, reviewed — and then **deliberately not deployed**. On
> **2026-08-12** Dennis decided to wait for **Wise's own first-party sync of Xero bills into Wise**
> rather than have this repo own a payment rail.
>
> Nothing was ever published. `xero-invoice-alerts` has exactly one live version
> (`019fd4cc-b3c5-…`, 2026-08-06) and it does not contain any of this. The implementation that
> briefly lived in that directory (`wise.ts`, `wise.test.mjs`, and a moved `recipient.ts`) was
> reverted in full; `recipient.ts` is back here as prior art, at its pre-move version.
>
> **Do not treat this as unfinished work to pick up.** Reopen only if Dennis asks, or if Wise's
> official sync turns out not to cover bill payouts.

## Why it was shelved

Dennis's words: *"This whole process feels too complicated and susceptible to errors."*

That is a judgement about **ownership**, not about whether the code worked. Preparing a payout from
bank details extracted off a PDF invoice means this repo owning corridor requirement mapping,
recipient cache binding, and invoice-redirection fraud guards — permanently, and in money-adjacent
code where a silent wrong answer pays the wrong account. A first-party Wise↔Xero sync moves all of
that to the vendor, who can see both sides.

## What the build learned, for whoever revisits this

Everything in [`payment-details-design.md`](payment-details-design.md) still holds — the Wise profile
constant, the response envelope, the PayNow-is-dominant finding, the read-vs-write enum asymmetry,
the two Tables, the write classes, and the cleared payment-approval rule.

Four findings from the build and its review are worth not rediscovering:

1. **A poller was the wrong trigger by the time the code was written.** The design verified on
   2026-07-30 that `XeroCLIAPI` / `bill` / `status: "authorised"` fires on the DRAFT → AUTHORISED
   transition — correct, and load-bearing. Six days later, on 2026-08-06, five Xero pollers on tenant
   `62699a8c` exhausted Xero's 5,000-calls/day limit, took every Xero Zap down for ~10 hours, and
   dropped two invoices in [`drive-invoice-to-xero`](../drive-invoice-to-xero/). One of the pollers
   retired in that clean-up carried *exactly this trigger*. Any revival should ride
   [`xero-invoice-alerts`](../xero-invoice-alerts/)'s hourly pass (~0 extra Xero calls), not add a
   poller (~1,440/day).

2. **Wise offers an `email` recipient type that needs no bank details at all.** Verified live on
   2026-08-12 by taking a real SGD→USD quote and reading
   `GET /v1/quotes/{id}/account-requirements`. Three types come back:

   | type | required fields |
   | --- | --- |
   | `aba` (ACH) | `legalType`, `abartn`, `accountNumber`, `accountType`, `address.country/firstLine/city/postCode` |
   | `swift_code` (SWIFT) | `legalType`, `accountNumber`, `swiftCode`, `address.country/city/firstLine/postCode` |
   | `email` | **none** — only an optional `language` |

   `email` is the Wise-to-Wise rail: Wise notifies the payee, who claims it into their balance. Both
   subcontractors in `Vendor Payment Details` are already Wise users — their stored "bank" details
   are Wise US receiving accounts (`TRWIUS35XXX` = Wise US Inc) — and Xero already holds their email
   addresses. **But** an email address has no equivalent of the account-number cache binding and is
   not covered by `drive-invoice-to-xero`'s `needs_review` conflict detection, so it is the *weakest*
   rail against invoice redirection. That trade-off was never resolved.

3. **Neither vendor on file can currently be paid in USD.** `aba` genuinely requires `accountType`
   plus a full beneficiary address (finding 2), and both rows have neither. An SGD bill would build a
   `swift_code` recipient pointing at a USD-only account, because `buildRecipient` takes the currency
   from the *bill* and never reads the row's stored `account_currency`. That gap is real and unfixed.

4. **The claim row was a one-way latch.** The build rejected gating on the alert state's
   `last_alerted_status` precisely because it is one-way — then blocked on the mere *existence* of a
   claim row, which has the same flaw. A `dry-run`, a transient Wise error, or a row left at
   `preparing` by a crash would each block that bill's real payment forever, silently. The fix is to
   block only on a completed movement (`wise_transfer_id` present) and reuse the row otherwise. It
   was written and tested but, like everything else here, never shipped.

## Still true: nothing here would have moved money

The design stops at an **unfunded** transfer; a human funds it in Wise. Wise documents that Singapore
business accounts *can* fund over the API, so that was a choice — the house style shared with
`drive-invoice-to-xero` stopping at a draft bill and `xero-overdue-invoice-to-gmail-reminder`
stopping at a Gmail draft.

## Maintainer notes

- The two Tables still exist and are **empty of transfer claims**: `Wise Transfers Prepared`
  (`01KYR680X3GNT4PE1YYDMM43HJ`, 0 rows) and `Vendor Payment Details`
  (`01KYR653H04DNMKKYAZ72534YG`, 2 rows). The latter is still written by `drive-invoice-to-xero` and
  is **not** orphaned — leave it alone.
- **Re-check Wise payment approvals if a team member is ever added.** Approvals configured on
  wise.com are incompatible with API transfer creation (`Quote cannot be accepted with this request
  due to missing approval`, no code workaround). None are configured today, and structurally cannot
  be while this is a single-member account.
- Repo rule 5 does not apply — no Notion pages are created.
