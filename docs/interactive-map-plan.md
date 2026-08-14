# Interactive map of the zapier-sdk workflow graph

## Context

Dennis wants a cool-looking, beautiful, informative **interactive map of all Zapier durable workflows** in this repo — pan/zoomable ("Rhizome / mermaid-like", different levels of detail at different zoom), following the workFlowers design guidelines. The key requirement: **illustrate interconnections between Zaps through the shared assets they touch** — Zapier Tables, Notion data sources, Drive folders, external apps.

Approved decisions (AskUserQuestion):
- **Delivery: both** — a self-contained HTML file committed to the repo AND published as a Claude Artifact link.
- **Maintenance: generator script** — e.g. `scripts/build-map.mjs` extracts graph data from `zap.json`/`workflow.ts` so the map stays refreshable.

## Inventory (Phase 1 findings, verified)

- 57 top-level Zap dirs; ~66 deployed workflow IDs (multi-deployment dirs use `deployments[]` in zap.json: `internal-user-ids-to-table-and-notion` ×5, `whatsapp-slack-bridge` ×3, `luma-event-to-notion` ×2, `esignatures-send-for-signing` ×2, `esignatures-status-to-notion` ×2). Parser must handle both zap.json shapes.
- 3 dirs with **no zap.json**: `deal-won-set-up-client-workspace` (never deployed), `xero-bill-approved-to-wise-transfer` (shelved design record), `email-contact-page-zap` (classic code step).
- **Hub assets**: Table `01JYEPSEARXB2Z6BJRCMFGXBC2` Email→Contact Page IDs (owner `contact-emails-to-zapier-table`, 11 consumers); Table `01JM3J9SG5X6S8GBSSC8AS28AT` Internal User IDs; Table `01JM8PH8YM93A482M8BFZ6WKW6` Company IDs (has "referenced-but-not-read" zaps to distinguish); ~20 tables total. Notion DS: Contacts (14 zaps), Companies (10), Deals (8), plus SOWs, Project Addendums, Events, Event Attendance, Newsletter Issues, Meeting Notes, People, Blog, Signed Legal Agreements.
- Producer→consumer via **Drive folders**: `gmail-attachments-to-drive-by-type` → Invoices/Paid Receipts/Signed Agreements folders → `drive-invoice-to-xero` / `drive-paid-receipts-to-table` / `drive-signed-agreement-to-notion`.
- Exactly **one direct zap→zap HTTP edge**: `notion-page-deleted-to-zapier-tables` POSTs to `notion-companies-to-zapier-table`'s catch URL (`workflow.ts:38`).
- Table `01JZCVG73MBWWB0357CEPS4903` (Meeting Note IDs) is owned by an **external** Notion Worker — show external ownership.
- 9 zaps carry AI steps (`*-prompt.md`); one at `advanced/auto`, rest `standard/auto`.
- Statuses: enabled / disabled / cutover-pending / retired / shelved / never-deployed. One README-vs-zap.json disagreement (`contrast-registrations-to-event-attendance`).

## Design system (the "design guidelines")

No vendored design skill; the de-facto system lives in two self-contained HTML explainers already in the repo — **match them**:
- `drive-invoice-to-xero/drive-invoice-to-xero.html` — "Persian Indigo anchor, Inter, ledger-ruled figure columns, 4pt spacing, 5px radius"; inline D3.
- `whatsapp-slack-bridge/whatsapp-slack-bridge.html` — full dark-mode token set (`--bg:#12101C --surface:#1A1726 --surface-2:#211D30 --ink:#F2F1F7 …`), radius scale, lane colouring.
- Brand palette (from `notion-blog-post-to-hero-image-prompt.md`): Persian Indigo `#2E1B88`, Azure `#1479E1`, Russian Violet `#4E1B61`, Non-Photo Blue `#9CE1FC`, Ochre `#E17A14`, Peach `#F6C696`, Eerie Black `#1F1F1F`. Inter for text, **JetBrains Mono for every figure/id**. Fonts base64-embedded (both reference files do this) — required anyway by the Artifact CSP (no external requests).

## Approach

**Correction found during design:** neither reference HTML uses D3 (the "d3 refs" in `drive-invoice-to-xero.html` were base64 font bytes). Both are hand-rolled inline SVG + CSS with a small vanilla-JS interaction layer. The map follows that precedent — no vendored library, CSP-safe by construction.

### Rendering: hand-rolled SVG, build-time layout

- `scripts/build-map.mjs` computes the layout in Node (deterministic, seeded mulberry32 PRNG) and bakes fixed x/y into the graph JSON. The browser does **zero layout** — runtime JS (~400–500 hand-authored lines) is only: pan/zoom (one `transform` on a root `<g>`, pointer + wheel + pinch), hover neighborhood highlighting (precomputed adjacency), semantic-zoom class toggling, detail panel.
- **Layout algorithm: cluster-anchored force layout** run at build time (~120 lines, velocity-Verlet): ~7 curated domain clusters arranged in a ring (**crm-contacts, finance-xero, events, newsletter-content, client-onboarding, internal-ops, esignatures-legal**). Zap nodes gravitate to their cluster center; asset nodes to the centroid of their consumers' clusters (Contacts DS lands between crm and events naturally). Mega-hubs get large collision radii and weak link springs (1/√degree) so they anchor rather than collapse the graph. ~300 iterations + collision pass + label-overlap nudge; coords rounded to ints so diffs are stable.
- **Semantic zoom** via CSS classes from zoom factor `k`: `k<0.55` cluster hulls + hub labels only; mid-zoom all zap labels; `k≥1.1` full detail (edge glyphs, status badges). Pure class toggling.
- Multi-deployment dirs = **one node** with a deployments sub-list in the panel (the dir is the unit of maintenance).

