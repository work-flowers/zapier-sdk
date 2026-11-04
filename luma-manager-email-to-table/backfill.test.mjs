// Offline checks of the backfill's batching and self-continuation — no Zapier
// calls, no credentials. Run with `npm test` from this directory (Node >= 23,
// which strips TypeScript types natively).
//
// workflow.ts can't be imported directly (the SDKs and defineDurable() run at
// module load), so this harness swaps those imports for fakes on globalThis,
// writes a temporary .ts copy and imports it. The fake ctx runs steps inline
// and records waits, so the whole workflow body runs against a fake Table,
// a fake Luma read and a fake triggerWorkflow.
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const dir = dirname(fileURLToPath(import.meta.url));
let src = readFileSync(join(dir, "workflow.ts"), "utf8");
src = src
  .replace(
    'import { defineDurable } from "@zapier/zapier-durable";',
    "const defineDurable = (name: string, fn: any) => ({ name, fn });",
  )
  .replace(
    'import { createZapierSdk } from "@zapier/zapier-sdk";',
    "const createZapierSdk = () => (globalThis as any).__fakeSdk;",
  )
  .replace(
    'import { createZapierSdk as createExperimentalSdk } from "@zapier/zapier-sdk/experimental";',
    "const createExperimentalSdk = () => (globalThis as any).__fakeWorkflows;",
  );
if (src.includes("@zapier/")) throw new Error("unstubbed @zapier import left in source");
src +=
  "\nexport const __test = { parseContinuation, pickContinuationGuests, guestKey, GUEST_BATCH_SIZE, CONTINUATION_KEY, MAX_CONTINUATION_HOPS };\n";

// --- Fakes -------------------------------------------------------------------
const EVENT_ID = "evt-9hO0MFRkAd3yKfi";
const ROW_ID = "01M6J94435JCYFPZFR0JS6H445";
const IDS = { event: "wf-event", guest: "wf-guest", self: "wf-self" };

const state = { guests: [], rows: [], updates: [], fired: [] };
const guest = (n, status = "approved") => ({
  id: `gst-g${n}_${status}_none`,
  guest_id: `gst-g${n}`,
  approval_status: status,
  event: { id: EVENT_ID },
  check_in_qr_code: "drop-me",
});

globalThis.__fakeSdk = {
  listTableRecords: async () => ({ data: state.rows }),
  createTableRecords: async ({ records }) => {
    const row = { id: ROW_ID, data: records[0].data };
    state.rows.push(row);
    return { data: [row] };
  },
  updateTableRecords: async ({ records }) => {
    state.updates.push(records[0].data["Backfill Status"]);
    return { data: records };
  },
  runAction: async ({ actionKey }) => {
    if (actionKey === "new_event") return { data: [{ id: EVENT_ID, name: "NotionSG SME Series" }] };
    if (actionKey === "new_or_updated_guest") return { data: state.guests };
    throw new Error(`unexpected action ${actionKey}`);
  },
};
globalThis.__fakeWorkflows = {
  listWorkflows: () => ({
    items: async function* () {
      yield { name: "luma-hosted-event-to-notion", id: IDS.event };
      yield { name: "luma-hosted-guest-to-event-attendance", id: IDS.guest };
      yield { name: "luma-manager-email-to-table", id: IDS.self };
      yield { name: "something-else", id: "wf-other" };
    },
  }),
  triggerWorkflow: async ({ workflow, input }) => {
    state.fired.push({ workflow, input });
    return { data: { id: `trig-${state.fired.length}` } };
  },
};

function fakeCtx() {
  const stepIds = new Set();
  const waits = [];
  return {
    waits,
    step: async (id, fn) => {
      assert.ok(!stepIds.has(id), `duplicate step id in one run: ${id}`);
      stepIds.add(id);
      return fn();
    },
    wait: async (id, seconds) => {
      assert.ok(!stepIds.has(id), `duplicate step id in one run: ${id}`);
      stepIds.add(id);
      assert.ok(Number.isSafeInteger(seconds) && seconds >= 1, `bad wait ${id}=${seconds}`);
      waits.push([id, seconds]);
    },
  };
}

const email = {
  id: "1a1a4919b407e0e3",
  subject: "Please join me as a host for NotionSG SME Series: Is Your Business Finance Ready?",
  from: { email: "calendar@calendar.luma-mail.com" },
  body_plain: `You have manage access to this event. https://luma.com/event/manage/${EVENT_ID}`,
  date: "Wed, 4 Nov 2026 03:19:27 +0000",
};

