// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/multi-wavy-whatsapp-forwarder
//
// Pure logic shared by the two Multi-Wavy WhatsApp durables
// (multi-wavy-whatsapp-branch-a/ and multi-wavy-whatsapp-branch-b/). No imports and
// no I/O, so the tests run it under plain `node --test` and the durables publish it
// as an extra `source_files` entry next to `workflow.ts`.
//
// CANONICAL COPY: this file. The publisher reads only files inside a Zap's own
// directory, so each branch directory carries a BYTE-IDENTICAL copy named
// `forwarder-core.ts`; forward.test.ts fails if a copy drifts. Edit here, then copy:
//   cp multi-wavy-whatsapp-forwarder/forwarder-core.ts multi-wavy-whatsapp-branch-a/
//   cp multi-wavy-whatsapp-forwarder/forwarder-core.ts multi-wavy-whatsapp-branch-b/

/** The Lovable app's inbound webhook. Contract: multi-wavy-numbers src/lib/zapier-inbound.server.ts. */
export const FORWARD_URL = "https://multi-wavy-numbers.lovable.app/api/public/zapier/whatsapp";

/**
 * The LIVE +65 production WhatsApp connection (consumed by whatsapp-slack-bridge, and
 * the default the Zapier UI/MCP may preselect). NEVER bound to a Multi-Wavy Zap.
 */
export const LIVE_CONNECTION_ID = "0240f561-4036-869d-bd75-4f2f28101022";

/** The live line's display number, digits only (BUSINESS_PHONE in whatsapp-slack-bridge/shared.ts). */
export const LIVE_DISPLAY_DIGITS = "6580839785";

export interface Branch {
  /** Sent as `branch_label`; the app maps a number by this when phone_number_id is unknown. */
  label: string;
  /** The test WhatsApp connection this durable's trigger is bound to. */
  connectionId: string;
  /** The branch's own display number, digits only (country code included). */
  displayDigits: string;
}

export type Flat = Record<string, string>;

/**
 * Flatten a trigger payload the way Zapier presents it to the next step:
 * nested objects become `parent__child` keys, null/undefined become "".
 * (`{ text: { body: "hi" } }` -> `{ text__body: "hi" }`.) Arrays are JSON-encoded.
 * The durable runtime delivers a NESTED payload (whatsapp-slack-bridge reads
 * `p.text?.body`) while the app handler wants the FLAT `text__body` key, so this is the
 * bridge between the two; a payload that already carries `text__body` passes through.
 */
export function flatten(payload: unknown, prefix = ""): Flat {
  const out: Flat = {};
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return out;
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    const key = prefix ? `${prefix}__${k}` : k;
    if (v === null || v === undefined) out[key] = "";
    else if (Array.isArray(v)) out[key] = JSON.stringify(v);
    else if (typeof v === "object") Object.assign(out, flatten(v, key));
    else out[key] = String(v);
  }
  return out;
}

const digits = (s: string) => s.replace(/\D+/g, "");

/**
 * Hard refusal of the live production line. Throws; called first thing in every run.
 * Checked by connection id (the binding) and by display number (the payload), and the
 * branch must be fully specified.
 */
export function assertBranchSafe(branch: Branch): void {
  if (!branch.label.trim()) throw new Error("branch label must be set");
  if (!branch.connectionId.trim()) throw new Error(`${branch.label}: no explicit connection id`);
  if (branch.connectionId.trim().toLowerCase() === LIVE_CONNECTION_ID) {
    throw new Error(`${branch.label}: refuses to bind the live production connection ${LIVE_CONNECTION_ID}`);
  }
  if (!branch.displayDigits || digits(branch.displayDigits) === LIVE_DISPLAY_DIGITS) {
    throw new Error(`${branch.label}: refuses the live production display number`);
  }
}

/**
 * The trigger pipeline can deliver input double-encoded (a JSON string of a JSON
 * string), while run-durable delivers it single-encoded. Unwrap up to four layers.
 */
export function normalizeInput(rawInput: unknown): unknown {
  let v: unknown = rawInput;
  for (let i = 0; i < 4 && typeof v === "string"; i++) {
    const t = v.trim();
    if (t[0] !== "{" && t[0] !== "[" && t[0] !== '"') break;
    try {
      v = JSON.parse(t);
    } catch {
      break;
    }
  }
  return v;
}

/**
 * No keys, or only known wrapper keys (`querystring`, `headers`, `params`, `body`,
 * `query`) whose values are empty. A wrapper with something in it is real content.
 * Same boundary as isEmptyPing in xero-contact-from-notion-deal/workflow.ts.
 */
export function isEmptyPing(raw: unknown): boolean {
  if (raw === null || raw === undefined || raw === "") return true;
  if (typeof raw !== "object") return false;
  const WRAPPER_KEYS = new Set(["querystring", "headers", "params", "body", "query"]);
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!WRAPPER_KEYS.has(key)) return false;
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object" && Object.keys(value as object).length === 0) continue;
    return false;
  }
  return true;
}

/** The JSON object POSTed to the app for a `new_message` event. Every value is a string. */
export interface ForwardBody {
  kind: "message";
  branch_label: string;
  id: string;
  from: string;
  text__body: string;
  type: string;
  timestamp: string;
  phone_number_id: string;
  display_phone_number: string;
}

