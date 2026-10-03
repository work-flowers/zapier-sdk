// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/zapier-error-email-to-triage
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import {
  createZapierSdk as createExperimentalSdk,
  createZapierApi,
  ZAPIER_BASE_URL,
} from "@zapier/zapier-sdk/experimental";

const sdk = createZapierSdk();
// Code Workflows surface (getWorkflow, getDurableRun) and its raw API client,
// both on the durable's own ambient credentials. Verified 2026-10-03 with
// run-durable: inside the sandbox these read the work.flowers account's
// workflows and run history with no extra connection. `any` because the
// experimental method shapes shift release to release.
const workflows = createExperimentalSdk() as any;
const zapierApi = createZapierApi({ baseUrl: ZAPIER_BASE_URL } as any) as any;

// --- Bindings --------------------------------------------------------------
// The Gmail credential lives on the TRIGGER (zap.json trigger.authentication_id);
// the workflow code never calls Gmail.
const NOTION_CONNECTION = "notion_wf";
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

/** "Zapier Error Triage". Formerly the zapier-durables-docs worker's managed
 *  `errors` database; detached from the worker 2026-10-03, so every column is
 *  ordinary and writable. */
const TRIAGE_DS = "db78a092-515d-40e6-9416-aab114460f86";

/** "Zapier Zaps", still synced daily by the worker's `zapsSync`. One row per
 *  durable in the work.flowers Zapier account, keyed on `Workflow ID`. Used
 *  only to link the ticket — a Zap deployed since the last sync has no row yet,
 *  and still gets its ticket. */
const ZAPS_DS = "261b21a7-7d9a-4d0e-bf8a-4aebcbbdee44";

/** "Zapier Zap Runs", synced daily by the worker's `runsDelta`, keyed on
 *  `Run ID`. The failed run usually has no row yet when the alert arrives; it
 *  is linked when a later recurrence of the same signature finds it. */
const RUNS_DS = "1714cb13-d1b1-4cab-9d2e-c56aadbfda47";

/** The `Zap Runs` relation is a sample, newest first; `Occurrences` is the
 *  count. Same cap the worker used. */
const MAX_RUNS_PER_TICKET = 25;

/** Which failed run an alert email is about. Observed 2026-09: the email lands
 *  ~2s after the run's `updated_at`. The window is generous on the early side
 *  (a run that retried for minutes) and allows a little clock skew late. */
const RUN_MATCH_BEFORE_MS = 30 * 60 * 1000;
const RUN_MATCH_AFTER_MS = 2 * 60 * 1000;
/** Run history pages are newest-first, 100 a page. A busy Zap does ~100 runs a
 *  day, so this reaches a few days back — far past any alert we act on. */
const MAX_RUN_PAGES = 10;

const ALERT_SENDER = "notifications@mail.zapier.com";

/** Status options on the triage data source. A repeat of a `Resolved` ticket
 *  reopens it; `Won't fix` is a deliberate verdict and stays closed. */
const STATUS_NEW = "Untriaged";
const STATUS_REOPENABLE = new Set(["Resolved"]);

/** Title message length, as the worker had it. */
const TITLE_MESSAGE_MAX = 70;

/** How much of the normalised message the signature keeps. Same as the
 *  worker's errorsDelta used, so the key length stays familiar. */
const SIGNATURE_MESSAGE_MAX = 120;

/** Notion rich text caps at 2000 characters per value. */
const TEXT_MAX_CHARS = 1900;

