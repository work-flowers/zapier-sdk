// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/contact-emails-to-zapier-table
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
const NOTION_APP_KEY = "NotionCLIAPI";
const NOTION_CONNECTION = "notion_wf";
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

// Contacts data source.
const CONTACTS_DS = "21991b07-11ac-81a6-a894-000be4a09a67";

// Zapier Table indexing email -> Notion Contact page id (free ops, no
// connection). The Luma guest workflows resolve contacts exclusively through
// this Table (Secondary Email is a multi-select, which Notion's find action
// cannot search) — every email on a contact MUST have a row here or a Luma
// registration with that address creates a duplicate contact.
const CONTACT_EMAIL_TABLE = "01JYEPSEARXB2Z6BJRCMFGXBC2";

// Where a cross-contact address collision is recorded.
//
// A single shared address is only ever a HINT that two contacts might be the
// same person, so it goes to `Possible duplicate of` — NEVER to `Duplicate of`,
// which the "Contact Merger" Notion Custom Agent treats as an instruction to
// merge the two records and delete one. Until 2026-07-28 this workflow wrote
// `Duplicate of`, and the two readings collided: a one-address collision
// between Sachin Kolekar (Knoxx Foods) and Lionel Sim (The AI Capitol) set the
// relation, the agent merged the records, its merge wrote `Secondary Email`,
// which fired this workflow again, which flagged the pair in the other
// direction. Six hops in three minutes, spreading addresses between unrelated
// contacts — and one hop away from the agent deleting a live contact.
//
// The relation is deliberately UNLIMITED and every write here is a union. A
// contact can collide with more than one other, and replacing the value would
// drop the only record that an earlier pair was ever questioned. The paired
// side, `Possible duplicates`, then lists every contact flagged against a given
// record — which is the view that makes a spreading cluster obvious.
const POSSIBLE_DUPLICATE_PROP = "Possible duplicate of";

// The Notion DB automation posts `{ data: { id, properties: {...} } }` with
// properties in full Notion API form. Accept anything and extract defensively —
// the predecessor Zap died silently when Secondary Email changed from an email
// property to a multi-select and its `.email` mapping stopped matching.
const InputSchema = z.unknown();

