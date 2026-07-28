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
   `checkedIn` (any `tickets[].checked_in_at` set), the **`Work Email` registration
   answer** and the **newsletter opt-in answer** (both below), and the nested `event`.
2. **Resolve the Event** — free `LUMA_EVENT_TABLE` lookup → Notion `Luma ID` search →
   create from the guest's `event` object (rich, incl. page cover) and index the table.
3. **Resolve the Contact** — work email, then Luma account email, each → page-id via
   `CONTACT_EMAIL_TABLE`; create in Contacts (`Name`, `Primary Email`,
   `Secondary Email`, `First`/`Last Name`) and index a row per address
   (`Trigger Contact Creation: false`) if missing. On an existing contact, reconcile
   the emails (see below).
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
5. **Newsletter opt-in → Buttondown** — if the guest ticked the newsletter question,
   upsert them as a Buttondown subscriber under the address that went into
   `Primary Email` (see below).

### Approval-status mapping

`approved`→Approved · `pending_approval`/`pending`→Pending Approval ·
`waitlist`→Waitlist · `declined`/`rejected`→Declined · `invited`→Invited · (default Approved)

Physical check-in is tracked separately in the **`Checked In`** checkbox, not in the select.

## Work email → `Primary Email`

The Luma events ask for a **work email** as a registration question, because a guest's
Luma account address is often a personal one. When that answer is present it becomes the
contact's `Primary Email`, and the Luma account address is kept in the `Secondary Email`
multi-select.

**The rule:** the guest's own work-email answer always wins the Primary slot. Whatever it
displaces — the previous `Primary Email`, plus the Luma account address — moves into
`Secondary Email`, so **no address is ever lost**. That includes a Primary set earlier by
[`enrich-contact-records`](../enrich-contact-records): the answer the guest just typed is
treated as the fresher signal.

| Contact before | Work-email answer | Contact after |
|---|---|---|
| *(none — new contact)* | `d@acme.io` | Primary `d@acme.io` · Secondary `[luma@gmail.com]` |
| Primary `luma@gmail.com` | `d@acme.io` | Primary `d@acme.io` · Secondary `[luma@gmail.com]` |
| Primary `old@acme.com` | `d@acme.io` | Primary `d@acme.io` · Secondary `[old@acme.com, luma@gmail.com]` |
| Primary `d@acme.io` · Secondary `[luma@gmail.com]` | `d@acme.io` | *(no write — already settled)* |

### How the answer is found

Luma delivers registration answers twice — `registration_answers` (an array of
`{ label, value, answer, value_text, question_id }`) and `registration_answers_by_label`
(snake_cased label → value). The array is read first, the map as a fallback.

Matching is on the **label**, never a hardcoded `question_id`: Luma mints a fresh question id
per event, so the same "Work Email" question has a different id on every event. **The question
can be reworded freely** — the match is on meaning, not exact wording.

The label is first normalised: lowercased, unicode hyphens/dashes (`‐ ‑ ‒ – — ― −`) and curly
apostrophes folded to ASCII — a rich-text editor silently produces these, and `Work e‑mail`
with a non-breaking hyphen would otherwise miss — then whitespace collapsed. It's then scored:

| Score | Condition | Examples |
|---|---|---|
| **2** | a work-ish word **and** an email word | `Work Email` · `Business e-mail address` · `Organisation email` · `Employer email` · `What email do you use at work?` · `Email (work)` · `Work Mail` |
| **1** | a work-ish word only — weaker, used only if nothing scores 2 | `Your work address` · `Where do you work?` |
| **0** | no work-ish word, **or** a third-party marker | `Email` · `Personal email` · `Your manager's work email` · `Referred by (business email)` · `Plus one work email` |

- **Work-ish words:** `work`/`works`/`working`/`workplace`, `business`, `company`/`companies`,
  `corporate`, `office`, `professional`, `employer`, `organisation`/`organization`, `official`,
  `firm`.
- **Email words:** `email`/`emails`, `e-mail`, `e mail`, and a bare `mail`. Word boundaries keep
  it off `mailing` and `gmail`.
