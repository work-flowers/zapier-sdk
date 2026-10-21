# Merge Duplicate Contacts

Merges a Notion Contact into the record its `Duplicate of` relation points at —
**only** when the two are corroborated as the same person — then moves the merged-away
record to Notion's trash. Nothing is ever permanently deleted.

Replaces the "Contact Merger" Notion Custom Agent, which was disabled on 2026-07-28.

## Trigger

Notion DB automation on **Contacts**, `Duplicate of` **edited** → this workflow's catch
URL. See `zap.json` for `trigger.webhook_url` — that's the URL the automation posts to,
*not* the internal `trigger_url`.

`Duplicate of` now means one thing only: *a person has confirmed these are the same
record.* No Zap writes it any more — `contact-emails-to-zapier-table` and
`luma-guest-registered-to-event-attendance` write `Possible duplicate of` instead.

**The automation payload carries only the page id — zero properties.** So the workflow
reads `Duplicate of` (and everything else) from a fresh page read. Anything that trusted
the payload would conclude the relation was empty and silently do nothing, which is a
failure mode with no error to notice. Notion also sends one empty delivery
(`{"querystring": {}}`) when the automation is first configured; that is handled as a
clean no-op rather than a failed run.

Wired and verified live on 2026-07-28 — see the Test section.

## Why it replaced an agent

The agent read `Duplicate of` as "merge these and delete one". Three of its failures
were not fixable by rewording its instructions:

1. **It fired on any edit, including a Zap's.** Both Zaps wrote `Duplicate of` as a
   review flag on a single shared email address. On 2026-07-28 a one-address collision
   between **Sachin Kolekar** (Knoxx Foods) and **Lionel Sim** (The AI Capitol) —
   unrelated people — made it merge the two records.
2. **Its `Secondary email` step SET the multi-select instead of appending.** The target
   lost addresses it already had; Sachin lost his own.
3. **It deleted the source without approval.** Leo Selie and a duplicate Lionel page
   went to the trash that way before anyone noticed.

Each of those is a semantic a prompt can only *ask* for. Here they're types and control
flow: a union cannot be forgotten, a guard cannot be talked around, and there is no
delete call to mis-fire.

## Flow

```mermaid
flowchart TD
    A(["Duplicate of edited"]) --> B["Read source page"]
    B --> C{"In trash?"}
    C -- yes --> Z(["No-op"])
    C -- no --> D{"Duplicate of:<br/>exactly one other page?"}
    D -- no --> Z
    D -- yes --> E["Read target page"]
    E --> F{"Target in trash?"}
    F -- yes --> Z
    F -- no --> G{"Target points back<br/>at source?"}
    G -- yes --> H["Comment: mutual,<br/>no survivor"] --> Y(["Nothing copied"])
    G -- no --> I{"Corroborated?"}
    I -- "different LinkedIn URLs" --> J["Comment: two<br/>different people"] --> Y
    I -- "no name match,<br/>no LinkedIn conflict" --> Q{"Jev: same person ≥ 0.85<br/>and evidence ≥ 2/3?"}
    Q -- no --> J
    Q -- yes --> K
    I -- "same LinkedIn<br/>or equivalent names" --> K["Re-read both,<br/>build patch"]
    K --> L["PATCH target:<br/>fill empties, OR checkboxes,<br/>UNION multi-values"]
    L --> P{"Source has page content,<br/>or is older than target?"}
    P -- no --> M["Comment on source:<br/>what was copied"] --> T(["Move source to trash"])
    P -- yes --> M2["Comment on source:<br/>what was copied, why kept"] --> N(["Source left in place"])
```

## Corroboration

A set `Duplicate of` is the *request*, not the evidence.