// --- Pure helpers ----------------------------------------------------------
function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline can deliver input double-encoded (a JSON string of a
  // JSON string), while run-durable delivers it single-encoded. Parse until we
  // reach a non-string, or stop on parse failure.
  let v: unknown = rawInput;
  for (let i = 0; i < 4 && typeof v === "string"; i++) {
    const t = v.trim();
    if (t[0] !== "{" && t[0] !== "[" && t[0] !== '"') break;
    try {
      v = JSON.parse(t);
    } catch {
      break;
    }
  }
  return v;
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/** Lowercased, validated email — or null. All Table rows and lookups are
 *  lowercase; the predecessor Zap stored raw case, leaving rows the (lowercased)
 *  guest-workflow lookups could never match. */
function cleanEmail(v: unknown): string | null {
  const s = firstString(v)?.toLowerCase() ?? null;
  return s && EMAIL_RE.test(s) ? s : null;
}

/**
 * Extract every value from a property that may be (or once was) an email,
 * a multi-select, or a comma-joined string — the Secondary Email property
 * changed type in the past and killed the predecessor's hardcoded mapping,
 * so handle every shape we might be sent:
 *   { multi_select: [{ name }] } · { email: "a" } · "a, b" · ["a", "b"]
 */
function extractEmails(prop: any): string[] {
  const rawValues: unknown[] = [];
  if (prop == null) {
    // nothing
  } else if (Array.isArray(prop)) {
    rawValues.push(...prop);
  } else if (typeof prop === "object") {
    if (Array.isArray(prop.multi_select)) {
      rawValues.push(...prop.multi_select.map((s: any) => s?.name ?? s));
    } else if (prop.email != null) {
      rawValues.push(prop.email);
    } else if (prop.name != null) {
      rawValues.push(prop.name);
    }
  } else {
    rawValues.push(prop);
  }
  // Flatten comma-joined strings, validate, lowercase, dedupe.
  const out = new Set<string>();
  for (const v of rawValues) {
    const s = firstString(v);
    if (!s) continue;
    for (const piece of s.split(",")) {
      const email = cleanEmail(piece);
      if (email) out.add(email);
    }
  }
  return [...out];
}

/** Page ids compare hyphen- and case-insensitively: the Table holds ids written
 *  by several generations of automation, some hyphenated ("3a991b07-11ac-…"),
 *  some bare. A hyphenation mismatch used to read as "a different contact owns
 *  this address" and mark a contact a duplicate of itself. */
function sameId(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.replace(/-/g, "").toLowerCase() === b.replace(/-/g, "").toLowerCase();
}

interface ContactEmails {
  pageId: string;
  /** [email, "Primary" | "Secondary"] pairs, primary first, deduped. */
  emails: Array<[string, "Primary" | "Secondary"]>;
  /** The contact was sent to Notion's trash — the losing half of a merge, or a
   *  genuine delete. */
  inTrash: boolean;
  /** The contact was pulled back OUT of the trash. */
  restored: boolean;
  /** Parent data source from the payload, when it says. The `page.deleted` /
   *  `page.undeleted` subscription is registered on the whole Core CRM Objects
   *  database, so pages from every data source under it arrive here. */
  dataSourceId: string | null;
}

/** True when a page is known NOT to be a Contact. Unknown (null) is not a
 *  rejection — the caller falls through and checks again after reading the page. */
function isForeignDataSource(dataSourceId: string | null): boolean {
  return dataSourceId !== null && !sameId(dataSourceId, CONTACTS_DS);
}

/** Notion's integration-webhook event types that mean "this page is gone".
 *  Matched exactly — `page.undeleted` must not be mistaken for a deletion. */
const DELETED_EVENT_TYPES = new Set(["page.deleted", "page.trashed"]);

/** ...and the ones that mean it came back. */
const RESTORED_EVENT_TYPES = new Set(["page.undeleted", "page.restored"]);

function extractContact(raw: unknown): ContactEmails | null {
  const o = (raw ?? {}) as Record<string, any>;
  const data = o.data ?? o;
  // Two payload shapes reach this workflow. A Notion DB automation posts
  // `{ data: { id, properties } }`. A Notion integration webhook (the
  // `page.deleted` subscription) posts `{ type, entity: { id }, data: {...} }`
  // with no page id on `data` at all — so `entity.id` is checked too.
  const pageId = firstString(
    data?.id,
    o.entity?.id,
    data?.entity?.id,
    o.id,
    o.page_id,
    o.pageId,
  );
  // Empty/malformed payload (e.g. a manual "test" run from the Zapier UI) —
  // return null so the workflow exits as a clean no-op, not a failed run.
  if (!pageId) return null;

  const props = data?.properties ?? {};
  const primary = cleanEmail(props["Primary Email"]?.email ?? props["Primary Email"]);
  const secondaries = extractEmails(props["Secondary Email"]);

  const emails: Array<[string, "Primary" | "Secondary"]> = [];
  if (primary) emails.push([primary, "Primary"]);
  for (const s of secondaries) {
    if (s !== primary) emails.push([s, "Secondary"]);
  }
  // Notion has shipped three spellings of the flag (`archived`, then
  // `in_trash`, and `is_archived` on the current REST payload) and the webhook
  // body isn't guaranteed to be the newest. Any of them counts — as does a
  // `page.deleted` integration-webhook event, which carries no flag at all.
  const eventType = firstString(o.type, data?.type)?.toLowerCase() ?? "";
  const inTrash =
    data?.in_trash === true ||
    data?.archived === true ||
    data?.is_archived === true ||
    DELETED_EVENT_TYPES.has(eventType);
  // Both shapes carry the parent under `data.parent`: the integration webhook as
  // `{ id, type: "database", data_source_id }`, the DB automation as
  // `{ type: "data_source_id", database_id, data_source_id }`.
  const dataSourceId = firstString(
    data?.parent?.data_source_id,
    o.parent?.data_source_id,
  );
  return {
    pageId,
    emails,
    inTrash,
    restored: !inTrash && RESTORED_EVENT_TYPES.has(eventType),
    dataSourceId,
  };
}

// --- Notion page state -------------------------------------------------------

interface PageState {
  /** The page is in the trash, or gone from Notion entirely. */
  gone: boolean;
  /** Page ids from `Duplicate of` then `Duplicated by` — the two ends of a
   *  duplicate marking, either of which can point at a merge's survivor. */
  duplicateLinks: string[];
  /** Page ids in `Possible duplicate of` — the unconfirmed collision flags this
   *  workflow writes. Deliberately NOT folded into `duplicateLinks`: a merge
   *  hand-over must only ever follow a CONFIRMED duplicate, and handing a
   *  contact's addresses to a page it merely collided with would be the same
   *  false-positive that made this property necessary. */
  possibleDuplicateLinks: string[];
  /** `Primary Email`, lowercased, or null — used to type a handed-over row. */
  primary: string | null;
  /** `Secondary Email` values, lowercased and validated. A trashed page keeps
   *  its properties, so this is the one address source a merge can always rely
   *  on: the webhook may carry none, and the rows may already be swept. */
  secondaries: string[];
  /** The data source the page actually lives in — the authority when a payload
   *  doesn't say, or says something stale. */
  dataSourceId: string | null;
}

/**
 * Read whether a contact page still exists and who it is linked to as a
 * duplicate, via a raw `GET /v1/pages/{id}`.
 *
 * Returns null when Notion can't be reached or answers with something other
 * than a page — callers treat that as "assume the page is alive", so a blip
 * never causes a Table row to be re-pointed away from a living contact.
 */
async function readPageState(pageId: string): Promise<PageState | null> {
  const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
    connection: NOTION_CONNECTION,
    headers: { "Notion-Version": NOTION_VERSION },
  });
  // Rate limits and server errors are transient. THROW so the enclosing
  // ctx.step retries with backoff, rather than returning null and letting the
  // caller mistake "Notion was busy" for an answer — three of these workflows
  // running at once is enough to trip Notion's rate limit, and on 2026-07-26
  // that turned two merges into genuine deletes.
  if (res.status === 429 || res.status >= 500) {
    throw new Error(`Notion ${res.status} reading page ${pageId} — retrying`);
  }
  // A hard-deleted page (emptied from the trash) 404s; that's still "gone",
  // and it's the state a row left behind by an old merge is most likely in.
  if (res.status === 404) {
    return {
      gone: true,
      duplicateLinks: [],
      possibleDuplicateLinks: [],
      primary: null,
      secondaries: [],
      dataSourceId: null,
    };
  }
  if (!res.ok) return null;
  const body: any = await res.json();
  if (body?.object !== "page") return null;
  const props = body?.properties ?? {};
  const links: string[] = [];
  for (const prop of ["Duplicate of", "Duplicated by"]) {
    for (const rel of props[prop]?.relation ?? []) {
      const id = firstString(rel?.id);
      if (id && !links.some((l) => sameId(l, id))) links.push(id);
    }
  }
  const possibleLinks: string[] = [];
  for (const rel of props[POSSIBLE_DUPLICATE_PROP]?.relation ?? []) {
    const id = firstString(rel?.id);
    if (id && !possibleLinks.some((l) => sameId(l, id))) possibleLinks.push(id);
  }
  return {
    gone:
      body?.in_trash === true ||
      body?.archived === true ||
      body?.is_archived === true,
    duplicateLinks: links,
    possibleDuplicateLinks: possibleLinks,
    primary: cleanEmail(props["Primary Email"]?.email),
    secondaries: extractEmails(props["Secondary Email"]),
    dataSourceId: firstString(body?.parent?.data_source_id),
  };
}

