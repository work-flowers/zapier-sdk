# zapier-sdk

Source-of-truth repo for workFlowers Code Zaps in the main work.flowers Zapier workspace. One sub-directory per Zap — mostly Durables, plus one classic Code-step Zap (`email-contact-page-zap`).

## Repo rules

1. **Every Zap sub-directory must contain a brief `README.md`** alongside the code — what the Zap does, its trigger, and anything a maintainer needs to know before touching it. The README always includes a Mermaid diagram depicting the workflow, if possible; keep it in sync when the workflow logic changes.
2. **Deployed code must link back to this repo.** Every source file (`workflow.ts`, or the code-step file for classic Zaps) carries a comment near the top pointing to its directory on GitHub, e.g.:
   `// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/<zap-name>`
   When creating or modifying a Zap, make sure this comment is present in the version published to Zapier.
3. **Keep the root `README.md` in sync.** Whenever a Zap is created, published, modified, enabled/disabled, or removed, update the Zap index table (and anything else affected) in the root README in the same change.
4. **Every Durable directory carries a `zap.json` mirroring the deployed state.** Pull it down from Zapier when adding a Zap to the repo, and refresh it (`current_version_id`, `enabled`, dependency versions, etc.) whenever the Zap changes on Zapier.

## Working conventions

- Each Durable directory contains `workflow.ts` (the source as published on Zapier), `zap.json` (workflow ID, current version ID, trigger URL, enabled state, runtime/dependency versions), and `README.md`. Classic Code-step Zap directories carry the code-step source and tests instead.
- After publishing any change to Zapier, sync the new source and `current_version_id` back into this repo — the repo must always match what is deployed.
- Zaps are managed via the Zapier SDK CLI or the Zapier MCP connector. **Prefer the CLI wherever possible** — it's faster and more cost-effective; fall back to the MCP connector (`list_workflows`, `get_workflow_version`, publish tools) only when the CLI can't do the job. CLI setup (install, login, experimental flag for Durables) is documented in the root README under "Setting up the Zapier CLI".
- The `notion-companies-to-zapier-table` Durable was historically managed in the personal `denchiuten/notion-companies-hub` repo by mistake; this repo is its source of truth now. Its deployed header comment and workflow description still point at the old repo until the next republish.
