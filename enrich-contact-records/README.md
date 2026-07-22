# Enrich Contact Records

Durable replacement for the "Enrich Contact Records" parent Zap and its
"[Sub-Zap] Update Contact Record" sub-Zap. The sub-Zap is collapsed into an
inline function (`updateContactRecord`) — no separate Durable needed.

## What it does

1. **Trigger** — Notion webhook on the Contacts DB (same `hook_v2` trigger as
   the original Zap).
2. **Enrich** — Calls `App243984CLIAPI.search.find_person_profile` with the
   contact's email, name, domain, and LinkedIn URL. On error or no result, logs
   and returns (no retry; the original Zap retried after a 1-minute delay).
3. **Update contact** — Inline function that replaces the sub-Zap:
   - **Same or no prior email** (Path D): sets Primary Email to the enriched
     email; leaves Secondary Email untouched.
   - **New/different email** (Path G): keeps the existing Primary Email, adds
     the enriched email to Secondary Email.
   - **Profile pic** (Path C): if the enrichment returned a profile pic URL,
     updates the Notion page icon and cover via `sdk.fetch`.
4. **Return** — `{ pageId, enriched, emailPath, iconUpdated }`.

## Connections

| Alias | App key | Connection |
|---|---|---|
| `notion_wf` | `NotionCLIAPI` | Notion (work.flowers \| Dennis) |
| `enrichment` | `App243984CLIAPI` | Person enrichment app (zapier-ninjapear) |

## Trigger configuration

```json
{
  "selected_api": "WebHookCLIAPI@1.1.1",
  "action": "hook_v2",
  "authentication_id": null,
  "params": {}
}
```

The Notion database automation on the Contacts DB sends a webhook to the
Zapier webhook URL when a contact is created or updated. The trigger payload
has the shape `{ data: { id, properties: { ... } } }`.

## Test

```bash
SOURCE_FILES="$(jq -n --rawfile workflow workflow.ts '{"workflow.ts": $workflow}')"

zapier-sdk --experimental run-durable "$SOURCE_FILES" \
  --dependencies '{"@zapier/zapier-sdk":"0.79.0","zod":"4.4.3"}' \
  --zapier-durable-version '0.6.1' \
  --connections '{"notion_wf":{"connectionId":"<notion-conn-id>"},"enrichment":{"connectionId":"<enrichment-conn-id>"}}' \
  --input '{"data":{"id":"<contact-page-id>","properties":{"First Name":{"rich_text":[{"plain_text":"Test"}]},"Last Name":{"rich_text":[{"plain_text":"User"}]},"Primary Email":{"email":"test@example.com"}}}}' \
  --private
```

## Deploy

```bash
zapier-sdk --experimental create-workflow "enrich-contact-records" \
  --description "Enrich Notion contact records with person profile data" \
  --private --json

# Capture the workflow ID, then:
zapier-sdk --experimental publish-workflow-version <workflow-id> "$SOURCE_FILES" \
  --dependencies '{"@zapier/zapier-sdk":"0.79.0","zod":"4.4.3"}' \
  --zapier-durable-version '0.6.1' \
  --connections '{"notion_wf":{"connectionId":"<notion-conn-id>"},"enrichment":{"connectionId":"<enrichment-conn-id>"}}' \
  --trigger '{"selected_api":"WebHookCLIAPI@1.1.1","action":"hook_v2","authentication_id":null,"params":{}}' \
  --enabled --json
```

## Architectural changes vs the original Zaps

- **No sub-Zap** — the sub-Zap's four-path branching logic (Path D / G / C / E)
  collapses into a single inline function with if/else blocks.
- **No retry** — the original parent Zap retried enrichment after a 1-minute
  delay on error. This Durable logs and skips instead.
- **Page icon via `sdk.fetch`** — the original sub-Zap used a Notion action
  (`ae:523997`) for the icon/cover update. This Durable uses a direct
  `PATCH /v1/pages/{id}` call instead, which is more reliable and doesn't depend
  on a specific action key.
- **Enrichment via `sdk.runAction`** — uses the Zapier SDK action interface
  rather than raw API calls, following the repo's existing Durable patterns.

## References

- `exported-zap-2026-07-22T01_26_39.602Z.json` — original parent Zap (Enrich Contact Records).
- `exported-zap-2026-07-22T01_26_44.566Z.json` — original sub-Zap (Update Contact Record).