// --- Merge hand-over ---------------------------------------------------------

/** Every Table row owned by a page, matched on both id spellings (see
 *  `sameId`) because an exact filter can't do it in one query. */
async function rowsOwnedBy(pageId: string): Promise<any[]> {
  const spellings = [...new Set([pageId, pageId.replace(/-/g, "")])];
  const rows: any[] = [];
  for (const spelling of spellings) {
    const hit = await sdk.listTableRecords({
      table: CONTACT_EMAIL_TABLE,
      keyMode: "names",
      filters: [{ fieldKey: "Page ID", operator: "exact", value: spelling }],
      pageSize: 100,
    });
    for (const row of hit?.data ?? []) {
      if (!rows.some((r) => r.id === row.id)) rows.push(row);
    }
  }
  return rows;
}

/**
 * How long to let a trashed contact settle before re-checking its addresses.
 *
 * A separate, older automation (not in this repo) DELETES a contact's rows from
 * this Table about 30-90s after the contact is trashed. On an ordinary delete
 * that is correct. On a merge it is the bug: the addresses now belong to the
 * survivor, and once their rows are gone the next Luma registration with one of
 * them finds nothing in the Table and creates a fresh duplicate contact — which
 * is how the 2026-07-26 Tun Shu pair kept regenerating.
 *
 * RETIRED 2026-07-26: that Zap's Contacts branch (path A) has been turned off
 * and the `page.deleted` subscription now points at this workflow, so nothing
 * races the hand-over any more and the second pass is dead weight. Set back to
 * 300 if path A is ever revived — the second pass is an idempotent upsert, so it
 * is only ever a cost, never a risk.
 */
const MERGE_SETTLE_SECONDS = 0;

