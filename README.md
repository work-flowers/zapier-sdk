# zapier-sdk

Source-of-truth repo for **workFlowers** Code Zaps in the main work.flowers Zapier workspace — Durables (`@zapier/zapier-durable`) plus one classic Code-step Zap.

## Repo structure

One sub-directory per Zap. Each Durable directory contains:

| File | Purpose |
| --- | --- |
| `workflow.ts` | The durable workflow source, as published on Zapier |
| `zap.json` | Deployment metadata: workflow ID, current version ID, trigger URL, runtime/dependency versions |
| `README.md` | Brief description of the Zap: what it does, trigger, a Mermaid diagram of the workflow, maintainer notes |

Classic Code-step Zap directories carry the code-step source and tests instead of `workflow.ts`/`zap.json`; everything else applies unchanged.

## Repo rules

1. **Every Zap sub-directory includes a brief README** in addition to the code, always with a Mermaid diagram depicting the workflow, if possible.
2. **Deployed code always links back to this repo** — each source file carries a `// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/<zap-name>` comment, and that comment must be present in the version published to Zapier.
3. **This root README is updated whenever Zaps are created, published, modified, enabled/disabled, or removed** — keep the Zap index below current.
4. **Every Durable directory carries a `zap.json` mirroring the deployed state** — pulled from Zapier when the Zap is added to the repo, and refreshed (`current_version_id`, `enabled`, dependency versions, etc.) whenever the Zap changes on Zapier.

These rules are mirrored in [CLAUDE.md](CLAUDE.md) so Claude Code sessions follow them automatically.

## Zaps

| Zap | Type | Status | Description |
| --- | --- | --- | --- |
| [`contrast-registrations-to-event-attendance`](contrast-registrations-to-event-attendance/) | Durable | ✅ Enabled | Contrast webinar registrations → Notion Event Attendance upserts, resolving/creating the related Event (by Contrast ID) and Contact (via email → page-ID Zapier Table). |
| [`deal-won-set-up-client-workspace`](deal-won-set-up-client-workspace/) | Durable | ⚠️ Not deployed | Deal won → create the company's Google Drive folder under Client Docs and link it on the Notion Companies record. Source only; not yet published to Zapier. |
| [`email-contact-page-zap`](email-contact-page-zap/) | Code step (classic Zap) | ✅ In production | [Sub-Zap] Retrieve Contact Page IDs for Email Addresses — single Code step replacing the original 24-node sub-Zap. |
| [`enrich-contact-records`](enrich-contact-records/) | Durable | ✅ Enabled | Enrich Notion contact records with person profile data; collapses the old parent Zap + sub-Zap into one workflow. |
| [`notion-companies-to-zapier-table`](notion-companies-to-zapier-table/) | Durable | ✅ Enabled | Race-safe mirror of Notion Companies records into the company-ID Zapier Table, keyed on Notion Page ID. |
| [`notion-newsletter-to-buttondown`](notion-newsletter-to-buttondown/) | Durable | ✅ Enabled | Notion Newsletter Issues page → Buttondown draft/scheduled email, keyed on the page's Buttondown ID. |

## Working with these Zaps

Managed via the Zapier SDK CLI (preferred — faster and more cost-effective) or the Zapier MCP connector as a fallback:

- **List deployed workflows** — CLI workflows list command (MCP: `list_workflows`)
- **Inspect a version** — CLI workflows version command (MCP: `get_workflow_version`, returns `source_files`)
- **Publish changes** — edit `workflow.ts` here, then publish a new version and update `zap.json` with the new `current_version_id`

Convention: after any change published to Zapier, sync the source and metadata back to this repo so it stays the source of truth.

### Setting up the Zapier CLI

Requires Node.js 20+. The CLI runs via `npx` — no global install needed:

```bash
npx zapier-sdk login
```

This opens a browser to authenticate against your Zapier account (credentials are stored at `~/.config/zapier-sdk-cli-nodejs/config.json`). On a machine without a browser, use `npx zapier-sdk login --headless`. For project-local installs: `npm install -D @zapier/zapier-sdk-cli` (and `@zapier/zapier-sdk` as a runtime dependency if writing code against the SDK).

**Durables note:** the Code Workflows commands used for these Zaps are still experimental — use the `zapier-sdk-experimental` bin, or pass `--experimental` / set `ZAPIER_EXPERIMENTAL=true` with the plain `zapier-sdk` CLI.

Reference docs:

- [Zapier SDK API reference](https://docs.zapier.com/sdk/reference)
- [SDK changelog](https://docs.zapier.com/sdk/changelog) (Zapier ships near-daily — check here when a command's behaviour seems off)
