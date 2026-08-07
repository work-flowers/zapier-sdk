# xero-contact-from-notion-deal

Creates a company's contact in Xero from the Notion CRM, so a deal that is about to be invoiced has somewhere to be invoiced to.

**Status:** enabled on Zapier, cutover complete (2026-08-02). Replaces the classic Zap **Create Xero Contact from Notion**, which is now disabled — the Companies button and the Deals automation both post here, and nothing else serves them.

## What it does

A webhook delivers a Notion page — either a **Company** (the `Create Xero Contact` button on the Companies record) or a **Deal** (a stage automation on the Deals database). The workflow re-reads that page's current state, resolves the Company/Deal pair, and creates the company's Xero contact with the right person on it.

Who ends up on the contact:

| Company's `Primary Billing Contact` | Deal's `Contact` | Xero contact |
| --- | --- | --- |
| set | set, different person | billing contact is the primary person; deal contact rides along as Xero's secondary "contact person", included in emails |
| set | set, **same person** | that person, once, as the primary — no secondary |
| set | empty | billing contact as the primary — no secondary |
| empty | set | deal contact as the primary — no secondary |
| empty | empty | nothing created (`no-usable-contact`) |

The Xero contact is named after the company and carries the company's Notion `ID` (e.g. `COM-766`) as its Account Number.

## Workflow

```mermaid
flowchart TD
    A["Webhook: Notion page<br/>(Companies button or Deals automation)"] --> B["Re-fetch the page's CURRENT state<br/>(never trust the payload)"]
    B --> C{"Company or Deal?"}
    C -- Deal --> D["Fetch its Company"]
    C -- Company --> E["Use it directly"]
    D --> F
    E --> F{"Company already has<br/>a Xero Contact ID?"}
    F -- yes --> G(["Skip — already in Xero"])
    F -- no --> H{"A deal to work from?"}
    H -- no --> I(["Skip — company has no deals"])
    H -- yes --> J["Read Primary Billing Contact<br/>and the deal's Contact"]
    J --> K{"Who is known?"}
    K -- "neither" --> L(["Skip — no usable contact"])
    K -- "both, different" --> M["Primary = billing contact<br/>Contact person = deal contact"]
    K -- "one, or both the same" --> N["Primary = that person<br/>No contact person"]
    M --> O["Xero: Create/Update Contact<br/>name = Company Name, acct no = COM-nnn"]
    N --> O
    O --> P["Write the Xero Contact ID back<br/>onto the Notion company"]
    P --> Q(["Return the created contact"])
```

## Trigger

Webhooks by Zapier Catch Hook (`hook_v2`). **Two Notion senders post to the same URL:**

```
https://hooks.zapier.com/hooks/catch/20495893/igoRSxsAwMIxDwO6/
```

- the `Create Xero Contact` **button** property on Companies (sends the Company page)
- a **stage automation** on Deals (sends the Deal page)

The classic Zap only understood the Company shape, so a Deal-shaped payload would have read `Deals`, `Company Name` and `ID` off a Deal page and found none of them. This one detects the page's data source and resolves the pair either way.

`previewOnly: true` in the payload resolves the whole chain and returns the exact Xero inputs it *would* send, without writing anything. Use it for testing — see the maintainer notes.

**An empty payload is treated as a ping, not an event.** A catch URL is public: opening it in a browser, curling it, or hitting "test" while wiring up the Notion side delivers `{"querystring":{}}`. Those return `skipped: "empty-payload"` rather than failing. A payload that *does* carry content but no page id still throws — that is a real event we failed to understand, and it should be loud.

## Verified cases

All against live CRM records, 2026-08-02. The first three are dry runs (`previewOnly`, Notion reads only); the last two are real.

