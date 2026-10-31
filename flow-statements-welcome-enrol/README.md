# flow-statements-welcome-enrol

Enrols each newly confirmed Flow Statements subscriber in the five-email welcome sequence. It writes one row to the **Welcome Sequence** Zapier Table and sends the welcome email (step 1) straight away. [`flow-statements-welcome-sender`](../flow-statements-welcome-sender/) sends steps 2–5 from there, once a day. The sender's README covers the sequence itself and the reason it runs as Zaps rather than Buttondown Automations.

**Status: enabled 2026-10-24**, together with the sender.

## Trigger

**Buttondown — New Confirmed Subscriber** (`ButtondownCLIAPI@2.0.4` `confirmedSubscriber`), on the `workflowers` Buttondown connection. It uses the same app version, trigger and connection as [`new-buttondown-subscriber-update-in-notion`](../new-buttondown-subscriber-update-in-notion/), so both Zaps fire on each confirmation. The trigger is *confirmed*, not *created*, because double opt-in keeps unconfirmed bot signups out.

## What it does

```mermaid
flowchart TD
  A[Buttondown: subscriber confirmed] --> B{Empty payload?}
  B -- yes --> S0[skip: empty-payload]
  B -- no --> C{Has email_address and id?}
  C -- no --> ERR[throw: unrecognized payload]
  C -- yes --> D{type is regular?}
  D -- no --> S1[skip: type-…]
  D -- yes --> E{Bot pattern?}
  E -- "+km&lt;hex&gt; plus-tag, or referrer /blog/page/2/ with no form id" --> S2[skip: bot-…]
  E -- no --> F{Row for this email in Welcome Sequence?}
  F -- yes --> S3[skip: already-enrolled]
  F -- no --> G["Create row: next_step 1, next_send_at now, status active"]
  G --> H["Buttondown: POST /subscribers/{id}/emails/{welcome}"]
  H -- "200, or 400 EMAIL_ALREADY_SENT" --> I["row: last_sent_step 1, next_step 2, next_send_at confirmed_at + 4d"]
  H -- other error --> J["row: fail_count 1, last_error; stays on step 1, due now — the sender retries it"]
```

- **Insert-only upsert on the lowercased email.** An existing row holds that subscriber's sequence state: they may be mid-sequence, or paused or stopped by hand. A second confirmation therefore never resets it, and no subscriber ever gets a second row. Find-then-create isn't atomic, but the trigger fires once per subscriber, so a duplicate row would need a duplicate event.
- **`confirmed_at` is when this Zap saw the confirmation**, not Buttondown's own timestamp. The trigger has delivered a confirmation weeks late before (a 28 Aug confirmation reached the sibling Zap on 16 Sep). Anchoring on the real date would make the first three steps due at once.
- **The welcome goes out at once (since 2026-10-31).** Until then the hourly sender sent it, within the hour. When the sender moved to daily to save tasks, sending step 1 here kept the welcome immediate. The send uses the same `buttondown_api` connection and the same `EMAIL_ALREADY_SENT`-as-success rule as the sender. If it fails, the run stays green and the row is left on step 1, due now, so the sender's next daily run retries it, with its usual pause and alert after three failures. `WELCOME_EMAIL_ID` and the 4-day step-2 offset are copies of the sender's `SEQUENCE`; change them together.
- **Bot filter.** The two known list-bombing patterns are skipped and logged: a `+km<hex>` plus-tag, and a `/blog/page/2/` referrer with a null `form_id`.

## Testing (2026-10-23, `run-durable`, live Table)

| Payload | Result |
| --- | --- |
| `{}`, `null`, `""`, `{"querystring":{}}` | `skipped: empty-payload` |
| `{"foo":"bar"}`, `{"data":{"id":""}}` | throws, naming the keys it got |
| `type: unsubscribed` | `skipped: type-unsubscribed` |
| `jane+km3fa9c@gmail.com` | `skipped: bot-plus-tag` |
| referrer `…/blog/page/2/`, `form_id: null` | `skipped: bot-referrer-no-form` |
| Dennis's real subscriber record, `Dennis@work.flowers` | row created, email lowercased |
| same again | `skipped: already-enrolled` |

The test row was deleted afterwards.

## Maintenance notes

- **Unrecognized-payload posture: throw** (repo default).
- **Cost:** one `sdk.fetch` (the welcome send) per enrolled subscriber, so 1 task a run from 2026-12-01. That is the same as the 1-task minimum the run would cost anyway. Skipped runs cost the minimum, 1 task. The Table reads and writes are free.
- The Table id, `WELCOME_EMAIL_ID` and the step-2 offset are also in the sender. Change them together.