| Signal | Effect |
|---|---|
| Both have a LinkedIn URL, and they **differ** | **Hard decline.** Two real people — this beats a name match |
| Same LinkedIn profile slug | Merge |
| Equivalent names | Merge |
| Names differ, no LinkedIn conflict, and **Jev** corroborates one person | Merge (see [Second opinion from Jev](#second-opinion-from-jev)) |
| Anything else | Decline, with a comment |

- **Name keys sort their tokens**, so "Sim Lionel" and "Lionel Sim" compare equal —
  Luma sends whatever the guest typed. Under two tokens the key is `""` and never
  matches: a lone "Grace" is far too weak to merge two records on.
- **A shared email domain is deliberately not a signal.** Colleagues share a work
  domain (Sachin and Minnie Dua are both `@knoxxfoods.com`) and strangers share
  consumer ones. This is the check that would have stopped 2026-07-28: Sachin and
  Lionel shared one address, no name match, and different LinkedIn profiles.
- Differing employers or email domains are **not** a disqualifier on their own —
  people change jobs.

## Second opinion from Jev

**Added 2026-10-03.** The name rule declined both real duplicates it was asked to merge whose names differed in a way token sorting can't see:

- **"Ustaz Syakir" → "Syakir Samsaimon"** (2026-08-03). *Ustaz* is a Malay honorific, and each page's `Note` names the other.
- **"New Contact" → "Alasdair Bell"** (2026-09-11). A placeholder name on a record with the identical personal-domain address `ab@alasdairbell.com`.

A person had set `Duplicate of` both times. So when — and only when — the rules decline **because the names don't match** (no LinkedIn on either side, or only on one), the workflow asks **Jev**, TypeSafe's typed-judgement model, two questions about the pair, and merges only if both clear their bar:

| Question | Type | Bar |
| --- | --- | --- |
| Do the two records describe the same real person? | yes/no probability | ≥ 0.85 |
| How strong is the identifying evidence linking them? | score, 0 (coincidence) to 3 (several independent strong identifiers) | ≥ 2.0 (at least one strong identifier) |

Jev sees only identity-bearing fields (`contactSummary`): Name, First/Last Name, Primary and Secondary Email, LinkedIn, Job Title, Company, City, Country, and `Note`/`Bio` capped at 600 characters. It is called through `sdk.fetch` with the `typesafe` connection (an *API by Zapier* connection holding the TypeSafe key), in its own `jev-same-person` step.

What does **not** change: a LinkedIn conflict is still a hard decline that Jev never sees; equivalent names or a shared LinkedIn profile still merge on the rules alone, with no Jev call; nothing is ever deleted. Failure falls back to the rules: a `429`/`5xx` retries the step, any other error or a malformed answer declines with the rules' reason. Declines carry Jev's scores in the comment, and merges name them in the reason, so every decision is auditable.

**Cost:** one extra call, only on the name-mismatch path — so a Zapier task plus a fraction of a cent of TypeSafe usage, a handful of times a month at most.

### Criteria revised (2026-10-14)

The first questions declined **"Appireddy Pamulapati" → "Appi Pamulapati"** (0.67, 1.8): a shortened given name, the same mailbox `appi@` at two Knoxx group domains (`knoxxinnovations.com`, `knoxxfoods.com`), and a LinkedIn handle `appi-reddy` on the target. They counted only a personal address or a note as a strong identifier. The criteria now:

- require **compatible names** — same surname, given names that are the same or forms of one another (shortened/extended, nickname, honorific, word order), or a placeholder;
- name the **specific identifiers**: the same personal address, the same mailbox name at related company domains, a LinkedIn handle spelling the other record's name, a note naming the other record;
- rule out conflicting given names and a shared surname, company or role address on their own.

Thresholds are unchanged. Lowering them instead would not have worked: under the old questions a constructed one-shared-address negative scored 0.67 / 2.0, level with Appi.

### Verified offline (`jev-1.13.0`)

`node replay-jev.mjs` replays [`jev-cases.json`](jev-cases.json) through the real `corroborate` / `contactSummary` / `jevVerdict` code and `JEV_QUESTIONS` against the live Jev API — read-only, one Zapier task per case. Pass a questions JSON as the second argument to try a rewording before editing `workflow.ts`. Real pairs are read live from Notion where the pages still exist; the rest are literal summaries. Scores below are the median of three runs on 2026-10-14 (spread ≤ 0.03):

| Pair | Truth | Questions of 2026-10-03 | Now |
| --- | --- | --- | --- |
| Appireddy Pamulapati → Appi Pamulapati | same | **declined** (0.69, 1.9) | **merge** (0.89, 2.4) |
| Ustaz Syakir → Syakir Samsaimon | same | merge (0.96, 2.4) | merge (0.97, 2.3) |
| New Contact → Alasdair Bell¹ | same | merge (0.88, 2.0)² | merge (0.97, 2.0) |
| One shared address, different names (Sachin/Lionel shape) | different | declined (0.67, 2.0) | declined (0.66, 1.7) |
| Same first-name mailbox at sibling domains, different surnames | different | — | declined (0.75, 1.9) |
| Chris Wong / Christine Wong, same company | different | declined (0.44, 1.1) | declined (0.64, 1.4) |
| Two Grace Tangs, different employers | different | declined (0.24, 1.0) | declined (0.30, 1.2) |
| Same surname, sibling domains, different given names | different | declined (0.23, 1.0) | declined (0.25, 1.1) |
| Sam Lee / Samantha Lee, unrelated companies | different | declined (0.20, 1.0) | declined (0.26, 1.0) |
| Two colleagues on one work domain | different | declined (0.03, 1.0) | declined (0.02, 0.7) |
| Role mailbox (`sales@`) at sibling domains | different | — | declined (0.05, 0.3) |

¹ The source page has since been deleted, so the case is a literal summary of what it held. ² Scored 2026-10-03.

Rule-only cases (different LinkedIn = hard decline; equivalent names or the same LinkedIn = merge) make no Jev call and are covered by `npm test`.

The thresholds were chosen on these few cases, and Appi clears the 0.85 bar by only 0.04. Add every new real decline to `jev-cases.json` and re-run before moving `JEV_SAME_PERSON_MIN` or `JEV_EVIDENCE_MIN` or rewording a question. `npm test` runs offline assertions over the corroboration rules, the summary and the decision, including the real scores above.

## Copy rules

Source → target, and only ever additively:

| Property kind | Rule |
|---|---|
| `title`, `rich_text`, `number`, `select`, `status`, `date`, `url`, `email`, `phone_number`, `files` | Fill the target only when it is **empty**. Never overwrite |
| `checkbox` | OR — true if either record is true |
| `multi_select`, `people`, `relation` | **Union** of the target's current value and the source's |
| `formula`, `rollup`, `created_*`, `last_edited_*`, `unique_id`, `button`, `verification` | Skipped — Notion computes them and rejects the write |
| `Duplicate of`, `Duplicated by`, `Possible duplicate of`, `Possible duplicates` | **Never copied** |

Those four relations are excluded for two different reasons. The first pair is what
triggers this workflow, so copying it is a self-trigger by construction. The second is a
review queue — propagating one contact's unresolved questions onto another manufactures
the next false positive.

**A write that removes an existing value is always a bug.** Two consequences:

- A relation in a page read is capped at 25 entries and flagged `has_more`. Paging it is
  not optional — a union built from a truncated list would prune everything past the cap
  on write. If the full list can't be read, the property is **skipped** and says so in
  `skippedProperties`.
- The read and the PATCH live in **one** `ctx.step`, so a retry re-reads both pages
  rather than patching from state that has since moved.

## The source is archived, never deleted

**Since 2026-10-21**, after a merge the source gets a comment listing what was copied
and is then moved to Notion's trash (`PATCH in_trash: true`, which is what the API means
by "archive"). Notion has no archive separate from the trash: the page can be restored
from the trash for 30 days, after which Notion empties it. Contacts has no "Archived"
property, and adding one would leave the loser live — still resolving guests through the
email Table — so the trash is the archive. *(Dennis, 2026-10-21.)* Before that date the
source was left in place for a person to archive.

Trashing the source is also what moves its email Table rows to the survivor:
[`contact-emails-to-zapier-table`](../contact-emails-to-zapier-table/#merges-deletes-and-restores)
gets the `page.deleted` event and reads the survivor off the trashed page's
`Duplicate of`.

The source is **left in place**, and the comment says why, when a person should look
first (`archiveBlocker`):

- it has **page content** — only properties are merged, and the trash empties itself;
- the content check failed, so we don't know;
- it is **older** than the target — `Duplicate of` may point the wrong way round, so the
  record being thrown away could be the one to keep.

The comment is posted before the trash, because Notion rejects comments on a trashed
page. A trash that Notion answers with *already archived* counts as done; any other
rejection fails the run with Notion's message. The run output reports `archived` and
`archiveBlockedBy`.

## Comments

One comment per `(source, target, outcome)`. The outcome is part of the marker
(`[merge-duplicate-contacts:merged]`, `:declined`, `:mutual`), which matters: a
per-*pair* marker meant a "declined" comment suppressed the later "merged" comment for
the same pair, so a merge that happened after someone fixed the names left no audit
trail and no ready-to-archive signal. Caught by the pre-publish test, not in production.

Silent by design (no comment, no changes): `Duplicate of` empty, self-referential, or
with more than one target; either page in the trash. Those are noise, not decisions
anyone needs to see.

## Writes go through a raw PATCH

`update_database_item` is not used. This workflow touches arbitrary properties, and that
action's cached schema omits recently-added ones — a `properties|||New Prop|||relation`
key that doesn't exist yet fails at run time. `PATCH /v1/pages/{id}` with a Notion
properties object sidesteps the cache entirely.

Raw `sdk.fetch` calls are billed (only Zapier Tables ops are free). A merge costs
roughly 5–8 requests: two page reads, any relation paging, one PATCH, one comment
listing, one comment write. Merges are rare, so this is not a hot path.

## Known limitations

- **Page content is not merged**, only properties. A source with body blocks is
  therefore left in place, for its content to be moved by hand before archiving.
- `files` properties are filled only when the target is empty, rather than unioned —
  appending externally-hosted files reliably is fiddly and no Contact currently needs it.
- A **third** record pointing at either half is not considered. Each run looks at one
  pair.
- The merge does not touch the email → page-id Zapier Table. That stays
  `contact-emails-to-zapier-table`'s job, driven by the `Secondary Email` edit this
  workflow's union produces.

## Test

Both paths write to real Notion — use throwaway contacts and archive them afterwards.

```bash
SOURCE_FILES="$(jq -n --rawfile workflow workflow.ts '{"workflow.ts": $workflow}')"
zapier-sdk --experimental run-durable "$SOURCE_FILES" \
  --dependencies '{"@zapier/zapier-sdk":"0.86.0","zod":"4.4.3"}' \
  --zapier-durable-version '0.9.1' \
  --connections '{"notion_wf":{"connectionId":"02b73654-15c8-85c3-b16a-07304d2beb17"},"typesafe":{"connectionId":"02c36cbc-669d-8c82-9c72-7b7813e5cde0"}}' \
  --input '{"data":{"id":"<source-contact-page-id>"}}' \
  --private
```

Verified live on 2026-07-28 through the real Notion automation, after wiring:

| Case | Fixture | Result |
|---|---|---|
| Genuine duplicate | "ZZ Live Merge" → "Merge Live ZZ" | `merged: true` — `Job Title` and `Country` filled, `Mailing List` OR'd, `Bio` **not** overwritten, source left in place |
| Different people | Two contacts, different LinkedIn URLs | `merged: false` — *"different LinkedIn profiles (zz-live-one vs zz-live-two)"*, both records untouched |
| Config test delivery | Notion's empty `{"querystring": {}}` | Clean no-op, not a failed run |

Verified earlier the same day with `run-durable`, before publishing:

| Case | Fixture | Result |
|---|---|---|
| Different people | Two contacts, different names, different LinkedIn URLs | `merged: false` — *"different LinkedIn profiles (zz-alpha vs zz-beta)"*, comment posted |
| No usable identity | Both titles empty | Declined — conservative default, no merge |
| Genuine duplicate | "ZZ Same Person" → "Person Same ZZ" (reversed tokens) | `merged: true` — `Job Title` and `Country` filled, `Mailing List` OR'd, `Bio` **skipped** (target already set), `Name` skipped, all four duplicate relations never copied |
| Re-fire after merge | Same pair again | No-op patch, `Already merged` comment, nothing lost |

## Deploy

```bash
SOURCE_FILES="$(jq -n --rawfile workflow workflow.ts '{"workflow.ts": $workflow}')"
zapier-sdk --experimental publish-workflow-version <workflow-id> "$SOURCE_FILES" \
  --dependencies '{"@zapier/zapier-sdk":"0.86.0","zod":"4.4.3"}' \
  --zapier-durable-version '0.9.1' \
  --connections '{"notion_wf":{"connection_id":"02b73654-15c8-85c3-b16a-07304d2beb17"},"typesafe":{"connection_id":"02c36cbc-669d-8c82-9c72-7b7813e5cde0"}}' \
  --trigger '{"selected_api":"WebHookCLIAPI@1.1.1","action":"hook_v2","params":{}}' \
  --json
```

Always pass `--trigger`; omitting it silently unclaims the trigger and the Zap stops
firing while still reporting itself enabled.