| Case | Trigger page | Mode | Result |
| --- | --- | --- | --- |
| GGV — Technical Advisory Retainer | Deal | preview | `billing-primary-with-deal-contact-person` — Jeffrey Paine (billing) primary, Angela Toy as contact person |
| GastroGig — Notion Implementation | Deal | preview | `single-person` — Deal → Company resolved; Jasmine Cheah primary, acct `COM-766` |
| Knoxx Business Group | Company (button) | preview | `single-person` — billing contact **is** the deal contact, so it collapses to one person |
| GastroGig — Notion Implementation | Deal | **live**, via the deployed catch hook | Xero contact `a0d4f085-8e7b-4834-9f1a-c5c8cf1b5747` created; `writeBack: "written"` and the id verified back on the Notion company |
| GastroGig, fired a second time | Deal | **live** | `skipped: "already-in-xero"` — returns before the Xero call. This is the repeat the classic Zap could not stop, and it is the whole point of the write-back |
| `{"querystring":{}}` — the real payload that failed during cutover | — | replay | `skipped: "empty-payload"`, no longer a failed run |
| `{"data":{"properties":{...}}}` with no id | — | replay | still fails loudly, as a malformed real event should |

## What changed from the classic Zap

Three deliberate differences; everything else is a straight port.

- **The branch had a hole.** Its Path A required billing ≠ deal contact and Path C required *no* billing contact, and there was no Path B. So "billing contact **is** the deal contact" and "billing contact but no deal contact" matched no path and the Zap silently did nothing. Both now produce a single-person contact. This is not hypothetical: Knoxx hits the first case (see the table above).
- **The dedupe guard now has teeth.** The classic Zap stopped when `[Table] Company IDs` held a `Xero Contact ID` — but nothing wrote that property, so it almost never fired, and Xero's Create/Update Contact matches on **name**, meaning a repeat trigger quietly *overwrote* the live contact's people. The durable writes the new id back onto the Notion company after creating, which [`notion-companies-to-zapier-table`](../notion-companies-to-zapier-table/) then mirrors into the Table for free.
- **The guard reads Notion, not the Table.** The company page is already in hand, the Table is fed from that same property, and the Table read would only ever be staler. One less lookup.

Two smaller ones: the empty `address__type_of: "Postal Address"` is dropped (no address data was ever sent with it), and the `contact_person__first_name: "na"` placeholder is gone — when there is no second person the contact-person fields are simply omitted.

## The reverse direction: [`xero-contact-to-notion-company`](../xero-contact-to-notion-company/)

This durable covers **Notion → Xero**. There is a genuine **Xero → Notion** case it structurally
cannot cover, and a *classic* Zap owns it:

> A contact gets created in Xero by other means — typically a transaction arrives from a new vendor
> and Dennis makes the contact by hand. If a Company record for that vendor already exists in Notion,
> he pastes its **Notion Company ID into the Xero contact's Account Number**, and the classic Zap
> links the two.

Nothing on the Notion side changes in that flow, so no webhook fires and this durable never runs.
That case is real and needed — it is **not** redundant with this workflow.

> ### ✅ Migrated to a durable on 2026-08-07
>
> It now lives in [`xero-contact-to-notion-company`](../xero-contact-to-notion-company/), which is
> schedule-driven (~24 Xero calls/day) and writes to **Notion** rather than the Table, fixing both
> faults described below. **Both classic Zaps should now be turned off in the Zapier UI** — while
> enabled they keep writing `f15` directly and keep costing ~192 Xero calls/day.
>
> The rest of this section is kept as the record of what was wrong and why, since the reasoning is
> what makes the durable's shape make sense.

### ⚠️ There were TWO of them, and both wrote to the wrong place

As of 2026-08-07 the account held two classic Zaps doing this, *functionally identical*:
**"Add Xero Contact ID to Company IDs Table"** and **"Associate Xero Contact with Notion Company"**.
Same trigger (`XeroCLIAPI@2.21.0` / `updated_contact`), same connection, same organization, same
filter, same table, same lookup and write fields. The only differences were the titles, the per-Zap
step ids inside their `gives[…]` references, a `stepTitle` on one filter, and
`_zap_search_success_on_miss` being the string `"False"` in one and boolean `false` in the other.
**One is pure duplication** — at 1-minute polling the pair cost ~2,880 Xero API calls/day between
them and were the largest single contributor to the 2026-08-06 quota exhaustion. Both were moved to
15-minute polling (~192/day); one should be deleted outright.

