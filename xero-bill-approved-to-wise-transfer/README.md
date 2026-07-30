# Xero bill approved → Wise transfer

> ## ⚠️ Design stage. Nothing here is deployed.
>
> There is no `workflow.ts` and no `zap.json` yet. What this directory holds today is the
> **verified groundwork**: [`payment-details-design.md`](payment-details-design.md), which records
> what was measured against the live Wise and Xero accounts rather than assumed, and
> [`recipient.ts`](recipient.ts), a **first-cut, never-executed** payload builder.
>
> The upstream half — `drive-invoice-to-xero` writing the `Vendor Payment Details` Table — **is**
> live as of version `019fb0f6`.

## What it will do

When a bill in Xero reaches **AUTHORISED** ("Awaiting Payment"), read the vendor's payment
instruction out of the `Vendor Payment Details` Table, reuse or create the matching Wise
recipient, take a quote, and create an **unfunded** Wise transfer. Then stop.

**A human funds it in Wise.** Nothing here moves money.

That is a deliberate choice, not a technical limit — and the plan originally justified it with a
wrong reason worth correcting here. Wise's SCA (`x-2fa-approval` / `X-Signature`) regime is
UK/EEA; Wise documents that business accounts in **Singapore**, along with US/CA/AU/NZ/MY, *can*
fund transfers over the API. So funding is reachable later with one extra `POST` and no redesign.
It is left out because outbound money should have a human in the loop, which is also the house
style for every money-adjacent Zap in this repo: `drive-invoice-to-xero` stops at a draft bill,
`xero-overdue-invoice-to-gmail-reminder` stops at a Gmail draft.

## Settled design

| | |
| --- | --- |
| Trigger | `XeroCLIAPI@2.20.5` / `bill`, `status: "authorised"` — **verified to fire on a DRAFT→AUTHORISED transition** |
| Wise access | API by Zapier connection `023b4433-…` (*Wise - workFlowers*), app `App235435CLIAPI@2.1.3`. No first-party Wise app exists on Zapier. |
| Wise profile | `80913588` — Company Flow Pte. Ltd., BUSINESS, hardcoded as a constant |
| Idempotency | the Xero `InvoiceID`, already a GUID, passed verbatim as Wise's `customerTransactionId`, so the free Table guard and Wise's own dedupe key are one identifier |
| Xero writeback | **none** — Wise feeds into Xero as a bank feed, and `details.reference` carries the invoice number so the payout lands already matchable |
| Rail preference | bank account over PayNow when a vendor has both |

Everything above is evidenced in [`payment-details-design.md`](payment-details-design.md),
including the trigger experiment, the response envelope, and the shape of all 14 live recipients.

## Two findings that shaped it

**PayNow is the dominant rail, not an edge case.** 9 of the 14 active recipients on the live Wise
account are PayNow aliases rather than bank accounts. A bank-transfer-only design would have
covered a minority of real payments. It also breaks the obvious cache design: Wise returns a PayNow
alias **hashed** and never in plaintext, so the recipient cache binds on `wise_recipient_alias_hash`
for that rail and on a normalised account number for bank rails.

**Duplicate recipients per vendor are normal.** Insur-Asia and Eugene Thuraisingam each already
have both a bank recipient and a PayNow one. "Stop and ask a human on any multi-match" would fire
constantly, so the bank rail wins by default and only a same-rail collision stops.

## Cost shape

Every rejection is free. All the gating is Zapier Table reads and pure code, which consume no
tasks:

| Outcome | Tasks |
| --- | --- |
| Any guard rejection — wrong type, nothing due, no vendor row, `needs_review` set, not payable by transfer, currency mismatch, unbuildable corridor | **0** |
| Transfer prepared, recipient already cached | **2** (quote + transfer) |
| Transfer prepared, recipient created first | **3** |

## Still to build

1. `workflow.ts` — the guard ladder, the claim row, and the Wise call sequence.
2. Reconciling [`recipient.ts`](recipient.ts) against `GET /v1/quotes/{quoteId}/account-requirements`.
   Its `details` key names are **provisional**: the documented `singapore` shape takes `bic`, while
   the real recipient on this account (`1505954755`) stores `{accountNumber, bankCode}`. The
   `values` field on its output carries the same data keyed semantically, which is the half meant
   to survive that reconciliation.
3. A `reference` fallback chain. `InvoiceNumber` is an **absent key** on the trigger payload when
   the bill has none — not null — and the reference is what makes the payout self-reconcile.
4. `zap.json`, and a Mermaid diagram here once the flow is real.
5. `create-workflow` **without** `--private` (repo rule 7 — visibility is permanent).
6. First publish with `DRY_RUN = true`, gating only the final transfer POST: recipient creation and
   quoting are both non-committal, so a dry run still proves the corridor mapping and the real FX
   numbers with nothing irreversible.

## Maintainer notes

- **Re-check Wise payment approvals if a team member is ever added.** Approvals configured on
  wise.com are incompatible with API transfer creation (`Quote cannot be accepted with this request
  due to missing approval`, no code workaround). None are configured today, and structurally cannot
  be while this is a single-member account — Wise requires a second member with approve permission.
- **Repo rule 5 does not apply here** — no Notion pages are created, so there is no
  `createItemWithTemplate` and no `template_mode`.
- The `Wise Transfers Prepared` Table (`01KYR680X3GNT4PE1YYDMM43HJ`) already exists and is empty.
