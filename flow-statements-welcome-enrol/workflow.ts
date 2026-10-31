// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/flow-statements-welcome-enrol
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";

const sdk = createZapierSdk();

// Enrols each newly confirmed Flow Statements subscriber in the welcome
// sequence by writing one row to the Welcome Sequence Table, then sends step 1
// (the welcome email) straight away and moves the row on to step 2. Steps 2-5
// are the job of flow-statements-welcome-sender, which reads that Table once a
// day. If the welcome send fails, the row stays on step 1, due now, and the
// sender's next daily run retries it.
//
// Sending here rather than in the sender is what let the sender drop from
// hourly to daily without a new subscriber waiting up to a day for the
// welcome. It costs no extra task: from 2026-12-01 this run is billed its
// 1-task minimum anyway, and the send fetch is that one task.

// --- Bindings --------------------------------------------------------------
const BUTTONDOWN_CONNECTION = "buttondown_api";
const BUTTONDOWN_API = "https://api.buttondown.com/v1";

// Step 1 of the sequence, and when step 2 falls due. Both are copies of the
// sender's SEQUENCE entries; change them together.
const WELCOME_EMAIL_ID = "em_7xspe63xkp8qf9cx6tzeyg776c";
const STEP_2_OFFSET_DAYS = 4;
const DAY_MS = 86400000;

// Welcome Sequence Table, shared with flow-statements-welcome-sender. Keyed on
// `email`, lowercased. One row per subscriber, ever.
const WELCOME_TABLE = "01M5M4KH7C1KCFD3CDRSAF46XA";

// The list-bombing signups seen on Buttondown carry a plus-tag of `km` and a
// hex string (`name+km3f9a1c@…`). Double opt-in keeps most of them out, but a
// confirmed one should still never get the sequence.
const BOT_PLUS_TAG = /\+km[0-9a-f]+@/i;
// The other bot pattern: a signup from the blog's second index page with no
// form id. Real visitors come through an embedded form, which carries one.
const BOT_REFERRER_SUFFIX = "/blog/page/2/";

type Outcome =
  | { skipped: string; email?: string }
  | { enrolled: string; recordId: string | null; welcome: "sent" | "already-sent" | "failed"; error?: string };

// --- Pure helpers ----------------------------------------------------------
function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline can deliver input double-encoded; run-durable does not.
  let v: unknown = rawInput;
  for (let i = 0; i < 4 && typeof v === "string"; i++) {
    const t = v.trim();
    if (t === "" || t === "null") return null;
    if (t[0] !== "{" && t[0] !== '"') break;
    try {
      v = JSON.parse(t);
    } catch {
      break;
    }
  }
  return v;
}

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

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Buttondown refuses a second send of one email to one subscriber with
 * `400 {"code":"invalid_input","detail":"EMAIL_ALREADY_SENT"}`. The subscriber
 * already has the email, so this one error reads as success. Same predicate
 * as flow-statements-welcome-sender's.
 */
export function isAlreadySent(status: number, body: string): boolean {
  return status === 400 && body.includes("EMAIL_ALREADY_SENT");
}

function errorText(err: unknown): string {
  return String((err as Error)?.message ?? err).slice(0, 500);
}

