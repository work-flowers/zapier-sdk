// Offline assertions over the real decide() in workflow.ts — no Zapier calls,
// no credentials. Run with `npm test` from this directory.
//
// workflow.ts can't be imported directly (createZapierSdk() and defineDurable()
// run at module load), so this harness stubs those two imports, appends a test
// export, strips the types with the local tsc, and imports the emitted JS.
import { readFileSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = dirname(fileURLToPath(import.meta.url));
let src = readFileSync(join(dir, "workflow.ts"), "utf8");

src = src
  .replace(
    'import { defineDurable } from "@zapier/zapier-durable";',
    "const defineDurable = (name: string, fn: unknown) => ({ name, fn });",
  )
  .replace(
    'import { createZapierSdk } from "@zapier/zapier-sdk";',
    "const createZapierSdk = () => ({ runAction: async (_: unknown): Promise<any> => { throw new Error('no network in tests'); } });",
  );
if (src.includes("@zapier/")) throw new Error("unstubbed @zapier import left in source");
src += "\nexport const __test = { decide, normalizeInvoiceNumber, stripUncheckpointableChars, CATEGORY_FOLDERS, FOLDER_INVOICES, FOLDER_PAID_RECEIPTS, FOLDER_SIGNED_AGREEMENTS, FOLDER_FINANCIAL_REPORTING };\n";

const tmpTs = join(dir, ".decide-under-test.ts");
const outDir = join(dir, ".decide-under-test-out");
writeFileSync(tmpTs, src);
let mod;
try {
  execFileSync(
    "npx",
    ["tsc", tmpTs, "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler",
     "--skipLibCheck", "--noCheck", "--outDir", outDir],
    { cwd: dir, stdio: "inherit" },
  );
  mod = await import(pathToFileURL(join(outDir, ".decide-under-test.js")));
} finally {
  unlinkSync(tmpTs);
  rmSync(outDir, { recursive: true, force: true });
}
const { decide, stripUncheckpointableChars, FOLDER_INVOICES, FOLDER_PAID_RECEIPTS, FOLDER_SIGNED_AGREEMENTS, FOLDER_FINANCIAL_REPORTING } =
  mod.__test;

// --- helpers -----------------------------------------------------------------
const base = {
  filename: "x.pdf",
  category: "Other",
  paymentStatus: "Not Applicable",
  supersededByReceipt: false,
  autoPaidByRecurringCharge: false,
  paymentEvidence: "",
  invoiceNumber: "",
  invoiceDate: "",
  dueDate: "",
  amount: "",
  currency: "",
  vendor: "",
  justification: "",
};
const c = (over) => ({ ...base, ...over });
const invoice = (over) => c({ category: "Invoice", paymentStatus: "Unpaid", ...over });
const receipt = (over) => c({ category: "Receipt", paymentStatus: "Paid", ...over });

let failures = 0;
let count = 0;
function check(name, actual, expected) {
  count++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`ok ${count} - ${name}`);
  } else {
    failures++;
    console.error(`NOT OK ${count} - ${name}\n  expected ${e}\n  got      ${a}`);
  }
}
// decide() with every attachment readable unless stated otherwise.
const run = (cls, readable) => decide(cls, readable ?? cls.map(() => true));
const brief = (d) =>
  d.action === "file" ? { action: "file", folderId: d.folderId } : { action: "skip", reason: d.reason };

// --- the classic destinations ------------------------------------------------
check("outstanding invoice alone files to Invoices (Vanta)",
  brief(run([invoice()])[0]),
  { action: "file", folderId: FOLDER_INVOICES });

check("receipt files to Paid Receipts",
  brief(run([receipt()])[0]),
  { action: "file", folderId: FOLDER_PAID_RECEIPTS });

check("legal agreement files to Signed Agreements",
  brief(run([c({ category: "Legal Agreement" })])[0]),
  { action: "file", folderId: FOLDER_SIGNED_AGREEMENTS });

check("governance document files to Signed Agreements",
  brief(run([c({ category: "Governance Document" })])[0]),
  { action: "file", folderId: FOLDER_SIGNED_AGREEMENTS });

check("financial statements file to Financial Reporting",
  brief(run([c({ category: "Financial Statements" })])[0]),
  { action: "file", folderId: FOLDER_FINANCIAL_REPORTING });

check("vendor account statement has no destination",
  run([c({ category: "Vendor Account Statement" })])[0].action,
  "skip");

check("category Other has no destination",
  run([c({ category: "Other" })])[0].action,
  "skip");

check("null classification skips",
  run([null], [true])[0].action,
  "skip");

// --- signal 1: receipt quotes the invoice number (Anthropic) -----------------
{
  const d = run([
    invoice({ invoiceNumber: "YIGHXGH9-0005" }),
    receipt({ invoiceNumber: "YIGHXGH9-0005" }),
  ]);
  check("invoice settled by number-matching receipt skips",
    d[0], { action: "skip", reason: "already paid — a receipt on this email settles invoice YIGHXGH9-0005" });
  check("the settling receipt itself files to Paid Receipts",
    brief(d[1]), { action: "file", folderId: FOLDER_PAID_RECEIPTS });
}

check("invoice-number match survives formatting differences",
  run([invoice({ invoiceNumber: "yighxgh9 0005" }), receipt({ invoiceNumber: "YIGHXGH9-0005" })])[0].action,
  "skip");