- **Third-party markers** (score 0 regardless): `manager`, `colleague`, `coworker`, `teammate`,
  `refer*`/`referral`/`referred`, `friend`, `someone`/`somebody`, `assistant`, `boss`,
  `supervisor`, `plus one`, `companion`, and the pronouns `their`/`his`/`her`. **Without this,
  "Your manager's work email" would promote a third party's address into the guest's
  `Primary Email`.**

The **highest-scoring** label wins, so an explicit `Work Email` question beats a merely work-ish
one no matter which order they appear in the form.

An answer that is blank, not a valid email, or just repeats the Luma account address is treated
as absent — the workflow then behaves exactly as it did before this feature. That answer
validation is also what makes the score-1 tier safe: `Where do you work?` answered `Acme Inc`
is discarded, because it doesn't parse as an email.

If you word a question in a way none of this catches, the fix is a word in `WORK_WORD_RE` — not
new logic.

### Contact resolution with two addresses

Both addresses are looked up in `CONTACT_EMAIL_TABLE` (free ops). The work email is tried
first, since it's the identity the guest is asserting.

| Work email row | Account email row | Result |
|---|---|---|
| miss | miss | **Create** the contact with Primary = work, Secondary = `[account]`; index both rows |
| hit | miss / same page | Use it; reconcile emails per the rule above; index the missing row |
| miss | hit | Use it; **promote** the work email; index the work-email row |
| hit | hit, **different page** | Two contacts for one person. Use the work-email contact, leave both records' emails alone, and **add** the work-email one to the account-email record's `Possible duplicate of` (the same convention [`contact-emails-to-zapier-table`](../contact-emails-to-zapier-table) uses) so a person can judge it. Never `Duplicate of` — the Contact Merger Notion agent treats that as an instruction to merge and delete; see that Zap's README for the 2026-07-28 loop. The write unions the existing links, and is skipped entirely if the page can't be read. |

Every address put on a contact is also indexed in `CONTACT_EMAIL_TABLE` here, rather than
relying on the Contacts DB automation behind `contact-emails-to-zapier-table` to catch the
edit — a contact email missing from that table is what creates duplicate contacts on the
guest's next registration.

### Why the emails are read over raw REST

`Secondary Email` is a **multi-select**, and writing a multi-select **replaces** the whole
option list — appending an address without first reading the current list would silently
drop every address already on the contact. `find_data_source_item` can't read a
multi-select back either, so the current state comes from a raw
`GET /v1/pages/{id}` via `sdk.fetch` (the same idiom as the page-cover `PATCH`). The read
and the write share **one** `ctx.step`, so a step retry re-reads the contact rather than
writing a multi-select computed from stale state.

## Newsletter opt-in → Buttondown

The registration form also carries a boolean **"sign me up to the newsletter"** question.
When it's ticked, the guest is upserted as a Buttondown subscriber via
`App240106CLIAPI write/create_update_subscriber` (the same custom integration
[`notion-newsletter-to-buttondown`](../notion-newsletter-to-buttondown) uses). The action is
create-**or**-update on the address, so a repeat registration is a no-op rather than an error.

**Which address:** the **work email**, when the guest gave one — it's the address that ends up
in `Primary Email`, so the subscriber and the contact line up. The one exception is a
`reconcile-contact-emails` step that couldn't read the contact page (`read: false`): it writes
and indexes nothing, so the work email isn't on the contact yet and the Luma **account
address** — the one that resolved the contact — is used instead.

**Only `email_address` is sent.** The action updates an existing subscriber, and Buttondown
notes / tags / metadata are maintained by hand and by other automations; passing them here
would overwrite a returning subscriber's.

### Why it runs last

> A separate automation upserts a Notion **Contact** whenever a new subscriber appears in
> Buttondown, resolving the address through `CONTACT_EMAIL_TABLE`. Subscribe *before* this
> workflow has created the contact and indexed its addresses and that automation matches
> nothing — so it creates a **second contact** for the same person.

