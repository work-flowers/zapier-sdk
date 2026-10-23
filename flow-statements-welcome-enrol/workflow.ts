// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/flow-statements-welcome-enrol
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";

const sdk = createZapierSdk();

// Enrols each newly confirmed Flow Statements subscriber in the welcome
// sequence by writing one row to the Welcome Sequence Table. Sending is the
// job of flow-statements-welcome-sender, which reads that Table hourly; this
// Zap never talks to Buttondown beyond receiving the trigger.

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
  | { enrolled: string; recordId: string | null; next_send_at: string };

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
  return { enrolled: email, recordId: result.recordId, next_send_at: result.now } satisfies Outcome;
});
