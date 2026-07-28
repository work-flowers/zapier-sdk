// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/xero-bank-transactions-to-zapier-table
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// No connection aliases at all. The Xero credential lives on the TRIGGER
// (publish --trigger authentication_id) and the workflow body only touches a
// Zapier Table, which needs no connection and costs no tasks.

/**
 * "Xero Bank Transactions" — the mirror this workflow owns.
 *
 * Read by `drive-invoice-to-xero` to answer "has this invoice already been
 * paid?". That workflow is only as correct as this one is current: when this
 * Zap's write step was accidentally paused, the Table silently fell ~5 days
 * behind and invoices that HAD been paid got duplicate draft bills, with no
 * error anywhere. Treat a pause here as a production incident downstream.
 */
const TABLE_ID = "01KCDV6Y17F31J2Q6S1EMYZC8K";

/** The Table's natural key: one row per Xero bank transaction. */
const KEY_FIELD = "bank_transaction_id";

/**
 * Every field this workflow mirrors, in Table order. `currency_rate` is
 * included deliberately — the classic Zap never mapped it, so that column was
 * null on every row despite being populated on ~36% of transactions (any
 * non-base-currency one).
 */
const MIRRORED_FIELDS = [
  KEY_FIELD,
  "date",
  "bank_account_id",
  "reference",
  "contact_id",
  "contact_name",
  "type",
  "currency_code",
  "currency_rate",
  "total",
  "has_attachments",
] as const;

// The Xero "New Bank Transaction" trigger delivers one transaction object.
// Accept anything and extract defensively.
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

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/[^0-9.+-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A Zapier Table `labeled_string` cell reads back as `{ value, label }`. */
function labeledValue(cell: unknown): string | null {
  if (cell && typeof cell === "object" && "value" in (cell as any)) {
    return firstString((cell as any).value);
  }
  return firstString(cell);
}

/**
 * Midnight-UTC datetime for the Table's `date` column.
 *
 * Xero sends `2026-07-26T00:00:00+00:00`; a bare `YYYY-MM-DD` would be read in
 * the account's local timezone (Asia/Singapore) and land 8 hours off, which
 * shifts every date-window query run against this Table. Pin `Z` explicitly.
 */
function toTableDate(v: unknown): string | null {
  const s = firstString(v);
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? `${m[1]}T00:00:00Z` : null;
}

interface Snapshot {
  bank_transaction_id: string;
  date: string | null;
  bank_account_id: string;
  reference: string;
  contact_id: string;
  contact_name: string;
  type: string;
  currency_code: string;
  currency_rate: number | null;
  total: number | null;
  has_attachments: boolean;
}

/** Build the row this transaction should have. */
function extractSnapshot(payload: unknown): Snapshot | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, any>;
  // Zapier adds a lowercase `id`; Xero's own name is BankTransactionID.
  const id = firstString(p.id, p.BankTransactionID);
  if (!id) return null;
  return {
    bank_transaction_id: id,
    date: toTableDate(p.Date ?? p.DateString),
    bank_account_id: firstString(p.BankAccount?.AccountID) ?? "",
    reference: firstString(p.Reference) ?? "",
    // Transfers (SPEND-TRANSFER / RECEIVE-TRANSFER) carry no contact at all.
    contact_id: firstString(p.Contact?.ContactID) ?? "",
    contact_name: firstString(p.Contact?.Name) ?? "",
    type: firstString(p.Type) ?? "",
    currency_code: firstString(p.CurrencyCode) ?? "",
    currency_rate: toNumber(p.CurrencyRate),
    total: toNumber(p.Total),
    has_attachments: p.HasAttachments === true,
  };
}

/** Compare a stored row against the snapshot, field by field, as the Table
 *  would return them. Returns the fields that actually differ. */
function changedFields(stored: Record<string, unknown>, snap: Snapshot): string[] {
  const diffs: string[] = [];
  for (const field of MIRRORED_FIELDS) {
    const want: unknown = snap[field];
    const got = stored[field];
    if (field === "type" || field === "currency_code") {
      if ((labeledValue(got) ?? "") !== String(want ?? "")) diffs.push(field);
      continue;
    }
    if (field === "has_attachments") {
      if (Boolean(got) !== Boolean(want)) diffs.push(field);
      continue;
    }
    if (field === "total" || field === "currency_rate") {
      const a = toNumber(got);
      const b = want as number | null;
      if (a == null && b == null) continue;
      if (a == null || b == null || Math.abs(a - b) > 0.000001) diffs.push(field);
      continue;
    }
    if (field === "date") {
      // Compare on the calendar day; the stored form may or may not carry Z.
      if ((firstString(got) ?? "").slice(0, 10) !== (firstString(want) ?? "").slice(0, 10)) {
        diffs.push(field);
      }
      continue;
    }
    if ((firstString(got) ?? "") !== String(want ?? "")) diffs.push(field);
  }
  return diffs;
}