**And the survivor wrote the ContactID into `[Table] Company IDs` (`f15`) rather than onto the Notion
company page.** That is the wrong target, for two reasons:

1. **The link was temporary.** [`notion-companies-to-zapier-table`](../notion-companies-to-zapier-table/)
   is a *true mirror* — its own source comment says *"empty in Notion clears the table value"* — and
   `Xero Contact ID` is in its mirrored set. So with the Notion property still empty, the next edit
   of that company in Notion wiped `f15` straight back out.
2. **This durable's dedupe guard stayed blind.** The guard reads `Xero Contact ID` off the *Notion
   page*. With that property empty, a later Companies-button or Deals-stage trigger would re-run the
   upsert — and Xero matches on **name**, so it would silently overwrite the hand-made vendor
   contact's people. Exactly the failure the guard exists to prevent.

### The corrected classic Zap

Steps 1–3 are unchanged. Step 3 does double duty and every part still matters: `f11 exact = Account
Number` proves the company really is one we hold in Notion, `f15 isnull` stops a re-fire once linked,
and its output supplies **`f14` (Notion Page ID)** — the page UUID, which the trigger alone cannot
give, because `AccountNumber` carries Notion's `ID` property (a `unique_id` like `COMP-42`), not a
UUID. Keep **Success on miss = No** so an unrecognised Account Number simply halts.

Replace **step 4** (`TableCLIAPI` / `update_record`) with:

| Field | Value |
| --- | --- |
| App / action | **Notion → Update Data Source Item** (`update_database_item`) |
| Connection | `work.flowers \| Dennis <dennis@work.flowers>` (`02b73654-15c8-85c3-b16a-07304d2beb17`) — **never** the Knoxx connection, which cannot see work.flowers databases |
| Data source | **Companies** |
| Item / Page ID | step 3 → **`Notion Page ID`** (`f14`) |
| Property `Xero Contact ID` | step 1 → **`ContactID`** |

Writing to Notion instead of the Table fixes both faults at once and needs no new plumbing: Notion
stays the single source of truth, the mirror carries the value into `f15` for free, and this
durable's guard finally has something to read. It is also **self-limiting** — once the mirror
populates `f15`, step 3's `f15 isnull` gate goes false and the Zap stops firing for that contact.

> Classic Zaps are exposed by neither the SDK CLI nor the MCP connector, so none of this is
> machine-verifiable from this repo and the change has to be made in the Zapier UI. That is also why
> it is written down here: the durable is the only tracked artifact adjacent to it.

## Maintainer notes

- Connection aliases `notion_wf` (Notion, **work.flowers** workspace — never the Knoxx one) and `xero_wf` (Xero work.flowers), resolved at run/publish time via `--connections`.
- **Test with `previewOnly`, not a live run.** Xero's Create/Update Contact upserts on name, so a careless test against a real company overwrites that contact's people in the production ledger. Preview does Notion reads only.
- `previewOnly` deliberately walks *past* the already-in-Xero guard and reports it as `wouldSkip`. Every company that currently has a `Primary Billing Contact` also already has a Xero id, so returning at the guard would make the two-person shape impossible to exercise without writing.
- **When the button fires on a Company with several deals, the first entry of the `Deals` relation wins** — the same arbitrary choice the classic Zap made. It only matters for picking the secondary contact person; the company, name and account number are unaffected. Firing from the Deal instead removes the ambiguity.
- The Xero contact id is dug out of the action result defensively (`ContactID` / `contact_id` / `id` / nested `Contacts[0]`), because the action's output key spelling is not contractual. If none matches, the contact is still created and the write-back is skipped with a `WARNING` log rather than failing the run.
- Notion property names are hoisted to constants at the top of [workflow.ts](workflow.ts); the CRM schema is the thing most likely to drift under this workflow.