/** Why this confirmed subscriber is a bot signup, or null when it isn't. */
export function botReason(sub: Record<string, unknown>): string | null {
  const email = str(sub.email_address);
  if (BOT_PLUS_TAG.test(email)) return "bot-plus-tag";
  const referrer = str(sub.referrer_url).split(/[?#]/)[0];
  if (referrer.endsWith(BOT_REFERRER_SUFFIX) && (sub.form_id === null || sub.form_id === undefined)) {
    return "bot-referrer-no-form";
  }
  return null;
}

// --- Workflow --------------------------------------------------------------
export default defineDurable("flow-statements-welcome-enrol", async (ctx, rawInput) => {
  const payload = normalizeInput(rawInput);
  if (isEmptyPing(payload)) {
    console.log("empty payload — a ping, not a confirmed subscriber");
    return { skipped: "empty-payload" } satisfies Outcome;
  }

  const sub = (payload ?? {}) as Record<string, unknown>;
  const email = str(sub.email_address).toLowerCase();
  const subscriberId = str(sub.id);
  if (!email || !subscriberId) {
    // Content we can't read is a real event whose shape we failed to
    // understand. Surface it rather than dropping it.
    const keys = typeof payload === "object" && payload ? Object.keys(payload).join(", ") : typeof payload;
    throw new Error(`Confirmed-subscriber payload has no usable email_address/id (got: ${keys})`);
  }

  const type = str(sub.type);
  if (type && type !== "regular") {
    console.log(`skip ${email}: subscriber type is ${type}, not regular`);
    return { skipped: `type-${type}`, email } satisfies Outcome;
  }

  const bot = botReason(sub);
  if (bot) {
    console.log(`skip ${email}: ${bot}`);
    return { skipped: bot, email } satisfies Outcome;
  }

  // Upsert by email, insert-only: an existing row is the subscriber's
  // sequence state (maybe mid-sequence, paused or stopped by hand), so a
  // second confirmation never resets it. Find-then-create is not atomic, but
  // the trigger fires once per subscriber, so a race needs a duplicate event.
  //
  // `confirmed_at` is when this Zap saw the confirmation, not Buttondown's
  // own timestamp. The trigger has been seen delivering a confirmation weeks
  // late; anchoring on the real date would make steps 1–3 all due at once.
  const result = await ctx.step("upsert-welcome-row", async () => {
    const existing = await sdk.listTableRecords({
      table: WELCOME_TABLE,
      keyMode: "names",
      filters: [{ fieldKey: "email", operator: "exact", value: email }],
      pageSize: 1,
    });
    const found = existing.data?.[0];
    if (found) {
      return { created: false as const, recordId: found.id, status: String(found.data?.status ?? "") };
    }
    const now = new Date().toISOString();
    const created = await sdk.createTableRecords({
      table: WELCOME_TABLE,
      keyMode: "names",
      records: [
        {
          data: {
            email,
            subscriber_id: subscriberId,
            confirmed_at: now,
            next_step: 1,
            next_send_at: now,
            last_sent_step: 0,
            status: "active",
            fail_count: 0,
          },
        },
      ],
    });
    return { created: true as const, recordId: created.data?.[0]?.id ?? null, now };
  });

  if (!result.created) {
    console.log(`skip ${email}: already enrolled (row ${result.recordId}, status ${result.status})`);
    return { skipped: "already-enrolled", email } satisfies Outcome;
  }

  console.log(`enrolled ${email} (row ${result.recordId})`);

  // Send the welcome (step 1) now. The step returns its failure rather than
  // throwing, so a Buttondown error doesn't burn retries: the row is left on
  // step 1, due now, and the sender's next daily run is the retry, with its
  // own 3-strikes pause and alert.
  const sent = await ctx.step("send-welcome", async () => {
    try {
      const res = await sdk.fetch(
        `${BUTTONDOWN_API}/subscribers/${encodeURIComponent(subscriberId)}/emails/${WELCOME_EMAIL_ID}`,
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

  // Record the outcome on the row. On success the row moves to step 2, due
  // confirmed_at + 4 days, exactly as the sender would have left it.
  if (result.recordId) {
    await ctx.step("record-welcome", async () => {
      const confirmedMs = Date.parse(result.now);
      const data: Record<string, unknown> = sent.ok
        ? {
            last_sent_step: 1,
            last_sent_at: new Date().toISOString(),
            next_step: 2,
            next_send_at: new Date(confirmedMs + STEP_2_OFFSET_DAYS * DAY_MS).toISOString(),
            fail_count: 0,
            last_error: "",
          }
        : { fail_count: 1, last_error: sent.error };
      await sdk.updateTableRecords({
        table: WELCOME_TABLE,
        keyMode: "names",
        records: [{ id: result.recordId as string, data }],
      });
      return { ok: true };
    });
  }

  if (!sent.ok) {
    console.log(`welcome to ${email} failed (${sent.error}); the sender retries it on its next run`);
    return { enrolled: email, recordId: result.recordId, welcome: "failed", error: sent.error } satisfies Outcome;
  }
  return {
    enrolled: email,
    recordId: result.recordId,
    welcome: sent.duplicate ? "already-sent" : "sent",
  } satisfies Outcome;
});
