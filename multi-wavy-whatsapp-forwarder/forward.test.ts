// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/multi-wavy-whatsapp-forwarder
//
// Run: node --test multi-wavy-whatsapp-forwarder/forward.test.ts   (Node >= 22.18)
//
// Replays forwarder-spec.json's four Zap definitions against realistic trigger
// payloads and checks (a) the mapping produces a body the Lovable handler
// accepts, (b) the empty-payload shapes are stopped by the Filter step and would
// be rejected by the handler anyway, (c) the spec never binds the live line.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  assertSpecSafe,
  checkHandlerContract,
  flatten,
  passesFilter,
  renderMapping,
  wireBody,
  type ForwarderSpec,
  type ZapSpec,
} from "./forward.ts";

const spec: ForwarderSpec = JSON.parse(
  readFileSync(new URL("./forwarder-spec.json", import.meta.url), "utf8"),
);

const zap = (branch: string, kind: "message" | "status"): ZapSpec => {
  const z = spec.zaps.find((x) => x.branch_label === branch && x.kind === kind);
  assert.ok(z, `spec has a ${branch} ${kind} Zap`);
  return z;
};

/** Run one trigger payload through filter -> mapping -> handler contract. */
function forward(z: ZapSpec, payload: unknown) {
  const body = renderMapping(z.data_mapping, payload);
  const pass = passesFilter(z.kind, body);
  return { body, pass, contract: checkHandlerContract(wireBody(body)) };
}

// Shapes taken from the WhatsApp Business (App228834CLIAPI@1.4.6) trigger fields
// named in the spike spec and the live whatsapp-slack-bridge, which reads the same
// triggers. NOTE: the bridge durable sees nested `text.body`; the classic editor
// shows the flattened `text__body`. Both are covered.
const PNID = "100000000000001";
const DISPLAY = "19297622048";
const textMessage = {
  id: "wamid.HBgLMTY1MDU1NTAxMDAVAgASGBQzQTAxAAA=",
  from: "16505550100",
  text__body: "Hello Branch A",
  type: "text",
  timestamp: "1760706000",
  phone_number_id: PNID,
  display_phone_number: DISPLAY,
};

// ---- message mapping ------------------------------------------------------

test("message: flat text payload maps 1:1 and the handler accepts it", () => {
  const r = forward(zap("Branch A", "message"), textMessage);
  assert.equal(r.pass, true);
  assert.deepEqual(r.body, {
    kind: "message",
    branch_label: "Branch A",
    id: textMessage.id,
    from: "16505550100",
    text__body: "Hello Branch A",
    type: "text",
    timestamp: "1760706000",
    phone_number_id: PNID,
    display_phone_number: DISPLAY,
  });
  assert.ok(r.contract.ok);
  assert.equal(r.contract.kind, "message");
  assert.equal(r.contract.deliveryId, `zap:message:${textMessage.id}`);
  assert.equal(r.contract.providerTs, "2025-10-17T13:00:00.000Z");
});

test("message: nested text.body (durable-style payload) flattens to text__body", () => {
  const nested = { ...textMessage, text__body: undefined, text: { body: "Hello nested" } };
  assert.equal(flatten(nested)["text__body"], "Hello nested");
  const r = forward(zap("Branch B", "message"), nested);
  assert.equal(r.body["text__body"], "Hello nested");
  assert.equal(r.body["branch_label"], "Branch B");
  assert.ok(r.contract.ok);
});

test("message: media message with no text still forwards (handler stores [image])", () => {
  const image = { ...textMessage, type: "image", text__body: undefined, image__id: "media-1" };
  const r = forward(zap("Branch A", "message"), image);
  assert.equal(r.pass, true);
  assert.equal(r.body["text__body"], "");
  assert.equal(r.body["type"], "image");
  assert.ok(r.contract.ok);
});

