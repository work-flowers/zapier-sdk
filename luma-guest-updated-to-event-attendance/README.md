# Luma Guest Updated → Notion Event Attendance

Durable workflow (trigger **`guest_updated`**, `LumaCLIAPI@6.1.0`) that reflects Luma guest
changes — approval-status change, check-in, registration edit — onto the existing Notion
**Event Attendance** record.

> **Pure updater — never creates.** Creation of Event / Contact / Attendance records is owned
> solely by the sibling [`luma-guest-registered-to-event-attendance`](../luma-guest-registered-to-event-attendance)
> (trigger `guest_registered`).
>
> **Why:** Luma fires `guest.registered` **and** `guest.updated` within ~150ms of a single new
> registration. When both workflows could create, they raced and produced duplicate Attendance
> (and Contact) records. Restricting this workflow to lookup + update removes the race. If the
> event / contact / attendance isn't found yet, it exits as a clean no-op — the registered
> workflow will (or already did) create it, and a later `guest.updated` (e.g. the check-in) will
> find and update it.

## What it does

1. Extract the guest: `email` (required), `approval_status`, `checkedIn` (any
   `tickets[].checked_in_at` set), and the nested `event` id.
2. **Look up the Event** — free `LUMA_EVENT_TABLE` → Notion `Luma ID` search. Not found → skip.
3. **Look up the Contact** — email → page-id via `CONTACT_EMAIL_TABLE`. Not found → skip.
4. **Look up the Attendance** — free `ATTENDANCE_TABLE` (`<eventPageId>::<contactPageId>`) →
   Notion `find_data_source_item` on `Event` + `Contact` relations. Not found → skip.
5. **Update** the record: refresh `Approval Status` (mapped from `approval_status`); only ever
   tick `Checked In` true (never un-tick); `Registration Date` untouched.
6. If resolved via a Notion search (a pre-Table record), backfill the `ATTENDANCE_TABLE` row so
   future lookups are free.

### Approval-status mapping

`approved`→Approved · `pending_approval`/`pending`→Pending Approval ·
`waitlist`→Waitlist · `declined`/`rejected`→Declined · `invited`→Invited · (default Approved)

**Known limitation:** a guest who never fires `guest_registered` (e.g. invited-but-never-registered,
or manually added) gets no Attendance record — this workflow won't create one for them.

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

## Deploy

```bash
SOURCE_FILES="$(jq -n --rawfile workflow workflow.ts '{"workflow.ts": $workflow}')"
zapier-sdk --experimental create-workflow "luma-guest-updated-to-event-attendance" \
  --description "Luma guest updated -> update Notion Event Attendance (lookup/update-only)." --private --json
# capture the workflow id, then:
zapier-sdk --experimental publish-workflow-version <workflow-id> "$SOURCE_FILES" \
  --dependencies '{"@zapier/zapier-sdk":"0.86.0","zod":"4.4.3"}' \
  --zapier-durable-version '0.9.1' \
  --connections '{"notion_wf":{"connectionId":"02b73654-15c8-85c3-b16a-07304d2beb17"}}' \
  --trigger '{"selected_api":"LumaCLIAPI@6.1.0","action":"guest_updated","authentication_id":"020ea5fc-59b8-8042-b128-49a6d0ed6f48","params":{}}' \
  --enabled --json
```

`selected_api` must be version-pinned (`LumaCLIAPI@6.1.0`) or the trigger claim fails silently.
Verify `get-workflow` shows `enabled: true` and `triggers[0].status: "active"`.
