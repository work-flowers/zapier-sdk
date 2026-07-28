# Receipt extraction prompt

Used by the single **AI by Zapier** step (`AICLIAPI` / `write` / `get_completion`, tier
`standard/auto`, built-in credentials) in [`workflow.ts`](workflow.ts) — the
`analyze-receipt` step.

The PDF itself is passed to the model as a file input (`inputFieldConfig_Invoice_isFileUrl`),
using the Drive trigger's `file` hydrate reference — the model reads the rendered receipt
directly rather than pre-extracted text.

The structured output field definitions live in `workflow.ts` as `OUTPUT_FIELDS`, because the
action needs them as JSON. Keep their descriptions consistent with the wording below.

## Prompt

As a data extraction specialist, your task is to analyze the provided invoice document and extract specific information. Please identify and extract the vendor name, date, currency, and total amount due from the receipt.

The date should be formatted in ISO8601 format (YYYY-MM-DD). Ensure that the extracted information is accurate and clearly presented.

**Expected Output Format:**
- Vendor Name: [Extracted Vendor Name]
- Date: [Extracted Date in ISO8601 format]
- Currency: [Extracted Currency]
- Amount Due: [Extracted Total Amount Due]

**Example:**
- Vendor Name: Acme Corp
- Date: 2023-10-15
- Currency: SGD
- Amount Due: 65.05