// --- Pure helpers ----------------------------------------------------------
function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline can deliver input double-encoded (a JSON string of a
  // JSON string), while run-durable delivers it single-encoded.
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

/** Empty = no keys, or only wrapper keys with nothing in them. See the shared
 *  rules: a polling Gmail trigger should never deliver this, but a manual
 *  `trigger-workflow` or a test run can. */
function isEmptyPing(raw: unknown): boolean {
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

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

function clip(text: string, max = TEXT_MAX_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}… (truncated)` : text;
}

/**
 * Strip the parts of an error message that vary between otherwise identical
 * failures. Ported from the worker's errorsDelta, where every rule was driven
 * by a message actually observed (appended JSON payload dumps, ids, ISO and
 * US-format timestamps, semver). Quoted substrings are kept on purpose — they
 * are usually the discriminating part (`Step "update-contact-record"`).
 */
function normaliseMessage(message: string): string {
  let text = message.replace(/\s+/g, " ").trim();
  text = text.replace(/:\s*[[{].*$/, "");
  text = text.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    "<id>",
  );
  text = text.replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, "<ts>");
  text = text.replace(/\b\d{1,2}\/\d{1,2}\/\d{4},? \d{1,2}:\d{2}(:\d{2})? ?[AP]M\b/g, "<ts>");
  text = text.replace(/\b\d+\.\d+\.\d+\b/g, "<version>");
  return text.trim();
}

type AlertKind = "error" | "couldnt_run";

/** Subject → kind. Zapier sends exactly these two subjects for Code Zaps:
 *  "had an error" for a failure in our code, "couldn't run" for a Zapier-side
 *  one (the 2026-09-15 platform outage, `upstream_rejected`). */
const SUBJECT_PATTERNS: Array<[RegExp, AlertKind]> = [
  [/^Your Zap "(.+)" had an error$/, "error"],
  [/^Your Zap "(.+)" couldn['’]t run$/, "couldnt_run"],
];

const ERROR_TYPE_LABEL: Record<AlertKind, string> = {
  error: "Zap error",
  couldnt_run: "Couldn't run",
};

interface Alert {
  kind: AlertKind;
  zapName: string;
  workflowId: string;
  message: string;
  receivedAt: string; // raw, parsed to ISO inside a step
  messageId: string | null;
}

/**
 * The alert email's plain-text body, as observed 2026-09-30:
 *
 *   Workflow: slack-thread-to-notion-discussion
 *
 *   Error
 *   SyntaxError: Expected ',', got '}'
 *
 *   Open in workflow manager
 *   (https://zapier.com/workflow/01a05bff-37b5-7b12-b5aa-3bbafe623e84?utm_…)
 *
 * The message is hard-wrapped at ~60 columns, so the lines between `Error` and
 * `Open in workflow manager` are re-joined into one. The workflow id is read
 * off the editor link — it is the only id the email carries.
 */
function parseAlertBody(body: string): { zapName: string | null; workflowId: string | null; message: string | null } {
  const text = body.replace(/\r\n?/g, "\n");
  const zapName = text.match(/^Workflow:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const workflowId =
    text.match(/zapier\.com\/workflow\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1]?.toLowerCase() ?? null;
  const block = text.match(/^Error\s*\n([\s\S]*?)\n\s*Open in workflow manager/m)?.[1] ?? "";
  const message = block.replace(/\s+/g, " ").trim() || null;
  return { zapName, workflowId, message };
}

/**
 * The Gmail payload → an Alert, or a reason it is not one.
 *
 * `not-an-alert` (another sender or subject that slipped through the trigger's
 * fuzzy Gmail search) is a skip. An email that IS a Zapier alert but whose body
 * we cannot parse throws instead: that is a template change on Zapier's side,
 * and silently skipping it is how failures go unticketed.
 */
function extractAlert(raw: unknown): { alert: Alert } | { skip: string } {
  const o = (raw ?? {}) as Record<string, any>;
  const m = (o.message ?? o.data ?? o) as Record<string, any>;
  const subject = firstString(m.subject) ?? "";
  const from = (firstString(m.from?.email, m.from) ?? "").toLowerCase();

  let kind: AlertKind | null = null;
  let subjectZap: string | null = null;
  for (const [re, k] of SUBJECT_PATTERNS) {
    const hit = subject.match(re);
    if (hit) {
      kind = k;
      subjectZap = hit[1];
      break;
    }
  }
  if (!kind || !from.includes(ALERT_SENDER)) {
    if (!subject && !from) {
      throw new Error(
        `Unrecognised payload: no subject or sender. Keys: ${Object.keys(m).slice(0, 20).join(", ")}`,
      );
    }
    return { skip: `not-an-alert: from "${from}", subject "${subject}"` };
  }

  const body = firstString(m.body_plain, m.text_body, m.body) ?? "";
  const parsed = parseAlertBody(body);
  if (!parsed.workflowId || !parsed.message) {
    throw new Error(
      `Zapier alert email "${subject}" did not parse (workflowId=${parsed.workflowId ?? "missing"}, ` +
        `message=${parsed.message ? "ok" : "missing"}) — has the email template changed? ` +
        `Body starts: ${body.replace(/\s+/g, " ").slice(0, 400)}`,
    );
  }
  return {
    alert: {
      kind,
      zapName: parsed.zapName ?? subjectZap ?? parsed.workflowId,
      workflowId: parsed.workflowId,
      message: parsed.message,
      receivedAt: firstString(m.date, m.internal_date, m.received_at) ?? "",
      messageId: firstString(m.message_id, m.id),
    },
  };
}

/**
 * What a ticket is keyed and titled on. Built from the failed RUN when it can be
 * found — then it matches the worker's errorsDelta tickets exactly, so a fault
 * ticketed before 2026-10-03 recurs onto its existing ticket — and from the
 * email alone when it cannot.
 */
interface Failure {
  errorType: string;
  message: string;
  failingStep: string | null;
  runId: string | null;
  durableRunId: string | null;
  at: string | null; // run created_at, when known
}

function failureFromAlert(alert: Alert): Failure {
  return {
    errorType: ERROR_TYPE_LABEL[alert.kind],
    message: alert.message,
    failingStep: null,
    runId: null,
    durableRunId: null,
    at: null,
  };
}

/** The worker's `errorType` / `errorMessage`: `details.name` is the useful one
 *  (`StepExhaustedError`, `DeterminismViolation`); the outer code
 *  (`execution_failed`, `upstream_rejected`) is the fallback. */
function failureFromRun(run: any): Failure {
  const e = run?.error ?? {};
  return {
    errorType: firstString(e?.details?.name, e?.code) ?? "unknown",
    message: firstString(e?.details?.message, e?.message) ?? "",
    failingStep: null,
    runId: firstString(run?.id),
    durableRunId: firstString(run?.durable_run_id),
    at: firstString(run?.created_at),
  };
}

function signatureOf(workflowId: string, f: Failure): string {
  const normalised = normaliseMessage(f.message).slice(0, SIGNATURE_MESSAGE_MAX) || "-";
  return [workflowId, f.errorType, normalised].join(" · ");
}

/** The worker's title: the failing step when the journal named one, else the
 *  message — `<zap> · Error` alone was unusable in a list. */
function titleOf(zapName: string, f: Failure): string {
  if (f.failingStep) return `${zapName} · ${f.errorType} in ${f.failingStep}`;
  const normalised = normaliseMessage(f.message);
  if (!normalised) return `${zapName} · ${f.errorType}`;
  const summary =
    normalised.length > TITLE_MESSAGE_MAX ? `${normalised.slice(0, TITLE_MESSAGE_MAX).trimEnd()}…` : normalised;
  return `${zapName} · ${f.errorType}: ${summary}`;
}

/**
 * The failed run this alert is about: status `failed`, not an editor draft
 * run, finished within the match window around the email, closest wins.
 * `runs` are raw API rows; `seenAtMs` is the email's timestamp.
 */
function pickRun(runs: any[], seenAtMs: number): any | null {
  let best: any = null;
  let bestGap = Infinity;
  for (const run of runs) {
    if (run?.status !== "failed" || run?.kind === "draft") continue;
    const t = Date.parse(run.updated_at ?? run.created_at ?? "");
    if (Number.isNaN(t)) continue;
    if (t < seenAtMs - RUN_MATCH_BEFORE_MS || t > seenAtMs + RUN_MATCH_AFTER_MS) continue;
    const gap = Math.abs(seenAtMs - t);
    if (gap < bestGap) {
      best = run;
      bestGap = gap;
    }
  }
  return best;
}

/** The last operation that did not complete — the worker's `failureDetail`.
 *  Earlier non-completed ones can retry and recover. */
function failingOperation(ops: any[]): { step: string | null; cause: string | null } {
  const failed = ops.filter((op) => op?.status && op.status !== "completed");
  const last = failed[failed.length - 1];
  if (!last) return { step: null, cause: null };
  const parts = [last.error?.name, last.error?.message].filter(Boolean);
  return { step: firstString(last.name), cause: parts.length ? parts.join(": ") : null };
}

function richText(text: string): Array<Record<string, unknown>> {
  return [{ type: "text", text: { content: clip(text) } }];
}

// --- Notion I/O (each must be called inside a ctx.step) ----------------------
async function notion(path: string, method: string, body?: unknown): Promise<any> {
  const res = await sdk.fetch(`${NOTION_API}${path}`, {
    connection: NOTION_CONNECTION,
    method,
    headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Notion ${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`);
    (err as any).status = res.status;
    (err as any).body = text;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

async function queryOne(dataSource: string, filter: unknown): Promise<any | null> {
  const json = await notion(`/data_sources/${dataSource}/query`, "POST", { filter, page_size: 2 });
  const results: any[] = Array.isArray(json?.results) ? json.results : [];
  if (results.length > 1) {
    console.log(`warning: ${results.length}+ rows in ${dataSource} matched ${JSON.stringify(filter)}; using the first`);
  }
  return results[0] ?? null;
}

/** Repo rule 5, raw-API form: ask for the data source's default template, and
 *  retry without it when the data source has none. */
async function createPageWithTemplate(properties: Record<string, unknown>): Promise<any> {
  const parent = { type: "data_source_id", data_source_id: TRIAGE_DS };
  try {
    return await notion("/pages", "POST", { parent, properties, template: { type: "default" } });
  } catch (err) {
    const status = (err as any)?.status;
    const body = String((err as any)?.body ?? "");
    if (status !== 400 || !/template/i.test(body)) throw err;
    return await notion("/pages", "POST", { parent, properties });
  }
}

function numberProp(page: any, name: string): number {
  const v = page?.properties?.[name]?.number;
  return typeof v === "number" ? v : 0;
}

function statusProp(page: any, name: string): string | null {
  return page?.properties?.[name]?.status?.name ?? null;
}

function relationIds(page: any, name: string): string[] {
  const rel = page?.properties?.[name]?.relation;
  return Array.isArray(rel) ? rel.map((r: any) => String(r.id)) : [];
}

// --- Zapier I/O (each must be called inside a ctx.step) ---------------------

/** True for a workflow in this account, false for one Zapier cannot find —
 *  which is what a Knoxx-account Zap's id gets (verified 2026-10-03). Anything
 *  else throws, so a transient failure retries instead of skipping a real Zap. */
async function workflowInAccount(workflowId: string): Promise<boolean> {
  try {
    await workflows.getWorkflow({ workflow: workflowId });
    return true;
  } catch (err) {
    if (/not found/i.test(String((err as Error)?.message ?? err))) return false;
    throw err;
  }
}

/**
 * Walk the workflow's run history newest-first until it is older than the
 * match window, then pick the run. Through the raw API client rather than
 * `listWorkflowRuns`: the SDK's response schema rejects a whole page that
 * contains an editor draft run (no `trigger_id`), the same reason the worker
 * switched (notion-workers zapier-durables-docs CLAUDE.md).
 */
async function findFailedRun(workflowId: string, seenAtMs: number): Promise<any | null> {
  const floor = seenAtMs - RUN_MATCH_BEFORE_MS;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_RUN_PAGES; page++) {
    const searchParams: Record<string, string> = { limit: "100" };
    if (cursor) searchParams.cursor = cursor;
    const res = await zapierApi.get(
      `/code-substrate-workflows/api/v0/workflows/${encodeURIComponent(workflowId)}/runs`,
      { searchParams, authRequired: true },
    );
    const runs: any[] = Array.isArray(res?.results) ? res.results : [];
    const hit = pickRun(runs, seenAtMs);
    if (hit) return hit;
    const oldest = runs.length ? Date.parse(runs[runs.length - 1]?.created_at ?? "") : NaN;
    cursor = res?.meta?.next_cursor ?? undefined;
    if (!cursor || Number.isNaN(oldest) || oldest < floor) return null;
  }
  return null;
}

