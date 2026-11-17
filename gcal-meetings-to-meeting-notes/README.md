# gcal-meetings-to-meeting-notes

Pre-creates a Notion **full-page meeting note**, linked to its Google Calendar event, for every upcoming meeting on Dennis's work calendar. It runs as a daily sweep over the next 7 days, so a note exists (and has been enriched) before the meeting starts.

- **Trigger:** Schedule by Zapier, every day at 6:00 AM, weekends included.
- **Workflow ID:** assigned on first publish (see `zap.json`).
- **Cost:** ~1 task per day for the calendar search, plus 1 task per note created. Table reads and writes are free. Roughly 30 + (meetings per month) tasks a month.

## Workflow

```mermaid
flowchart TD
    T([Schedule: daily 6:00 AM]) --> S[search-events<br/>Google Calendar event_v2, primary calendar<br/>next 7 days, recurring expanded<br/>1 task]
    S --> C{each event:<br/>a meeting?}
    C -- no --> X[/skip: cancelled, all-day, Free,<br/>focus/OOO/working location,<br/>declined, unanswered,<br/>no other guests and not an SCW mirror/]
    C -- yes --> L[lookup<br/>Table: Meeting Note IDs<br/>Event ID = occurrence id AND Page ID set<br/>0 tasks]
    L -- row found --> K[/skip: already has a note/]
    L -- no row --> D{dryRun?}
    D -- yes --> W[/list as wouldCreate/]
    D -- no --> P{under the cap?<br/>40 per run}
    P -- no --> F[fail loudly after the batch<br/>later runs continue soonest-first]
    P -- yes --> N[meeting-note<br/>POST /v1/meeting_notes with calendar_event<br/>get-or-create, PAT via sdk.fetch<br/>1 task]
    N --> R[record<br/>Table upsert: Page ID, Event ID,<br/>Start, End, Title, iCal UID<br/>0 tasks]
    R --> A([Notion DB automation fires<br/>meeting-note-db-updates Worker enriches the note])
```

## What counts as a meeting

`classifySkip` in [`workflow.ts`](workflow.ts) keeps an event when all of these hold:

| Rule | Why |
| --- | --- |
| `status` is not `cancelled` | Tombstones of deleted occurrences. |
| `eventType` is `default` | Drops focus time, out of office and working location. |
| Has `start.dateTime` and `end.dateTime` | All-day events are never meetings. |
| `transparency` is not `transparent` | A "Free" event is a reminder, not a meeting. |
| Dennis has not declined and has answered | Same rule as the calendar-blocking Zaps: `declined` and `needsAction` skip. |
| At least one other non-room guest, **or** the description starts with `[gcal-block]` | Solo blocks and webinars that list only Dennis are not meetings. SCW client meetings arrive as guest-less mirrors from [`scw-events-to-workflowers-block`](../scw-events-to-workflowers-block/), and they were already getting notes by hand, so they count. |

On the 2026-11-17 dry run this kept 15 of 24 events in the coming week, skipping 4 declined invites and 5 with no other guests (solo blocks, a Vanta webinar, the Community Hangout).

## Recurring meetings and the cap

A recurring invite with no end date is the obvious way to burn tasks, so two fences hold it:

1. **The window bounds it.** The search asks Google for events between now and 7 days out with `expand_recurring: true`, so a series can only ever contribute the occurrences inside that window, about one a day at most. Each day the next day rolls in.
2. **`MAX_CREATES_PER_RUN` = 40.** A normal week here is around 15 meetings, so 40 is well above routine. Past the cap the run still creates and records the first 40 (soonest first), then throws, so the run shows red and Zapier sends an error alert. The rest roll into later runs. A cap hit means something abnormal, such as a mass import or a calendar shared by mistake, and someone should look before raising it.

## How a note is created

`POST https://api.notion.com/v1/meeting_notes` with `Notion-Version: 2026-03-11` and

```json
{ "calendar_event": { "calendar": { "account_id": "<Notion Calendar account id>", "calendar_id": "<Google calendar id>" }, "event_id": "<Google occurrence id>" } }
```