So the Buttondown call is the **last** thing the workflow does: contact create/resolve, email
reconciliation, address indexing and the attendance upsert are all settled first. Running it
after the attendance upsert (rather than merely after contact resolution) also means a
Buttondown outage can never block the CRM records — the step is deliberately *not* wrapped in
a try/catch, so a genuine failure retries and then surfaces as a failed run, with every Notion
step already durably committed and memoised.

### How the answer is found

Same two sources and the same label-not-`question_id` matching as the work email, but the label
match is deliberately **narrower**. A false positive on a work-email question just discards an
address that doesn't parse; a false positive here **subscribes someone who never asked**. So a
generic "would you like updates about future events?" must *not* match — the label has to name
the newsletter or explicitly say subscribe:

| Matches | Doesn't match |
|---|---|
| `Newsletter` · `Join our mailing list` · `Add me to the email list` · `Sign up for Flow Statements` · `Would you like to subscribe to our monthly email?` · `Opt in to email updates` | `Would you like updates about future events?` · `How did you hear about us?` · `Work Email` |

A label that asks the **opposite** (`unsubscribe`, `opt out`, `do not`, `don't`, `no thanks` —
e.g. "Untick to unsubscribe") is skipped entirely, since ticking one of those is a *no*.

The answer is then read generously, because Luma delivers a boolean question's answer as a real
boolean, as `"yes"`/`"no"`, or — when the form renders it as a tick box — as the option's own
text:

- **Yes** — `true`, `1`, a leading `yes`/`y`/`on`/`checked`/`agree`/`accept`/`sure`/`ok`, or a
  phrase like `sign me up` / `subscribe` / `opt in` / `count me in` / `I agree` (`Yes, sign me
  up!` covers both). Arrays are matched element-wise.
- **No** — everything else, including `maybe`, an empty answer, and anything starting
  `no`/`n`/`off`/`none`/`nope`/`not now`. **Defaulting to no is the point:** a wrong yes
  subscribes someone without consent.

Either source may carry the yes — the `by_label` map's snake_cased key can lose punctuation the
array's label keeps.

> **Registration only, by design.** The sibling
> [`luma-guest-updated-to-event-attendance`](../luma-guest-updated-to-event-attendance) does
> *not* subscribe, unlike the work-email promotion it shares. Luma doesn't re-submit
> registration answers when a guest's status changes, so a `guest_updated` payload has no
> newsletter answer to act on.

## Workflow

```mermaid
flowchart TD
    A["Luma guest_registered"] --> B["Extract guest<br/>account email · name · approval_status<br/>Work Email answer · newsletter opt-in<br/>nested event"]
    B -->|"no email or event"| Z["Skip (clean no-op)"]
    B --> C{"Event in<br/>LUMA_EVENT_TABLE?"}
    C -->|hit| G["eventPageId"]
    C -->|miss| D{"Notion search<br/>on Luma ID?"}
    D -->|hit| G
    D -->|miss| E["Create Event<br/>(default template · body · cover)"] --> F["Index Luma ID → Page ID"] --> G

    G --> H{"Look up work email,<br/>then account email,<br/>in CONTACT_EMAIL_TABLE"}
    H -->|"both miss"| I["Create Contact<br/>Primary = work ?? account<br/>Secondary = [account]"] --> J["Index a row per address"]
    H -->|"one hit / same page"| K["Read Primary + Secondary<br/>via GET /v1/pages"] --> L["Promote work email to Primary,<br/>displaced addresses → Secondary"] --> M["Index any un-indexed address"]
    H -->|"hit, different pages"| N["Use work-email contact ·<br/>add to the other's<br/>'Possible duplicate of'"]

    J --> O["contactPageId"]
    M --> O
    N --> O

    O --> P{"Event or contact<br/>just created?"}
    P -->|yes| S["Create Attendance"]
    P -->|no| Q{"Pair in<br/>ATTENDANCE_TABLE?"}
    Q -->|hit| R["Update Attendance<br/>(Approval Status · tick Checked In)"]
    Q -->|miss| T{"Notion search on<br/>Event + Contact relations?"}
    T -->|hit| R
    T -->|miss| S
    S --> U["Index the pair in ATTENDANCE_TABLE"]
    R --> U

    U --> V{"Newsletter<br/>opt-in ticked?"}
    V -->|no| W["Done"]
    V -->|yes| X["Buttondown create_update_subscriber<br/>(work email if it's on the contact,<br/>else account email)"] --> W
```

