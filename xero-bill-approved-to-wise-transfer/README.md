# Xero bill approved → Wise transfer

> ## 📦 This is a design record, not a Zap directory.
>
> The workflow it specifies **ships as the `wise-transfer` channel of
> [`xero-invoice-alerts`](../xero-invoice-alerts/)**, not as its own Zap. The code lives there:
> [`wise.ts`](../xero-invoice-alerts/wise.ts), [`recipient.ts`](../xero-invoice-alerts/recipient.ts)
> (moved out of this directory), and [`wise.test.mjs`](../xero-invoice-alerts/wise.test.mjs).
>
> What stays here is [`payment-details-design.md`](payment-details-design.md) — the live-account
> evidence behind the Table schemas and the fraud semantics, all of it still current.

## Why it is not its own Zap

The design settled on a `XeroCLIAPI` / `bill` / `status: "authorised"` **polling** trigger, and
verified empirically on 2026-07-30 that it fires on a DRAFT → AUTHORISED transition. That was the
load-bearing unknown, and the answer was right.

Six days later the trigger became the wrong choice. On **2026-08-06**, five Xero polling triggers on
tenant `62699a8c` exhausted Xero's 5,000-calls/day limit, took every Xero Zap in the workspace down
for ~10 hours, and dropped two invoices in [`drive-invoice-to-xero`](../drive-invoice-to-xero/). One
of the pollers retired in that clean-up was `xero-bill-approved-to-subcontractor-email` — carrying
**exactly this trigger**. Adding it back would have put ~1,440 calls/day onto the tenant that had
just gone down, for an event another Zap was already detecting.

[`xero-invoice-alerts`](../xero-invoice-alerts/) already classifies `ACCPAY` + `AUTHORISED`, already
runs hourly for ~24 Xero calls/day, and already re-reads the invoice. Riding along on that read
costs **zero additional Xero calls**.

| | Xero calls/day |
| --- | --- |
| This Zap as designed, on its own poller | ~1,440 |
| As a channel of `xero-invoice-alerts` | **0** |

The Zapier-side cost is unchanged either way — the Wise calls are the same calls.

## What survived the move, and what changed

Everything in [`payment-details-design.md`](payment-details-design.md) still holds: the Wise profile
constant, the response envelope, the PayNow-is-dominant finding, the read-vs-write enum asymmetry,
the two Tables, the write classes, and the cleared payment-approval rule. So does the shape of the
workflow — guard ladder, claim row, reuse-or-create recipient, quote, unfunded transfer, stop.

Three things changed in the build:

1. **The trigger**, as above.
2. **The dedupe.** The channel is deliberately **not** gated on the alerting Zap's
   `last_alerted_status`. That latch answers "have we announced this status?", which is a different
   question from "has this bill been paid?" — and it is one-way, so an hour where the Wise call
   failed would never be retried. The channel carries its own claim row instead, keyed on the Xero
   `InvoiceID`, so re-entering every hour is free and self-healing.
3. **Requirement reconciliation is real now.** `recipient.ts` still proposes `details` key names from
   the corridor docs, but `fillRequirements` in `wise.ts` maps its `values` half onto the keys
   `GET /v1/quotes/{quoteId}/account-requirements` actually returns, honours `valuesAllowed`, and
   checks each field's own `validationRegexp`. Identifiers are normalised on the way out — the
   invoice prints `072-144543-3` where Wise stores `0721445433`.

## Still true: nothing here moves money

The channel creates an **unfunded** transfer and stops. A human funds it in Wise. Wise documents
that Singapore business accounts *can* fund over the API, so this is a choice — the house style
shared with `drive-invoice-to-xero` stopping at a draft bill and
`xero-overdue-invoice-to-gmail-reminder` stopping at a Gmail draft.

`DRY_RUN` in `wise.ts` is `true`, gating the final transfer POST only. Recipient creation and
quoting are non-committal, so a dry run still proves the corridor mapping and the real FX numbers.

## Maintainer notes

- **Re-check Wise payment approvals if a team member is ever added.** Approvals configured on
  wise.com are incompatible with API transfer creation (`Quote cannot be accepted with this request
  due to missing approval`, no code workaround). None are configured today, and structurally cannot
  be while this is a single-member account.
- The `Wise Transfers Prepared` Table (`01KYR680X3GNT4PE1YYDMM43HJ`) is this channel's claim store.
- Repo rule 5 does not apply — no Notion pages are created.
