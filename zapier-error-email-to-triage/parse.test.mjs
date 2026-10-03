// Offline assertions over the real parsing helpers in workflow.ts — no Zapier
// calls, no credentials. Run with `npm test` from this directory (Node >= 23,
// which strips TypeScript types natively).
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
  .replace(
    'import { createZapierSdk } from "@zapier/zapier-sdk";',
    "const createZapierSdk = () => ({ fetch: async (..._: unknown[]): Promise<any> => { throw new Error('no network in tests'); } });",
  );
if (src.includes("@zapier/")) throw new Error("unstubbed @zapier import left in source");
src += "\nexport const __test = { extractAlert, signatureFor, ticketTitle, isEmptyPing, normalizeInput, normaliseMessage };\n";

const tmp = join(dir, ".parse-under-test.ts");
writeFileSync(tmp, src);
let t;
try {
  ({ __test: t } = await import(pathToFileURL(tmp).href));
} finally {
  unlinkSync(tmp);
}

const fixture = (name) => JSON.parse(readFileSync(join(dir, "fixtures", name), "utf8"));
let passed = 0;
const check = (label, fn) => {
  fn();
  passed++;
  console.log(`ok  ${label}`);
};

check("code-error alert parses", () => {
  const { alert } = t.extractAlert(fixture("had-an-error.json"));
  assert.equal(alert.kind, "error");
  assert.equal(alert.zapName, "slack-thread-to-notion-discussion");
  assert.equal(alert.workflowId, "01a05bff-37b5-7b12-b5aa-3bbafe623e84");
  assert.equal(alert.message, "SyntaxError: Expected ',', got '}'");
  assert.equal(
    t.signatureFor(alert),
    "01a05bff-37b5-7b12-b5aa-3bbafe623e84 · Zap error · SyntaxError: Expected ',', got '}'",
  );
});

check("couldn't-run alert parses, hard-wrapped message re-joined", () => {
  const { alert } = t.extractAlert(fixture("couldnt-run.json"));
  assert.equal(alert.kind, "couldnt_run");
  assert.equal(alert.zapName, "gcal-event-updated-to-meeting-note");
  assert.equal(alert.workflowId, "019fb770-139b-74ca-bf9b-fec7ea0c9c3b");
  assert.equal(
    alert.message,
    "We couldn't confirm the outcome of your Zap run -- this is a Zapier-side issue, not a problem with your code.",
  );
  assert.ok(t.ticketTitle(alert).startsWith("gcal-event-updated-to-meeting-note · We couldn't"));
});

check("double-encoded payload is unwrapped", () => {
  const raw = JSON.stringify(JSON.stringify(fixture("had-an-error.json")));
  const { alert } = t.extractAlert(t.normalizeInput(raw));
  assert.equal(alert.workflowId, "01a05bff-37b5-7b12-b5aa-3bbafe623e84");
});

check("same fault with a different id or timestamp shares a signature", () => {
  const base = fixture("had-an-error.json");
  const a = structuredClone(base);
  const b = structuredClone(base);
  a.body_plain = a.body_plain.replace(
    "SyntaxError: Expected ',', got '}'",
    "Page 2f1e0c3a-1111-4222-8333-944445555666 failed at 2026-09-30T04:34:54Z",
  );
  b.body_plain = b.body_plain.replace(
    "SyntaxError: Expected ',', got '}'",
    "Page 9a8b7c6d-1111-4222-8333-944445555666 failed at 2026-10-01T11:00:00Z",
  );
  assert.equal(t.signatureFor(t.extractAlert(a).alert), t.signatureFor(t.extractAlert(b).alert));
});

check("other mail from another sender is skipped, not thrown", () => {
  const r = t.extractAlert({ subject: "Your Zap \"x\" had an error", from: { email: "someone@example.com" }, body_plain: "hi" });
  assert.ok("skip" in r);
  const r2 = t.extractAlert({ subject: "What's New: 39 updated integrations", from: { email: "notifications@mail.zapier.com" }, body_plain: "hi" });
  assert.ok("skip" in r2);
});

check("an alert whose body no longer parses THROWS (template drift must surface)", () => {
  const f = fixture("had-an-error.json");
  f.body_plain = "Something completely different";
  assert.throws(() => t.extractAlert(f), /did not parse/);
});

check("an unrelated object with no subject or sender throws", () => {
  assert.throws(() => t.extractAlert({ foo: "bar" }), /Unrecognised payload/);
});

check("empty-ping shapes are recognised; content is not", () => {
  for (const v of [{}, null, "", { querystring: {} }, undefined]) assert.equal(t.isEmptyPing(v), true, JSON.stringify(v));
  for (const v of [{ data: {} }, { data: { id: "" } }, { foo: "bar" }, { querystring: { a: 1 } }]) {
    assert.equal(t.isEmptyPing(v), false, JSON.stringify(v));
  }
});

console.log(`\n${passed} checks passed`);