/** Rows for one transaction id, oldest ULID first so racers agree on a winner. */
async function findRows(id: string): Promise<any[]> {
  const hit = await sdk.listTableRecords({
    table: TABLE_ID,
    keyMode: "names",
    filters: [{ fieldKey: KEY_FIELD, operator: "exact", value: id }],
    pageSize: 100,
  });
  return [...(hit?.data ?? [])].sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
}

const workflow = defineDurable<Record<string, unknown>, unknown>(
  "xero-bank-transactions-to-zapier-table",
  async (ctx, rawInput) => {
    const snap = extractSnapshot(InputSchema.parse(normalizeInput(rawInput)));
    if (!snap) {
      console.log("skipping: no bank transaction id in payload (empty/test delivery)");
      return { skipped: true, reason: "no bank transaction id in payload" };
    }

    // 1. Find-or-create, keyed on the transaction id. The classic Zap created
    //    unconditionally, which is why the Table holds 4 duplicate pairs.
    const existing = await ctx.step("find-existing-row", async () => findRows(snap.bank_transaction_id));

    if (existing.length === 0) {
      await ctx.step("create-row", async () =>
        sdk.createTableRecords({
          table: TABLE_ID,
          keyMode: "names",
          records: [{ data: { ...snap } }],
        }),
      );

      // Two runs for the same transaction can both find nothing and both
      // create. Re-read and converge: earliest ULID wins, strays go. Deletes
      // are idempotent, so whichever racer gets here second is still correct.
      const after = await ctx.step("dedupe-after-create", async () => findRows(snap.bank_transaction_id));
      if (after.length > 1) {
        await ctx.step("delete-duplicate-rows", async () =>
          sdk.deleteTableRecords({
            table: TABLE_ID,
            records: after.slice(1).map((r: any) => r.id),
          }),
        );
        console.log(
          `created ${snap.bank_transaction_id} and removed ${after.length - 1} racing duplicate(s)`,
        );
        return {
          bankTransactionId: snap.bank_transaction_id,
          outcome: "created-deduped",
          duplicatesRemoved: after.length - 1,
          snapshot: snap,
        };
      }
      console.log(
        `created ${snap.bank_transaction_id} (${snap.contact_name || "no contact"} ` +
          `${snap.type} ${snap.currency_code} ${snap.total})`,
      );
      return { bankTransactionId: snap.bank_transaction_id, outcome: "created", snapshot: snap };
    }

    // 2. Already mirrored. Clear any strays first so the key stays unique.
    let duplicatesRemoved = 0;
    if (existing.length > 1) {
      await ctx.step("delete-duplicate-rows", async () =>
        sdk.deleteTableRecords({
          table: TABLE_ID,
          records: existing.slice(1).map((r: any) => r.id),
        }),
      );
      duplicatesRemoved = existing.length - 1;
      console.log(`removed ${duplicatesRemoved} pre-existing duplicate row(s) for ${snap.bank_transaction_id}`);
    }

    // 3. Refresh the row only when something actually moved. Xero can restate a
    //    transaction, and `has_attachments` flips to true when
    //    `drive-invoice-to-xero` attaches an invoice to it — so a re-delivery
    //    is a chance to correct the mirror rather than a no-op.
    const winner = existing[0];
    const diffs = changedFields((winner?.data ?? {}) as Record<string, unknown>, snap);
    if (diffs.length === 0) {
      console.log(`no change for ${snap.bank_transaction_id}`);
      return {
        bankTransactionId: snap.bank_transaction_id,
        outcome: "unchanged",
        duplicatesRemoved,
        snapshot: snap,
      };
    }

    await ctx.step("update-row", async () =>
      sdk.updateTableRecords({
        table: TABLE_ID,
        keyMode: "names",
        records: [{ id: String(winner.id), data: { ...snap } }],
      }),
    );
    console.log(`updated ${snap.bank_transaction_id}: ${diffs.join(", ")}`);
    return {
      bankTransactionId: snap.bank_transaction_id,
      outcome: "updated",
      changedFields: diffs,
      duplicatesRemoved,
      snapshot: snap,
    };
  },
);

export default workflow;
