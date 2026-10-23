// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/flow-statements-welcome-sender
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// Hourly sender for the Flow Statements welcome sequence. Buttondown's Basic
// plan has no Automations, so the sequence state lives in a Zapier Table
// (written by flow-statements-welcome-enrol) and this Zap sends each due step
// as a one-subscriber send of an `imported` Buttondown email. Buttondown
// still does the sending, so the unsubscribe link and suppression rules apply.

// --- Bindings --------------------------------------------------------------
const BUTTONDOWN_CONNECTION = "buttondown_api";
const BUTTONDOWN_API = "https://api.buttondown.com/v1";

// Welcome Sequence Table, shared with flow-statements-welcome-enrol.
const WELCOME_TABLE = "01M5M4KH7C1KCFD3CDRSAF46XA";

// --- The sequence ----------------------------------------------------------
// Step -> the Buttondown email sent at that step, and its offset in days from
// `confirmed_at`. Each email is a refreshed copy created as `imported`,
// `archival_mode: disabled`, `email_type: private` — never the original sent
// issue, which the per-subscriber endpoint would also accept. Changing an
// offset reschedules everyone still waiting on that step.
//
// The ids are null until the refreshed emails exist in Buttondown. A due step
// with no id throws, so the Zap must stay disabled until all six are filled.
const SEQUENCE: ReadonlyArray<{ step: number; offsetDays: number; emailId: string | null; note: string }> = [
  { step: 1, offsetDays: 0, emailId: null, note: "New welcome email" },
  { step: 2, offsetDays: 4, emailId: null, note: "I'm Not Vibe-Coding the Next Salesforce (from em_26s9k9k7gn9xbarq0grgz61zns)" },
  { step: 3, offsetDays: 11, emailId: null, note: "Five practical WhatsApp automations for small teams (from em_2ps5r1kk548bvryp1d9dyq560w)" },
  { step: 4, offsetDays: 18, emailId: null, note: "Why Notion Workers + Dashboards are my New BI Stack (from em_4tsdpj2bjq8xh9tmzma3tnr26m)" },
  { step: 5, offsetDays: 25, emailId: null, note: "How Knoxx Foods Built the Operational Foundations for AI (from em_6kppy625nv8cp8nzan86h4fyq2)" },
  { step: 6, offsetDays: 32, emailId: null, note: "AI Is Writing Faster Than We Can Read (from em_32ng61zqng88na5dmfxe0nhf90)" },
];
const LAST_STEP = SEQUENCE.length;

// A subscriber who fell behind (the Zap was off, or sends kept failing) gets
// their overdue steps no closer together than this, rather than one an hour.
const MIN_GAP_MS = 2 * 86400000;

// Consecutive send failures before a row is paused and the run goes red.
const FAIL_ALERT_THRESHOLD = 3;

// Rows handled per run, oldest due first. The rest wait for the next hour.
const MAX_ROWS_PER_RUN = 50;

const DAY_MS = 86400000;

// The schedule tick's payload is ignored. Manual runs can pass:
//   now        – RFC 3339 instant to treat as the current time (walk a test
//                row through the sequence without waiting days)
//   only_email – handle that one row and nothing else
//   dryRun     – list what is due and what would happen, write nothing
const InputSchema = z
  .object({
    now: z.string().optional(),
    only_email: z.string().optional(),
    dryRun: z.boolean().optional(),
  })
  .passthrough()
  .nullish();

type Row = {
  id: string;
  email: string;
  subscriberId: string;
  confirmedAtMs: number;
  nextStep: number;
  lastSentStep: number;
  failCount: number;
};

type RowOutcome =
  | { email: string; action: "sent"; step: number; next: string }
  | { email: string; action: "completed"; step: number }
  | { email: string; action: "stopped"; reason: string }
  | { email: string; action: "repaired"; step: number }
  | { email: string; action: "failed"; step: number; error: string; paused: boolean }
  | { email: string; action: "would-send"; step: number };

// --- Pure helpers ----------------------------------------------------------
function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline can deliver input double-encoded; run-durable does not.
  let v: unknown = rawInput;
  for (let i = 0; i < 4 && typeof v === "string"; i++) {
    const t = v.trim();
    if (t === "") return null;
    if (t[0] !== "{" && t[0] !== '"') break;
    try {
      v = JSON.parse(t);
    } catch {
      break;
    }
  }
  return typeof v === "string" ? null : v;
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/**
 * When step `nextStep` is due, given the subscriber's anchor and when the
 * previous step went out. Null when the sequence is over.
 */
export function nextSendAtMs(confirmedAtMs: number, nextStep: number, sentAtMs: number): number | null {
  const entry = SEQUENCE.find((s) => s.step === nextStep);
  if (!entry) return null;
  return Math.max(confirmedAtMs + entry.offsetDays * DAY_MS, sentAtMs + MIN_GAP_MS);
}