### Data pipeline: parse facts, curate semantics, `--check` for drift

- **Parsed** from the repo: dir list, both zap.json shapes (`deployments[]` vs top-level) + the 3 no-zap.json dirs, descriptions, triggers, connections, `tables`/`drive_folders`/`ai_model` blocks, plus a regex sweep for every ULID table-id and UUID DS-id in zap.json + workflow.ts so nothing escapes the map.
- **Curated** in `docs/map-overlay.json`: cluster membership; canonical asset registry (names, types, `external_owner` for the Meeting Note IDs table, `legacy` for the stale DS id); the ~150 semantic edges `{from, to, kind: own|write|read|trigger|reference|http}` (read/write semantics live in zap.json prose, not parseable) — including the one zap→zap HTTP edge and the 3 Drive-folder producer→consumer chains; status overrides (shelved/never-deployed/retired + the contrast-registrations disagreement, surfaced as a panel note).
- **`--check` mode** (mirrors `check-prompts.mjs` exit-code contract): every extracted asset id must be in the overlay registry and vice versa; every zap dir in exactly one cluster; regenerated data block must byte-match the committed one. Default run regenerates in place; `--check` never writes.

### Visual encoding (workFlowers tokens, light + dark)

- Node type by **shape + border color**: durable = rounded rect, Persian Indigo border; classic code step = dashed rect; Zapier Table = ledger-rule-topped rect, Ochre, mono id; Notion DS = circle, Russian Violet; Drive folder = notched rect, Azure; external app = grey pill at cluster periphery (only apps creating real interconnection get nodes). Hub size scales with √degree.
- Status: enabled full opacity; disabled 45% grey; cutover-pending ochre dot; shelved/never-deployed dashed + 60%; retired grey tag; external-owned = double border.
- Edges (quadratic curves): write solid 1.5px →asset; read solid 1px →zap; own 2.5px accent; trigger azure with origin dot; reference-only dotted 35% (distinct from read, per the Companies-table case); the single HTTP zap→zap edge ochre 2px with its own legend entry.
- Hover: 1-hop neighborhood at full opacity, rest fades to ~0.12. Fixed legend bottom-left; theme toggle top-right (same `data-theme` mechanism as reference files).

### Detail panel (right, ~320px, on node click)

Zap node: mono name, status badge, cluster chip, description from `zap.json.description` (clamped, expander; overlay `blurb` override available), trigger line, AI badge with tier (advanced-tier zap visually distinct), deployments sub-list, assets grouped by direction (owns/writes/reads/references — rows link to asset nodes and pan/zoom to them), GitHub link `https://github.com/work-flowers/zapier-sdk/tree/main/<dir>`. Asset node: type, mono id, external-owner note, owner/writer/reader lists.

### Files

```
docs/map.html          hand-authored template + deliverable in one; generator rewrites ONLY
                       the marker-delimited <script id="graph-data"> JSON block
docs/map-overlay.json  curated semantics
scripts/build-map.mjs  extract → merge overlay → validate → layout → inject
```
Fonts: lift the InterVar + JetBrains Mono base64 `@font-face` blocks verbatim from `drive-invoice-to-xero.html` (~130KB; total file ~250–300KB). **Artifact = the identical file published as-is** (already CSP-clean and theme-aware).

### Docs updates (repo rule 3)

- Root `README.md`: `build-map.mjs` row in the scripts table; `docs/` + map pointer in Repo structure.
- `CLAUDE.md`: one Working-conventions bullet — when a Zap or asset relationship changes, update `docs/map-overlay.json`, run `node scripts/build-map.mjs`; `--check` is the drift gate.

## Implementation sequence

1. Extractor phase of `scripts/build-map.mjs`; verify counts (57 dirs, ~66 workflow ids, ~20 tables).
2. Author `docs/map-overlay.json` (clusters, asset registry, ~150 edges) from the cross-reference already gathered.
3. `--check` + validation (orphans both directions, cluster totality).
4. Layout engine; iterate via debug SVG dumps to scratchpad until clusters read cleanly.
5. `docs/map.html` template: tokens + fonts from the reference files, SVG scaffold, pan/zoom, semantic zoom, hover, panel, legend, theme toggle, data markers. (Load `artifact-design`/`dataviz` skill guidance where it applies before styling.)
6. Wire injection, generate, commit map + overlay + script.
7. README + CLAUDE.md updates.
8. Push to `claude/zapier-workflows-interactive-map-zr5ime`, open draft PR, publish `docs/map.html` as the Artifact, send Dennis the link.

## Verification

- `node scripts/build-map.mjs && node scripts/build-map.mjs --check` → exit 0; perturb a zap.json field → `--check` fails.
- Generator asserts: node/edge counts, every edge endpoint resolves, enabled flags flow from zap.json.
- Playwright + bundled Chromium on `file://…/docs/map.html`: **zero non-`data:` network requests**; screenshots at k≈0.4/1.0/2.0 in both themes; click a hub → panel screenshot; console must be error-free.
- Grep final HTML: no `https://` outside GitHub links in the data block.
- Truth spot-checks: 11 read edges into the email table, 14 on Contacts DS, exactly one ochre HTTP edge, 3 Drive-folder chains, double border on the externally-owned Meeting Note IDs table.