- **Get-or-create.** If the event already has a note, Notion returns it (`created: false`) instead of making another. That makes the step safe to retry and makes overlap with hand-made or Notion-made notes harmless. Verified 2026-11-17 on an event that already had a note.
- **Filing and title come from Notion.** With `calendar_event` you may not pass `parent`, `title` or `markdown`. A note for an event with no other notes lands in the **Meeting Notes** data source, titled `<summary> @<start>`, the same as one made in the app.
- **The response's `meeting_note.id` is the page id**, which is what goes into the Table's `Page ID`.
- **`account_id`** is Notion Calendar's own id for the work Google account (`9c2abc99-…`, from `calendar.accountId` in Notion MCP's `notion-calendar-list-events`). **`calendar_id`** is the Google calendar id. The workflow reads it at run time from the events (the attendee, organizer or creator marked `self`), so no address is hardcoded. **`event_id`** is the plain Google occurrence id (`<seriesId>_<startUTC>` for a recurring occurrence).

### Why a PAT and not the Notion connection

The meeting-notes endpoints accept only a personal access token or a Notion Worker. Zapier's Notion connection, including the app's **API Request (Beta)** action, is refused for both the create and the link endpoint with:

```
403 restricted_resource: This tool is not available to user_owned_guest_bot actors.
```

(probed 2026-11-17). The call therefore goes through `sdk.fetch` on `notion_pat`, an **API by Zapier** connection holding Dennis's PAT as a Bearer token, which keeps the token out of source. Notes are created as Dennis. A Notion Worker could do it without a PAT, but a Worker may not pass `calendar_event`, so it would need a create call and then a link call, and would show as the note's creator.

## Shared Table

[`[Table] Meeting Note IDs`](https://tables.zapier.com/app/tables/t/01JZCVG73MBWWB0357CEPS4903) is shared with three other automations:

- the [`meeting-note-db-updates`](https://github.com/work-flowers/notion-worker-meeting-note-db-updates) Worker upserts a row for every note it enriches;
- [`gcal-event-updated-to-meeting-note`](../gcal-event-updated-to-meeting-note/) looks notes up here on a reschedule;
- [`notion-page-deleted-to-zapier-tables`](../notion-page-deleted-to-zapier-tables/) flags a deleted note's row `Archived`.

This Zap writes the same upsert the Worker does (find-or-create on `Event ID`, then update), so whichever of the two runs second updates the row rather than adding one; the live test left exactly one row. **`Event ID` (f3) must stay the occurrence id**, never the iCalUID (see [the two Google Calendar ids](../gcal-event-updated-to-meeting-note/#the-two-google-calendar-ids--and-why-it-matters)).

The skip check matches any row with a Page ID, including one flagged `Archived`. So a note Dennis deletes is **not** re-created the next morning.

## Interaction with the enrichment Worker

Creating the note fires the Meeting Notes "page added" automation, so the Worker enriches it straight away: Date, Google Calendar Event ID, Description, Call Link, Contacts, Internal Attendees, Companies, Deals and Type. In the live test that took about 13 seconds. Notes are therefore enriched up to a week before the meeting rather than at the meeting. A meeting rescheduled after that is handled by [`gcal-event-updated-to-meeting-note`](../gcal-event-updated-to-meeting-note/), which moves the note's Date and title.

## Manual runs

```bash
npx zapier-sdk --stability experimental trigger-workflow <workflow-id> --input '{"dryRun":true}'
```

| Input | Default | Meaning |
| --- | --- | --- |
| `dryRun` | `false` | List `wouldCreate` without writing anything. The search still costs 1 task. |
| `from_days` / `to_days` | `0` / `7` | Window in days from now. Fractions are allowed (`0.1` ≈ 2.4 h); max 31. |
| `max_creates` | `40` | Cap for this run, 1..200. |
| `now` | the tick time | RFC 3339 anchor for the window. |

## Known limits

- **A meeting booked after 6:00 AM for the same day** gets no note from this Zap, since by the next run it has passed. Its note still gets made the way notes were made before this Zap, at meeting time. An `event_created` trigger for that case was considered and left out to keep the first version simple.
- **The search returns one page.** Ordered by start time, a truncated page would drop the far end of the window, which later runs reach, so it is logged rather than fatal. The busiest week checked returned 24 events.
- **Untested:** an event created minutes before the run, before Notion Calendar has synced it. Notion may reject an `event_id` it has not seen yet. If that happens the step throws and the next run retries it.

## Verified behaviour (2026-11-17)

| Check | Result |
| --- | --- |
| Get-or-create on an event that already had a note | `200`, `created: false`, existing page id returned |
| Dry run over the next 7 days | 24 events → 15 meetings → 2 already noted → 13 to create |
| Live create (one event, window 0..0.1 days) | Note created in Meeting Notes as Dennis, titled `AI COE - Weekly Long Sync @12:00`; Worker enriched it within ~13s; one Table row |
| Search truncation | 20–24 Nov returned 8 events; no page limit hit |