/**
 * How long to keep watching an address that another live contact already owns.
 *
 * A cross-contact collision is the first visible sign of a merge in progress:
 * the addresses land on the survivor before the loser is trashed. This existed
 * because the trash event did not reach this workflow, so the merge path never
 * ran and a collision was the only handle on a merge.
 *
 * RETIRED 2026-07-26: `page.deleted` now arrives here, so trashing the loser
 * drives the merge path directly and the deferred re-check is redundant — along
 * with the fifteen-minute lingering run it caused on every collision. Set back
 * to 900 if the subscription is ever pointed away again.
 */
const CONFLICT_SETTLE_SECONDS = 0;

/** How the survivor holds an address, so a handed-over row is typed the way the
 *  contact actually reads — after a merge the loser's Primary is usually one of
 *  the survivor's Secondaries. */
function emailTypeOn(state: PageState | null, email: string): "Primary" | "Secondary" {
  return state && state.primary === email ? "Primary" : "Secondary";
}

/**
 * Point every one of `addresses` at `survivor`, whatever state the Table is in:
 * move the row if the trashed contact still owns it, recreate it if it has been
 * deleted, leave it alone if a third contact has since claimed the address.
 * Idempotent, so it is safe to run twice — which is exactly what the merge path
 * does, once immediately and once after the settle wait.
 */
async function handOverAddresses(
  ctx: DurableContext,
  stepPrefix: string,
  addresses: string[],
  fromPageId: string,
  survivor: string,
  survivorState: PageState | null,
) {
  const moved: string[] = [];
  const recreated: string[] = [];
  const skipped: Array<{ email: string; ownerPageId: string }> = [];

  for (let i = 0; i < addresses.length; i++) {
    const email = addresses[i];
    const type = emailTypeOn(survivorState, email);
    const outcome = await ctx.step(`${stepPrefix}-${i}`, async () => {
      const hit = await sdk.listTableRecords({
        table: CONTACT_EMAIL_TABLE,
        keyMode: "names",
        filters: [{ fieldKey: "Email", operator: "exact", value: email }],
        pageSize: 1,
      });
      const row = hit?.data?.[0] ?? null;
      const rowPageId = firstString(row?.data?.["Page ID"]);

      if (!row) {
        await sdk.createTableRecords({
          table: CONTACT_EMAIL_TABLE,
          keyMode: "names",
          records: [
            {
              data: {
                Email: email,
                "Page ID": survivor,
                Type: type,
                "Trigger Contact Creation": false,
              },
            },
          ],
        });
        return { action: "recreated" as const, ownerPageId: null as string | null };
      }
      if (sameId(rowPageId, survivor)) {
        return { action: "already" as const, ownerPageId: null as string | null };
      }
      if (rowPageId && !sameId(rowPageId, fromPageId)) {
        // A third contact holds this address now — not ours to take.
        return { action: "skipped" as const, ownerPageId: rowPageId };
      }
      await sdk.updateTableRecords({
        table: CONTACT_EMAIL_TABLE,
        keyMode: "names",
        records: [{ id: row.id, data: { "Page ID": survivor, Type: type } }],
      });
      return { action: "moved" as const, ownerPageId: null as string | null };
    });

    if (outcome.action === "moved") moved.push(email);
    else if (outcome.action === "recreated") recreated.push(email);
    else if (outcome.action === "skipped") {
      skipped.push({ email, ownerPageId: outcome.ownerPageId as string });
    }
  }

  return { moved, recreated, skipped };
}

/**
 * Make `pageId` the owner of every address in `entries`, without ever taking one
 * off a living contact: the row is created if it has gone, re-pointed if its
 * owner is in the trash, and left exactly as it is if some other live contact
 * holds it.
 *
 * Used twice — to settle a collision once a merge has had time to finish, and to
 * put a restored contact's addresses back.
 */
