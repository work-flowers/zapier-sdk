// Offline assertions over the real helpers in workflow.ts — no Zapier calls, no
// credentials. Run with `npm test` from this directory (Node >= 23, which strips
// TypeScript types natively).
//
// workflow.ts can't be imported directly (createZapierSdk() and defineDurable()
// run at module load), so this harness stubs those two imports, appends a test
// export, writes a temporary .ts copy and imports it.
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const dir = dirname(fileURLToPath(import.meta.url));
let src = readFileSync(join(dir, "workflow.ts"), "utf8");
src = src
  .replace(
    'import { defineDurable } from "@zapier/zapier-durable";',
    "const defineDurable = (name: string, fn: unknown) => ({ name, fn });",
  )
  .replace('import { createZapierSdk } from "@zapier/zapier-sdk";', "const createZapierSdk = () => ({});");
if (src.includes("@zapier/")) throw new Error("unstubbed @zapier import left in source");
src +=
  "\nexport const __test = { normalizeInput, isEmptyPing, extractPageId, readClaim, missingFields, billNumber, lineDescription, lineTax, matchingContacts, liveBills, billUrl, CATEGORY_ACCOUNTS };\n";
const tmp = join(dir, ".workflow.test-copy.ts");
writeFileSync(tmp, src);
let t;
try {
  t = (await import(pathToFileURL(tmp).href)).__test;
} finally {
  unlinkSync(tmp);
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

const DS = "4c0a9038-54fc-4643-a63b-df4e52139219";

/** A page as Notion's API returns it, trimmed to what the workflow reads. */
function page(overrides = {}) {
  const props = {
    "Claim description": { title: [{ plain_text: "Printer paper" }] },
    "Claim ID": { unique_id: { prefix: null, number: 7 } },
    Amount: { number: 25 },
    Currency: { select: { name: "SGD" } },
    Category: { select: { name: "Office supplies" } },
    "Expense date": { date: { start: "2026-10-01", end: null } },
    "Merchant / supplier": { rich_text: [{ plain_text: "Popular" }] },
    "Business purpose": { rich_text: [{ plain_text: "Client workshop handouts" }] },
    Receipt: {
      files: [{ name: "receipt.jpg", type: "file", file: { url: "https://s3.example/receipt.jpg?sig=1" } }],
    },
    Status: { status: { name: "Submitted" } },
    "Xero bill": { url: null },
    ...(overrides.properties ?? {}),
  };
  return {
    id: "1b2c3d4e5f60718293a4b5c6d7e8f901",
    url: "https://www.notion.so/Printer-paper-1b2c3d4e5f60718293a4b5c6d7e8f901",
    parent: { type: "data_source_id", data_source_id: DS },
    created_by: { object: "user", id: "121d872b-594c-810b-ba5a-000206eeef1e" },
    in_trash: false,
    ...overrides.page,
    properties: props,
  };
}

test("empty pings skip; content never does", () => {
  for (const v of [{}, null, "", { querystring: {} }, { body: "", headers: {} }]) {
    assert.equal(t.isEmptyPing(t.normalizeInput(v)), true, JSON.stringify(v));
  }
  for (const v of [{ unrelated: 1 }, { data: {} }, { data: { id: "" } }, { body: { id: "x" } }]) {
    assert.equal(t.isEmptyPing(t.normalizeInput(v)), false, JSON.stringify(v));
  }
});

test("page id extraction: Notion automation webhook, replay shapes, double-encoded input", () => {
  const want = "1b2c3d4e-5f60-7182-93a4-b5c6d7e8f901";
  const automation = {
    source: { type: "automation", automation_id: "a1", action_id: "b2", event_id: "c3", attempt: 1 },
    data: page(),
  };
  assert.equal(t.isEmptyPing(automation), false);
  assert.equal(t.extractPageId(automation), want);
  assert.equal(t.extractPageId(t.normalizeInput(JSON.stringify(automation))), want);
  assert.equal(t.extractPageId(page()), want);
  assert.equal(t.extractPageId({ page_id: want }), want);
  assert.equal(t.extractPageId({ data: { id: "1b2c3d4e5f60718293a4b5c6d7e8f901" } }), want);
  assert.equal(t.extractPageId(t.normalizeInput(JSON.stringify(JSON.stringify({ id: want })))), want);
});

test("unrecognised non-empty payloads throw rather than skip", () => {
  for (const v of [{ unrelated: 1 }, { data: {} }, { data: { id: "" } }, "not-an-id"]) {
    assert.throws(() => t.extractPageId(v), /Could not find a Notion page id/, JSON.stringify(v));
  }
});

test("readClaim reads every property the bill needs", () => {
  const c = t.readClaim(page());
  assert.equal(c.pageId, "1b2c3d4e-5f60-7182-93a4-b5c6d7e8f901");
  assert.equal(c.dataSourceId, DS);
  assert.equal(c.claimNumber, 7);
  assert.equal(c.amount, 25);
  assert.equal(c.currency, "SGD");
  assert.equal(c.category, "Office supplies");
  assert.equal(c.expenseDate, "2026-10-01");
  assert.equal(c.receipts.length, 1);
  assert.equal(c.existingBillUrl, "");
  assert.equal(c.createdById, "121d872b-594c-810b-ba5a-000206eeef1e");
  assert.deepEqual(t.missingFields(c), []);
  assert.equal(t.billNumber(c), "EXP-7");
});

test("a blank amount stays absent and is caught, never billed at 0", () => {
  const c = t.readClaim(page({ properties: { Amount: { number: null } } }));
  assert.equal(c.amount, null);
  assert.match(t.missingFields(c).join(), /Amount is empty/);
  const zero = t.readClaim(page({ properties: { Amount: { number: 0 } } }));
  assert.match(t.missingFields(zero).join(), /must be positive/);
});

test("missing currency, category, date are all reported", () => {
  const c = t.readClaim(
    page({
      properties: {
        Currency: { select: null },
        Category: { select: { name: "Gadgets" } },
        "Expense date": { date: null },
      },
    }),
  );
  const m = t.missingFields(c).join(" | ");
  assert.match(m, /Currency is empty/);
  assert.match(m, /"Gadgets" has no Xero account/);
  assert.match(m, /Expense date is empty/);
  const other = t.readClaim(page({ properties: { Currency: { select: { name: "Other" } } } }));
  assert.match(t.missingFields(other).join(), /not an ISO currency code/);
});

test("every Notion Category option maps to an account", () => {
  const options = [
    "Travel",
    "Meals",
    "Software & subscriptions",
    "Office supplies",
    "Professional services",
    "Training & courses",
    "Events & sponsorship",
    "Memberships & publications",
    "Other",
  ];
  for (const o of options) assert.match(t.CATEGORY_ACCOUNTS[o] ?? "", /^\d{3}$/, o);
});

test("datetime expense dates are trimmed to the day", () => {
  const c = t.readClaim(page({ properties: { "Expense date": { date: { start: "2026-10-01T09:30:00.000+08:00" } } } }));
  assert.equal(c.expenseDate, "2026-10-01");
});

test("SGD is tax-inclusive at the account default; other currencies carry no tax", () => {
  assert.deepEqual(t.lineTax(t.readClaim(page())), { line_items_type: "Inclusive" });
  const usd = t.readClaim(page({ properties: { Currency: { select: { name: "USD" } } } }));
  assert.deepEqual(t.lineTax(usd), { line_items_type: "NoTax" });
});

test("line description carries merchant, purpose and claim number", () => {
  assert.equal(
    t.lineDescription(t.readClaim(page())),
    "Printer paper — Popular\nClient workshop handouts\nExpense claim EXP-7",
  );
  const bare = t.readClaim(
    page({
      properties: {
        "Claim description": { title: [] },
        "Merchant / supplier": { rich_text: [] },
        "Business purpose": { rich_text: [] },
      },
    }),
  );
  assert.equal(t.lineDescription(bare), "Office supplies\nExpense claim EXP-7");
});

test("status is read so only Approved claims are billed", () => {
  assert.equal(t.readClaim(page()).status, "Submitted");
  assert.equal(t.readClaim(page({ properties: { Status: { status: { name: "Approved" } } } })).status, "Approved");
  assert.equal(t.readClaim(page({ properties: { Status: { status: null } } })).status, "");
});

test("an existing Xero bill link or a trashed page is visible to the guards", () => {
  assert.equal(
    t.readClaim(page({ properties: { "Xero bill": { url: "https://go.xero.com/x" } } })).existingBillUrl,
    "https://go.xero.com/x",
  );
  assert.equal(t.readClaim(page({ page: { in_trash: true } })).inTrash, true);
});

test("contact match is by email, case-insensitive, ignoring archived contacts", () => {
  const body = {
    Contacts: [
      { ContactID: "a", Name: "Dennis Chiuten", EmailAddress: "Dennis@Work.Flowers", ContactStatus: "ACTIVE" },
      { ContactID: "b", Name: "Old Dennis", EmailAddress: "dennis@work.flowers", ContactStatus: "ARCHIVED" },
      { ContactID: "c", Name: "Someone Else", EmailAddress: "else@work.flowers", ContactStatus: "ACTIVE" },
    ],
  };
  assert.deepEqual(t.matchingContacts(body, "dennis@work.flowers"), [{ id: "a", name: "Dennis Chiuten" }]);
  assert.deepEqual(t.matchingContacts({}, "dennis@work.flowers"), []);
});

test("deleted and voided bills don't block a re-create", () => {
  const body = {
    Invoices: [
      { InvoiceID: "x", Status: "DELETED" },
      { InvoiceID: "y", Status: "VOIDED" },
      { InvoiceID: "z", Status: "DRAFT" },
    ],
  };
  assert.deepEqual(t.liveBills(body), [{ id: "z", status: "DRAFT" }]);
  assert.deepEqual(t.liveBills({ Invoices: [{ InvoiceID: "x", Status: "DELETED" }] }), []);
});

console.log(`\n${passed} passed`);
