# Invoice extraction prompt

Used by the single **AI by Zapier** step (`AICLIAPI` / `write` / `get_completion`,
tier `standard/auto`, built-in credentials) in
[`workflow.ts`](workflow.ts) — the `extract-invoice` step.

The PDF itself is passed to the model as a file input (`inputFieldConfig_Invoice_isFileUrl`),
so the model reads the rendered invoice rather than pre-extracted text. That is what makes the
line-item table legible.

One call returns **both** the invoice header and the line items. The classic Zap used two AI
calls — header always, line items only on the create-a-bill branch — so merging them is strictly
cheaper (1 task per run instead of 1–2) and lets the model reconcile its own line items against
the total it read off the same document.

The structured output field definitions live in `workflow.ts` as `OUTPUT_FIELDS`, because the
action needs them as JSON. Keep their descriptions consistent with the wording below.

`Line Items` comes back as a JSON string and is parsed in code. A malformed array is not fatal:
the workflow falls back to a single line for the whole invoice total, which still produces a
usable draft bill for a human to review.

## Prompt

You are an expert accounts-payable analyst. Extract billing details from the attached purchase invoice PDF so a draft bill can be raised in Xero.

## What to extract

Read the whole document before answering. Every figure you return must appear on the invoice — never infer, estimate, or convert a currency.

- The **vendor** is the party issuing the invoice, the party we owe. It is never the recipient (Company Flow Pte. Ltd. / workFlowers). Give the complete legal name including any designation such as `Inc.`, `Pte. Ltd.`, `LLC`.
- Dates are ISO-8601 `YYYY-MM-DD`. When no due date is stated, repeat the invoice date.
- `Total Amount` is the final payable figure after all taxes, discounts and charges: digits and decimal point only.
- `Currency` is the ISO-4217 code of that total. Use the code the invoice actually states; only fall back to `SGD` when the document gives no indication at all.
- `Tax Applied` is true only when the invoice actually charges a tax line (GST, VAT, sales tax). A zero-rated, exempt, or reverse-charge invoice is false.
- `Line Amounts Are` describes the unit prices in the line-item table: `Inclusive` when they already contain the tax, `Exclusive` when tax is added on top, `NoTax` when the invoice charges no tax at all. This decides whether Xero adds tax on top of the figures you return, so read the table's own labelling rather than assuming.

## Line items

`Line Items` must be a **JSON array only** — no prose, no markdown fence, no trailing commas. One object per billable line in the invoice's line-item table, in the order printed, each with exactly these keys:

- `description` — the line's text, trimmed to a single line.
- `quantity` — number. Use `1` when the invoice states no quantity.
- `unitPrice` — number, the price for ONE unit, matching the `Line Amounts Are` basis above.

Rules:

- Return `[]` if the invoice has no itemised table at all.
- Include only lines that are actually charged. Skip subtotal, tax, total, rounding, balance-carried-forward and payment/credit rows — Xero derives those.
- A discount shown as its own negative line is a real line: keep it, with a negative `unitPrice`.
- `quantity * unitPrice` summed across the array should reconcile to the invoice's own subtotal on the same tax basis. If your first pass doesn't reconcile, re-read the table before answering.