/**
 * Buttondown refuses a second send of one email to one subscriber with
 * `400 {"code":"invalid_input","detail":"EMAIL_ALREADY_SENT"}` (seen live
 * 2026-10-23). The subscriber already has the email, which is the state a send
 * is after, so this one error reads as success. That makes the send
 * idempotent: a run whose send landed but whose row update didn't is repaired
 * by the next run instead of failing it three times and pausing the row.
 * Matched on status AND detail, so every other 400 still counts as a failure.
 */
export function isAlreadySent(status: number, body: string): boolean {
  return status === 400 && body.includes("EMAIL_ALREADY_SENT");
}

function errorText(err: unknown): string {
  return String((err as Error)?.message ?? err).slice(0, 500);
}

// --- Per-row processing ----------------------------------------------------
// Step ids carry the row id, so they live in a helper that takes ctx: the
// publish-time analyzer refuses template-literal ids in the workflow body.
// Every step here returns its failure instead of throwing, so one bad row
// can't exhaust a step's retries and kill the run for every other row; the
// next hourly run is the retry.
async function processRow(
  ctx: DurableContext,
  row: Row,
  nowMs: number,
  dryRun: boolean,
): Promise<RowOutcome> {
  const p = `row-${row.id}`;

  const update = (name: string, data: Record<string, unknown>) =>
    ctx.step(`${p}-${name}`, async () => {
      await sdk.updateTableRecords({
        table: WELCOME_TABLE,
        keyMode: "names",
        records: [{ id: row.id, data }],
      });
      return { ok: true };
    });

  if (row.nextStep < 1 || row.nextStep > LAST_STEP) {
    if (!dryRun) await update("bad-step", { status: "stopped", stop_reason: `invalid next_step ${row.nextStep}` });
    return { email: row.email, action: "stopped", reason: `invalid next_step ${row.nextStep}` };
  }

  // 1. Re-fetch the subscriber: an unsubscribe since the last step ends the
  //    sequence. Buttondown would suppress the send anyway, but stopping here
  //    keeps the row honest and stops the hourly re-checks.
  const sub = await ctx.step(`${p}-subscriber`, async () => {
    try {
      const res = await sdk.fetch(`${BUTTONDOWN_API}/subscribers/${encodeURIComponent(row.subscriberId)}`, {
        connection: BUTTONDOWN_CONNECTION,
      });
      if (res.status === 404) return { ok: true as const, type: "missing" };
      if (!res.ok) return { ok: false as const, error: `GET subscriber ${res.status}: ${(await res.text()).slice(0, 300)}` };
      const body = (await res.json()) as Record<string, unknown>;
      return { ok: true as const, type: String(body.type ?? "") };
    } catch (err) {
      return { ok: false as const, error: `GET subscriber: ${errorText(err)}` };
    }
  });

  if (sub.ok && sub.type !== "regular") {
    const reason = `subscriber type ${sub.type || "unknown"}`;
    if (!dryRun) await update("stop", { status: "stopped", stop_reason: reason });
    return { email: row.email, action: "stopped", reason };
  }

  const step = row.nextStep;
  const entry = SEQUENCE.find((s) => s.step === step)!;

  // 2. Retry guard: this step already went out (the send landed but the row
  //    update after it didn't). Advance without sending again.
  const alreadySent = row.lastSentStep >= step;

  let failure: string | null = sub.ok ? null : sub.error;
  if (!failure && !alreadySent && !entry.emailId) {
    failure = `no Buttondown email id configured for step ${step}`;
  }

  if (!failure && !alreadySent) {
    if (dryRun) return { email: row.email, action: "would-send", step };
    // 3. Send. Buttondown answers 200 with an empty body.
    const sent = await ctx.step(`${p}-send-${step}`, async () => {
      try {
        const res = await sdk.fetch(
          `${BUTTONDOWN_API}/subscribers/${encodeURIComponent(row.subscriberId)}/emails/${entry.emailId}`,
          { connection: BUTTONDOWN_CONNECTION, method: "POST" },
        );
        if (res.ok) return { ok: true as const, duplicate: false };
        const body = await res.text();
        if (isAlreadySent(res.status, body)) return { ok: true as const, duplicate: true };
        return { ok: false as const, error: `send ${res.status}: ${body.slice(0, 300)}` };
      } catch (err) {
        return { ok: false as const, error: `send: ${errorText(err)}` };
      }
    });
    if (!sent.ok) failure = sent.error;
    else if (sent.duplicate) console.log(`${row.email}: step ${step} was already delivered; advancing`);
  }

  // 5. Failure: leave the step where it is so the next run retries, and count
  //    it. At the threshold, pause the row so it stops retrying hourly, and
  //    let the run go red once.
  if (failure) {
    const failCount = row.failCount + 1;
    const paused = failCount >= FAIL_ALERT_THRESHOLD;
    if (!dryRun) {
      await update(`fail-${step}`, {
        fail_count: failCount,
        last_error: failure,
        ...(paused ? { status: "paused", stop_reason: `step ${step} failed ${failCount}x` } : {}),
      });
    }
    return { email: row.email, action: "failed", step, error: failure, paused };
  }

  if (dryRun) return { email: row.email, action: "repaired", step };

  // 4. Success: record the step and schedule the next one from confirmed_at.
  const advanced = await ctx.step(`${p}-advance-${step}`, async () => {
    const data: Record<string, unknown> = {
      last_sent_step: step,
      fail_count: 0,
      last_error: "",
    };
    if (!alreadySent) data.last_sent_at = new Date(nowMs).toISOString();
    let next: string | null = null;
    if (step >= LAST_STEP) {
      data.status = "completed";
    } else {
      const nextMs = nextSendAtMs(row.confirmedAtMs, step + 1, nowMs)!;
      next = new Date(nextMs).toISOString();
      data.next_step = step + 1;
      data.next_send_at = next;
    }
    await sdk.updateTableRecords({
      table: WELCOME_TABLE,
      keyMode: "names",
      records: [{ id: row.id, data }],
    });
    return { next };
  });

  if (alreadySent) return { email: row.email, action: "repaired", step };
  if (advanced.next === null) return { email: row.email, action: "completed", step };
  return { email: row.email, action: "sent", step, next: advanced.next };
}

