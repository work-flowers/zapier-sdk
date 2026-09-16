// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/new-authentication-alert
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
const SLACK_APP_KEY = "SlackCLIAPI";
const SLACK_CONNECTION = "slack_wf";
// Dennis's Slack user id — a direct message, not a channel.
const SLACK_DM_TARGET = "U07SZ8SA760";

// New connections created by this account holder are expected (it's Dennis
// wiring up Zaps); the alert is for connections added by ANYONE ELSE.
const SELF_EMAIL = "dennis@work.flowers";

// The Zapier Manager "New Authentication" trigger delivers an authentication
// record; accept anything and extract defensively.
const InputSchema = z.unknown();

// --- Pure helpers ----------------------------------------------------------
function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline can deliver input double-encoded (a JSON string of a
  // JSON string), while run-durable delivers it single-encoded. Parse until we
  // reach a non-string, or stop on parse failure.
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

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

/** First item of a runAction result ({ data: [...] } or a bare array). */
function firstResult(res: any): any {
  if (res && Array.isArray(res.data)) return res.data[0] ?? null;
  if (Array.isArray(res)) return res[0] ?? null;
  return res ?? null;
}

const WRAPPER_KEYS = new Set(["querystring", "headers", "params", "body", "query"]);

/** True when the payload carries nothing to act on (empty/test tick). Anything
 *  with real content but no usable authentication identity is an unrecognized
 *  event and must throw — see the body. */
function isEmptyish(payload: unknown): boolean {
  if (payload === null || payload === undefined) return true;
  if (typeof payload === "string") return payload.trim() === "";
  if (Array.isArray(payload)) return payload.length === 0;
  if (typeof payload !== "object") return false;
  const entries = Object.entries(payload as Record<string, unknown>);
  if (entries.length === 0) return true;
  return entries.every(([k, v]) => {
    if (!WRAPPER_KEYS.has(k)) return false;
    if (v === null || v === undefined || v === "") return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === "object") return Object.keys(v as object).length === 0;
    return false;
  });
}

/**
 * A human-readable app name derived from a versioned implementation id like
 * `GoogleCalendarCLIAPI@1.16.0` -> `Google Calendar`. Best-effort: strips the
 * `@version` and the `CLIAPI`/`API` suffix, then splits camelCase and digit
 * runs. Ugly for numbered private apps (`App228555CLIAPI` -> `App 228555`),
 * which is why the raw `selected_api` is always shown alongside it.
 */
function friendlyAppName(selectedApi: string): string {
  let s = selectedApi.split("@")[0];
  s = s.replace(/CLIAPI$/, "").replace(/API$/, "");
  s = s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .trim();
  return s || selectedApi;
}

/** ISO `2026-09-15T06:09:08Z` -> `2026-09-15 06:09 UTC`; anything else is
 *  returned unchanged. Pure string work — safe in the workflow body. */
function prettyWhen(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

interface Authentication {
  id: string | null;
  /** The connection's label — usually the account email or a user-set name. */
  title: string | null;
  /** The versioned app implementation id, e.g. `GoogleCalendarCLIAPI@1.16.0`. */
  selectedApi: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

function extractAuth(raw: unknown): Authentication | null {
  const o = (raw ?? {}) as Record<string, any>;
  const d = (o.body ?? o.data ?? o) as Record<string, any>;
  const id = firstString(d.id, d.authentication_id);
  const title = firstString(d.title);
  const selectedApi = firstString(d.selected_api, d.app, d.app_title);
  // Real identity is the auth id; a record with none of these is not an event.
  if (!id && !title && !selectedApi) return null;
  return {
    id,
    title,
    selectedApi,
    createdBy: firstString(d.created_by, d.owner, d.user),
    createdAt: firstString(d.created_at, d.last_updated),
  };
}

/** Build the Slack message. mrkdwn; only lines we actually have are included. */
function buildMessage(a: Authentication): string {
  const lines: string[] = ["*🔐 New authentication added to the work.flowers Zapier account*"];
  if (a.selectedApi) {
    lines.push(`*App:* ${friendlyAppName(a.selectedApi)} (\`${a.selectedApi}\`)`);
  }
  if (a.title) lines.push(`*Connection:* ${a.title}`);
  if (a.createdBy) lines.push(`*Added by:* ${a.createdBy}`);
  if (a.createdAt) lines.push(`*When:* ${prettyWhen(a.createdAt)}`);
  if (a.id) lines.push(`*Auth ID:* ${a.id}`);
  lines.push("Review it at <https://zapier.com/app/assets/connections|Connections>.");
  return lines.join("\n");
}

// --- Workflow --------------------------------------------------------------
// Zapier Manager "New Authentication" -> DM Dennis on Slack when someone OTHER
// than him adds a connection to the work.flowers Zapier account. A security /
// awareness alert. Migration of the classic "New Authentication Alert" Zap,
// with a richer message: the classic showed only the connection label (mislabel-
// ed "App") and who added it; this adds the real app (from `selected_api`), the
// connection label, the timestamp, and the auth id.
//
// Unrecognized non-empty payloads throw (repo default); empty/test ticks skip.
const workflow = defineDurable(
  "new-authentication-alert",
  async (ctx, rawInput: unknown) => {
    const payload = InputSchema.parse(normalizeInput(rawInput));
    const auth = extractAuth(payload);

    if (!auth) {
      if (isEmptyish(payload)) {
        console.log("skipping: empty payload (test tick / empty poll)");
        return { skipped: "empty-payload" };
      }
      throw new Error(
        "Unrecognized Zapier Manager payload: no authentication identity found",
      );
    }

    // "Not me": don't alert on connections Dennis added himself.
    if ((auth.createdBy ?? "").toLowerCase() === SELF_EMAIL) {
      console.log(`skipping ${auth.id}: created by ${SELF_EMAIL}`);
      return { skipped: "own-connection", authId: auth.id };
    }

    const text = buildMessage(auth);

    const posted = await ctx.step("dm-dennis", async () =>
      sdk.runAction({
        appKey: SLACK_APP_KEY,
        actionType: "write",
        actionKey: "direct_message",
        connection: SLACK_CONNECTION,
        inputs: {
          channel: SLACK_DM_TARGET,
          text,
          send_multi: "no",
          as_bot: "yes",
          add_edit_link: "no",
          unfurl: "yes",
          link_names: "yes",
        },
      }),
    );

    console.log(`alerted on new authentication ${auth.id} (${auth.selectedApi})`);
    return {
      authId: auth.id,
      app: auth.selectedApi,
      connection: auth.title,
      createdBy: auth.createdBy,
      slackTs: firstString(firstResult(posted)?.ts, firstResult(posted)?.message_ts),
    };
  },
);

export default workflow;
