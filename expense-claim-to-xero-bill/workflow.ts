// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/expense-claim-to-xero-bill
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
// The trigger is a catch hook, so it needs no connection. A Notion database
// automation on Expense Claims POSTs the page when Status becomes Approved.
// `notion_wf` is used here to re-read the claim, look up the claimant's email
// and write the bill link back.
const NOTION_CONNECTION = "notion_wf"; // work.flowers workspace connection
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

/** 🧾 Expense Claims DB. A page from anywhere else is refused. */
const EXPENSE_CLAIMS_DATA_SOURCE = "4c0a9038-54fc-4643-a63b-df4e52139219";

const XERO_APP_KEY = "XeroCLIAPI";
const XERO_CONNECTION = "xero_wf";
/** Xero organisation ("tenant") — work.flowers. Both the Zapier action's
 *  `organization` input and the raw request's `Xero-Tenant-Id` header. */
const XERO_ORGANIZATION = "62699a8c-3351-40e8-9265-bdca5e037b03";
const XERO_API = "https://api.xero.com/api.xro/2.0";

// --- Notion property names ----------------------------------------------------
const PROP_TITLE = "Claim description";
const PROP_CLAIM_ID = "Claim ID";
const PROP_AMOUNT = "Amount";
const PROP_CURRENCY = "Currency";
const PROP_CATEGORY = "Category";
const PROP_EXPENSE_DATE = "Expense date";
const PROP_MERCHANT = "Merchant / supplier";
const PROP_PURPOSE = "Business purpose";
const PROP_RECEIPT = "Receipt";
const PROP_STATUS = "Status";
const PROP_XERO_BILL = "Xero bill";

/** Status the claim moves to once its bill exists; `xero-invoice-alerts` moves
 *  it on to "Paid" when Xero reports the bill paid. */
const STATUS_PAYMENT_PENDING = "Payment Pending";

// --- Zapier Table ---------------------------------------------------------------

/**
 * "Expense Claim Bills": one row per bill, keyed on `xero_invoice_id`. This Zap
 * writes each row as `pending`; `xero-invoice-alerts` reads the pending rows
 * on its hourly pass (free, no task), and when one of those bills shows up
 * PAID it sets the claim to Paid and the row to `paid`.
 */
const CLAIM_BILLS_TABLE = "01M4BBZ4ET36BQ29EAXJ5833JZ";
const TABLE_KEY_FIELD = "xero_invoice_id";

// --- Bill shape ----------------------------------------------------------------

/**
 * Category → Xero account code. Every Category option in Notion must appear
 * here; a claim whose category is missing from this map fails the run rather
 * than landing on a guessed account. Adding a Category option in Notion means
 * adding a row here in the same change.
 */
export const CATEGORY_ACCOUNTS: Record<string, string> = {
  Travel: "420", // Travel & Entertainment
  Meals: "420", // Travel & Entertainment
  "Software & subscriptions": "510", // Subscriptions - Software
  "Office supplies": "453", // Office Expenses
  "Professional services": "313", // Professional Fees
  "Training & courses": "475", // Learning & Development
  "Events & sponsorship": "405", // Event & Sponsorship Costs
  "Memberships & publications": "485", // Subscriptions - Non-Software
  Other: "429", // General Expenses
};

/**
 * The organisation's home currency. Only a claim in this currency can carry
 * Singapore GST, so only it is raised tax-inclusive at the account's default
 * tax rate; every other currency is raised with no tax. The draft is reviewed
 * before approval, so a receipt that isn't a valid tax invoice is fixed there.
 */
const HOME_CURRENCY = "SGD";

/** The only Status that raises a bill. The Notion automation fires on it; a
 *  stray or hand-replayed POST for a claim in any other state is skipped. */
const APPROVED_STATUS = "Approved";

/** Bills are created for review, never posted automatically. */
const BILL_STATUS = "draft";

/** Due date = bill date (the expense date) + this many days. */
const PAYMENT_TERMS_DAYS = 30;

