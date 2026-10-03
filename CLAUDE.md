# zapier-sdk

Source-of-truth repo for workFlowers Code Zaps in the main work.flowers Zapier workspace. One sub-directory per Zap — mostly Durables, plus one classic Code-step Zap (`email-contact-page-zap`).

<!-- The universal engineering rules for a Zap repo — publishing pipeline, trigger
     handling, determinism guard, empty-ping guard, AI tiers, concurrency — live in
     .claude/rules/durables.md, which loads automatically every session and is kept
     BYTE-IDENTICAL across every Zap repo. This file holds only what is specific to
     work.flowers. Put a universal lesson in the rules files, not here, or it will
     never reach the other repos. -->

Universal rules live in [`.claude/rules/`](.claude/rules/) — [`durables.md`](.claude/rules/durables.md) (how a Zap repo ships) and [`durables-sdk.md`](.claude/rules/durables-sdk.md) (writing durable code). Both load automatically each session, and both are byte-identical across every Zap repo. **A new lesson that would be true in any Zap repo belongs there, not in this file.** This file holds only work.flowers-specific facts.

## Workspace facts

- **Zapier account id `20495893`** — the `<account-id>` in a static catch URL, `https://hooks.zapier.com/hooks/catch/20495893/<code>/`.
- **Notion connection: always use the work.flowers workspace connection** — `NotionCLIAPI` connection `02b73654-15c8-85c3-b16a-07304d2beb17` (titled `work.flowers | Dennis <dennis@work.flowers>`). This is the connection that has the work.flowers CRM databases (Contacts, Companies, etc.) shared with it. **Never bind the `Knoxx | Dennis #2` connection (`02b95b31-c152-8800-9036-1107e08f70da`) in this repo** — that connection points at the Knoxx Foods *client* Notion workspace and cannot see work.flowers databases (a write against it fails with `Could not find data_source … shared with your integration "Zapier"`). When publishing, always double-check the `notion_wf` connection id matches the deployed value in the Zap's `zap.json`/README rather than picking one from `list-connections` by title.
- **Source-of-truth comment prefix** (repo rule 2): `// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/<zap-name>`
- **Zaps that are private and stay that way** (repo rule 7 grandfathering): `email-db-updates`, `merge-duplicate-contacts`. They predate the rule; leave them as they are rather than recreating them.
- **Zaps pinning a catch URL with `params._zap_static_hook_code`**: `notion-newsletter-to-buttondown`, `notion-companies-to-zapier-table`. Never let that key fall out of their `zap.json`. The `--audit` run on 2026-08-25 found exactly this drift on `notion-companies-to-zapier-table` and it was corrected in the repo.
- The `notion-companies-to-zapier-table` Durable was historically managed in the personal `denchiuten/notion-companies-hub` repo by mistake; this repo is its source of truth now. Its deployed header comment and workflow description still point at the old repo until the next republish.

## Unrecognized-payload mechanism

This repo uses the **default mechanism: throw.** An unrecognized non-empty payload raises, producing a red run and a Zapier error alert. That suits the workload here — several Zaps are background mirrors ([`contact-emails-to-zapier-table`](contact-emails-to-zapier-table/), [`gcal-event-updated-to-meeting-note`](gcal-event-updated-to-meeting-note/)) where no human is waiting on any individual run, so a silent skip would go unnoticed indefinitely. That is not hypothetical: the latter's predecessor sat dead for three months.

The shared rule permits substituting an explicit alert channel instead. **This repo does not substitute.**

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

## AI-step exception: Jev in two Zaps

The shared rules say AI steps run on AI by Zapier. **This repo makes two exceptions**, both using **Jev**, TypeSafe's typed-judgement model: [`gmail-attachments-to-drive-by-type`](gmail-attachments-to-drive-by-type/) classifies attachments with it (since 2026-10-02), and [`merge-duplicate-contacts`](merge-duplicate-contacts/) asks it whether two contacts are one person when the name rule declines (since 2026-10-03). Jev returns probabilities for typed questions (choice / yes-no / score), never generated text, so it fits classification and routing, not extraction or writing. Both call it through `sdk.fetch` with the `typesafe` connection (`02c36cbc-669d-8c82-9c72-7b7813e5cde0`, an *API by Zapier* connection titled *Jev* holding the TypeSafe key as a Bearer token). That keeps the key out of source and goes out through Zapier's Relay, which the durable sandbox allows (verified with `run-durable`). It does **not** save a Zapier task: that call is itself a task, like the AI by Zapier step it replaced. TypeSafe also bills its own tokens on top, ~$0.0001 per call here.