test("message: quotes, newlines, emoji and backslashes survive the JSON body", () => {
  const nasty = 'He said "hi"\nline two \\ \u{1F600}';
  const r = forward(zap("Branch A", "message"), { ...textMessage, text__body: nasty });
  assert.equal(JSON.parse(wireBody(r.body)).text__body, nasty);
  assert.ok(r.contract.ok);
});

test("message: wire body keeps the FLAT text__body key (Webhooks Unflatten must be off)", () => {
  const wire = JSON.parse(wireBody(forward(zap("Branch A", "message"), textMessage).body));
  assert.equal(wire.text__body, "Hello Branch A");
  assert.equal("text" in wire, false);
});

test("message: numeric timestamp / numeric ids are stringified, not dropped", () => {
  const r = forward(zap("Branch A", "message"), { ...textMessage, timestamp: 1760706000, from: 16505550100 });
  assert.equal(r.body["timestamp"], "1760706000");
  assert.equal(r.body["from"], "16505550100");
  assert.ok(r.contract.ok);
  assert.equal(r.contract.providerTs, "2025-10-17T13:00:00.000Z");
});

// ---- status mapping -------------------------------------------------------

const statusUpdate = (status: string) => ({
  id: textMessage.id,
  status,
  timestamp: "1760706060",
  recipient_id: "16505550100",
  phone_number_id: PNID,
  display_phone_number: DISPLAY,
});

test("status: every status maps and the handler accepts it", () => {
  for (const s of ["sent", "delivered", "read", "failed"]) {
    const r = forward(zap("Branch B", "status"), statusUpdate(s));
    assert.equal(r.pass, true, s);
    assert.equal(r.body["kind"], "status");
    assert.equal(r.body["branch_label"], "Branch B");
    assert.equal(r.body["status"], s);
    assert.equal(r.body["recipient_id"], "16505550100");
    assert.ok(r.contract.ok, s);
    assert.equal(r.contract.deliveryId, `zap:status:${textMessage.id}:${s}`);
  }
});

test("status: same wamid with different statuses gets distinct delivery ids (handler dedupes wamid+status)", () => {
  const ids = ["sent", "delivered", "read"].map((s) => {
    const c = forward(zap("Branch A", "status"), statusUpdate(s)).contract;
    assert.ok(c.ok);
    return c.deliveryId;
  });
  assert.equal(new Set(ids).size, 3);
});

test("status: handler lower-cases status for the dedupe key", () => {
  const c = forward(zap("Branch A", "status"), statusUpdate("Delivered")).contract;
  assert.ok(c.ok);
  assert.equal(c.status, "delivered");
});

test("status: a status payload with no status is stopped by the Filter and rejected by the handler", () => {
  const r = forward(zap("Branch A", "status"), { ...statusUpdate("sent"), status: "" });
  assert.equal(r.pass, false);
  assert.deepEqual(r.contract, { ok: false, error: "missing status", httpStatus: 400 });
});

// ---- empty-ping / junk shapes (the six the repo rule asks for) -------------

const emptyShapes: Array<[string, unknown]> = [
  ["{}", {}],
  ["null", null],
  ['""', ""],
  ["unrelated object", { hello: "world" }],
  ['{"data":{}}', { data: {} }],
  ['{"data":{"id":""}}', { data: { id: "" } }],
  ['{"querystring":{}}', { querystring: {} }],
];

for (const kind of ["message", "status"] as const) {
  for (const [label, payload] of emptyShapes) {
    test(`${kind}: empty/junk shape ${label} is filtered, never forwarded as a real event`, () => {
      const r = forward(zap("Branch A", kind), payload);
      assert.equal(r.pass, false);
      // And the handler would have refused it had it been sent: missing id.
      assert.equal(r.contract.ok, false);
      if (!r.contract.ok) assert.equal(r.contract.error, "missing id (wamid)");
    });
  }
}

// ---- handler contract mirror ----------------------------------------------