async function claimAddresses(
  ctx: DurableContext,
  stepPrefix: string,
  pageId: string,
  entries: Array<[string, "Primary" | "Secondary"]>,
) {
  const claimed: string[] = [];
  const stillOwned: Array<{ email: string; ownerPageId: string }> = [];

  for (let i = 0; i < entries.length; i++) {
    const [email, type] = entries[i];
    const outcome = await ctx.step(`${stepPrefix}-${i}`, async () => {
      const hit = await sdk.listTableRecords({
        table: CONTACT_EMAIL_TABLE,
        keyMode: "names",
        filters: [{ fieldKey: "Email", operator: "exact", value: email }],
        pageSize: 1,
      });
      const row = hit?.data?.[0] ?? null;
      const rowPageId = firstString(row?.data?.["Page ID"]);

      if (!row) {
        // No row at all — the owner was trashed and its rows removed with it.
        // The address is on this contact, so this contact is who it should
        // resolve to.
        await sdk.createTableRecords({
          table: CONTACT_EMAIL_TABLE,
          keyMode: "names",
          records: [
            {
              data: {
                Email: email,
                "Page ID": pageId,
                Type: type,
                "Trigger Contact Creation": false,
              },
            },
          ],
        });
        return { action: "claimed" as const, ownerPageId: null as string | null };
      }
      if (sameId(rowPageId, pageId)) {
        return { action: "already" as const, ownerPageId: null as string | null };
      }
      const state = rowPageId ? await readPageState(rowPageId) : null;
      if (state?.gone !== true) {
        return { action: "still-owned" as const, ownerPageId: rowPageId };
      }
      await sdk.updateTableRecords({
        table: CONTACT_EMAIL_TABLE,
        keyMode: "names",
        records: [{ id: row.id, data: { "Page ID": pageId, Type: type } }],
      });
      return { action: "claimed" as const, ownerPageId: null as string | null };
    });

    if (outcome.action === "claimed") claimed.push(email);
    else if (outcome.action === "still-owned") {
      stillOwned.push({ email, ownerPageId: outcome.ownerPageId as string });
    }
  }

  return { claimed, stillOwned };
}

/**
 * The contact came back out of the trash. Its rows went with it when it was
 * deleted, so put them back — otherwise the restored contact is invisible to
 * every lookup until someone happens to edit one of its emails, and the next
 * registration with one of its addresses creates a duplicate.
 *
 * Addresses come off the page itself rather than the payload: Notion's
 * `page.undeleted` event carries no properties, and the restore is the moment
 * the page is authoritative again.
 */
async function restoreContact(ctx: DurableContext, contact: ContactEmails) {
  const pageId = contact.pageId;
  const state = await ctx.step("restore-read-page", async () => readPageState(pageId));

  if (!state) {
    console.log(`contact ${pageId} was restored but Notion would not return the page`);
    return { pageId, restored: true, claimed: [], reason: "page unreadable" };
  }
  if (state.gone) {
    // Trashed again between the event and this read — the trash path owns it.
    console.log(`contact ${pageId} is back in the trash; nothing to restore`);
    return { pageId, restored: true, claimed: [], reason: "back in the trash" };
  }
  if (isForeignDataSource(state.dataSourceId)) {
    // Another data source under Core CRM Objects. Indexing its `Primary Email`
    // would point a contact lookup at a Company or a Deal.
    console.log(
      `skipping: restored page ${pageId} belongs to data source ${state.dataSourceId}, not Contacts`,
    );
    return { pageId, restored: true, claimed: [], reason: "not a Contacts page" };
  }

  const entries: Array<[string, "Primary" | "Secondary"]> = [];
  if (state.primary) entries.push([state.primary, "Primary"]);
  for (const email of state.secondaries) {
    if (email !== state.primary) entries.push([email, "Secondary"]);
  }
  for (const [email, type] of contact.emails) {
    if (!entries.some(([e]) => e === email)) entries.push([email, type]);
  }

  if (entries.length === 0) {
    console.log(`contact ${pageId} was restored but holds no addresses`);
    return { pageId, restored: true, claimed: [], reason: "no addresses" };
  }

  const result = await claimAddresses(ctx, "restore", pageId, entries);
  console.log(
    `restored ${pageId}: re-indexed ${result.claimed.length} of ${entries.length} ` +
      `address(es), ${result.stillOwned.length} held by another contact`,
  );
  return { pageId, restored: true, ...result };
}

/**
 * The triggering contact is in the trash: hand its addresses to the contact it
 * was merged into.
 *
 * The survivor is read off the trashed page's own duplicate relations. Both
 * ends are considered, because which one holds the link depends on the order
 * the merge happened in: `Duplicate of` when this contact was the one marked,
 * `Duplicated by` when the survivor was marked against it (the mutual case that
 * arises when both contacts' emails get edited). The first linked page that
 * isn't itself in the trash wins.
 *
 * A trashed contact with no live duplicate link was not merged into anything —
 * it was simply deleted — so its rows are deleted with it. That is the classic
 * Zap's Contacts behaviour, kept here where the merge case can be recognised
 * first. The two are told apart only when Notion actually answers: if the
 * trashed page can't be read, nothing is touched, because "no link" and "no
 * answer" look identical and only one of them justifies deleting rows.
 */
