// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/multi-wavy-whatsapp-forwarder
//
// Pure helpers behind the multi-wavy-whatsapp-forwarder build spec. NOTHING here
// runs on Zapier: the four classic Zaps are built by hand from forwarder-spec.json,
// and these helpers exist so the tests can replay what Zapier does with that spec
// (token substitution into the Webhooks "Data" fields) and check the result
// against the receiving handler's contract.

/** One Zap definition in forwarder-spec.json. */
export interface ZapSpec {
  zap_name: string;
  branch_label: string;
  kind: "message" | "status";
  trigger: { event: string; connection_id: string };
  data_mapping: Record<string, string>;
}

export interface ForwarderSpec {
  forbidden_connection_ids: Record<string, string>;
  target: { url: string; method: string; secret_header: string; secret_source: string };
  zaps: ZapSpec[];
}

export type Flat = Record<string, string>;

/**
 * Flatten a trigger payload the way Zapier presents it to the next step:
 * nested objects become `parent__child` keys, null/undefined become "".
 * (`{ text: { body: "hi" } }` -> `{ text__body: "hi" }`.) Arrays are JSON-encoded.
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

/**
 * Replay the Webhooks step's Data mapping: a value of exactly `{{field}}` takes
 * the trigger's flattened field (empty string when absent, like a blank Zapier
 * token); anything else is a literal. Every value comes out a string, which is
 * what the Webhooks "json" payload type sends.
 */
export function renderMapping(mapping: Record<string, string>, triggerPayload: unknown): Record<string, string> {
  const flat = flatten(triggerPayload);
  const out: Record<string, string> = {};
  for (const [key, template] of Object.entries(mapping)) {
    const m = /^\{\{([A-Za-z0-9_]+)\}\}$/.exec(template);
    out[key] = m ? (flat[m[1]!] ?? "") : template;
  }
  return out;
}

/**
 * The Filter step in front of the Webhooks step ("only continue if id exists",
 * and for status Zaps also "status exists"). The handler would 400 these anyway
 * (and log a rejected row), so stop them before they cost a task.
 */
export function passesFilter(kind: ZapSpec["kind"], body: Record<string, string>): boolean {
  if (!(body["id"] ?? "").trim()) return false;
  if (kind === "status" && !(body["status"] ?? "").trim()) return false;
  return true;
}

export type Contract =
  | { ok: true; kind: "message" | "status"; wamid: string; status: string; deliveryId: string; providerTs: string | null }
  | { ok: false; error: string; httpStatus: number };

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v)).trim();

/** Mirror of handler `tsOf` (multi-wavy-numbers src/lib/zapier-inbound.server.ts). */
function tsOf(s: unknown): string | null {
  if (s === null || s === undefined || s === "") return null;
  const n = Number(s);
  const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(s));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Mirror of the validation in `handleZapierInbound` AFTER the secret check:
 * bad JSON, non-object body, kind not message|status, missing id, status kind
 * without status. Takes the raw request body text, as the handler does.
 * Keep in sync with multi-wavy-numbers src/lib/zapier-inbound.server.ts.
 */
export function checkHandlerContract(rawBody: string): Contract {
  let p: unknown;
  try {
    p = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: "invalid JSON", httpStatus: 400 };
  }
  if (!p || typeof p !== "object") return { ok: false, error: "body is not a JSON object", httpStatus: 400 };
  const o = p as Record<string, unknown>;
  const kind = str(o["kind"]);
  const wamid = str(o["id"]);
  if (kind !== "message" && kind !== "status") {
    return { ok: false, error: `kind must be "message" or "status" (got "${kind}")`, httpStatus: 400 };
  }
  if (!wamid) return { ok: false, error: "missing id (wamid)", httpStatus: 400 };
  const status = str(o["status"]).toLowerCase();
  if (kind === "status" && !status) return { ok: false, error: "missing status", httpStatus: 400 };
  const deliveryId = kind === "message" ? `zap:message:${wamid}` : `zap:status:${wamid}:${status}`;
  return { ok: true, kind, wamid, status, deliveryId, providerTs: tsOf(o["timestamp"]) };
}

/** What the Webhooks step actually puts on the wire: a JSON object body. */
export function wireBody(body: Record<string, string>): string {
  return JSON.stringify(body);
}

/**
 * Hard refusal of the live production connection (and anything not listed as a
 * test connection). Throws; the tests call it on the spec as committed.
 */
export function assertSpecSafe(spec: ForwarderSpec): void {
  const forbidden = new Set(Object.keys(spec.forbidden_connection_ids));
  const seen = new Set<string>();
  for (const z of spec.zaps) {
    const id = z.trigger.connection_id;
    if (!id) throw new Error(`${z.zap_name}: no explicit connection id`);
    if (forbidden.has(id)) throw new Error(`${z.zap_name}: refuses to bind live connection ${id}`);
    seen.add(`${z.branch_label}|${id}`);
  }
  if (!spec.target.secret_header) throw new Error("target.secret_header must be set");
  // The secret must never be inlined in the spec: header NAME only, plus where it is typed.
  const blob = JSON.stringify(spec);
  if (/secret"\s*:\s*"[A-Za-z0-9+/=_-]{20,}"/i.test(blob)) throw new Error("spec appears to inline a secret value");
}