// --- Workflow --------------------------------------------------------------
export default defineDurable("flow-statements-welcome-sender", async (ctx, rawInput) => {
  const input = InputSchema.parse(normalizeInput(rawInput)) ?? {};
  const dryRun = input.dryRun === true;
  const onlyEmail = input.only_email?.trim().toLowerCase() || null;

  const clock = await ctx.step("clock", async () => {
    if (input.now) {
      const ms = Date.parse(input.now);
      if (!Number.isFinite(ms)) throw new Error(`input.now is not a valid instant: ${input.now}`);
      return { nowMs: ms, pinned: true };
    }
    return { nowMs: Date.now(), pinned: false };
  });

  // Active rows whose next step is due, oldest first. Paused, stopped and
  // completed rows are skipped by the status filter, which is how a row is
  // paused by hand: set its status to `paused`.
  const due = await ctx.step("load-due-rows", async () => {
    const rows: Array<{ row: Row; dueMs: number }> = [];
    for await (const rec of sdk
      .listTableRecords({
        table: WELCOME_TABLE,
        keyMode: "names",
        filters: [{ fieldKey: "status", operator: "exact", value: "active" }],
        pageSize: 500,
      })
      .items()) {
      const d = (rec.data ?? {}) as Record<string, unknown>;
      const email = String(d.email ?? "").trim().toLowerCase();
      if (onlyEmail && email !== onlyEmail) continue;
      const nextSendMs = Date.parse(String(d.next_send_at ?? ""));
      const confirmedAtMs = Date.parse(String(d.confirmed_at ?? ""));
      if (!Number.isFinite(nextSendMs) || nextSendMs > clock.nowMs) continue;
      rows.push({
        dueMs: nextSendMs,
        row: {
          id: rec.id,
          email,
          subscriberId: String(d.subscriber_id ?? "").trim() || email,
          confirmedAtMs: Number.isFinite(confirmedAtMs) ? confirmedAtMs : nextSendMs,
          nextStep: num(d.next_step, 1),
          lastSentStep: num(d.last_sent_step, 0),
          failCount: num(d.fail_count, 0),
        },
      });
    }
    rows.sort((a, b) => a.dueMs - b.dueMs);
    return { rows: rows.slice(0, MAX_ROWS_PER_RUN).map((r) => r.row), total: rows.length };
  });

  console.log(`${due.total} row(s) due at ${clock.pinned ? "pinned" : "tick"} time ${clock.nowMs}; handling ${due.rows.length}`);

  const outcomes: RowOutcome[] = [];
  for (const row of due.rows) {
    const outcome = await processRow(ctx, row, clock.nowMs, dryRun);
    console.log(JSON.stringify(outcome));
    outcomes.push(outcome);
  }

  const summary = {
    dryRun,
    due: due.total,
    handled: outcomes.length,
    outcomes,
  };

  // An unrecognized failure must surface: a row that hit the threshold this
  // run turns the run red (and so raises Zapier's error alert) exactly once,
  // since the row is now paused and drops out of later runs.
  const paused = outcomes.filter((o) => o.action === "failed" && o.paused);
  if (paused.length > 0) {
    throw new Error(
      `Welcome sequence paused ${paused.length} row(s) after ${FAIL_ALERT_THRESHOLD} failed sends: ` +
        JSON.stringify(paused),
    );
  }
  return summary;
});