async function mergeAway(ctx: DurableContext, contact: ContactEmails) {
  const pageId = contact.pageId;

  // Read the trashed page first — it is the only address source that can't be
  // raced. The webhook may carry no properties at all (Notion's `page.deleted`
  // integration event carries none), and the rows may already have been swept
  // by the row-deleting automation; a page in the trash still answers
  // `GET /v1/pages/{id}` with its full property set.
  //
  // `readable` separates "this contact was merged into nobody" from "Notion
  // wouldn't tell us". Only the first is grounds for deleting rows.
  const self = await ctx.step("merge-read-self", async () => readPageState(pageId));
  const readable = self !== null;

  // Second line of defence for a payload that didn't name its parent: never
  // delete or move rows on the strength of a page from another data source.
  if (isForeignDataSource(self?.dataSourceId ?? null)) {
    console.log(
      `skipping: trashed page ${pageId} belongs to data source ${self?.dataSourceId}, not Contacts`,
    );
    return {
      pageId,
      inTrash: true,
      movedTo: null,
      addresses: [],
      reason: "not a Contacts page",
    };
  }

  const addresses = await ctx.step("merge-collect-addresses", async () => {
    const found = new Set(contact.emails.map(([email]) => email));
    if (self?.primary) found.add(self.primary);
    for (const email of self?.secondaries ?? []) found.add(email);
    for (const row of await rowsOwnedBy(pageId)) {
      const email = cleanEmail(row?.data?.["Email"]);
      if (email) found.add(email);
    }
    return [...found];
  });

  if (addresses.length === 0) {
    console.log(`contact ${pageId} is in the trash and holds no addresses`);
    return { pageId, inTrash: true, movedTo: null, addresses, reason: "no addresses" };
  }

  // Three outcomes, not two. "No survivor" is not the same claim as "no
  // survivor could be confirmed", and only the first may lead to a delete.
  const { survivor, inconclusive } = await ctx.step("merge-find-survivor", async () => {
    let inconclusive = false;
    for (const candidate of self?.duplicateLinks ?? []) {
      if (sameId(candidate, pageId)) continue;
      const state = await readPageState(candidate);
      if (state === null) {
        // Readable neither as a page nor as a 404. Not proof of life, and
        // emphatically not proof of death.
        inconclusive = true;
        continue;
      }
      if (!state.gone) return { survivor: candidate as string | null, inconclusive: false };
    }
    return { survivor: null as string | null, inconclusive };
  });

  if (!survivor && inconclusive) {
    console.log(
      `contact ${pageId} is in the trash and its duplicate link could not be read — ` +
        "leaving the Table alone",
    );
    return {
      pageId,
      inTrash: true,
      movedTo: null,
      addresses,
      reason: "duplicate link unreadable",
    };
  }

  if (!survivor && !readable) {
    console.log(
      `contact ${pageId} is in the trash but Notion would not return the page — ` +
        "leaving the Table alone",
    );
    return {
      pageId,
      inTrash: true,
      movedTo: null,
      addresses,
      reason: "trashed page unreadable",
    };
  }

  if (!survivor) {
    // Nobody was merged into — positively, not for want of looking. This is a
    // genuine delete, and the rows should go
    // with the contact. Leaving them would resolve future registrations to a
    // page in the trash, which is the problem the classic Zap's Contacts branch
    // was built to solve — this is that behaviour, moved here so that the merge
    // case can be told apart from it first.
    const removed = await ctx.step("merge-delete-rows", async () => {
      const rows = await rowsOwnedBy(pageId);
      if (rows.length === 0) return [] as string[];
      await sdk.deleteTableRecords({
        table: CONTACT_EMAIL_TABLE,
        records: rows.map((r) => r.id),
      });
      return rows.map((r) => firstString(r?.data?.["Email"]) ?? r.id);
    });
    console.log(
      `contact ${pageId} was deleted, not merged — removed ${removed.length} Table row(s)`,
    );
    return {
      pageId,
      inTrash: true,
      movedTo: null,
      addresses,
      deleted: removed,
      reason: "no surviving duplicate link (genuine delete)",
    };
  }

  const beforeState = await ctx.step("merge-read-survivor", async () =>
    readPageState(survivor),
  );

  // First pass, immediately: hand the rows over. This closes the window in
  // which an address belongs to nobody, and moves the rows out of reach of the
  // deleting automation described on MERGE_SETTLE_SECONDS.
  const first = await handOverAddresses(
    ctx, "merge-handover", addresses, pageId, survivor, beforeState,
  );

  // Zero disables the wait — see the cutover notes in the README.
  if (MERGE_SETTLE_SECONDS > 0) await ctx.wait("merge-settle", MERGE_SETTLE_SECONDS);

  // Second pass: put back anything that got deleted in the meantime.
  const afterState = await ctx.step("merge-recheck-survivor", async () =>
    readPageState(survivor),
  );
  if (afterState?.gone) {
    console.log(
      `survivor ${survivor} was trashed during the settle wait — first pass stands, no re-check`,
    );
    return {
      pageId,
      inTrash: true,
      movedTo: survivor,
      addresses,
      first,
      reason: "survivor trashed during settle",
    };
  }
  const second = await handOverAddresses(
    ctx, "merge-recheck", addresses, pageId, survivor, afterState ?? beforeState,
  );

  console.log(
    `merged ${pageId} -> ${survivor}: ${first.moved.length + first.recreated.length} ` +
      `address(es) handed over, ${second.recreated.length} restored after settle, ` +
      `${second.skipped.length} left with another owner`,
  );
  return { pageId, inTrash: true, movedTo: survivor, addresses, first, second };
}

