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

A Zap with an AI step additionally carries a `*-prompt.md` holding the prompt (repo rule 6). Repo-wide helper scripts live in [`scripts/`](scripts/).

A Zap deployed more than once from one directory keeps a single `zap.json` with a `deployments` array (see [`luma-event-to-notion`](luma-event-to-notion/)). Where those deployments need to differ in code, the shared logic lives in a module and each deployment publishes its own thin entry file as `workflow.ts` — see [`internal-user-ids-to-table-and-notion`](internal-user-ids-to-table-and-notion/).

## Repo rules

1. **Every Zap sub-directory includes a brief README** in addition to the code, always with a Mermaid diagram depicting the workflow, if possible.
2. **Deployed code always links back to this repo** — each source file carries a `// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/<zap-name>` comment, and that comment must be present in the version published to Zapier.
3. **This root README is updated whenever Zaps are created, published, modified, enabled/disabled, or removed** — keep the Zap index below current.
4. **Every Durable directory carries a `zap.json` mirroring the deployed state** — pulled from Zapier when the Zap is added to the repo, and refreshed (`current_version_id`, `enabled`, dependency versions, etc.) whenever the Zap changes on Zapier.
5. **Creating a page in a Notion data source always applies that data source's default template, if one exists** — automation-created pages must look like hand-made ones. Pass `template_mode: "default"` on every `create_database_item` call and fall back to a plain create only when Notion reports the data source has no default template. Because a template and inline page content are mutually exclusive in one call, body content is added in a second `write/page_content` call. See the "Notion page creation" convention in [CLAUDE.md](CLAUDE.md) for the helper and the exact error to catch.

6. **Every Zap with an AI step keeps its prompt in a `*-prompt.md` file in the Zap's directory** — prompts are the part of a Zap most worth reviewing and the hardest to read inside a code literal, so the markdown is the source of truth and the deployed source embeds a verbatim copy. Run `node scripts/check-prompts.mjs` to verify the two agree (`--fix` re-injects from the markdown). See [`gmail-attachments-to-drive-by-type`](gmail-attachments-to-drive-by-type/) for the reference layout.
7. **AI steps run on AI by Zapier and default to the `standard/auto` tier.** The tier *is* the task cost — standard 1×, advanced 3×, premium 5× per run — and Zapier's own Advanced default exists mainly to enable tool calls, which these Zaps don't use. A higher tier is only adopted when a test at Standard actually fails; the doubt gets raised first and the comparison recorded. Each such Zap keeps a verified-cases table in its README and an `ai_model` block in its `zap.json`. See the "AI by Zapier" convention in [CLAUDE.md](CLAUDE.md).

These rules are mirrored in [CLAUDE.md](CLAUDE.md) so Claude Code sessions follow them automatically.

## Zaps

| Zap | Type | Status | Description |
| --- | --- | --- | --- |
| [`contact-emails-to-zapier-table`](contact-emails-to-zapier-table/) | Durable | ✅ Enabled | Sole owner of the email → page-ID Zapier Table. Notion Contacts email edits → index every Primary/Secondary email; marks cross-contact collisions as `Duplicate of`; on trash, hands a merged-away contact's addresses to the survivor or deletes them if it was a genuine delete; on restore, re-indexes them; ignores pages from the other Core CRM Objects data sources. Port of the classic "Update Zapier Table When Email Address Updated" Zap, plus the retired Contacts branch of "Delete Contact, Company or Meeting Note Page from Zapier Table". |
| [`contrast-registrations-to-event-attendance`](contrast-registrations-to-event-attendance/) | Durable | ⏸️ Disabled | Contrast webinar registrations → Notion Event Attendance upserts. Retired 2026-07-23 when events moved to Luma; kept for reference. |
| [`deal-won-set-up-client-workspace`](deal-won-set-up-client-workspace/) | Durable | ⚠️ Not deployed | Deal won → create the company's Google Drive folder under Client Docs and link it on the Notion Companies record. Source only; not yet published to Zapier. |
| [`email-contact-page-zap`](email-contact-page-zap/) | Code step (classic Zap) | ✅ In production | [Sub-Zap] Retrieve Contact Page IDs for Email Addresses — single Code step replacing the original 24-node sub-Zap. |
| [`enrich-contact-records`](enrich-contact-records/) | Durable | ✅ Enabled | Enrich Notion contact records with person profile data (Apollo primary, NinjaPear fallback); collapses the old parent Zap + sub-Zap into one workflow. An enriched work address takes `Primary Email` when the existing Primary is a consumer mailbox; a corporate Primary is left alone. Contact name falls back to the page title, skip comments name each source's failure separately, and NinjaPear is never queried with a personal email (privacy-rejected — stripped from inputs, call skipped if nothing else identifies the person). |
| [`gmail-attachments-to-drive-by-type`](gmail-attachments-to-drive-by-type/) | Durable | ✅ Enabled | Gmail email with PDF attachments → classify every attachment in **one** AI call → file each into Invoices / Paid Receipts / Signed Agreements / Financial Reporting. Migration of the classic "Gmail Attachments to Google Drive by Type" Zap. Triggers **per email, not per attachment**, so the classifier sees an invoice alongside the receipt that settles it — the Invoices folder now holds only bills that are still outstanding. Replaces the old "due date == invoice date" proxy with real payment evidence. |
| [`internal-user-ids-to-table-and-notion`](internal-user-ids-to-table-and-notion/) | Durable ×5 | ✅ Enabled (Linear pending) | One shared `sync.ts` deployed five times — Slack / Harvest / Linear / Notion / Zapier Manager. Upserts the internal person's row in the "User IDs" Zapier Table, then mirrors every ID onto their row in Notion's native People data source. Port of the five classic "Add New \<System\> User ID" Zaps, plus the Notion mirror. **Linear's outgoing webhook still needs repointing at the new catch-hook** — see the directory README. |
| [`luma-event-to-notion`](luma-event-to-notion/) | Durable ×2 | ✅ Enabled | One code file deployed twice — `luma-event-created-to-notion` (`event_created`) and `luma-event-updated-to-notion` (`event_updated`). Upserts the Notion Events record keyed on Luma ID: properties, page cover, and description → page body (full replace). |
| [`luma-guest-registered-to-event-attendance`](luma-guest-registered-to-event-attendance/) | Durable | ✅ Enabled | Luma `guest_registered` → Event Attendance upsert. **Sole creator** of Event/Contact/Attendance records for the guest flow (see README for the race this prevents). A guest's `Work Email` registration answer becomes the contact's `Primary Email`, with the Luma account address kept as a Secondary. A ticked newsletter opt-in answer subscribes them in Buttondown under that same address — last, so the Buttondown → Contacts automation can't race this one into a duplicate contact. |
| [`luma-guest-updated-to-event-attendance`](luma-guest-updated-to-event-attendance/) | Durable | ✅ Enabled | Luma `guest_updated` → pure updater: refreshes Approval Status / ticks Checked In on the existing Attendance record; never creates. Also applies the work-email → `Primary Email` promotion, which is the only path that catches a guest editing that answer after registering. |
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