- **Why there:** on the 48 most recent real emails it matched the AI by Zapier classifier's filing on 58 of 59 PDFs (the 59th was a production misfile) at ~1/5 the latency. In `merge-duplicate-contacts` it overturns only the name-mismatch decline, never a LinkedIn conflict; replayed on the six real requests it fixed both real false declines. Each Zap's README holds its comparison and what was given up.
- **Repo rule 6 doesn't fit it:** Jev's "prompt" is structured question objects, not a prose literal, so `check-prompts.mjs` can't embed it. The questions live in each `workflow.ts` (`jevQuestions`/`CATEGORY_CRITERIA`, `JEV_QUESTIONS`) and are tabulated in that Zap's README. That README, not a `*-prompt.md`, is where they get reviewed.
- **Don't extend this by default.** Any other Zap still starts on AI by Zapier `standard/auto`. Moving one to Jev needs the same kind of offline comparison on real cases first. The TypeSafe agent skill (`typesafe:typesafe-ai`) has the API and question-design guidance.

## Tooling baseline for this repo

Zaps are managed via the Zapier SDK CLI or the Zapier MCP connector. **In this repo, prefer the CLI wherever possible** — it's faster and more cost-effective; fall back to the MCP connector (`list_workflows`, `get_workflow_version`, publish tools) only when the CLI can't do the job. CLI setup (install, login, experimental flag for Durables) is documented in the root README under "Setting up the Zapier CLI". This CLI-over-MCP preference is about *reads and one-off operations* — **publishing a durable defaults to the merge pipeline** (see `.claude/rules/durables.md`), and any direct `publish-workflow-version`, by CLI or MCP, bypasses PR review.

> This baseline is repo-specific and deliberately **not** in the shared rules file — other Zap repos set their own (knoxx-code-zaps defaults to MCP), and syncing this preference into them would silently override that choice.

## The interactive workflow map

**Keep the interactive workflow map's curation in sync.** When a Zap is added/removed/re-statused or an asset relationship changes, update [`docs/map-overlay.json`](docs/map-overlay.json) in the same PR; `node scripts/build-map.mjs --validate` is the gate, and it runs as a **required PR check** ([`check-map.yml`](.github/workflows/check-map.yml)). **Don't commit a regenerated `docs/map.html` in an ordinary PR** — [`refresh-map.yml`](.github/workflows/refresh-map.yml) regenerates it daily and pushes to `main`, and neither PRs nor the publish sync-back touch it, so the public map can trail the repo by up to a day by design (run the workflow by hand to refresh sooner). **The map is published — any change to `docs/` landing on `main` deploys it to a public page** via [`deploy-pages.yml`](.github/workflows/deploy-pages.yml), and `map.html` must stay a complete standalone document (never embed its markup in a host page). Load the `zap-map` skill for the regeneration mechanics and the standalone-document constraints.

## Repo-specific notes

- **Known Zapier bug (open): polling triggers on durables never re-fire for an id they have already delivered.** Confirmed by Zapier Product Escalations on 2026-09-08 (ticket W6ZE93-VMEWP, filed from this repo's `event_updated` Zaps): durables add a dedupe layer keyed on the raw event id, so the "updated" half of "New or Updated" triggers is dead until their fix ships (no ETA; the dedupe shape may change with the fix). Consequences here: the update/delete branches of `scw-events-to-workflowers-block` and `workflowers-events-to-scw-busy` never run, and `gcal-block-sweep`'s daily reconcile pass propagates every post-creation change instead. Assume the same of any other polling "updated" trigger in this repo until proven otherwise; Dennis saw the same symptom on the SPOT integration earlier and that one was fixed quickly. Re-verify with a live edit when Zapier reports movement on the ticket. **It is not limited to polling, and a catch hook does not escape it** (probed 2026-10-01 on `save-tagged-docs-to-notion`): REST-hook app triggers are deduped the same way, and a raw `WebHookCLIAPI` catch hook drops a second POST whose top-level `id` it has already seen (Zapier still answers `status: success`). Any sender that reuses a record id at the top level of its payload (Readwise does) loses every repeat event.
- Each Durable directory contains `workflow.ts` (the source as published on Zapier), `zap.json` (workflow ID, current version ID, trigger URL, enabled state, runtime/dependency versions), and `README.md`. Classic Code-step Zap directories carry the code-step source and tests instead.
- The publish pipeline's former `production`-environment required-reviewer gate was removed 2026-08-18 as redundant — merging the PR is the approval. **Never merge a Zap-affecting PR without Dennis's explicit go-ahead.**
- The disabled-republish path went unexercised until 2026-08-25, because no republish had ever targeted a parked Zap. Six deployments here are disabled; a code change to any of them would have failed the publish job. Mechanics are in the shared rules.
- Repo-local skills that aren't vendored (`zap-ai-prompts`, `zap-map`) live as real directories under `.claude/skills/`, not symlinks.
- **The five `-peter` calendar-sync Zaps are private on Zapier although their `zap.json` says `"is_private": false`.** They were created 2026-09-25/26 through the CLI's `create-workflow`, which cannot send `is_private: false`, so Zapier's then-private default applied (the publisher now creates through the SDK; see repo rule 7). Visibility cannot be changed after creation, so the only fix is to recreate them. Until someone decides to, their `zap.json` does not match the deployed visibility.
