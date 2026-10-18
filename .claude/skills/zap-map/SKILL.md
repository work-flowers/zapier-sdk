---
name: zap-map
description: Mechanics for this repo's interactive workflow map — docs/map-overlay.json curated semantics, scripts/build-map.mjs and its --validate check, how to regenerate the map by hand, why map.html must stay a standalone document, and the fact that the map publishes publicly from main. Use only when asked to regenerate or edit the map — ordinary Zap PRs no longer maintain it.
---

# The interactive workflow map

No CI maintains this map. The daily `refresh-map.yml` job and the
`check-map.yml` PR gate were retired 2026-10-18 — the map was a novelty and
didn't need constant upkeep. Ordinary Zap PRs leave it alone; it is regenerated
only when someone asks, so the published copy can trail the repo indefinitely.

## Regenerating (by hand, on request)

[`docs/map.html`](../../../docs/map.html) is a generated atlas of every Zap and
the shared assets connecting them. Its facts are extracted from the repo; the
read/write/own/trigger semantics are curated in
[`docs/map-overlay.json`](../../../docs/map-overlay.json).

1. `node scripts/build-map.mjs --validate` — fails when the repo and the overlay
   disagree (new asset ids must be registered or explicitly ignored; every zap
   dir must sit in exactly one cluster; every zap→asset reference needs a
   curated edge). Expect a backlog of gaps after a long gap between refreshes;
   fix the overlay until it passes.
2. `node scripts/build-map.mjs` — rewrites only the marker-delimited data block
   in `docs/map.html`. It refuses while `--validate` would fail.
3. Open the page locally to check it, then commit `map.html` and the overlay in
   one PR. After it merges, run the deploy (below).

`node scripts/build-map.mjs --check` fails when the committed map differs from a
fresh build — use it to ask "is the published map current?".

## Publishing is a separate, manual step

[`deploy-pages.yml`](../../../.github/workflows/deploy-pages.yml) publishes
`docs/` to `https://work-flowers.github.io/zapier-sdk/map.html`, and
[work.flowers/zap-map](https://www.work.flowers/zap-map) embeds that URL in an
`<iframe>`. Since 2026-10-18 it runs **only by hand**
(`gh workflow run deploy-pages.yml`); merging a `docs/` change no longer
deploys. So after the regeneration PR merges, run the deploy and check the live
page. Pages' source must stay set to "GitHub Actions". Deploying changes a
public page with no undo.

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
