# zapier-sdk

Source-of-truth repo for workFlowers Code Zaps in the main work.flowers Zapier workspace. One sub-directory per Zap — mostly Durables, plus one classic Code-step Zap (`email-contact-page-zap`).

<!-- The universal engineering rules for a Zap repo — publishing pipeline, trigger
     handling, determinism guard, empty-ping guard, AI tiers, concurrency — live in
     .claude/rules/durables.md, which loads automatically every session and is kept
     BYTE-IDENTICAL across every Zap repo. This file holds only what is specific to
     work.flowers. Put a universal lesson in the rules file, not here, or it will
     never reach the other repos. -->

Universal rules live in [`.claude/rules/durables.md`](.claude/rules/durables.md) — loaded automatically each session, and byte-identical across every Zap repo. **A new lesson that would be true in any Zap repo belongs there, not in this file.** This file holds only work.flowers-specific facts.

## Workspace facts

- **Zapier account id `20495893`** — the `<account-id>` in a static catch URL, `https://hooks.zapier.com/hooks/catch/20495893/<code>/`.
- **Notion connection: always use the work.flowers workspace connection** — `NotionCLIAPI` connection `02b73654-15c8-85c3-b16a-07304d2beb17` (titled `work.flowers | Dennis <dennis@work.flowers>`). This is the connection that has the work.flowers CRM databases (Contacts, Companies, etc.) shared with it. **Never bind the `Knoxx | Dennis #2` connection (`02b95b31-c152-8800-9036-1107e08f70da`) in this repo** — that connection points at the Knoxx Foods *client* Notion workspace and cannot see work.flowers databases (a write against it fails with `Could not find data_source … shared with your integration "Zapier"`). When publishing, always double-check the `notion_wf` connection id matches the deployed value in the Zap's `zap.json`/README rather than picking one from `list-connections` by title.
- **Source-of-truth comment prefix** (repo rule 2): `// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/<zap-name>`
- **Zaps that are private and stay that way** (repo rule 7 grandfathering): `email-db-updates`, `merge-duplicate-contacts`. They predate the rule; leave them as they are rather than recreating them.
- **Zaps pinning a catch URL with `params._zap_static_hook_code`**: `notion-newsletter-to-buttondown`, `notion-companies-to-zapier-table`. Never let that key fall out of their `zap.json`. The `--audit` run on 2026-08-25 found exactly this drift on `notion-companies-to-zapier-table` and it was corrected in the repo.
- The `notion-companies-to-zapier-table` Durable was historically managed in the personal `denchiuten/notion-companies-hub` repo by mistake; this repo is its source of truth now. Its deployed header comment and workflow description still point at the old repo until the next republish.

## Reference implementations

The shared rules cite these helpers by name; here is where this repo's copy lives.

| Helper | Location |
| --- | --- |
| `isEmptyPing` | [`xero-contact-from-notion-deal/workflow.ts`](xero-contact-from-notion-deal/workflow.ts) |
| `createItemWithTemplate` | [`luma-guest-registered-to-event-attendance/workflow.ts`](luma-guest-registered-to-event-attendance/workflow.ts) |
| `daysFromCivil` / `isoDateFromEpochMs` / `daysInMonth` | [`drive-invoice-to-xero/workflow.ts`](drive-invoice-to-xero/workflow.ts) |

Worked examples for the shared rules: the empty-ping guard exists because [`gcal-event-updated-to-meeting-note`](gcal-event-updated-to-meeting-note/)'s predecessor sat dead for three months with no error and no alert. The `new Date` determinism guard cost [`drive-invoice-to-xero`](drive-invoice-to-xero/) 100% of its runs, and [`drive-paid-receipts-to-table`](drive-paid-receipts-to-table/) shipped the same latent bug. On AI tiers, [`gmail-attachments-to-drive-by-type`](gmail-attachments-to-drive-by-type/) is the case where Standard matched Advanced on every case including a multi-row statement-history inference. The idempotent-write posture leans on [`merge-duplicate-contacts`](merge-duplicate-contacts/) as the existing cleanup backstop. The Zapier Tables rule's production example is [`email-contact-page-zap`](email-contact-page-zap/), which uses Table `01JYEPSEARXB2Z6BJRCMFGXBC2` as its email→Notion-page-id map.

## Notion data source template state

Current state (2026-07-25): **Contacts has** a default template (blue `user-circle-filled` icon); **Events and Event Attendance do not**. Exception: `contrast-registrations-to-event-attendance` predates repo rule 5 and is retired/disabled — leave it as-is rather than editing source that can't be republished without re-enabling the Zap.

## Tooling baseline for this repo

Zaps are managed via the Zapier SDK CLI or the Zapier MCP connector. **In this repo, prefer the CLI wherever possible** — it's faster and more cost-effective; fall back to the MCP connector (`list_workflows`, `get_workflow_version`, publish tools) only when the CLI can't do the job. CLI setup (install, login, experimental flag for Durables) is documented in the root README under "Setting up the Zapier CLI". This CLI-over-MCP preference is about *reads and one-off operations* — **publishing a durable defaults to the merge pipeline** (see `.claude/rules/durables.md`), and any direct `publish-workflow-version`, by CLI or MCP, bypasses PR review.

> This baseline is repo-specific and deliberately **not** in the shared rules file — other Zap repos set their own (knoxx-code-zaps defaults to MCP), and syncing this preference into them would silently override that choice.

## The interactive workflow map

**Keep the interactive workflow map in sync.** When a Zap is added/removed/re-statused or an asset relationship changes, update [`docs/map-overlay.json`](docs/map-overlay.json) and run `node scripts/build-map.mjs`; `--check` is the drift gate, and it runs as a **required PR check** ([`check-map.yml`](.github/workflows/check-map.yml)) — so a stale map fails the PR instead of publishing quietly. You still regenerate it yourself; CI only refuses the drift. The one exception is a publish: [`publish-zaps.yml`](.github/workflows/publish-zaps.yml) regenerates the map inside its sync-back commit, because a first publish fills in `workflow_id` and the map's data is derived from it. **The map is published — a merge to `main` deploys it to a public page**, and `map.html` must stay a complete standalone document (never embed its markup in a host page). Load the `zap-map` skill for the regeneration mechanics and the standalone-document constraints.

## Repo-specific notes

- Each Durable directory contains `workflow.ts` (the source as published on Zapier), `zap.json` (workflow ID, current version ID, trigger URL, enabled state, runtime/dependency versions), and `README.md`. Classic Code-step Zap directories carry the code-step source and tests instead.
- The publish pipeline's former `production`-environment required-reviewer gate was removed 2026-08-18 as redundant — merging the PR is the approval. **Never merge a Zap-affecting PR without Dennis's explicit go-ahead.**
- The disabled-republish path went unexercised until 2026-08-25, because no republish had ever targeted a parked Zap. Six deployments here are disabled; a code change to any of them would have failed the publish job. Mechanics are in the shared rules.
- Repo-local skills that aren't vendored (`zap-ai-prompts`, `zap-map`) live as real directories under `.claude/skills/`, not symlinks.