The Buttondown call sits at the very end on purpose — see
[Why it runs last](#why-it-runs-last).

## Notion default templates

All three creates (Event, Contact, Attendance) go through
`createItemWithTemplate`, which applies the data source's **default template** so
automation-created pages match hand-made ones (icon, body blocks, template
property defaults). Two Notion-action constraints shape it:

1. `template_mode: "default"` **throws** on a data source with no default
   template (`No default template is configured for this data source`). The
   helper catches that single error and retries without it — no per-data-source
   config, and a template added in Notion later is picked up automatically.
   Current state: **Contacts has** a default template (blue `user-circle-filled`
   icon); **Events and Event Attendance do not**.
2. A template and inline `content` are **mutually exclusive** in one call, so the
   event body (Luma's description) is appended in a second `write/page_content`
   call.

Properties you pass still win — Notion's docs: "Any properties you provide here
override the template's defaults." Verified live: a contact created by this
workflow now carries the template icon while keeping its own Name/email.

## Connections

| Alias | App key | Connection |
|---|---|---|
| `notion_wf` | `NotionCLIAPI` | Notion (work.flowers \| Dennis) — `02b73654-15c8-85c3-b16a-07304d2beb17` |
| `buttondown` | `App240106CLIAPI` | Buttondown Unofficial #2 — `02a9a6e8-4c09-8cdb-a798-4d65af16d32a` |

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
  --connections '{"notion_wf":{"connectionId":"02b73654-15c8-85c3-b16a-07304d2beb17"},"buttondown":{"connectionId":"02a9a6e8-4c09-8cdb-a798-4d65af16d32a"}}' \
  --input '{"email":"…","first_name":"…","approval_status":"approved","registered_at":"…","tickets":[{"checked_in_at":null}],"registration_answers":[{"label":"Work Email","value":"…"},{"label":"Sign me up to the newsletter","value":"yes"}],"event":{"id":"evt-…","name":"…","start_at":"…"}}' \
  --private
```

A test run with the newsletter answer set creates a **real Buttondown subscriber** — use a
throwaway address and delete it afterwards.

Verified end-to-end 2026-07-26 against the real `evt-9jYYQfY4U8I0jDJ` event with throwaway
`@wf-probe.invalid` addresses: a new guest with a work-email answer got Primary = work
email and Secondary = `[account]`; re-running with a changed answer promoted the new address
and pushed the displaced one into Secondary **without** creating a second contact. All test
records (contact, attendance, the company the domain-match automation spun up, and the four
Table rows) were removed afterwards.

## Deploy

```bash
SOURCE_FILES="$(jq -n --rawfile workflow workflow.ts '{"workflow.ts": $workflow}')"
zapier-sdk --experimental create-workflow "luma-guest-registered-to-event-attendance" \
  --description "Luma guest registered -> upsert Notion Event Attendance." --private --json
# capture the workflow id, then (repeat with guest_updated for the update workflow):
zapier-sdk --experimental publish-workflow-version <workflow-id> "$SOURCE_FILES" \
  --dependencies '{"@zapier/zapier-sdk":"0.86.0","zod":"4.4.3"}' \
  --zapier-durable-version '0.9.1' \
  --connections '{"notion_wf":{"connectionId":"02b73654-15c8-85c3-b16a-07304d2beb17"},"buttondown":{"connectionId":"02a9a6e8-4c09-8cdb-a798-4d65af16d32a"}}' \
  --trigger '{"selected_api":"LumaCLIAPI@6.1.0","action":"guest_registered","authentication_id":"020ea5fc-59b8-8042-b128-49a6d0ed6f48","params":{}}' \
  --enabled --json
```

`selected_api` must be version-pinned (`LumaCLIAPI@6.1.0`) or the trigger claim fails
silently. Verify `get-workflow` shows `enabled: true` and `triggers[0].status: "active"`.
