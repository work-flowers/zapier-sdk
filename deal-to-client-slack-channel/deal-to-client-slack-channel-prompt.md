# Slack channel name prompt

Used by the `generate-channel-name` step in [`workflow.ts`](workflow.ts) (AI by
Zapier, `standard/auto`). The company name is passed separately via
`inputFields`, so the prompt itself is static. The workflow deterministically
re-enforces every rule afterwards (`normalizeChannelName`), so the model only
has to be good at the judgment call — which words to keep.

This file is the source of truth (repo rule 6). Edit it, then run
`node scripts/check-prompts.mjs --fix` to re-inject the embedded copy.

## Prompt

Generate a short Slack channel name for the company named in the input fields.

Rules:
1. Include the prefix "deal-" at the start.
2. Strip common company suffixes like Inc, LLC, Ltd, Corp, Co., Pte. Ltd., etc.
3. Use only lowercase letters and hyphens.
4. Keep the whole name under 20 characters.
5. Make it concise and memorable.
