# drive-files-to-zapier-table

Google Drive polling trigger (new file or folder anywhere on **Work.Flowers
HQ**) → upsert that object into **[Table] Google Drive Files and Folders**,
keyed on the Drive object id.

Migration of the classic Zap **"Log New Google Drive Files and Folders in
Zapier Table"**.

- **Workflow ID:** _pending first publish_ (account-visible)
- **Trigger:** Google Drive `file_in_folder_v2` over the whole shared drive
  (`0AHY_MJFjT0WtUk9PVA`), subfolders on, 4 levels deep, deleted excluded — a
  polling trigger, no external URL to cut over. Durable triggers have no
  polling-interval field; the classic Zap ran at the account default too
  (`polling_interval_override: 0`).
- **Table:** `01K5ZN0AGNDHS4C424XEDCWJZY` — this workflow **owns** row creation.

## Workflow

```mermaid
flowchart TD
    A["Google Drive polling trigger:<br/>new file/folder on Work.Flowers HQ"] --> B["Extract id, kind, name, parent"]
    B --> C{"id present?"}
    C -- no --> E1(["Throw — real event, unknown shape"])
    C -- yes --> D["Look up [Table] row by ID"]
    D --> F{"Row exists?"}
    F -- no --> G["Create row<br/>ID · Kind · Name · Parent ID"]
    G --> H["Re-query; if a concurrent run<br/>also created, keep earliest ULID"]
    F -- yes --> I{"Name or parent<br/>drifted?"}
    I -- no --> S1(["Skip — unchanged"])
    I -- yes --> J["Update row"]
```

## What changed vs the classic Zap

- **Idempotent on the Drive id.** The classic Zap called `create_record`
  unconditionally, so any re-trigger on the same object added a duplicate row.
  The durable upserts: unseen ids are created, a known id is left alone, and a
  known id whose `Name`/`Parent ID` drifted is repaired.
- **Racing creates converge.** Two runs that both find nothing and both create
  now agree on the earliest ULID and delete the rest, the same pattern
  [`notion-companies-to-zapier-table`](../notion-companies-to-zapier-table/)
  uses. Zapier Tables offer no unique constraint, so this narrows the window
  rather than closing it (see the concurrency note in `CLAUDE.md`).
- **Table writes are free.** Row reads and writes go through the SDK Tables API
  (`listTableRecords` / `createTableRecords` / `updateTableRecords`), which
  consumes no Zapier tasks — so the whole run costs nothing beyond the trigger.

## Testing

Not yet run. `run-durable` on this workflow **writes to the production
inventory table**, so the first exercise is the first live run after cutover;
the upsert makes a repeated run safe. The trigger param shapes
(`includeSubfolders` BOOLEAN, `subfolderDepth` INTEGER) are field-verified
against the live connection with `list-trigger-input-fields`.

## Cutover

**Pending.** The durable is published but **disabled**. To cut over:

1. Disable the classic Zap **"Log New Google Drive Files and Folders in Zapier
   Table"** in the Zapier UI (classic Zaps are exposed by neither the SDK CLI
   nor the MCP connector).
2. `zapier-sdk --experimental enable-workflow <workflow_id>`
3. Record the date in `zap.json` under `cutover.classic_zap_disabled`.

Order is not critical here — both sides upsert-or-create the same row, and the
durable's dedupe absorbs an overlap — but leaving both enabled reintroduces the
duplicate rows the durable exists to stop.

## Maintainer notes

- **No connection aliases.** The workflow only touches Zapier Tables, which
  need none; the Google Drive connection is bound to the *trigger*
  (`trigger.authentication_id`), not to a step.
- `kind` falls back to the mime type when Drive omits its own
  `drive#file`/`drive#folder` discriminator — that is what distinguishes a
  folder from a file.
- [`drive-file-renamed-to-zapier-table`](../drive-file-renamed-to-zapier-table/)
  keeps `Name`/`Parent ID` current after creation. Rows are never created there.
