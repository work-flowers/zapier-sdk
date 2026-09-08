# Prompt: replicate the SCW ↔ workFlowers Google Calendar block-sync for Peter's calendars

> Hand this to Claude Code with the `work-flowers/zapier-sdk` repo checked out.

---

**Task: replicate Dennis's two-way SCW ↔ workFlowers Google Calendar block-sync for my own two calendars.**

**Context / why.** Dennis and I both work on SCW. Dennis can't see my availability when booking joint meetings, because my SCW calendar isn't visible in the workFlowers GCal workspace (and vice-versa). Dennis already runs a durable-Zap system that mirrors busy time between *his* SCW calendar and *his* work.flowers calendar. I want the same thing for **my** two calendars, built in the `work-flowers/zapier-sdk` repo through its normal PR/merge pipeline. Dennis approves the merge.

**First, read these — they are the source of truth and non-negotiable:**

- `CLAUDE.md`, `.claude/rules/durables.md`, `.claude/rules/durables-sdk.md` (repo + durable engineering rules).
- The four reference Zaps this replicates, READMEs *and* `workflow.ts` + `zap.json` — my build is a **direct, same-behaviour copy** of these, just repointed at my two calendars, my connections and my own table:
  - `scw-events-to-workflowers-block/` (SCW→wf, **full-title** create/update — my SCW meeting titles show in the workFlowers entries, same as Dennis's)
  - `workflowers-events-to-scw-busy/` (wf→SCW, **bare "Busy"** create/update)
  - `scw-cancellations-to-workflowers-unblock/` and `workflowers-cancellations-to-scw-unblock/` (the `event_cancelled` deletion Zaps)
  - `gcal-block-sweep/` (the daily horizon backstop — I need my own copy of this too; the horizon guard is load-bearing).
- Load the `zapier-sdk` + `workflows-modify`/`workflows-create` skills and run the `workflows-doctor` gate before writing any durable code.

**What to build — four Zaps + a sweep, one calendar pair (mine):**

- Source A = my SCW calendar `<peter@securecodewarrior.com>`; Source B = my work.flowers calendar `<peter@work.flowers>`. (I'll confirm the exact addresses.)
- Direction A→B and B→A, each an `event_updated` (`expand_recurring: true`) create/update Zap, **plus** a matching `event_cancelled` deletion Zap per direction — because `expand_recurring: true` silently drops cancellations (see the cancellation-Zap READMEs; this is proven, not theoretical).
- **Same asymmetry as Dennis's setup:** SCW→wf mirrors carry the **full title** (base on `scw-events-to-workflowers-block`); wf→SCW mirrors are a **private, bare "Busy" block** — `summary: "Busy"`, `visibility: private`, `transparency: opaque`, no description beyond the sync marker, no attendees, no reminders (base on `workflowers-events-to-scw-busy`). My work.flowers meeting details never leak into the SCW workspace; my SCW titles do show in workFlowers.
- Replicate `gcal-block-sweep` as my own daily reconcile/backstop, sharing my table, with `HORIZON_DAYS` kept in lockstep (30) across all my workflows.

**Things I must set up fresh (do NOT reuse Dennis's):**

- **A brand-new "GCal Sync Map" Zapier Table** with the identical 8-column schema (`Source Event ID` f1, `Mirror Event ID` f2, `Direction` f3, `Status` f4, `Start` f5, `End` f6, `Summary` f7, `Source Updated` f8). **Do not reuse Dennis's table `01M13QPJ5GRJV33096MBNSN1Q5`** — a shared table would cross-contaminate loop guards and mirror maps.
- **My own two Google Calendar connections** in the workFlowers Zapier workspace (my SCW auth + my work.flowers auth). Do not bind Dennis's connection ids. Each direction reads one calendar on the trigger and writes the other via a bound `--connections` alias, exactly as the reference `zap.json`s show.
- New workflow names + directories (e.g. `peter-scw-events-to-workflowers-block`, `peter-workflowers-events-to-scw-busy`, and the two `-cancellations-` companions) — Dennis and I will finalize names.

**Loop guards — keep Dennis's three layers exactly as-is** (they carry over unchanged because I'm keeping the same asymmetry — only the wf→SCW direction emits bare "Busy"):

1. **Structural** — each Zap reads one calendar, writes the other (one hop max).
2. **Table** — every mirror's event id is written as `Mirror Event ID`; skip any incoming event whose id is found there (this also swallows cancellation echoes).
3. **Content** — skip the SCW→wf full-title mirrors by their `[gcal-block]` description marker, and skip the wf→SCW bare mirrors by their `Busy` summary — the same checks as the reference workflows.

**Durable gotchas the repo has already paid for (all in the rules/READMEs — obey them):**

- No `new Date` / `Date.now()` / `Math.random()` / `fetch` in the workflow body — determinism guard throws at runtime; wrap real clock reads in a `ctx.step`, do calendar maths with the integer helpers.
- Key everything on the per-occurrence `id` (`<seriesId>_<originalStartUTC>`), **never `iCalUID`** (series-wide).
- Webhook/`event_updated` empty-ping safety and unrecognized-payload handling per `durables.md`.
- The horizon guard (`expand_recurring: true` can expand a weekly series ~730 instances in one poll) — keep the 30-day create-horizon; the sweep fills in occurrences as they roll into the window.
- A truncated ("this and following") series leaves orphan mirrors that no trigger catches — the daily sweep is what cleans them up. That's why the sweep isn't optional.

**Ship it the repo way (not a direct CLI publish):**

- Each directory gets `workflow.ts`, `zap.json`, and a `README.md` with a Mermaid diagram, per repo rules 1–4.
- `is_private: false`; author `zap.json` in the `pending-create` shape (null ids + `deploy` block) so the pipeline first-publishes on merge — declare `trigger`, `is_private`, `enable_on_publish` explicitly (a catch-hook isn't used here, these are polling triggers).
- **Park every Zap disabled until cutover** (`deploy.enable_on_publish: false`, `enabled: false`) if any prior/manual blocking is still live, so nothing double-writes the moment the PR merges. Record the cutover date in `zap.json` when we flip them on.
- Update the root `README.md` index and regenerate the interactive workflow map (`docs/map-overlay.json` + `node scripts/build-map.mjs`) in the same PR — the map's `--check` is a required CI gate.
- Open a PR; **do not merge without Dennis's explicit go-ahead** (merge = deploy in this repo).

**Before you write anything, confirm back to me:** my two exact calendar addresses, the final four workflow names, and whether any old blocking (Notion Calendar or otherwise) is still live on either of my calendars that we need to disable at cutover.
