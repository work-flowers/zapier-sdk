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
  )
  .replace(
    /import \{\n  createZapierSdk as createExperimentalSdk,\n  createZapierApi,\n  ZAPIER_BASE_URL,\n\} from "@zapier\/zapier-sdk\/experimental";/,
    "const createExperimentalSdk = () => ({}); const createZapierApi = (_: unknown) => ({}); const ZAPIER_BASE_URL = '';",
  );
if (src.includes("@zapier/")) throw new Error("unstubbed @zapier import left in source");
src += "\nexport const __test = { extractAlert, signatureOf, titleOf, failureFromAlert, failureFromRun, pickRun, failingOperation, isEmptyPing, normalizeInput, normaliseMessage };\n";

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
    t.signatureOf(alert.workflowId, t.failureFromAlert(alert)),
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
  assert.ok(t.titleOf(alert.zapName, t.failureFromAlert(alert)).startsWith("gcal-event-updated-to-meeting-note · Couldn't run: We couldn't"));
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
  const sig = (f) => { const { alert } = t.extractAlert(f); return t.signatureOf(alert.workflowId, t.failureFromAlert(alert)); };
  assert.equal(sig(a), sig(b));
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

// --- Run-based failures: parity with the worker's errorsDelta tickets --------
// Real run rows of slack-thread-to-notion-discussion, as the runs API returned
// them on 2026-10-03 (trimmed). ZAP-57 and ZAP-54 are the worker's tickets for
// these two failures; a recurrence must land on them, so signature and title
// must match the worker's byte for byte.
const WF = "01a05bff-37b5-7b12-b5aa-3bbafe623e84";
const syntaxRun = {
  id: "01a0f097-f9a2-76c3-b4f3-9484db5bef6c", kind: "live", status: "failed",
  durable_run_id: "01a0f097-fb43-7ca9-88d4-2404dd3c3fdd",
  created_at: "2026-09-30T04:34:46.813Z", updated_at: "2026-09-30T04:34:52.598Z",
  error: { code: "execution_failed", message: "SyntaxError: Expected ',', got '}'" },
};
const exhaustedRun = {
  id: "01a0e78d-c08f-7de4-8d35-3acdfb3b0fad", kind: "live", status: "failed",
  durable_run_id: "01a0e78d-c1c1-7a65-99b7-73cc2ff0ac20",
  created_at: "2026-09-28T10:27:01.896Z", updated_at: "2026-09-28T10:30:15.393Z",
  error: { code: "execution_failed", details: { name: "StepExhaustedError", message: 'Step "check-page-access" exhausted all retry attempts.' } },
};

check("run-based signature matches the worker's ticket ZAP-57", () => {
  const f = t.failureFromRun(syntaxRun);
  assert.equal(t.signatureOf(WF, f), `${WF} · execution_failed · SyntaxError: Expected ',', got '}'`);
  assert.equal(t.titleOf("slack-thread-to-notion-discussion", f), "slack-thread-to-notion-discussion · execution_failed: SyntaxError: Expected ',', got '}'");
});

check("run-based signature and step title match the worker's ticket ZAP-54", () => {
  const f = t.failureFromRun(exhaustedRun);
  assert.equal(t.signatureOf(WF, f), `${WF} · StepExhaustedError · Step "check-page-access" exhausted all retry attempts.`);
  f.failingStep = "check-page-access";
  assert.equal(t.titleOf("slack-thread-to-notion-discussion", f), "slack-thread-to-notion-discussion · StepExhaustedError in check-page-access");
});

check("pickRun matches the run that finished just before the email", () => {
  const ok = { id: "x", status: "finished", kind: "live", created_at: "2026-09-30T04:34:50Z", updated_at: "2026-09-30T04:34:53Z" };
  const draft = { ...syntaxRun, id: "draft", kind: "draft", updated_at: "2026-09-30T04:34:53.000Z" };
  const older = { ...exhaustedRun };
  const runs = [ok, draft, syntaxRun, older];
  assert.equal(t.pickRun(runs, Date.parse("2026-09-30T04:34:54Z"))?.id, syntaxRun.id);
  assert.equal(t.pickRun(runs, Date.parse("2026-09-28T10:30:17Z"))?.id, exhaustedRun.id);
  assert.equal(t.pickRun(runs, Date.parse("2026-10-01T00:00:00Z")), null, "nothing in the window");
});

check("failingOperation takes the last non-completed operation", () => {
  const ops = [
    { name: "find-thread-map", status: "completed" },
    { name: "flaky", status: "failed", error: { name: "Error", message: "first try" } },
    { name: "check-page-access", status: "exhausted", error: { name: "Error", message: "Notion page lookup failed (400)" } },
  ];
  assert.deepEqual(t.failingOperation(ops), { step: "check-page-access", cause: "Error: Notion page lookup failed (400)" });
  assert.deepEqual(t.failingOperation([]), { step: null, cause: null });
});

console.log(`\n${passed} checks passed`);
