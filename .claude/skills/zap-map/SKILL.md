---
name: zap-map
description: Mechanics for this repo's interactive workflow map — docs/map-overlay.json curated semantics, scripts/build-map.mjs and its --validate PR gate, the daily refresh-map.yml job that regenerates the data block, why map.html must stay a standalone document, and the fact that the map publishes publicly from main. Use when a Zap is added, removed or re-statused, when an asset relationship changes, or when build-map.mjs --validate fails.
---

# The interactive workflow map

Repo rule (in `CLAUDE.md`): keep the map's curation in sync. This skill is the how-to.

## Curating (your job, per PR)

[`docs/map.html`](../../../docs/map.html) is a generated atlas of every Zap and
the shared assets connecting them. When a Zap is added/removed/re-statused or an
asset relationship changes (a Table read/write, a Notion data source, a Drive
folder, the one zap→zap HTTP edge), update the curated semantics in
[`docs/map-overlay.json`](../../../docs/map-overlay.json).

`node scripts/build-map.mjs --validate` is the gate — it fails when the repo and
the overlay disagree (new asset ids must be registered or explicitly ignored;
every zap dir must sit in exactly one cluster; every zap→asset reference needs a
curated edge). **It runs on every PR** ([`check-map.yml`](../../../.github/workflows/check-map.yml)),
so a curation gap fails the PR instead of breaking the next scheduled refresh.

## Regenerating (daily, automatic)

**Don't commit a regenerated `docs/map.html` in an ordinary PR.** The data block
is one long line of JSON, so two PRs that both regenerate it conflict with each
other, and the regeneration is redundant anyway:
[`refresh-map.yml`](../../../.github/workflows/refresh-map.yml) runs
`node scripts/build-map.mjs` daily at 01:00 UTC and pushes the result
straight to `main`. The committed map can therefore trail the repo by up to a
day — that is by design, not drift to hand-fix. Trigger the job by hand
(`gh workflow run refresh-map.yml`) when a change should show sooner.

The exception is a PR that edits `map.html`'s own markup/JS or `build-map.mjs`'s
rendering: run the generator locally to check the page still works, and commit
the result so the review covers what will publish.

The publish pipeline doesn't regenerate either. A **first publish** fills in
`workflow_id` (which the extractor reads as "not deployed" while `null`), so the
map shows a freshly shipped Zap as undeployed until the next daily refresh.

`node scripts/build-map.mjs --check` still exists — it fails when the committed
map differs from a fresh build. It is no longer a gate; use it locally to ask
"is the published map current?".

## The map is published, so a push to `main` is a deploy

GitHub Pages serves `/docs` from `main` at
`https://work-flowers.github.io/zapier-sdk/map.html`, and
[work.flowers/zap-map](https://www.work.flowers/zap-map) embeds that URL in an
`<iframe>`. Regenerating the map therefore changes a public page — no extra step,
but no undo either.

## `map.html` must stay a complete, standalone document

Doctype, `<html>`, `<head>`, `<body>`. It is a full-viewport app
(`html,body{height:100%}`, `#stage{position:absolute;inset:0}`,
`header{position:fixed}`), which only works when it owns the document.

**Never embed its markup directly in a host page**: `#stage` then resolves
`inset:0` against whatever the host's nearest positioned ancestor is, collapses
to a ~28px sliver, and `body{overflow:hidden}` leaks out and kills the host's
scrolling. That is exactly how the first Bullet.so publish failed — the JS ran
fine and built all 102 nodes; nothing was visible. The iframe is the fix, and it
also gives the map its own CSP so the embedded `data:font/woff2` faces load
(Bullet's `default-src 'self' https: wss:` blocks them).
