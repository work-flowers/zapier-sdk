# Luma Guest Registered → Notion Event Attendance

Durable workflow (trigger **`guest_registered`**, `LumaCLIAPI@6.1.0`) that upserts a Notion
**Event Attendance** record from a Luma guest. Replaces the retired
`contrast-registrations-to-event-attendance` workflow.

> **This is the SOLE CREATOR** of Event / Contact / Attendance records for the guest flow.
> The sibling [`luma-guest-updated-to-event-attendance`](../luma-guest-updated-to-event-attendance)
> (trigger `guest_updated`) is **lookup/update-only** and never creates.
>
> **Why the split:** Luma fires `guest.registered` **and** `guest.updated` within ~150ms of a
> single new registration. When both workflows could create, they raced and produced duplicate
> Attendance (and Contact) records — neither saw the other's just-created record (Notion search
> lags, and this Zapier account has no unique-Table constraint to claim atomically). Making
> creation single-owner eliminates the race.

## What it does

1. Extract the guest: `email` (required), name, `approval_status`, `registered_at`,
   `checkedIn` (any `tickets[].checked_in_at` set), and the nested `event`.
2. **Resolve the Event** — free `LUMA_EVENT_TABLE` lookup → Notion `Luma ID` search →
   create from the guest's `event` object (rich, incl. page cover) and index the table.
3. **Resolve the Contact** — email → page-id via `CONTACT_EMAIL_TABLE`; create in
   Contacts (`Name`, `Primary Email`, `First`/`Last Name`) and index the row
   (`Type: Primary`, `Trigger Contact Creation: false`) if missing.
4. **Upsert Attendance**, deduped on the `<eventPageId>::<contactPageId>` pair:
   - **Resolve via the free `ATTENDANCE_TABLE`** first (no Notion read). If the event
     or contact was *just created* this run, skip the lookup entirely (nothing can
     pre-exist) and create directly.
   - On a Table miss, fall back to a Notion `find_data_source_item` search on the
     `Event` + `Contact` relations (backfills pre-Table / Contrast-era records).
   - **Create** → `Approval Status` (mapped from `approval_status`), `Checked In`
     (if checked in), `Registration Date`. No title (a native automation sets `ATT-<id>`).
   - **Update** → refresh `Approval Status`; only ever tick `Checked In` true (never
     un-tick on a later non-checkin update); `Registration Date` left untouched.
   - **Index** the pair into `ATTENDANCE_TABLE` unless it was already resolved from
     there — so repeat guest triggers for the same pair cost zero Notion reads.

### Approval-status mapping

`approved`→Approved · `pending_approval`/`pending`→Pending Approval ·
`waitlist`→Waitlist · `declined`/`rejected`→Declined · `invited`→Invited · (default Approved)

Physical check-in is tracked separately in the **`Checked In`** checkbox, not in the select.

## Connections

| Alias | App key | Connection |
|---|---|---|
| `notion_wf` | `NotionCLIAPI` | Notion (work.flowers \| Dennis) — `02b73654-15c8-85c3-b16a-07304d2beb17` |

Trigger source connection (`authentication_id`): Luma **Calendar · workFlowers Events**
`020ea5fc-59b8-8042-b128-49a6d0ed6f48`.

## IDs

- Events / Event Attendance / Contacts data sources:
  `65490a1e-aa79-4884-932b-60e88db67042` / `a591ecac-259f-4490-8f09-f7fddd556eed` /
  `21991b07-11ac-81a6-a894-000be4a09a67`
- Email → Contact page-id table: `01JYEPSEARXB2Z6BJRCMFGXBC2`
- Luma Event ID → Notion Page ID table: `01KY6MEV55JF723XYDEE4EP0T6`
- Event Attendance index table (`Match Key`, `Attendance Page ID`, `Event Page ID`, `Contact Page ID`): `01KY6NDTW05196F1A3G3XY3ESY`

## Test

```bash
SOURCE_FILES="$(jq -n --rawfile workflow workflow.ts '{"workflow.ts": $workflow}')"
zapier-sdk --experimental run-durable "$SOURCE_FILES" \
  --dependencies '{"@zapier/zapier-sdk":"0.86.0","zod":"4.4.3"}' \
  --zapier-durable-version '0.9.1' \
  --connections '{"notion_wf":{"connectionId":"02b73654-15c8-85c3-b16a-07304d2beb17"}}' \
  --input '{"email":"…","first_name":"…","approval_status":"approved","registered_at":"…","tickets":[{"checked_in_at":null}],"event":{"id":"evt-…","name":"…","start_at":"…"}}' \
  --private
```

## Deploy

```bash
SOURCE_FILES="$(jq -n --rawfile workflow workflow.ts '{"workflow.ts": $workflow}')"
zapier-sdk --experimental create-workflow "luma-guest-registered-to-event-attendance" \
  --description "Luma guest registered -> upsert Notion Event Attendance." --private --json
# capture the workflow id, then (repeat with guest_updated for the update workflow):
zapier-sdk --experimental publish-workflow-version <workflow-id> "$SOURCE_FILES" \
  --dependencies '{"@zapier/zapier-sdk":"0.86.0","zod":"4.4.3"}' \
  --zapier-durable-version '0.9.1' \
  --connections '{"notion_wf":{"connectionId":"02b73654-15c8-85c3-b16a-07304d2beb17"}}' \
  --trigger '{"selected_api":"LumaCLIAPI@6.1.0","action":"guest_registered","authentication_id":"020ea5fc-59b8-8042-b128-49a6d0ed6f48","params":{}}' \
  --enabled --json
```

`selected_api` must be version-pinned (`LumaCLIAPI@6.1.0`) or the trigger claim fails
silently. Verify `get-workflow` shows `enabled: true` and `triggers[0].status: "active"`.
