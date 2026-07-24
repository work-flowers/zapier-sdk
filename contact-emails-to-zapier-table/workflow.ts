// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/contact-emails-to-zapier-table
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
const NOTION_APP_KEY = "NotionCLIAPI";
const NOTION_CONNECTION = "notion_wf";

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

interface ContactEmails {
  pageId: string;
  /** [email, "Primary" | "Secondary"] pairs, primary first, deduped. */
  emails: Array<[string, "Primary" | "Secondary"]>;
}

function extractContact(raw: unknown): ContactEmails | null {
  const o = (raw ?? {}) as Record<string, any>;
  const data = o.data ?? o;
  const pageId = firstString(data?.id, o.id, o.page_id, o.pageId);
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
  return { pageId, emails };
}

// --- Workflow ----------------------------------------------------------------
// Durable port of "Update Zapier Table When Email Address Updated in Contacts
// Database". Trigger: Notion DB automation on the Contacts DB (Primary or
// Secondary Email edited) -> webhook. For every email on the contact, ensure
// the email -> page id Table has a row:
//   - not in the Table            -> create { Email, Page ID, Type }
//   - in the Table, same page     -> no-op
//   - in the Table, empty page id -> self-heal: point the row at this page
//   - in the Table, OTHER page    -> leave the row (first page keeps the email)
//     and set this page's "Duplicate of" relation to the owning page, like the
//     original Zap. (The original's Path B wrote "Merge Into", a property that
//     no longer exists on Contacts — both paths now use "Duplicate of".)
const workflow = defineDurable<unknown, unknown>(
  "contact-emails-to-zapier-table",
  async (ctx, rawInput) => {
    const contact = extractContact(InputSchema.parse(normalizeInput(rawInput)));
    if (!contact) {
      console.log("skipping: no page id in payload (empty/test delivery)");
      return { skipped: true, reason: "no page id in payload" };
    }
    if (contact.emails.length === 0) {
      console.log("skipping: no valid emails in payload");
      return { skipped: true, reason: "no valid emails in payload", pageId: contact.pageId };
    }

    const indexed: string[] = [];
    const unchanged: string[] = [];
    const healed: string[] = [];
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
      } else if (rowPageId === contact.pageId) {
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
        // Email already belongs to a different contact: leave the row with its
        // first owner and mark this contact as a duplicate of that one.
        duplicates.push({ email, ownerPageId: rowPageId });
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

    return {
      pageId: contact.pageId,
      indexed,
      unchanged,
      healed,
      duplicates,
      markedDuplicateOf,
    };
  },
);

export default workflow;
