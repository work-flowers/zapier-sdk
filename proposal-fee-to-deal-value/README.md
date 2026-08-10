# proposal-fee-to-deal-value

**⏸️ Retired 2026-08-10 — deprecated the same day it was migrated.** Dennis
removed the fee property from the Proposals data source because it was
superfluous, which confirmed the staleness flag this migration shipped with
(see below). The durable is **disabled** on Zapier, was never repointed to,
and never ran on a live event; the directory is kept for reference. The
classic Zap **"Update Deal Value When Proposal Fee Updated"** is equally dead
(its source property no longer exists) and should still be disabled in the
Zapier UI, along with whatever Notion automation posts to its catch URL.

Proposal webhook from Notion → copy the proposal's **Project Fee** onto the
related Deal's **Value**.

Migration of the classic Zap **"Update Deal Value When Proposal Fee Updated"**.

- **Workflow ID:** `019feb0a-b966-78a1-b2e1-da422eca223f` (account-visible, disabled)
- **Trigger:** Webhooks by Zapier catch hook —
  `https://hooks.zapier.com/hooks/catch/20495893/cCSLFIVwOZMqVxFz/`
- **Editor:** <https://zapier.com/durables-editor/019feb0a-b966-78a1-b2e1-da422eca223f>

## ⚠️ Staleness flag (confirmed — the reason it was retired)

As of 2026-08-10 **no data source visible to the work.flowers Zapier
integration carries a "Project Fee" property**. The current *Project
Proposals* data source (`1d791b07-11ac-8058-8c70-000b0d0dfaf2`) has `Deals`
but no fee, and the classic Zap's export already showed
`has_automatic_issues` on its Notion step. Dennis confirmed he removed the
fee property deliberately.

## Workflow

```mermaid
flowchart TD
    A["Notion automation POSTs proposal page<br/>(Project Fee changed) to catch hook"] --> B{"Empty ping?"}
    B -- yes --> S1(["Skip — log only"])
    B -- no --> C{"Payload readable as<br/>a page snapshot?"}
    C -- no --> X(["THROW — unrecognized shape"])
    C -- yes --> D{"Deal / Deals relation<br/>and Project Fee present?"}
    D -- "neither property exists" --> X2(["THROW — source DB shape changed"])
    D -- "no deal linked" --> S2(["Skip"])
    D -- "fee empty" --> S3(["Skip — never blank Value"])
    D -- ok --> E["PATCH deal page:<br/>Value = Project Fee"]
```

## What changed vs the classic Zap

- **The payload is the input** — unlike this repo's other Notion durables, the
  source page can't be re-read because its database isn't shared with the
  integration. Only the fee and the deal relation are read from it.
- **An empty fee skips instead of writing** (the mirror rule: never blank what
  you failed to read). The classic Zap would have pushed an empty value at the
  Deal.
- Accepts both `Deal` and `Deals` as the relation name, since the current
  Project Proposals schema uses the plural.
- Empty-ping skip; unrecognizable content throws loudly.

## Testing

`run-durable` on 2026-08-10, **full main path** with a no-op value: synthetic
payload carrying deal `9ca1f339-617f-4e08-946b-7bb00a475fa9` (Tannin Road) and
its current fee `2500` → `updated: true`, Deal Value re-written to the same
number. Empty-ping payload → `skipped: empty-payload`.

## Cutover

Cancelled — retired before any cutover. Remaining cleanup: disable the classic
Zap **"Update Deal Value When Proposal Fee Updated"** in the Zapier UI and
remove the Notion automation that posts to its catch URL.

## Maintainer notes

- Connection: `notion_wf` = work.flowers Notion
  (`02b73654-15c8-85c3-b16a-07304d2beb17`).
- Writes Deals `Value` via a raw page PATCH (the action schema cache goes
  stale on newly added properties; same pattern as the rest of the repo).