// --- Workflow ----------------------------------------------------------------
// Durable port of "Update Zapier Table When Email Address Updated in Contacts
// Database". Trigger: Notion DB automation on the Contacts DB (Primary or
// Secondary Email edited) -> webhook. For every email on the contact, ensure
// the email -> page id Table has a row:
//   - not in the Table            -> create { Email, Page ID, Type }
//   - in the Table, same page     -> no-op
//   - in the Table, empty page id -> self-heal: point the row at this page
//   - in the Table, OTHER page    -> if that page is in the trash, reclaim the
//     row onto this contact; otherwise leave the row (first page keeps the
//     email) and ADD the owning page to this page's "Possible duplicate of"
//     relation — a review flag, not a merge instruction. (The original Zap's
//     Path B wrote "Merge Into", a property that no longer exists on Contacts.
//     Its successor wrote "Duplicate of", which a Notion Custom Agent acts on;
//     see POSSIBLE_DUPLICATE_PROP for why that had to change.)
//
// And when the triggering contact is itself in the trash, it is the losing half
// of a merge: its addresses are handed to the surviving contact (see mergeAway).
const workflow = defineDurable<unknown, unknown>(
  "contact-emails-to-zapier-table",
  async (ctx, rawInput) => {
    const contact = extractContact(InputSchema.parse(normalizeInput(rawInput)));
    if (!contact) {
      // Also the shape of Notion's subscription-verification ping, which carries
      // only `{ verification_token }` — a clean no-op, and the token stays
      // readable in this run's input for whoever is wiring the subscription up.
      console.log("skipping: no page id in payload (empty/test or verification delivery)");
      return { skipped: true, reason: "no page id in payload" };
    }

    // The `page.deleted` / `page.undeleted` subscription is registered on the
    // whole Core CRM Objects database, so Companies, Deals and every other data
    // source under it arrive here too. Drop them before spending a single API
    // call. A payload that doesn't name its parent falls through and is checked
    // again once the page has been read.
    if (isForeignDataSource(contact.dataSourceId)) {
      console.log(
        `skipping: page ${contact.pageId} belongs to data source ${contact.dataSourceId}, not Contacts`,
      );
      return {
        skipped: true,
        reason: "not a Contacts page",
        pageId: contact.pageId,
        dataSourceId: contact.dataSourceId,
      };
    }

    // A trashed contact is a merge's loser. Its addresses now belong to the
    // survivor, and unless they are handed over they end up owned by a page in
    // the trash — or, once the row-deleting automation has run, owned by nobody
    // at all, which is what makes the next Luma registration create yet another
    // duplicate. Runs before the emails check: a trashed contact with no email
    // properties in the payload can still own rows.
    if (contact.inTrash) {
      return await mergeAway(ctx, contact);
    }

    // Pulled back out of the trash: its rows were removed when it went in, so
    // re-index the addresses it still holds.
    if (contact.restored) {
      return await restoreContact(ctx, contact);
    }

    if (contact.emails.length === 0) {
      console.log("skipping: no valid emails in payload");
      return { skipped: true, reason: "no valid emails in payload", pageId: contact.pageId };
    }

    const indexed: string[] = [];
    const unchanged: string[] = [];
    const healed: string[] = [];
    const reclaimed: Array<{ email: string; fromPageId: string }> = [];
    const duplicates: Array<{ email: string; ownerPageId: string }> = [];

    for (let i = 0; i < contact.emails.length; i++) {
      const [email, type] = contact.emails[i];

      const hit = await ctx.step(`find-email-${i}`, async () =>
        sdk.listTableRecords({
          table: CONTACT_EMAIL_TABLE,
          keyMode: "names",
          filters: [{ fieldKey: "Email", operator: "exact", value: email }],
          pageSize: 1,
        }),
      );
      const row = hit?.data?.[0] ?? null;
      const rowPageId = firstString(row?.data?.["Page ID"]);

      if (!row) {
        // New address -> index it. "Trigger Contact Creation" stays false:
        // the contact already exists (true would let other automations create
        // a duplicate).
        await ctx.step(`create-row-${i}`, async () =>
          sdk.createTableRecords({
            table: CONTACT_EMAIL_TABLE,
            keyMode: "names",
            records: [
              {
                data: {
                  Email: email,
                  "Page ID": contact.pageId,
                  Type: type,
                  "Trigger Contact Creation": false,
                },
              },
            ],
          }),
        );
        indexed.push(email);
      } else if (sameId(rowPageId, contact.pageId)) {
        unchanged.push(email);
      } else if (!rowPageId) {
        // Row exists but points nowhere (the original Zap left these behind) —
        // self-heal it onto this page.
        await ctx.step(`heal-row-${i}`, async () =>
          sdk.updateTableRecords({
            table: CONTACT_EMAIL_TABLE,
            keyMode: "names",
            records: [{ id: row.id, data: { "Page ID": contact.pageId, Type: type } }],
          }),
        );
        healed.push(email);
      } else {
        // The address is on another contact's row. Two very different cases.
        const ownerGone = await ctx.step(`owner-state-${i}`, async () => {
          const state = await readPageState(rowPageId);
          return state?.gone === true;
        });
        if (ownerGone) {
          // The owner is in the trash — the leftover half of a merge that
          // happened before this workflow could hand the row over (or one the
          // trash trigger never fired for). This contact holds the address now.
          await ctx.step(`reclaim-row-${i}`, async () =>
            sdk.updateTableRecords({
              table: CONTACT_EMAIL_TABLE,
              keyMode: "names",
              records: [{ id: row.id, data: { "Page ID": contact.pageId, Type: type } }],
            }),
          );
          reclaimed.push({ email, fromPageId: rowPageId });
        } else {
          // A living contact already holds the address: leave the row with its
          // first owner and mark this contact as a duplicate of that one.
          duplicates.push({ email, ownerPageId: rowPageId });
        }
      }
    }

    // Flag at most one new owner per run, the first conflicting one. See
    // POSSIBLE_DUPLICATE_PROP for why this is never `Duplicate of`.
    //
    // Returns the owner it flagged, or null when the flag was already there —
    // a redundant write would only fire the Notion automation and burn another
    // run of this workflow, which is how a three-minute flag storm happened.
    let markedPossibleDuplicateOf: string | null = null;
    if (duplicates.length > 0) {
      const owner = duplicates[0].ownerPageId;
      markedPossibleDuplicateOf = await ctx.step(
        "mark-possible-duplicate",
        async () => {
          const state = await readPageState(contact.pageId);
          // Never compute a union from unknown state: writing [owner] alone
          // would silently drop every earlier flag. Throw so the step retries.
          if (!state) {
            throw new Error(
              `could not read ${contact.pageId} to union its ${POSSIBLE_DUPLICATE_PROP} ` +
                `flags — retrying rather than risk replacing them`,
            );
          }
          const existing = state.possibleDuplicateLinks;
          if (existing.some((l) => sameId(l, owner))) return null;
          await sdk.runAction({
            appKey: NOTION_APP_KEY,
            actionType: "write",
            actionKey: "update_database_item",
            connection: NOTION_CONNECTION,
            inputs: {
              datasource: CONTACTS_DS,
              page: contact.pageId,
              [`properties|||${POSSIBLE_DUPLICATE_PROP}|||relation`]: [
                ...existing,
                owner,
              ],
            },
          });
          return owner;
        },
      );
    }

    // A collision is usually a merge caught in the act — the addresses reach the
    // survivor before the loser is trashed. Come back once the dust has settled
    // and claim anything whose owner has gone. See CONFLICT_SETTLE_SECONDS.
    let settledConflicts: Awaited<ReturnType<typeof claimAddresses>> | null = null;
    if (duplicates.length > 0 && CONFLICT_SETTLE_SECONDS > 0) {
      await ctx.wait("conflict-settle", CONFLICT_SETTLE_SECONDS);
      const conflicted = duplicates.map(
        (d) =>
          contact.emails.find(([email]) => email === d.email) ??
          ([d.email, "Secondary"] as [string, "Primary" | "Secondary"]),
      );
      settledConflicts = await claimAddresses(
        ctx, "conflict-recheck", contact.pageId, conflicted,
      );
    }

    return {
      pageId: contact.pageId,
      indexed,
      unchanged,
      healed,
      reclaimed,
      duplicates,
      markedPossibleDuplicateOf,
      settledConflicts,
    };
  },
);

export default workflow;