test("contract mirror: bad JSON, non-object, bad kind, missing id, status without status", () => {
  assert.deepEqual(checkHandlerContract("{not json"), { ok: false, error: "invalid JSON", httpStatus: 400 });
  assert.deepEqual(checkHandlerContract("null"), { ok: false, error: "body is not a JSON object", httpStatus: 400 });
  assert.deepEqual(checkHandlerContract(JSON.stringify({ kind: "nope", id: "x" })), {
    ok: false,
    error: 'kind must be "message" or "status" (got "nope")',
    httpStatus: 400,
  });
  assert.deepEqual(checkHandlerContract(JSON.stringify({ kind: "message", id: "  " })), {
    ok: false,
    error: "missing id (wamid)",
    httpStatus: 400,
  });
  assert.deepEqual(checkHandlerContract(JSON.stringify({ kind: "status", id: "x" })), {
    ok: false,
    error: "missing status",
    httpStatus: 400,
  });
});

// ---- spec safety ----------------------------------------------------------

test("spec: four Zaps, one per (branch x kind), each on its own branch's test connection", () => {
  assert.equal(spec.zaps.length, 4);
  const combos = new Set(spec.zaps.map((z) => `${z.branch_label}|${z.kind}`));
  assert.equal(combos.size, 4);
  const byBranch = new Map<string, Set<string>>();
  for (const z of spec.zaps) {
    const s = byBranch.get(z.branch_label) ?? new Set<string>();
    s.add(z.trigger.connection_id);
    byBranch.set(z.branch_label, s);
  }
  for (const [branch, ids] of byBranch) assert.equal(ids.size, 1, `${branch} must use exactly one connection`);
  assert.notEqual([...byBranch.get("Branch A")!][0], [...byBranch.get("Branch B")!][0]);
  assert.equal(zap("Branch A", "message").trigger.event, "new_message");
  assert.equal(zap("Branch B", "status").trigger.event, "message_status_updated");
});

test("spec: the mapping's hard-coded branch_label matches the Zap's branch", () => {
  for (const z of spec.zaps) assert.equal(z.data_mapping["branch_label"], z.branch_label);
  for (const z of spec.zaps) assert.equal(z.data_mapping["kind"], z.kind);
});

test("spec: committed spec passes assertSpecSafe and never binds the live connection", () => {
  assert.doesNotThrow(() => assertSpecSafe(spec));
  const live = Object.keys(spec.forbidden_connection_ids);
  assert.equal(live.length, 1);
  assert.ok(!JSON.stringify(spec.zaps).includes(live[0]!), "live connection id must not appear in any Zap definition");
});

test("assertSpecSafe: refuses the live connection, a missing connection, and an inlined secret", () => {
  const live = Object.keys(spec.forbidden_connection_ids)[0]!;
  const withLive: ForwarderSpec = structuredClone(spec);
  withLive.zaps[0]!.trigger.connection_id = live;
  assert.throws(() => assertSpecSafe(withLive), /refuses to bind live connection/);

  const noConn: ForwarderSpec = structuredClone(spec);
  noConn.zaps[1]!.trigger.connection_id = "";
  assert.throws(() => assertSpecSafe(noConn), /no explicit connection id/);

  const leaky = structuredClone(spec) as ForwarderSpec & Record<string, unknown>;
  leaky["webhook_secret"] = "abcdefghijklmnopqrstuvwxyz0123456789";
  assert.throws(() => assertSpecSafe(leaky), /inline a secret/);
});

test("spec: the secret is named by header only; no value is stored anywhere in the directory spec", () => {
  assert.equal(spec.target.secret_header, "X-Webhook-Secret");
  assert.match(spec.target.secret_source, /Zapier UI/);
  assert.equal(spec.target.method, "POST");
  assert.equal(spec.target.url, "https://multi-wavy-numbers.lovable.app/api/public/zapier/whatsapp");
});