// --- Workflow --------------------------------------------------------------
const workflow = defineDurable("zapier-error-email-to-triage", async (ctx, rawInput) => {
  const payload = normalizeInput(rawInput);
  if (isEmptyPing(payload)) {
    console.log("empty payload, skipping");
    return { skipped: "empty-payload" };
  }

  const extracted = extractAlert(payload);
  if ("skip" in extracted) {
    console.log(`skipping: ${extracted.skip}`);
    return { skipped: extracted.skip };
  }
  const alert = extracted.alert;

  // Knoxx-account Zaps alert the same inbox. Asking Zapier directly, rather
  // than the daily-synced Zaps table, means a brand-new work.flowers Zap is
  // never mistaken for a foreign one.
  const inAccount = await ctx.step("check-account", async () => workflowInAccount(alert.workflowId));
  if (!inAccount) {
    console.log(`skipping: workflow ${alert.workflowId} (${alert.zapName}) is not in the work.flowers account`);
    return { skipped: "not-a-work.flowers-zap", workflowId: alert.workflowId, zapName: alert.zapName };
  }

  // The email's own timestamp, not the run's clock — Date lives in a step.
  const seenAt = await ctx.step("seen-at", async () => {
    const parsed = alert.receivedAt ? Date.parse(alert.receivedAt) : NaN;
    const ms = Number.isNaN(parsed)
      ? Number.isNaN(Number(alert.receivedAt)) || !alert.receivedAt
        ? Date.now()
        : Number(alert.receivedAt)
      : parsed;
    return new Date(ms).toISOString();
  });

  // Run detail is enrichment: if it cannot be found the ticket is still made,
  // from the email alone.
  const run = await ctx.step("find-run", async () => {
    try {
      return await findFailedRun(alert.workflowId, Date.parse(seenAt));
    } catch (err) {
      console.log(`run lookup failed, falling back to the email: ${String((err as Error)?.message ?? err).slice(0, 300)}`);
      return null;
    }
  });

  const failure: Failure = run ? failureFromRun(run) : failureFromAlert(alert);
  if (!run) console.log(`no matching failed run found for ${alert.workflowId} near ${seenAt}; using the email`);

  if (failure.durableRunId) {
    const durableRunId = failure.durableRunId;
    const detail = await ctx.step("run-journal", async () => {
      try {
        const res = await workflows.getDurableRun({ run: durableRunId });
        const ops: any[] = res?.data?.execution?.operations ?? [];
        return failingOperation(ops);
      } catch (err) {
        console.log(`getDurableRun failed for ${durableRunId}: ${String((err as Error)?.message ?? err).slice(0, 300)}`);
        return { step: null, cause: null };
      }
    });
    failure.failingStep = detail.step;
    // The root cause is what someone acts on, and the run's own error often
    // names none ("Step … exhausted all retry attempts"). Logged for run
    // history; the ticket body belongs to whoever triages (see README).
    if (detail.cause) console.log(`root cause: ${detail.cause.slice(0, 500)}`);
  }

  const signature = signatureOf(alert.workflowId, failure);
  const occurredAt = failure.at ?? seenAt;

  const links = await ctx.step("find-links", async () => {
    const zapPage = await queryOne(ZAPS_DS, { property: "Workflow ID", rich_text: { equals: alert.workflowId } });
    const runPage = failure.runId
      ? await queryOne(RUNS_DS, { property: "Run ID", rich_text: { equals: failure.runId } })
      : null;
    return { zapId: zapPage ? String(zapPage.id) : null, runRowId: runPage ? String(runPage.id) : null };
  });

  const existing = await ctx.step("find-ticket", async () => {
    const page = await queryOne(TRIAGE_DS, {
      property: "Signature",
      rich_text: { equals: signature },
    });
    if (!page) return null;
    return {
      id: String(page.id),
      occurrences: numberProp(page, "Occurrences"),
      status: statusProp(page, "Status"),
      zapLinked: relationIds(page, "Zap").length > 0,
      runIds: relationIds(page, "Zap Runs"),
    };
  });

  if (existing) {
    const reopen = existing.status !== null && STATUS_REOPENABLE.has(existing.status);
    await ctx.step("update-ticket", async () => {
      const properties: Record<string, unknown> = {
        Occurrences: { number: existing.occurrences + 1 },
        "Last Seen": { date: { start: occurredAt } },
        "Error Message": { rich_text: richText(failure.message) },
      };
      if (failure.failingStep) properties["Failing Step"] = { rich_text: richText(failure.failingStep) };
      if (reopen) properties.Status = { status: { name: STATUS_NEW } };
      if (!existing.zapLinked && links.zapId) properties.Zap = { relation: [{ id: links.zapId }] };
      if (links.runRowId && !existing.runIds.includes(links.runRowId)) {
        const ids = [links.runRowId, ...existing.runIds].slice(0, MAX_RUNS_PER_TICKET);
        properties["Zap Runs"] = { relation: ids.map((id) => ({ id })) };
      }
      await notion(`/pages/${existing.id}`, "PATCH", { properties });
      return null;
    });
    return {
      action: "updated",
      ticketId: existing.id,
      signature,
      occurrences: existing.occurrences + 1,
      reopened: reopen,
      runFound: Boolean(run),
    };
  }

  const created = await ctx.step("create-ticket", async () => {
    const properties: Record<string, unknown> = {
      Ticket: { title: richText(titleOf(alert.zapName, failure)) },
      Signature: { rich_text: richText(signature) },
      "Error Type": { rich_text: richText(failure.errorType) },
      "Error Message": { rich_text: richText(failure.message) },
      Occurrences: { number: 1 },
      "First Seen": { date: { start: occurredAt } },
      "Last Seen": { date: { start: occurredAt } },
      Status: { status: { name: STATUS_NEW } },
    };
    if (failure.failingStep) properties["Failing Step"] = { rich_text: richText(failure.failingStep) };
    if (links.zapId) properties.Zap = { relation: [{ id: links.zapId }] };
    if (links.runRowId) properties["Zap Runs"] = { relation: [{ id: links.runRowId }] };
    const page = await createPageWithTemplate(properties);
    return { id: String(page?.id ?? ""), url: firstString(page?.url) };
  });

  return { action: "created", ticketId: created.id, url: created.url, signature, runFound: Boolean(run) };
});

export default workflow;
