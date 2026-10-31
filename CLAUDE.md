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
- **No Zap here is grandfathered as private** under repo rule 7. `email-db-updates` and `merge-duplicate-contacts` were once listed as pre-rule private Zaps, but `get-workflow` reports both as account-visible (`email-db-updates` corrected 2026-07-31, `merge-duplicate-contacts` 2026-10-03), so the list was wrong. The `-peter` Zaps below are the only deployments whose visibility differs from their `zap.json`.
- **Zaps pinning a catch URL with `params._zap_static_hook_code`**: `notion-newsletter-to-buttondown`, `notion-companies-to-zapier-table`. Never let that key fall out of their `zap.json`. The `--audit` run on 2026-08-25 found exactly this drift on `notion-companies-to-zapier-table` and it was corrected in the repo.
- The `notion-companies-to-zapier-table` Durable was historically managed in the personal `denchiuten/notion-companies-hub` repo by mistake; this repo is its source of truth now. Its deployed header comment and workflow description still point at the old repo until the next republish.

## Unrecognized-payload mechanism

This repo uses the **default mechanism: throw.** An unrecognized non-empty payload raises, producing a red run and a Zapier error alert. That suits the workload here — several Zaps are background mirrors (e.g. [`contact-emails-to-zapier-table`](contact-emails-to-zapier-table/), and until its retirement [`gcal-event-updated-to-meeting-note`](gcal-event-updated-to-meeting-note/)) where no human is waiting on any individual run, so a silent skip would go unnoticed indefinitely. That is not hypothetical: the latter's predecessor sat dead for three months.

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

The shared rules say AI steps run on AI by Zapier. **This repo makes two exceptions**, both using **Jev**, TypeSafe's typed-judgement model: [`gmail-attachments-to-drive-by-type`](gmail-attachments-to-drive-by-type/) classifies attachments with it (since 2026-10-02), and [`luma-hosted-guest-to-event-attendance`](luma-hosted-guest-to-event-attendance/) asks whether an email domain is a personal provider, to pick a new contact's Primary Email and (since 2026-10-20) to decide whether a same-name contact at that domain is reused, with verdicts cached per domain in a Zapier Table (since 2026-10-15), and (since 2026-10-21) whether a new contact is the same person as a looser duplicate candidate, which decides its `Possible duplicate of` flag. [`merge-duplicate-contacts`](merge-duplicate-contacts/) used it from 2026-10-03 to second-guess name mismatches, and dropped it on 2026-10-21: `Duplicate of` is set only by a person, so their call stands. Jev returns probabilities for typed questions (choice / yes-no / score), never generated text, so it fits classification and routing, not extraction or writing. Both call it through `sdk.fetch` with the `typesafe` connection (`02c36cbc-669d-8c82-9c72-7b7813e5cde0`, an *API by Zapier* connection titled *Jev* holding the TypeSafe key as a Bearer token). That keeps the key out of source and goes out through Zapier's Relay, which the durable sandbox allows (verified with `run-durable`). It does **not** save a Zapier task: that call is itself a task, like the AI by Zapier step it replaced. TypeSafe also bills its own tokens on top, ~$0.0001 per call here.

- **Why there:** on the 48 most recent real emails it matched the AI by Zapier classifier's filing on 58 of 59 PDFs (the 59th was a production misfile) at ~1/5 the latency. Each Zap's README holds its comparison and what was given up.
- **Repo rule 6 doesn't fit it:** Jev's "prompt" is structured question objects, not a prose literal, so `check-prompts.mjs` can't embed it. The questions live in each `workflow.ts` (`jevQuestions`/`CATEGORY_CRITERIA`, `JEV_DOMAIN_CRITERIA`, `JEV_SAME_PERSON_QUESTIONS`) and are tabulated in that Zap's README. That README, not a `*-prompt.md`, is where they get reviewed.
- **Don't extend this by default.** Any other Zap still starts on AI by Zapier `standard/auto`. Moving one to Jev needs the same kind of offline comparison on real cases first. The TypeSafe agent skill (`typesafe:typesafe-ai`) has the API and question-design guidance.

## Tooling baseline for this repo

Zaps are managed via the Zapier SDK CLI or the Zapier MCP connector. **In this repo, prefer the CLI wherever possible** — it's faster and more cost-effective; fall back to the MCP connector (`list_workflows`, `get_workflow_version`, publish tools) only when the CLI can't do the job. CLI setup (install, login, experimental flag for Durables) is documented in the root README under "Setting up the Zapier CLI". This CLI-over-MCP preference is about *reads and one-off operations* — **publishing a durable defaults to the merge pipeline** (see `.claude/rules/durables.md`), and any direct `publish-workflow-version`, by CLI or MCP, bypasses PR review.