const tmp = join(dir, `.workflow.test-${process.pid}.ts`);
writeFileSync(tmp, src);
let mod;
try {
  mod = await import(pathToFileURL(tmp).href);
} finally {
  unlinkSync(tmp);
}
const run = (input) => {
  const ctx = fakeCtx();
  return mod.default.fn(ctx, input).then((out) => ({ out, ctx }));
};
const { parseContinuation, pickContinuationGuests, guestKey, GUEST_BATCH_SIZE, CONTINUATION_KEY, MAX_CONTINUATION_HOPS } =
  mod.__test;
let checks = 0;
const check = async (name, fn) => {
  await fn();
  checks++;
  console.log(`ok - ${name}`);
};

// --- Pure helpers --------------------------------------------------------------
await check("guestKey prefers the bare gst- id over the status-bearing composite", () => {
  assert.equal(guestKey({ id: "gst-a_approved_none", guest_id: "gst-a" }), "gst-a");
  assert.equal(guestKey({ id: "gst-b_approved_none" }), "gst-b");
  assert.equal(guestKey({}), null);
});

await check("parseContinuation: absent key is not a continuation (email path)", () => {
  assert.equal(parseContinuation(email), null);
  assert.equal(parseContinuation(null), null);
  assert.equal(parseContinuation("x"), null);
});

await check("parseContinuation: malformed shapes are errors, never a silent skip", () => {
  const ok = { event_id: EVENT_ID, row_id: ROW_ID, guest_ids: ["gst-a"], fired_before: 75, invited_skipped: 3, hop: 1 };
  assert.deepEqual(parseContinuation({ [CONTINUATION_KEY]: ok }), {
    eventId: EVENT_ID, rowId: ROW_ID, guestIds: ["gst-a"], firedBefore: 75, invitedSkipped: 3, hop: 1,
  });
  for (const bad of [
    {},
    { ...ok, event_id: "" },
    { ...ok, row_id: 5 },
    { ...ok, guest_ids: [] },
    { ...ok, guest_ids: ["gst-a_approved_none"] },
    { ...ok, fired_before: -1 },
    { ...ok, hop: 0 },
  ]) {
    assert.ok("error" in parseContinuation({ [CONTINUATION_KEY]: bad }), JSON.stringify(bad));
  }
  assert.ok("error" in parseContinuation({ [CONTINUATION_KEY]: null }));
});

await check("pickContinuationGuests keeps queue order, reports deleted guests", () => {
  const all = [guest(1), guest(2, "declined"), guest(3)];
  const r = pickContinuationGuests(all, ["gst-g3", "gst-gone", "gst-g2"]);
  assert.deepEqual(r.items.map(guestKey), ["gst-g3", "gst-g2"]);
  assert.deepEqual(r.missing, ["gst-gone"]);
  assert.ok(!("check_in_qr_code" in r.items[0]), "slimmed");
});

// --- Whole runs ----------------------------------------------------------------
await check("101 guests: run 1 fires 75, marks progress, hands 26 to a continuation", async () => {
  state.guests = [
    ...Array.from({ length: 101 }, (_, i) => guest(i)),
    ...Array.from({ length: 5 }, (_, i) => guest(500 + i, "invited")),
  ];
  state.rows = [];
  state.updates = [];
  state.fired = [];
  const { out, ctx } = await run(email);
  const guestFires = state.fired.filter((f) => f.workflow === IDS.guest);
  const conts = state.fired.filter((f) => f.workflow === IDS.self);
  assert.equal(state.fired[0].workflow, IDS.event);
  assert.equal(guestFires.length, GUEST_BATCH_SIZE);
  assert.equal(conts.length, 1);
  const c = conts[0].input[CONTINUATION_KEY];
  assert.equal(c.guest_ids.length, 101 - GUEST_BATCH_SIZE);
  assert.equal(c.guest_ids[0], `gst-g${GUEST_BATCH_SIZE}`);
  assert.equal(c.fired_before, GUEST_BATCH_SIZE);
  assert.equal(c.invited_skipped, 5);
  assert.equal(c.hop, 1);
  assert.equal(c.row_id, ROW_ID);
  assert.deepEqual(state.updates, [`pending: 75 guests fired, 26 queued for run 2`]);
  assert.equal(out.guestsQueued, 26);
  // Time budget: everything this run waits stays well inside the ~40 min limit.
  const waited = ctx.waits.reduce((s, [, sec]) => s + sec, 0);
  assert.ok(waited < 30 * 60, `run 1 waits ${waited}s`);

  // Run 2: the continuation finishes the queue and marks the row done.
  state.fired = [];
  const r2 = await run(conts[0].input);
  const fires2 = state.fired.filter((f) => f.workflow === IDS.guest);
  assert.equal(fires2.length, 26);
  assert.deepEqual(fires2.map((f) => f.input.guest_id), c.guest_ids);
  assert.ok(fires2.every((f) => f.input.source === "backfill"));
  assert.equal(state.fired.filter((f) => f.workflow !== IDS.guest).length, 0, "no event re-fire, no further hop");
  assert.equal(state.updates.at(-1), "done: 101 guests fired, 5 invited skipped");
  assert.equal(r2.ctx.waits[0][0], "continuation-spacing");
  assert.equal(r2.out.backfill, "done: 101 guests fired, 5 invited skipped");
});

