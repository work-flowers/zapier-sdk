# Setup Session line-item extraction prompt

Used by the workflow's only AI step, `extract-line-items` (`get_completion`, `advanced/auto`).
Carried over verbatim from the classic Zap's AI action — the screenshot format and the task are
unchanged, so the instructions didn't need editing, only the tier (see the README's "AI model"
section).

Embedded in `workflow.ts` as `const SETUP_SESSION_INVOICE_PROMPT = \`…\``. Edit this file, then run
`node scripts/check-prompts.mjs --fix` from the repo root — never hand-edit the literal.

## Prompt

Please carefully analyze the attached screenshot, which provides a comprehensive breakdown of sessions organized by consultant and session type. For each entry, create detailed line items that include the following information:

- Consultant Name: Clearly specify the name of the consultant linked to each session.
- Session Type: Identify and categorize the sessions into one of the following types: Calls Completed, No-Shows, Late Cancellations, Workspace Conversions, Referral Bonuses, and Seats Added.
- Session Quantity: State the total number of sessions for each category per consultant.
- Invoice Period: Indicate the last day of the month for which the provided screenshot is reporting.

Ensure that you exclude any line items where the session quantity is either empty or 0. Present the results in a clear and organized format.