check("short invoice numbers (<4 chars) never match by number — falls to signal 5",
  run([invoice({ invoiceNumber: "1-2" }), receipt({ invoiceNumber: "12" })])[0],
  { action: "skip", reason: "already paid — this email also carries a paid receipt" });

check("short invoice numbers (<4 chars) never match by number — files when signal 5 can't fire",
  brief(run([invoice({ invoiceNumber: "1-2" }), receipt({ invoiceNumber: "12", paymentStatus: "Unpaid" })])[0]),
  { action: "file", folderId: FOLDER_INVOICES });

// --- signal 2: superseded-by-receipt, gated on a receipt being present -------
check("supersededByReceipt with a sibling receipt skips",
  run([invoice({ supersededByReceipt: true }), receipt()])[0],
  { action: "skip", reason: "already paid — classifier matched a receipt on this email to this invoice" });

check("supersededByReceipt WITHOUT a receipt is ignored (SimplePay guard)",
  brief(run([invoice({ supersededByReceipt: true }), c({ category: "Vendor Account Statement" })])[0]),
  { action: "file", folderId: FOLDER_INVOICES });

// --- paid invoices are the receipt when no receipt exists --------------------
check("paid invoice with no sibling receipt files to Paid Receipts (Aspire)",
  run([invoice({ paymentStatus: "Paid" })])[0],
  {
    action: "file",
    folderId: FOLDER_PAID_RECEIPTS,
    folderName: "Paid Receipts",
    reason:
      "paid invoice — payment markers on the invoice itself; no receipt on this email, so the invoice is the record of payment",
  });

check("auto-paid invoice with statement, no receipt, files to Paid Receipts (SimplePay)",
  run([
    invoice({ autoPaidByRecurringCharge: true, paymentStatus: "Paid" }),
    c({ category: "Vendor Account Statement" }),
  ])[0],
  {
    action: "file",
    folderId: FOLDER_PAID_RECEIPTS,
    folderName: "Paid Receipts",
    reason:
      "paid invoice — the account statement on this email shows this vendor's invoices auto-cleared by same-day card payments; no receipt on this email, so the invoice is the record of payment",
  });

check("auto-paid claim WITHOUT a statement attached is ignored",
  brief(run([invoice({ autoPaidByRecurringCharge: true })])[0]),
  { action: "file", folderId: FOLDER_INVOICES });

check("paid invoice with a sibling receipt skips — the receipt is the record",
  run([invoice({ paymentStatus: "Paid" }), receipt()])[0],
  {
    action: "skip",
    reason:
      "already paid — payment markers on the invoice itself; the receipt on this email is the filed record",
  });

// --- signal 5: any settling receipt, weakest, last ----------------------------
check("unpaid-looking invoice with an unmatched settling receipt skips",
  run([invoice(), receipt({ invoiceNumber: "OTHER-9999" })])[0],
  { action: "skip", reason: "already paid — this email also carries a paid receipt" });

check("a receipt itself flagged Unpaid does not settle by signal 5",
  brief(run([invoice(), receipt({ paymentStatus: "Unpaid" })])[0]),
  { action: "file", folderId: FOLDER_INVOICES });

// --- unreadable attachments ---------------------------------------------------
check("unreadable attachment never files, whatever it classifies as",
  run([receipt()], [false])[0],
  { action: "skip", reason: "no text could be extracted — not filed on filename and email evidence alone" });

check("unreadable PAID invoice also never files to Paid Receipts",
  run([invoice({ paymentStatus: "Paid" })], [false])[0].action,
  "skip");

check("an unreadable 'Receipt' cannot suppress a readable outstanding invoice",
  brief(run([invoice({ invoiceNumber: "ABCD-1" }), receipt({ invoiceNumber: "ABCD-1" })], [true, false])[0]),
  { action: "file", folderId: FOLDER_INVOICES });

check("an unreadable sibling receipt does not turn a paid invoice into a skip",
  brief(run([invoice({ paymentStatus: "Paid" }), receipt()], [true, false])[0]),
  { action: "file", folderId: FOLDER_PAID_RECEIPTS });

// --- checkpoint hygiene: stripUncheckpointableChars ---------------------------
// The char-code implementation must behave exactly like the regex pair it
// replaced: drop NUL and other C0 controls (keep tab/newline/CR) and drop lone
// surrogates while preserving valid surrogate pairs.
check("strip removes NUL and C0 controls, keeps tab/newline/CR",
  stripUncheckpointableChars("a" + String.fromCharCode(0) + "b" + String.fromCharCode(7) + "c\td\ne\rf" + String.fromCharCode(31) + "g"),
  "abc\td\ne\rfg");

check("strip keeps ordinary text and non-ASCII untouched",
  stripUncheckpointableChars("Rechnung über 133,58 € — bezahlt ✅"),
  "Rechnung über 133,58 € — bezahlt ✅");

check("strip drops a lone high surrogate but keeps a valid pair",
  stripUncheckpointableChars("x" + String.fromCharCode(55357) + "y" + String.fromCharCode(55357) + String.fromCharCode(56842) + "z"),
  "xy" + String.fromCharCode(55357) + String.fromCharCode(56842) + "z");

check("strip drops a lone low surrogate",
  stripUncheckpointableChars("x" + String.fromCharCode(56842) + "y"),
  "xy");

// -------------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n${failures}/${count} assertions FAILED`);
  process.exit(1);
}
console.log(`\nall ${count} assertions passed`);
