// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/multi-wavy-whatsapp-forwarder
//
// Run: node --test multi-wavy-whatsapp-forwarder/durable.test.ts   (Node >= 22.18)
//
// Covers the two Multi-Wavy WhatsApp durables (multi-wavy-whatsapp-branch-a / -b)
// through their shared forwarder-core.ts: payload shapes, the mapping to the app's
// body (replayed against the handler-contract mirror), the live-connection refusal,
// retry classification, and that the committed workflow.ts / zap.json / core copies
// agree with each other. Nothing here touches Zapier or the app.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkHandlerContract } from "./forward.ts";
import {
  FORWARD_URL,
  LIVE_CONNECTION_ID,
  LIVE_DISPLAY_DIGITS,
  assertBranchSafe,
  classifyAttempt,
  isEmptyPing,
  outcomeFromError,
  prepareForward,
  type Branch,
} from "./forwarder-core.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const json = (rel: string) => JSON.parse(read(rel));

const A: Branch = { label: "Branch A", connectionId: "0219aff1-73d3-866c-98a1-3f6cff9b4bf9", displayDigits: "19297622048" };
const B: Branch = { label: "Branch B", connectionId: "025a64f5-1887-8d0a-8f36-f08c0183487b", displayDigits: "17119218808" };

const PNID = "100000000000001";
const msg = {
  id: "wamid.HBgLMTY1MDU1NTAxMDAVAgASGBQzQTAxAAA=",
  from: "16505550100",
  text__body: "Hello Branch A",
  type: "text",
  timestamp: "1760706000",
  phone_number_id: PNID,
  display_phone_number: "19297622048",
};

function forward(branch: Branch, payload: unknown) {
  const p = prepareForward(branch, payload);
  assert.equal(p.action, "forward");
  if (p.action !== "forward") throw new Error("unreachable");
  return { body: p.body, contract: checkHandlerContract(JSON.stringify(p.body)) };
}

// ---- mapping (payload shapes that must forward) --------------------------------

test("flat text payload maps 1:1 and the handler contract accepts it", () => {
  const r = forward(A, msg);
  assert.deepEqual(r.body, {
    kind: "message",
    branch_label: "Branch A",
    id: msg.id,
    from: "16505550100",
    text__body: "Hello Branch A",
    type: "text",
    timestamp: "1760706000",
    phone_number_id: PNID,
    display_phone_number: "19297622048",
  });
  assert.ok(r.contract.ok);
  assert.equal(r.contract.deliveryId, `zap:message:${msg.id}`);
  assert.equal(r.contract.providerTs, "2025-10-17T13:00:00.000Z");
});

test("nested text.body (what the durable runtime delivers) flattens to text__body", () => {
  const { text__body: _drop, ...rest } = msg;
  const r = forward(B, { ...rest, display_phone_number: "17119218808", text: { body: "Hello nested" } });
  assert.equal(r.body.text__body, "Hello nested");
  assert.equal(r.body.branch_label, "Branch B");
  assert.equal("text" in r.body, false);
  assert.ok(r.contract.ok);
});

test("media message with no text forwards with an empty text__body", () => {
  const { text__body: _drop, ...rest } = msg;
  const r = forward(A, { ...rest, type: "image", image: { id: "media-1", caption: null } });
  assert.equal(r.body.text__body, "");
  assert.equal(r.body.type, "image");
  assert.ok(r.contract.ok);
});

test("quotes, newlines, emoji and backslashes survive the JSON body", () => {
  const nasty = 'He said "hi"\nline two \\ \u{1F600}';
  const r = forward(A, { ...msg, text__body: nasty });
  assert.equal(JSON.parse(JSON.stringify(r.body)).text__body, nasty);
});

test("numeric id/from/timestamp are stringified, not dropped", () => {
  const r = forward(A, { ...msg, timestamp: 1760706000, from: 16505550100 });
  assert.equal(r.body.timestamp, "1760706000");
  assert.equal(r.body.from, "16505550100");
  assert.equal(r.contract.ok && r.contract.providerTs, "2025-10-17T13:00:00.000Z");
});

test("double-encoded JSON string input (trigger pipeline) is unwrapped", () => {
  const once = JSON.stringify(msg);
  const twice = JSON.stringify(once);
  assert.equal(forward(A, once).body.id, msg.id);
  assert.equal(forward(A, twice).body.id, msg.id);
});

test("a missing display_phone_number is tolerated (the app falls back to branch_label)", () => {
  const { display_phone_number: _drop, ...rest } = msg;
  const r = forward(A, rest);
  assert.equal(r.body.display_phone_number, "");
  assert.ok(r.contract.ok);
});

test("a formatted display number still matches the branch", () => {
  assert.equal(forward(A, { ...msg, display_phone_number: "+1 929-762-2048" }).body.id, msg.id);
});

test("unknown extra trigger fields are not forwarded (exact body keys only)", () => {
  const r = forward(A, { ...msg, contact_name: "Jane", secret: "x", context: { id: "q" } });
  assert.deepEqual(Object.keys(r.body).sort(), [
    "branch_label", "display_phone_number", "from", "id", "kind", "phone_number_id", "text__body", "timestamp", "type",
  ]);
});

