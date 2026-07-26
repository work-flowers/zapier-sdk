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
  /** The contact was sent to Notion's trash — the losing half of a merge. */
  inTrash: boolean;
}

/** Notion's integration-webhook event types that mean "this page is gone".
 *  Matched exactly — `page.undeleted` must not be mistaken for a deletion. */
const DELETED_EVENT_TYPES = new Set(["page.deleted", "page.trashed"]);

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
  return { pageId, emails, inTrash };
}

// --- Notion page state -------------------------------------------------------

interface PageState {
  /** The page is in the trash, or gone from Notion entirely. */
  gone: boolean;
  /** Page ids from `Duplicate of` then `Duplicated by` — the two ends of a
   *  duplicate marking, either of which can point at a merge's survivor. */
  duplicateLinks: string[];
  /** `Primary Email`, lowercased, or null — used to type a handed-over row. */
  primary: string | null;
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
  // A hard-deleted page (emptied from the trash) 404s; that's still "gone",
  // and it's the state a row left behind by an old merge is most likely in.
  if (res.status === 404) {
    return { gone: true, duplicateLinks: [], primary: null };
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
  return {
    gone:
      body?.in_trash === true ||
      body?.archived === true ||
      body?.is_archived === true,
    duplicateLinks: links,
    primary: cleanEmail(props["Primary Email"]?.email),
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
 * That automation matches rows by Page ID, so the hand-over below both fixes
 * the ownership AND takes the rows out of its sights — verified live on
 * 2026-07-26: a row re-pointed at the survivor before the trash was still there
 * long after the deletion would have run. The second pass is the backstop for
 * when it wins anyway (this workflow queued behind it, a retry, a slow tick):
 * an upsert that puts back whatever went missing. Five minutes is several times
 * the observed latency, and the durable is suspended for the wait, so it costs
 * nothing. If that automation is ever retired, the second pass simply finds
 * every row already correct.
 */
const MERGE_SETTLE_SECONDS = 300;

/**
 * How long to keep watching an address that another live contact already owns.
 *
 * A cross-contact collision is the first visible sign of a merge in progress:
 * the addresses land on the survivor before the loser is trashed. As of
 * 2026-07-26 the Contacts automation does NOT fire on trash, so the merge path
 * above never runs — and the reclaim path can't help either, because by then
 * the row-deleting automation has removed the row entirely rather than leaving
 * it pointed at a trashed page.
 *
 * So a conflict schedules its own re-check: mark the duplicate as before, wait,
 * then look again. If the other contact has since been trashed (or its row has
 * vanished) the address is claimed for this contact. If it's still alive — two
 * genuinely different people sharing an address — nothing changes.
 *
 * Fifteen minutes covers a merge done in one sitting. Anything slower needs the
 * trash trigger; see the deploy notes in the README.
 */
const CONFLICT_SETTLE_SECONDS = 900;

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
 * Re-examine addresses that a different live contact owned, after giving a
 * merge time to finish. Claims an address for `pageId` when its previous owner
 * has gone to the trash, or when its row has disappeared altogether (the
 * row-deleting automation, see MERGE_SETTLE_SECONDS). Leaves it alone while the
 * other contact is still alive.
 */
async function reclaimConflicted(
  ctx: DurableContext,
  pageId: string,
  entries: Array<[string, "Primary" | "Secondary"]>,
) {
  const claimed: string[] = [];
  const stillOwned: Array<{ email: string; ownerPageId: string }> = [];

  for (let i = 0; i < entries.length; i++) {
    const [email, type] = entries[i];
    const outcome = await ctx.step(`conflict-recheck-${i}`, async () => {
      const hit = await sdk.listTableRecords({
        table: CONTACT_EMAIL_TABLE,
        keyMode: "names",
        filters: [{ fieldKey: "Email", operator: "exact", value: email }],
        pageSize: 1,
      });
      const row = hit?.data?.[0] ?? null;
      const rowPageId = firstString(row?.data?.["Page ID"]);

      if (!row) {
        // The owner was trashed and its rows swept away. The address is on this
        // contact, so this contact is who it should resolve to.
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
 * With no usable survivor nothing is written. A missing or trash-pointed row is
 * recoverable — the reclaim path picks it up the moment the surviving contact's
 * emails are next edited — whereas a row pointed at the WRONG contact is silent,
 * lasting corruption. Guessing is the worse failure, so this does nothing and
 * says so in the result.
 */
async function mergeAway(ctx: DurableContext, contact: ContactEmails) {
  const pageId = contact.pageId;

  // Snapshot the addresses while the evidence still exists: the trashed
  // contact's own properties from the webhook, plus whatever the Table still
  // says it owns. Minutes from now the rows may be gone.
  const addresses = await ctx.step("merge-collect-addresses", async () => {
    const found = new Set(contact.emails.map(([email]) => email));
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

  const survivor = await ctx.step("merge-find-survivor", async () => {
    const self = await readPageState(pageId);
    for (const candidate of self?.duplicateLinks ?? []) {
      if (sameId(candidate, pageId)) continue;
      const state = await readPageState(candidate);
      // Unreadable (null) is not proof of life — only an explicit "not gone"
      // is good enough to receive another contact's addresses.
      if (state && !state.gone) return candidate;
    }
    return null;
  });

  if (!survivor) {
    console.log(
      `contact ${pageId} is in the trash holding ${addresses.length} address(es) but ` +
        "has no surviving duplicate link — leaving the Table alone",
    );
    return {
      pageId,
      inTrash: true,
      movedTo: null,
      addresses,
      reason: "no surviving duplicate link",
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

  await ctx.wait("merge-settle", MERGE_SETTLE_SECONDS);

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
//     email) and set this page's "Duplicate of" relation to the owning page,
//     like the original Zap. (The original's Path B wrote "Merge Into", a
//     property that no longer exists on Contacts — both use "Duplicate of".)
//
// And when the triggering contact is itself in the trash, it is the losing half
// of a merge: its addresses are handed to the surviving contact (see mergeAway).
const workflow = defineDurable<unknown, unknown>(
  "contact-emails-to-zapier-table",
  async (ctx, rawInput) => {
    const contact = extractContact(InputSchema.parse(normalizeInput(rawInput)));
    if (!contact) {
      console.log("skipping: no page id in payload (empty/test delivery)");
      return { skipped: true, reason: "no page id in payload" };
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

    // Mark at most once, against the first conflicting owner.
    let markedDuplicateOf: string | null = null;
    if (duplicates.length > 0) {
      const owner = duplicates[0].ownerPageId;
      await ctx.step("mark-duplicate", async () =>
        sdk.runAction({
          appKey: NOTION_APP_KEY,
          actionType: "write",
          actionKey: "update_database_item",
          connection: NOTION_CONNECTION,
          inputs: {
            datasource: CONTACTS_DS,
            page: contact.pageId,
            "properties|||Duplicate of|||relation": [owner],
          },
        }),
      );
      markedDuplicateOf = owner;
    }

    // A collision is usually a merge caught in the act — the addresses reach the
    // survivor before the loser is trashed. Come back once the dust has settled
    // and claim anything whose owner has gone. See CONFLICT_SETTLE_SECONDS.
    let settledConflicts: Awaited<ReturnType<typeof reclaimConflicted>> | null = null;
    if (duplicates.length > 0) {
      await ctx.wait("conflict-settle", CONFLICT_SETTLE_SECONDS);
      const conflicted = duplicates.map(
        (d) =>
          contact.emails.find(([email]) => email === d.email) ??
          ([d.email, "Secondary"] as [string, "Primary" | "Secondary"]),
      );
      settledConflicts = await reclaimConflicted(ctx, contact.pageId, conflicted);
    }

    return {
      pageId: contact.pageId,
      indexed,
      unchanged,
      healed,
      reclaimed,
      duplicates,
      markedDuplicateOf,
      settledConflicts,
    };
  },
);

export default workflow;
