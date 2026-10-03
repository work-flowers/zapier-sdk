// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/zapier-error-email-to-triage
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";

const sdk = createZapierSdk();

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
 *  durable in the work.flowers Zapier account, keyed on `Workflow ID`. */
const ZAPS_DS = "261b21a7-7d9a-4d0e-bf8a-4aebcbbdee44";

const ALERT_SENDER = "notifications@mail.zapier.com";

/** Status options on the triage data source. A repeat of a `Resolved` ticket
 *  reopens it; `Won't fix` is a deliberate verdict and stays closed. */
const STATUS_NEW = "Untriaged";
const STATUS_REOPENABLE = new Set(["Resolved"]);

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

function signatureFor(alert: Alert): string {
  const normalised = normaliseMessage(alert.message).slice(0, SIGNATURE_MESSAGE_MAX) || "-";
  return [alert.workflowId, ERROR_TYPE_LABEL[alert.kind], normalised].join(" · ");
}

function ticketTitle(alert: Alert): string {
  const msg = normaliseMessage(alert.message);
  return `${alert.zapName} · ${msg.length > 100 ? `${msg.slice(0, 100)}…` : msg}`;
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
  const signature = signatureFor(alert);

  // Resolve the Zap row, which doubles as the account filter: Knoxx Zaps alert
  // the same inbox but are not in the work.flowers Zaps table.
  const zap = await ctx.step("find-zap", async () => {
    const page = await queryOne(ZAPS_DS, {
      property: "Workflow ID",
      rich_text: { equals: alert.workflowId },
    });
    return page ? { id: String(page.id) } : null;
  });
  if (!zap) {
    console.log(`skipping: workflow ${alert.workflowId} (${alert.zapName}) is not in the work.flowers Zaps table`);
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
    };
  });

  if (existing) {
    const reopen = existing.status !== null && STATUS_REOPENABLE.has(existing.status);
    await ctx.step("update-ticket", async () => {
      const properties: Record<string, unknown> = {
        Occurrences: { number: existing.occurrences + 1 },
        "Last Seen": { date: { start: seenAt } },
        "Error Message": { rich_text: richText(alert.message) },
      };
      if (reopen) properties.Status = { status: { name: STATUS_NEW } };
      if (!existing.zapLinked) properties.Zap = { relation: [{ id: zap.id }] };
      await notion(`/pages/${existing.id}`, "PATCH", { properties });
      return null;
    });
    return {
      action: "updated",
      ticketId: existing.id,
      signature,
      occurrences: existing.occurrences + 1,
      reopened: reopen,
    };
  }

  const created = await ctx.step("create-ticket", async () => {
    const page = await createPageWithTemplate({
      Ticket: { title: richText(ticketTitle(alert)) },
      Signature: { rich_text: richText(signature) },
      Zap: { relation: [{ id: zap.id }] },
      "Error Type": { rich_text: richText(ERROR_TYPE_LABEL[alert.kind]) },
      "Error Message": { rich_text: richText(alert.message) },
      Occurrences: { number: 1 },
      "First Seen": { date: { start: seenAt } },
      "Last Seen": { date: { start: seenAt } },
      Status: { status: { name: STATUS_NEW } },
    });
    return { id: String(page?.id ?? ""), url: firstString(page?.url) };
  });

  return { action: "created", ticketId: created.id, url: created.url, signature };
});

export default workflow;