// ---- empty / unrecognized payload rules ---------------------------------------

test("empty shapes skip (no raise): {}, null, undefined, \"\", wrapper-only", () => {
  for (const empty of [{}, null, undefined, "", { querystring: {} }, { headers: {}, body: "" }, "  {} ", "{}"]) {
    assert.deepEqual(prepareForward(A, empty), { action: "skip", reason: "empty-payload" }, JSON.stringify(empty));
  }
});

test("non-empty payloads with no usable id THROW and never skip silently", () => {
  const unrecognized: unknown[] = [
    { unrelated: true },
    { data: {} },
    { data: { id: "" } },
    { id: "" , from: "1" },
    { id: "   " },
    { id: null },
    { querystring: { a: "1" } },
    "not json at all",
    ["a", "b"],
    42,
  ];
  for (const bad of unrecognized) {
    assert.throws(() => prepareForward(A, bad), /unrecognized new_message payload/, JSON.stringify(bad));
  }
});

test("the unrecognized-payload error names keys, never values (message text is private)", () => {
  try {
    prepareForward(A, { text__body: "my password is hunter2", from: "16505550100" });
    assert.fail("should throw");
  } catch (e) {
    const m = String((e as Error).message);
    assert.match(m, /keys seen: from, text__body/);
    assert.equal(m.includes("hunter2"), false);
    assert.equal(m.includes("16505550100"), false);
  }
});

test("isEmptyPing boundary: a wrapper with content is content", () => {
  assert.equal(isEmptyPing({ querystring: { a: "1" } }), false);
  assert.equal(isEmptyPing({ body: "x" }), false);
  assert.equal(isEmptyPing({ id: "" }), false); // non-wrapper key present => not an empty ping
  assert.equal(isEmptyPing({ headers: null, query: "" }), true);
});

// ---- live-connection refusal ---------------------------------------------------

test("the live +65 connection id is refused, in any case", () => {
  assert.equal(LIVE_CONNECTION_ID, "0240f561-4036-869d-bd75-4f2f28101022");
  assert.throws(() => assertBranchSafe({ ...A, connectionId: LIVE_CONNECTION_ID }), /live production connection/);
  assert.throws(() => assertBranchSafe({ ...A, connectionId: LIVE_CONNECTION_ID.toUpperCase() }), /live production connection/);
  assert.throws(() => assertBranchSafe({ ...A, connectionId: ` ${LIVE_CONNECTION_ID} ` }), /live production connection/);
  // and a refused branch forwards nothing, even for a perfectly good payload
  assert.throws(() => prepareForward({ ...A, connectionId: LIVE_CONNECTION_ID }, msg), /live production connection/);
});

test("the live display number is refused as a branch number and as a payload number", () => {
  assert.equal(LIVE_DISPLAY_DIGITS, "6580839785");
  assert.throws(() => assertBranchSafe({ ...A, displayDigits: "+65 8083 9785" }), /live production display number/);
  assert.throws(() => prepareForward(A, { ...msg, display_phone_number: "6580839785" }), /live production line/);
  assert.throws(() => prepareForward(A, { ...msg, display_phone_number: "+65 8083 9785" }), /live production line/);
});