await check("a small event finishes in one run with the old status format", async () => {
  state.guests = [guest(1), guest(2), guest(3, "invited")];
  state.rows = [];
  state.updates = [];
  state.fired = [];
  const { out } = await run(email);
  assert.equal(state.fired.filter((f) => f.workflow === IDS.self).length, 0);
  assert.deepEqual(state.updates, ["done: 2 guests fired, 1 invited skipped"]);
  assert.equal(out.guestsQueued, 0);
});

await check("a long event chains run after run until done", async () => {
  const n = GUEST_BATCH_SIZE * 2 + 10;
  state.guests = Array.from({ length: n }, (_, i) => guest(i));
  state.rows = [];
  state.updates = [];
  state.fired = [];
  let next = email;
  let runs = 0;
  const seen = new Set();
  while (next) {
    runs++;
    const before = state.fired.length;
    await run(next);
    const added = state.fired.slice(before);
    for (const f of added.filter((f) => f.workflow === IDS.guest)) {
      assert.ok(!seen.has(f.input.guest_id), `guest fired twice: ${f.input.guest_id}`);
      seen.add(f.input.guest_id);
    }
    next = added.find((f) => f.workflow === IDS.self)?.input ?? null;
    assert.ok(runs <= 5, "runaway chain");
  }
  assert.equal(runs, 3);
  assert.equal(seen.size, n);
  assert.equal(state.updates.at(-1), `done: ${n} guests fired, 0 invited skipped`);
});

await check("a continuation whose guests all vanished marks done without firing", async () => {
  state.guests = [guest(1)];
  state.updates = [];
  state.fired = [];
  const input = {
    [CONTINUATION_KEY]: { event_id: EVENT_ID, row_id: ROW_ID, guest_ids: ["gst-gone"], fired_before: 98, invited_skipped: 2266, hop: 1 },
  };
  const { out } = await run(input);
  assert.equal(state.fired.length, 0);
  assert.equal(out.guestsMissing, 1);
  assert.deepEqual(state.updates, ["done: 98 guests fired, 2266 invited skipped"]);
});

await check("the hop cap throws instead of chaining forever", async () => {
  state.guests = Array.from({ length: GUEST_BATCH_SIZE + 1 }, (_, i) => guest(i));
  state.fired = [];
  const input = {
    [CONTINUATION_KEY]: {
      event_id: EVENT_ID,
      row_id: ROW_ID,
      guest_ids: state.guests.map(guestKey),
      fired_before: 0,
      invited_skipped: 0,
      hop: MAX_CONTINUATION_HOPS,
    },
  };
  await assert.rejects(run(input), /continuation hop/);
  assert.equal(state.fired.filter((f) => f.workflow === IDS.self).length, 0);
});

await check("a malformed continuation throws", async () => {
  await assert.rejects(run({ [CONTINUATION_KEY]: { event_id: EVENT_ID } }), /Malformed/);
});

await check("empty pings still skip before the continuation check", async () => {
  for (const p of [{}, null, "", { querystring: {} }]) {
    const { out } = await run(p);
    assert.deepEqual(out, { skipped: "empty-payload" });
  }
});

console.log(`\n${checks} checks passed`);
