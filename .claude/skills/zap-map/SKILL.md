---
name: zap-map
description: Mechanics for regenerating this repo's interactive workflow map — docs/map-overlay.json curated semantics, scripts/build-map.mjs and its --check drift gate, why map.html must stay a standalone document, and the fact that merging to main publishes it publicly. Use when a Zap is added, removed or re-statused, when an asset relationship changes, or when build-map.mjs --check fails.
---

# The interactive workflow map

Repo rule (in `CLAUDE.md`): keep the map in sync. This skill is the how-to.

## Regenerating

[`docs/map.html`](../../../docs/map.html) is a generated atlas of every Zap and
the shared assets connecting them. When a Zap is added/removed/re-statused or an
asset relationship changes (a Table read/write, a Notion data source, a Drive
folder, the one zap→zap HTTP edge), update the curated semantics in
[`docs/map-overlay.json`](../../../docs/map-overlay.json) and run
`node scripts/build-map.mjs` to regenerate.

`node scripts/build-map.mjs --check` is the drift gate — it fails when the repo,
the overlay and the map disagree (new asset ids must be registered or explicitly
ignored; every zap dir must sit in exactly one cluster).

**That gate runs on every PR** ([`check-map.yml`](../../../.github/workflows/check-map.yml)),
so forgetting to regenerate fails the PR rather than publishing a stale map. It
does not regenerate for you — CI only refuses the drift; running the generator
and committing the result is still yours to do.

## A publish drifts the map, and the pipeline handles that itself

The map's data block is derived from `zap.json` — including `workflow_id` and
`enabled`. A **first publish** is the sharp case: a Zap awaiting creation has
`workflow_id: null`, which the extractor reads as "not deployed", so when the
publish pipeline fills the ids in, the committed map silently goes stale. The
sync-back commit is `[skip ci]`, so the PR gate above never sees it.

[`publish-zaps.yml`](../../../.github/workflows/publish-zaps.yml) therefore runs
`build-map.mjs` and commits `docs/map.html` alongside the `zap.json` changes that
caused the drift. **Don't hand-fix that kind of drift after a merge** — if `main`
is stale following a publish, the pipeline step is what's broken.

## The map is published, so a merge to `main` is a deploy

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
