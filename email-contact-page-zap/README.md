# [Sub-Zap] Retrieve Contact Page IDs for Email Addresses

Single-Code-step replacement for the original 24-node Zap. Same contract: takes
`To`/`From`/`Cc` header strings, returns a comma-separated string of Notion
Contact page IDs.

- `code-step.js` — paste this into the Zap's Code (Run JavaScript) step.
- `code-step.test.js` — local Node tests (`node --test code-step.test.js`).
- `exported-zap-2026-05-06T01_58_34.473Z.json` — original visual Zap, kept as historical reference.

## Wiring it into the Zap

The end-state Zap has 3 steps: `start_subzap` → Code step → `return_subzap`.

In the Code step:

1. Toggle **`@zapier/zapier-sdk` (latest)** on so `zapier` and `connections` are auto-imported.
2. **Add app connection → Notion**, account = `work.flowers | Dennis`, set Account ID Variable to `notion`.
   (Zapier Tables and AI by Zapier are built-in and do not need connections.)
3. **Input Data:**

   | Key   | Value             |
   |-------|-------------------|
   | `to`  | `{{trigger.To}}`  |
   | `from`| `{{trigger.From}}`|
   | `cc`  | `{{trigger.Cc}}`  |

4. Paste `code-step.js` as the code body. The Return step maps `page_ids` from this step's output.

## What it does (summary)

1. Extract & dedupe email addresses from `to`/`from`/`cc`. Drop anything ending in `@work.flowers`, anything in the address blocklist, or anything containing a substring blocklist token (`support`, `billing`, `contact`, `@zapiermail.com`, `@resource.calendar.google.com`).
2. Look up filtered emails in Zapier Table `01JYEPSEARXB2Z6BJRCMFGXBC2` via `TableCLIAPI.search.find_record`.
3. If every email already has a row → return the matched page IDs and stop.
4. Otherwise, for each new email (capped at 10):
   - Ask AI by Zapier (`gpt-5-mini`, plan-included credits) whether the address looks like an individual person.
   - If yes, create a Notion Contacts row (`NotionCLIAPI.write.create_database_item`, data source `21991b07-11ac-81a6-a894-000be4a09a67`, property `Primary Email`).
   - Write the email→page-id mapping back to the Zapier Table immediately (`TableCLIAPI.write.create_record`).
5. Return existing + newly-created page IDs as a comma-separated string.

## Architectural change vs the original Zap

The original waited 1 minute and re-queried the Table because a sibling Zap (Notion → Tables sync) populated the email→page-id mapping. The new Code step writes the Table row itself, eliminating the delay.

**Required one-time edit to the sibling Notion→Tables Zap:** make it upsert (skip the row insert if the email already exists in the Table). Otherwise the sibling Zap will create a duplicate row whenever this Code step creates a new Notion contact.

The sibling Zap is still useful as a safety net for Contacts created via the Notion UI or other Zaps — don't delete it, just dedupe.

## Open question: the Table's "Trigger Contact Creation" field

The Table has a `f7` boolean field titled "Trigger Contact Creation". It's not currently set by this code. If that field drives the sibling sync Zap (i.e. the sibling watches for new Table rows where `f7=true`), set it to `false` here as an extra safeguard. Confirm by checking the sibling Zap's trigger before going live.

## Local tests

```bash
node --test code-step.test.js
```

Mocks the `zapier`/`connections` globals and exercises: empty input, all-existing, all-new, mixed, AI says false, blocklist hits, cap exceeded, and per-email error isolation. All 7 should pass.

## End-to-end verification in the Zap editor

Use **Test step** with these scenarios for the Input Data fields:

1. **All-internal** — `to: alice@work.flowers, bob@work.flowers` → `page_ids = ""`.
2. **All-known** — emails already in the Table → returns existing IDs, no Notion writes (verify in Notion + Table).
3. **Mixed** — known + new individual + service-address → existing IDs returned, only individual classified gets Notion + Table row.
4. **AI false-classification** — `to: info@somewhere.com` (would slip the substring filter) → no Notion write.
5. **Cap** — paste 15+ unknown vendor.com addresses → exactly 10 created.

Then re-run an upstream production Zap that calls this sub-zap with a real email; confirm the resulting Notion linkages match what the old Zap produced.