export type Prepared =
  | { action: "skip"; reason: "empty-payload" }
  | { action: "forward"; body: ForwardBody };

/**
 * Turn one trigger delivery into the app's body, or decide to skip it.
 *
 *  - Refuses the live line first (assertBranchSafe).
 *  - EMPTY payload -> skip (a manual `trigger-workflow` with no input, an editor test,
 *    a replay of nothing). This trigger is an app trigger, not a public catch URL, so a
 *    stray hit cannot cause it, but the shared repo rule still applies: an empty
 *    delivery is not an event and must not raise an alert. The caller logs the skip.
 *  - NON-EMPTY payload with no usable wamid -> THROW. That is a real event whose shape
 *    we failed to understand (Meta or the WhatsApp app changed it), and the repo's
 *    default mechanism for that is a red run plus a Zapier alert, never a silent skip.
 *    The message names the keys it saw, never their values (message text is private).
 *  - A payload whose display_phone_number is present and is not this branch's number
 *    -> THROW: forwarding it would file another line's traffic under this branch.
 *    An absent display number is tolerated (the app falls back to branch_label).
 */
export function prepareForward(branch: Branch, rawInput: unknown): Prepared {
  assertBranchSafe(branch);
  const payload = normalizeInput(rawInput);
  if (isEmptyPing(payload)) return { action: "skip", reason: "empty-payload" };
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`unrecognized new_message payload: expected an object, got ${Array.isArray(payload) ? "array" : typeof payload}`);
  }
  const flat = flatten(payload);
  const id = (flat["id"] ?? "").trim();
  if (!id) {
    throw new Error(
      `unrecognized new_message payload: no usable id (wamid); keys seen: ${Object.keys(flat).sort().join(", ") || "(none)"}`,
    );
  }
  const display = digits(flat["display_phone_number"] ?? "");
  if (display === LIVE_DISPLAY_DIGITS) {
    throw new Error(`${branch.label}: payload is from the live production line; refusing to forward`);
  }
  if (display && display !== branch.displayDigits) {
    throw new Error(
      `${branch.label}: payload display_phone_number (…${display.slice(-4)}) is not this branch's number (…${branch.displayDigits.slice(-4)}); refusing to forward under the wrong label`,
    );
  }
  return {
    action: "forward",
    body: {
      kind: "message",
      branch_label: branch.label,
      id,
      from: flat["from"] ?? "",
      text__body: flat["text__body"] ?? "",
      type: flat["type"] ?? "",
      timestamp: flat["timestamp"] ?? "",
      phone_number_id: flat["phone_number_id"] ?? "",
      display_phone_number: flat["display_phone_number"] ?? "",
    },
  };
}

// ---- Retry classification ---------------------------------------------------
//
// The rule (durables-sdk.md): only retry an error that guarantees no write happened,
// OR a write whose replay provably lands in the same state. A POST that times out or
// 5xxs is ambiguous about whether the app wrote. It is still safe to replay HERE
// because the handler is idempotent on the wamid: it upserts the event row on
// delivery_id `zap:message:<wamid>` (ignoreDuplicates) and the message row on
// wa_message_id (ignoreDuplicates), so a second delivery of the same message answers
// `deduped: true` and writes nothing. Replaying the call lands in the same state.
// The one blind spot: if the first attempt stored the event row and then failed
// processing (500 "processing failed"), the replay is deduped and does not re-process;
// that is the handler's gap, not something a durable-side retry can fix, and it is
// no worse than not retrying.
//
// Everything else (401 secret rejected, 400 contract, 413) is a genuine rejection that
// a replay cannot change. Those are returned, not thrown, so the run fails with the
// app's own message instead of the step's "exhausted all retry attempts".

export type Verdict = "ok" | "retry" | "reject";

export type AttemptOutcome =
  | { kind: "response"; status: number }
  | { kind: "error"; code?: string; statusCode?: number; retryable?: boolean };

const PERMANENT_ERROR_CODES = new Set([
  "ZAPIER_VALIDATION_ERROR",
  "ZAPIER_AUTHENTICATION_ERROR",
  "ZAPIER_CONFIGURATION_ERROR",
  "ZAPIER_APPROVAL_ERROR",
]);

export function classifyAttempt(outcome: AttemptOutcome): Verdict {
  if (outcome.kind === "response") {
    const s = outcome.status;
    if (s >= 200 && s < 300) return "ok";
    if (s === 408 || s === 429 || s >= 500) return "retry";
    return "reject";
  }
  if (outcome.retryable === false) return "reject";
  if (outcome.code && PERMANENT_ERROR_CODES.has(outcome.code)) return "reject";
  const s = outcome.statusCode;
  if (typeof s === "number" && s >= 400 && s < 500 && s !== 408 && s !== 429) return "reject";
  // No status at all (network failure, timeout, relay hiccup) or a 5xx/429/408.
  return "retry";
}

/** Pull the fields classifyAttempt needs off whatever sdk.fetch threw. */
export function outcomeFromError(err: unknown): AttemptOutcome {
  const e = (err ?? {}) as { code?: unknown; statusCode?: unknown; retryable?: unknown };
  return {
    kind: "error",
    ...(typeof e.code === "string" ? { code: e.code } : {}),
    ...(typeof e.statusCode === "number" ? { statusCode: e.statusCode } : {}),
    ...(typeof e.retryable === "boolean" ? { retryable: e.retryable } : {}),
  };
}