test("a payload from the OTHER branch's number is refused (wrong-label guard)", () => {
  assert.throws(() => prepareForward(A, { ...msg, display_phone_number: "17119218808" }), /not this branch's number/);
  assert.throws(() => prepareForward(B, msg), /not this branch's number/);
});

test("branch must be fully specified", () => {
  assert.throws(() => assertBranchSafe({ ...A, label: " " }), /label/);
  assert.throws(() => assertBranchSafe({ ...A, connectionId: "" }), /no explicit connection id/);
  assert.throws(() => assertBranchSafe({ ...A, displayDigits: "" }), /live production display number/);
  assertBranchSafe(A);
  assertBranchSafe(B);
});

// ---- retry classification ------------------------------------------------------

test("2xx is ok", () => {
  for (const status of [200, 201, 204]) assert.equal(classifyAttempt({ kind: "response", status }), "ok");
});

test("429, 408 and 5xx retry (replay is safe: the app dedupes on the wamid)", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(classifyAttempt({ kind: "response", status }), "retry", String(status));
});

test("genuine rejections never retry: 400, 401, 403, 404, 413, 3xx", () => {
  for (const status of [301, 302, 400, 401, 403, 404, 413, 422]) assert.equal(classifyAttempt({ kind: "response", status }), "reject", String(status));
});

test("thrown errors: network/relay hiccups retry, permanent ones reject", () => {
  assert.equal(classifyAttempt(outcomeFromError(new Error("fetch failed"))), "retry");
  assert.equal(classifyAttempt(outcomeFromError(Object.assign(new Error("relay"), { code: "ZAPIER_RELAY_ERROR", statusCode: 502 }))), "retry");
  assert.equal(classifyAttempt(outcomeFromError(Object.assign(new Error("relay"), { code: "ZAPIER_RELAY_ERROR", retryable: true }))), "retry");
  assert.equal(classifyAttempt(outcomeFromError(Object.assign(new Error("relay"), { code: "ZAPIER_RELAY_ERROR", retryable: false }))), "reject");
  // e.g. the sandbox allowlist refusing the host: a 403 from the relay is not going to clear
  assert.equal(classifyAttempt(outcomeFromError(Object.assign(new Error("blocked"), { code: "ZAPIER_RELAY_ERROR", statusCode: 403 }))), "reject");
  assert.equal(classifyAttempt(outcomeFromError(Object.assign(new Error("bad init"), { code: "ZAPIER_VALIDATION_ERROR" }))), "reject");
  assert.equal(classifyAttempt(outcomeFromError(Object.assign(new Error("429"), { statusCode: 429 }))), "retry");
  assert.equal(classifyAttempt(outcomeFromError(null)), "retry");
});

// ---- committed files agree -----------------------------------------------------

const DIRS = [
  { dir: "../multi-wavy-whatsapp-branch-a", branch: A, alias: "whatsapp_branch_a" },
  { dir: "../multi-wavy-whatsapp-branch-b", branch: B, alias: "whatsapp_branch_b" },
];

test("each branch dir carries a byte-identical copy of forwarder-core.ts", () => {
  const canonical = read("./forwarder-core.ts");
  for (const { dir } of DIRS) assert.equal(read(`${dir}/forwarder-core.ts`), canonical, `${dir}/forwarder-core.ts drifted`);
});

test("workflow.ts constants match the branch, and zap.json agrees with them", () => {
  for (const { dir, branch, alias } of DIRS) {
    const src = read(`${dir}/workflow.ts`);
    assert.ok(src.includes(`label: "${branch.label}"`), `${dir} label`);
    assert.ok(src.includes(`connectionId: "${branch.connectionId}"`), `${dir} connection`);
    assert.ok(src.includes(`displayDigits: "${branch.displayDigits}"`), `${dir} number`);
    assert.ok(src.includes(`defineDurable("${dir.split("/").pop()}"`), `${dir} literal durable name`);
    assert.ok(src.startsWith(`// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/${dir.split("/").pop()}`));
    assert.equal(src.includes(LIVE_CONNECTION_ID), false, `${dir} workflow.ts must not mention the live id`);
    assert.equal(/x-webhook-secret/i.test(src.replace(/^\/\/.*$/gm, "")), false, `${dir} must send no secret header`);
    assert.ok(src.includes('from "./forwarder-core.ts"'), "multi-file import needs the explicit .ts specifier");
    assert.equal(src.includes("FORWARD_URL"), true);

    const zap = json(`${dir}/zap.json`);
    assert.equal(zap.deploy.state, "pending-create");
    assert.equal(zap.workflow_id, null);
    assert.equal(zap.current_version_id, null);
    assert.equal(zap.trigger_url, null);
    assert.equal(zap.is_private, false);
    assert.equal(zap.deploy.enable_on_publish, true);
    assert.equal(zap.enabled, true);
    assert.deepEqual(zap.deploy.source_files, ["workflow.ts", "forwarder-core.ts"]);
    assert.equal(zap.trigger.selected_api, "App228834CLIAPI@1.4.6");
    assert.equal(zap.trigger.action, "new_message");
    assert.equal(zap.trigger.authentication_id, branch.connectionId);
    assert.deepEqual(zap.trigger.params, { only_replies: false });
    assert.deepEqual(zap.connections, { [alias]: branch.connectionId });
    assert.equal(zap.zapier_durable_version, "0.14.1");
    assert.deepEqual(zap.dependencies, { "@zapier/zapier-sdk": "0.115.1" });
    assert.equal(zap.target.url, FORWARD_URL);
    assert.equal(zap.target.branch_label, branch.label);
    // the live connection id may appear only inside the "NEVER" note
    const stripped = JSON.stringify({ ...zap, trigger: { ...zap.trigger, authentication_note: "" } });
    assert.equal(stripped.includes(LIVE_CONNECTION_ID), false, `${dir} zap.json binds the live connection`);
  }
});

test("the two branches never share a connection, a label or a number", () => {
  assert.notEqual(A.connectionId, B.connectionId);
  assert.notEqual(A.label, B.label);
  assert.notEqual(A.displayDigits, B.displayDigits);
});

test("the two workflow.ts files differ only in branch identity", () => {
  const norm = (s: string, b: Branch, dir: string) =>
    s.replaceAll(dir, "DIR").replaceAll(b.label, "LABEL").replaceAll(b.connectionId, "CONN").replaceAll(b.displayDigits, "DIGITS")
      .replace(/\(\+1 [0-9-]+\)/, "(NUMBER)");
  assert.equal(
    norm(read("../multi-wavy-whatsapp-branch-a/workflow.ts"), A, "multi-wavy-whatsapp-branch-a"),
    norm(read("../multi-wavy-whatsapp-branch-b/workflow.ts"), B, "multi-wavy-whatsapp-branch-b"),
  );
});