> This baseline is repo-specific and deliberately **not** in the shared rules file — other Zap repos set their own (knoxx-code-zaps defaults to MCP), and syncing this preference into them would silently override that choice.

## The interactive workflow map

**The map is a manual, occasional artifact — no CI maintains it.** The daily refresh and the `--validate` PR check were retired 2026-10-18, so don't update [`docs/map-overlay.json`](docs/map-overlay.json) as part of ordinary Zap PRs. Regenerate only when Dennis asks: fix the overlay until `node scripts/build-map.mjs --validate` passes, run `node scripts/build-map.mjs`, and commit `docs/map.html` in that PR. **`docs/` is a public GitHub Pages site, but deploys are manual** — [`deploy-pages.yml`](.github/workflows/deploy-pages.yml) runs only by hand (since 2026-10-18), so merging a `docs/` change publishes nothing until someone runs it. `map.html` must stay a complete standalone document (never embed its markup in a host page). Load the `zap-map` skill for the regeneration mechanics and the standalone-document constraints.

## Repo-specific notes

- **Zapier bug W6ZE93-VMEWP is FIXED (verified 2026-10-28): durable app triggers now re-fire for an id they have already delivered, once per new `updated` value.** History: confirmed by Zapier Product Escalations on 2026-09-08 (filed from this repo's `event_updated` Zaps), durables added a dedupe layer keyed on the raw record id, so the "updated" half of "New or Updated" triggers was dead and a REST-hook trigger (Readwise) fired once per document ever. Verified fixed 2026-10-28 two ways: a live probe (a Free test event on dennis@work.flowers, created then retitled) produced two `workflowers-events-to-scw-busy` runs on the same id, 22:38Z and 22:44Z; and run history shows repeat ids with a newer `updated` on all four `event_updated` Zaps and on `save-tagged-docs-to-notion` (Readwise), the earliest seen 2026-10-22. Consequences: the update/delete branches of the calendar-blocking trigger Zaps now run, and [`save-tagged-docs-sweep`](save-tagged-docs-sweep/) was disabled 2026-10-28 as redundant. [`gcal-block-sweep`](gcal-block-sweep/) stays on (its `-peter` copy was disabled 2026-10-31 with the rest of Peter's sync): its create pass fills in occurrences as they roll into the 30-day horizon (days 23..30) and its reconcile pass covers "this and following" truncations, neither of which the fix touches. **Not re-tested: a raw `WebHookCLIAPI` catch hook** (probed 2026-10-01: it dropped a second POST with an already-seen top-level `id` while still answering `status: success`). Until re-probed, keep sending a top-level `id` that changes per event, as the classic hand-off Zaps do. **Classic hand-off retired:** [`notion-company-renamed-to-xero-harvest-drive`](notion-company-renamed-to-xero-harvest-drive/#classic-hand-off-retired-2026-10-29) went back to its native Notion trigger on 2026-10-29; its classic Zap POSTed `<record id>_<updated>` with `source: "classic-handoff"` to a catch hook, and the `classic-handoff` branch in its `workflow.ts` stays in case the pattern is needed again. [`gcal-event-updated-to-meeting-note`](gcal-event-updated-to-meeting-note/#classic-hand-off) used the same pattern and is retired.
- Each Durable directory contains `workflow.ts` (the source as published on Zapier), `zap.json` (workflow ID, current version ID, trigger URL, enabled state, runtime/dependency versions), and `README.md`. Classic Code-step Zap directories carry the code-step source and tests instead.
- The publish pipeline's former `production`-environment required-reviewer gate was removed 2026-08-18 as redundant — merging the PR is the approval. **Never merge a Zap-affecting PR without Dennis's explicit go-ahead.**
- The disabled-republish path went unexercised until 2026-08-25, because no republish had ever targeted a parked Zap. Six deployments here are disabled; a code change to any of them would have failed the publish job. Mechanics are in the shared rules.
- Repo-local skills that aren't vendored (`zap-ai-prompts`, `zap-map`) live as real directories under `.claude/skills/`, not symlinks.
- **The five `-peter` calendar-sync Zaps were disabled 2026-10-31** (Peter rolling off the SCW engagement). **They are also private on Zapier although their `zap.json` says `"is_private": false`.** They were created 2026-09-25/26 through the CLI's `create-workflow`, which cannot send `is_private: false`, so Zapier's then-private default applied (the publisher now creates through the SDK; see repo rule 7). Visibility cannot be changed after creation, so the only fix is to recreate them. Until someone decides to, their `zap.json` does not match the deployed visibility.