/** `InvoiceNumber` on the bill — the dedupe key a re-run looks for. */
const BILL_NUMBER_PREFIX = "EXP-";

/** Xero's own wording for a currency the organisation doesn't hold. */
const UNSUBSCRIBED_CURRENCY = /not subscribed to currency/i;

// --- Pure helpers -----------------------------------------------------------

function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline can deliver input double-encoded (a JSON string of a
  // JSON string), while run-durable delivers it single-encoded.
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

/** An empty test ping: no keys, or only empty wrapper keys. */
function isEmptyPing(raw: unknown): boolean {
  if (raw === null || raw === undefined || raw === "") return true;
  if (typeof raw !== "object") return false;
  const WRAPPER_KEYS = new Set(["querystring", "headers", "params", "body", "query"]);
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!WRAPPER_KEYS.has(key)) return false;
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object" && Object.keys(value as object).length === 0) continue;
    return false; // a wrapper with something in it — treat as a real event
  }
  return true;
}

function firstString(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

function dashUuid(id: string): string {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return id.trim();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Notion's automation webhook delivers `{ source, data: <page> }`; a hand
 * replay through `trigger-workflow` can pass `{"page_id": "..."}`. A payload with content but
 * no recognisable id is a real event we failed to understand, so it throws.
 */
function extractPageId(raw: unknown): string {
  if (typeof raw === "string") {
    const id = dashUuid(raw.trim());
    if (/^[0-9a-f-]{36}$/.test(id)) return id;
  } else if (raw && typeof raw === "object") {
    const o = raw as Record<string, any>;
    const id = firstString(o.page_id, o.pageId, o.data?.id, o.data?.page_id, o.id, o.page?.id);
    if (id) return dashUuid(id);
  }
  throw new Error(`Could not find a Notion page id in the payload: ${JSON.stringify(raw).slice(0, 400)}`);
}

function plainText(rich: unknown): string {
  if (!Array.isArray(rich)) return "";
  return rich
    .map((r: any) => firstString(r?.plain_text) || firstString(r?.text?.content))
    .join("")
    .trim();
}

interface Receipt {
  name: string;
  url: string;
}

export interface Claim {
  pageId: string;
  pageUrl: string;
  dataSourceId: string;
  inTrash: boolean;
  claimNumber: number | null;
  title: string;
  /** null when blank — never coerced to 0, so the pre-flight can see it. */
  amount: number | null;
  currency: string;
  category: string;
  expenseDate: string;
  merchant: string;
  purpose: string;
  status: string;
  receipts: Receipt[];
  existingBillUrl: string;
  createdById: string;
}

function readClaim(page: any): Claim {
  const p = page?.properties ?? {};
  const files: any[] = Array.isArray(p[PROP_RECEIPT]?.files) ? p[PROP_RECEIPT].files : [];
  const amount = p[PROP_AMOUNT]?.number;
  const claimNumber = p[PROP_CLAIM_ID]?.unique_id?.number;
  const parent = page?.parent ?? {};
  return {
    pageId: dashUuid(firstString(page?.id)),
    pageUrl: firstString(page?.url),
    dataSourceId: dashUuid(firstString(parent.data_source_id, parent.database_id)),
    inTrash: Boolean(page?.in_trash || page?.archived),
    claimNumber: typeof claimNumber === "number" ? claimNumber : null,
    title: plainText(p[PROP_TITLE]?.title),
    amount: typeof amount === "number" && Number.isFinite(amount) ? amount : null,
    currency: firstString(p[PROP_CURRENCY]?.select?.name),
    category: firstString(p[PROP_CATEGORY]?.select?.name),
    // A date-only property's start is YYYY-MM-DD; a datetime's is trimmed to it.
    expenseDate: firstString(p[PROP_EXPENSE_DATE]?.date?.start).slice(0, 10),
    merchant: plainText(p[PROP_MERCHANT]?.rich_text),
    purpose: plainText(p[PROP_PURPOSE]?.rich_text),
    status: firstString(p[PROP_STATUS]?.status?.name),
    receipts: files
      .map((f) => ({ name: firstString(f?.name), url: firstString(f?.file?.url, f?.external?.url) }))
      .filter((r) => r.url),
    existingBillUrl: firstString(p[PROP_XERO_BILL]?.url),
    createdById: firstString(page?.created_by?.id),
  };
}

/** Everything a bill needs that the claim lacks, as human-readable reasons. */
function missingFields(c: Claim): string[] {
  const missing: string[] = [];
  if (c.claimNumber === null) missing.push(`${PROP_CLAIM_ID} is empty`);
  if (c.amount === null) missing.push(`${PROP_AMOUNT} is empty`);
  else if (c.amount <= 0) missing.push(`${PROP_AMOUNT} must be positive (got ${c.amount})`);
  if (!c.currency) missing.push(`${PROP_CURRENCY} is empty`);
  else if (!/^[A-Z]{3}$/.test(c.currency)) missing.push(`${PROP_CURRENCY} "${c.currency}" is not an ISO currency code`);
  if (!c.category) missing.push(`${PROP_CATEGORY} is empty`);
  else if (!CATEGORY_ACCOUNTS[c.category]) {
    missing.push(`${PROP_CATEGORY} "${c.category}" has no Xero account in CATEGORY_ACCOUNTS`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.expenseDate)) missing.push(`${PROP_EXPENSE_DATE} is empty`);
  if (!c.createdById) missing.push("the claimant (Created by) could not be read");
  return missing;
}

// Calendar arithmetic in integers: the durable runtime's determinism guard
// rejects `new Date(...)` in the workflow body even with a fixed argument.
// Hinnant's civil-from-days pair, as in drive-invoice-to-xero.

/** Days since the Unix epoch for a `YYYY-MM-DD` triple. */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** `YYYY-MM-DD` from epoch milliseconds. */
function isoDateFromEpochMs(ms: number): string {
  const z = Math.floor(ms / 86400000) + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function shiftIsoDate(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return isoDateFromEpochMs((daysFromCivil(y, m, d) + days) * 86400000);
}

function dueDate(c: Claim): string {
  return shiftIsoDate(c.expenseDate, PAYMENT_TERMS_DAYS);
}

function billNumber(c: Claim): string {
  return `${BILL_NUMBER_PREFIX}${c.claimNumber}`;
}

/** One line: the claim, then the merchant and purpose when given. */
function lineDescription(c: Claim): string {
  const head = c.title || c.category;
  const parts = [c.merchant ? `${head} — ${c.merchant}` : head];
  if (c.purpose) parts.push(c.purpose);
  parts.push(`Expense claim ${billNumber(c)}`);
  return parts.join("\n");
}

/**
 * Tax handling: see HOME_CURRENCY. `amountTypes` is the bill's
 * `LineAmountTypes` and MUST be sent as the TOP-LEVEL `line_items_type` input.
 * `new_bill` lists that key only inside the line-items fieldset, but silently
 * ignores it there: EXP-2 (USD, sent per-line `NoTax`) came back `Exclusive` at
 * the account's INPUTY24 and Xero added 4.50 of GST to a 50.00 claim. Probed
 * 2026-10-07 with throwaway drafts: per-line `Inclusive` → Exclusive, total
 * 118.81 on 109; top-level `Inclusive` → Inclusive, total 109.00.
 *
 * `taxType` is the line's explicit tax rate. Omitted for the home currency, so
 * the account's default rate applies; `NONE` otherwise, so no tax is added even
 * if `LineAmountTypes` were ever dropped again.
 */
function taxMode(c: Claim): { amountTypes: "Inclusive" | "NoTax"; taxType?: string } {
  return c.currency === HOME_CURRENCY ? { amountTypes: "Inclusive" } : { amountTypes: "NoTax", taxType: "NONE" };
}

function billUrl(invoiceId: string): string {
  return `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${invoiceId}`;
}

/** First item of a runAction result ({ data: [...] } or a bare array). */
function firstResult(res: any): any {
  if (!res) return null;
  if (Array.isArray(res)) return res[0] ?? null;
  if (Array.isArray(res.data)) return res.data[0] ?? null;
  return res.data ?? res;
}

/** Body of a `_zap_raw_request` result, parsed. */
function rawBody(res: any): any {
  const body = firstResult(res)?.response?.body;
  if (typeof body !== "string") return body ?? {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

/** Active Xero contacts whose email matches, case-insensitively. Xero's
 *  `where` already filtered on the address; this re-checks it in code. */
function matchingContacts(body: any, email: string): { id: string; name: string }[] {
  const want = email.toLowerCase();
  const rows: any[] = Array.isArray(body?.Contacts) ? body.Contacts : [];
  return rows
    .filter((c) => firstString(c?.ContactStatus).toUpperCase() !== "ARCHIVED")
    .filter((c) => firstString(c?.EmailAddress).toLowerCase() === want)
    .map((c) => ({ id: firstString(c?.ContactID), name: firstString(c?.Name) }))
    .filter((c) => c.id && c.name);
}

/** Bills still on the ledger — a deleted or voided one must not block a re-create. */
function liveBills(body: any): { id: string; status: string }[] {
  const rows: any[] = Array.isArray(body?.Invoices) ? body.Invoices : [];
  return rows
    .filter((b) => !["DELETED", "VOIDED"].includes(firstString(b?.Status).toUpperCase()))
    .map((b) => ({ id: firstString(b?.InvoiceID), status: firstString(b?.Status) }))
    .filter((b) => b.id);
}

// --- Workflow -----------------------------------------------------------------

const workflow = defineDurable("expense-claim-to-xero-bill", async (ctx, rawInput) => {
  const payload = normalizeInput(rawInput);
  if (isEmptyPing(payload)) {
    console.log("skipped: empty payload");
    return { skipped: "empty-payload" };
  }
  const pageId = extractPageId(payload);

  // 1. Re-read the claim rather than trusting the webhook's copy: a hand replay
  //    passes only an id, and the guards must see the current values.
  const page = await ctx.step("read-claim", async () => {
    const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
      connection: NOTION_CONNECTION,
      headers: { "Notion-Version": NOTION_VERSION },
    });
    if (!res.ok) throw new Error(`Notion get claim ${pageId} failed (${res.status}): ${await res.text()}`);
    return res.json();
  });
  const claim = readClaim(page);

  if (claim.dataSourceId && claim.dataSourceId !== EXPENSE_CLAIMS_DATA_SOURCE) {
    throw new Error(`Page ${pageId} is not in the Expense Claims data source (parent ${claim.dataSourceId}).`);
  }
  if (claim.inTrash) {
    console.log(`skipped: claim ${pageId} is in the trash`);
    return { skipped: "claim-in-trash", pageId };
  }
  if (claim.existingBillUrl) {
    console.log(`skipped: claim ${pageId} already links a Xero bill (${claim.existingBillUrl})`);
    return { skipped: "already-billed", pageId, billUrl: claim.existingBillUrl };
  }
  if (claim.status !== APPROVED_STATUS) {
    console.log(`skipped: claim ${pageId} is "${claim.status}", not ${APPROVED_STATUS}`);
    return { skipped: "claim-not-approved", pageId, status: claim.status };
  }

  const missing = missingFields(claim);
  if (missing.length > 0) {
    throw new Error(
      `Expense claim ${claim.pageUrl || pageId} can't become a bill: ${missing.join("; ")}. ` +
        `Fix the claim in Notion, then set Status away from and back to Approved, or replay with trigger-workflow --input '{"page_id":"${pageId}"}'.`,
    );
  }
  const number = billNumber(claim);

  // 2. The claimant's email is the join key to Xero. Notion's display name is
  //    often a first name only, so it is never used to match.
  const user = await ctx.step("read-claimant", async () => {
    const res = await sdk.fetch(`${NOTION_API}/users/${claim.createdById}`, {
      connection: NOTION_CONNECTION,
      headers: { "Notion-Version": NOTION_VERSION },
    });
    if (!res.ok) throw new Error(`Notion get user ${claim.createdById} failed (${res.status}): ${await res.text()}`);
    return res.json();
  });
  const email = firstString((user as any)?.person?.email);
  if (!email || /["\\]/.test(email)) {
    throw new Error(
      `Claim ${number}: the claimant (Notion user ${claim.createdById}, ` +
        `"${firstString((user as any)?.name)}") has no usable email, so no Xero contact can be found.`,
    );
  }

  // 3. Find the claimant's Xero contact by email. No match fails the run on
  //    purpose: creating a contact from a Notion display name ("Dennis") would
  //    put a stray payee in the books.
  const contactsResponse = await ctx.step("find-xero-contact", async () =>
    sdk.runAction({
      appKey: XERO_APP_KEY,
      actionType: "write",
      actionKey: "_zap_raw_request",
      connection: XERO_CONNECTION,
      inputs: {
        method: "GET",
        url: `${XERO_API}/Contacts`,
        fail_on_errors: true,
        headers: { "Xero-Tenant-Id": XERO_ORGANIZATION, Accept: "application/json" },
        querystring: { summaryOnly: "true", where: `EmailAddress=="${email}"` },
      },
    }),
  );
  const contacts = matchingContacts(rawBody(contactsResponse), email);
  if (contacts.length === 0) {
    throw new Error(
      `Claim ${number}: no active Xero contact has the email ${email}. ` +
        `Add it to the claimant's contact in Xero, then ` +
        `set Status away from and back to Approved, or replay with trigger-workflow --input '{"page_id":"${pageId}"}'.`,
    );
  }
  if (contacts.length > 1) {
    throw new Error(
      `Claim ${number}: ${contacts.length} Xero contacts share the email ${email} ` +
        `(${contacts.map((c) => c.name).join(", ")}). Archive or re-address the duplicates, then replay.`,
    );
  }
  const contact = contacts[0];

  // 4. A replay after a run that created the bill but died before the
  //    write-back must not raise a second bill. Bill numbers are EXP-<Claim ID>.
  const existingResponse = await ctx.step("find-existing-bill", async () =>
    sdk.runAction({
      appKey: XERO_APP_KEY,
      actionType: "write",
      actionKey: "_zap_raw_request",
      connection: XERO_CONNECTION,
      inputs: {
        method: "GET",
        url: `${XERO_API}/Invoices`,
        fail_on_errors: true,
        headers: { "Xero-Tenant-Id": XERO_ORGANIZATION, Accept: "application/json" },
        querystring: { where: `Type=="ACCPAY" AND InvoiceNumber=="${number}"` },
      },
    }),
  );
  const existing = liveBills(rawBody(existingResponse));

  let invoiceId: string;
  let outcome: string;
  if (existing.length > 0) {
    invoiceId = existing[0].id;
    outcome = "existing-bill-linked";
    console.log(`Xero already has bill ${number} (${existing[0].status}); linking it instead of creating another`);
  } else {
    // 5. Raise the draft bill. The receipt goes on as an attachment; Notion's
    //    signed file URL is good for an hour, far longer than this run needs.
    const accountCode = CATEGORY_ACCOUNTS[claim.category];
    const receipt = claim.receipts[0];
    const tax = taxMode(claim);
    const bill = await ctx.step("create-xero-bill", async () => {
      try {
        const result = await sdk.runAction({
          appKey: XERO_APP_KEY,
          actionType: "write",
          actionKey: "new_bill",
          connection: XERO_CONNECTION,
          inputs: {
            organization: XERO_ORGANIZATION,
            // The RESOLVED contact's name — `new_bill` binds by name, so this
            // is what lands the bill on the existing contact.
            contact_name: contact.name,
            status: BILL_STATUS,
            date: claim.expenseDate,
            due_date: dueDate(claim),
            currency: claim.currency,
            number,
            url: claim.pageUrl,
            // Top level — see taxMode for why the per-line key is not enough.
            line_items_type: tax.amountTypes,
            ...(receipt ? { attachment: receipt.url } : {}),
            line_items: [
              {
                line_description: lineDescription(claim),
                line_quantity: 1,
                line_unit_amount: claim.amount,
                line_account_code: accountCode,
                line_items_type: tax.amountTypes,
                ...(tax.taxType ? { line_tax_type: tax.taxType } : {}),
              },
            ],
          },
        });
        return { ok: true as const, result };
      } catch (err) {
        // Deterministic: the same payload fails identically on every retry, so
        // letting it throw would burn every attempt and lose Xero's message.
        const message = String((err as Error)?.message ?? err);
        if (UNSUBSCRIBED_CURRENCY.test(message)) return { ok: false as const, message };
        throw err;
      }
    });
    if (!bill.ok) {
      throw new Error(
        `Claim ${number}: Xero is not subscribed to ${claim.currency}, so this claim can't become a bill. ` +
          `Add the currency in Xero (or re-enter the claim in a held currency) and replay. (Xero: ${bill.message})`,
      );
    }
    const created = firstResult(bill.result);
    invoiceId = firstString(created?.InvoiceID, created?.invoice_id, created?.id);
    if (!invoiceId) {
      // The bill exists; a replay finds it by number and links it.
      throw new Error(
        `Claim ${number}: Xero created the bill but returned no InvoiceID to link. ` +
          `To link it by number, set Status away from and back to Approved, or replay with trigger-workflow --input '{"page_id":"${pageId}"}'.`,
      );
    }
    outcome = "draft-bill-created";
    if (claim.receipts.length > 1) {
      console.log(
        `WARNING: claim ${number} has ${claim.receipts.length} receipts; only "${claim.receipts[0].name}" was attached to the bill`,
      );
    }
    console.log(
      `created draft bill ${number} for ${contact.name}: ${claim.currency} ${claim.amount} ` +
        `→ account ${accountCode} (${claim.category})${receipt ? "" : ", no receipt attached"}`,
    );
  }

  // 6. Record the bill for the paid check, BEFORE the Notion write: once the
  //    claim carries a bill link, a replay skips at the guard above and would
  //    never reach this step. Find-or-create, so a step retry is harmless.
  const tableRow = await ctx.step("record-claim-bill", async () => {
    const hit = await sdk.listTableRecords({
      table: CLAIM_BILLS_TABLE,
      keyMode: "names",
      filters: [{ fieldKey: TABLE_KEY_FIELD, operator: "exact", value: invoiceId }],
      pageSize: 10,
    });
    const found = (hit?.data ?? [])[0];
    if (found) return { id: String(found.id), created: false };
    const created = await sdk.createTableRecords({
      table: CLAIM_BILLS_TABLE,
      keyMode: "names",
      records: [
        {
          data: {
            [TABLE_KEY_FIELD]: invoiceId,
            notion_page_id: pageId,
            bill_number: number,
            state: "pending",
            paid_at: "",
          },
        },
      ],
    });
    return { id: String((created as any)?.data?.[0]?.id ?? ""), created: true };
  });

  // 7. Link the bill from the claim and move it to Payment Pending. Both are
  //    plain property sets, so replaying the PATCH lands in the same state.
  const url = billUrl(invoiceId);
  await ctx.step("write-back-bill-link", async () => {
    const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
      connection: NOTION_CONNECTION,
      method: "PATCH",
      headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify({
        properties: {
          [PROP_XERO_BILL]: { url },
          [PROP_STATUS]: { status: { name: STATUS_PAYMENT_PENDING } },
        },
      }),
    });
    if (!res.ok) throw new Error(`Notion write-back to claim ${pageId} failed (${res.status}): ${await res.text()}`);
    return { ok: true };
  });

  return {
    outcome,
    pageId,
    billNumber: number,
    invoiceId,
    billUrl: url,
    dueDate: dueDate(claim),
    tableRow,
    contact: contact.name,
    accountCode: CATEGORY_ACCOUNTS[claim.category],
    currency: claim.currency,
    amount: claim.amount,
    receiptAttached: outcome === "draft-bill-created" ? claim.receipts.length > 0 : null,
  };
});

export default workflow;
