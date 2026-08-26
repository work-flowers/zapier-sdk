// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/agent-chat-session-to-notion
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
const NOTION_APP_KEY = "NotionCLIAPI";
const NOTION_CONNECTION = "notion_wf"; // work.flowers workspace connection

// "Notion Agents Unofficial" — the custom integration built for the
// embeddable-agent-chat Lovable app. Read-only: lists agents/sessions and
// fetches a session's transcript.
const AGENTS_APP_KEY = "App245513CLIAPI";
const AGENTS_CONNECTION = "notion_agents";

// AI by Zapier on Zapier's built-in credentials ("0" = Included in Plan).
// `standard/auto` (1x task) — this is a short-summary workload, exactly what
// Standard is recommended for. Verified on real session transcripts; see the
// README's "Verified behaviour" table before changing tier.
const AI_APP_KEY = "AICLIAPI";
const AI_MODEL = "standard/auto";
const AI_AUTHENTICATION = "0";

// "Agent Chat Sessions" data source (database created 2026-08-26; lives as a
// private page until Dennis files it — the data source id survives the move).
const SESSIONS_DS = "64e3a5e5-846c-4b95-bac6-d149e0284f39";

// A Notion rich_text property value caps at 2000 chars.
const MAX_SUMMARY_CHARS = 1900;
// Transcript context handed to the AI step.
const MAX_PROMPT_TRANSCRIPT_CHARS = 60_000;
// Transcript appended as the page body.
const MAX_BODY_TRANSCRIPT_CHARS = 40_000;

const InputSchema = z.unknown();

// Embedded copy of agent-chat-session-to-notion-prompt.md (the source of
// truth). Edit the markdown, then run `node scripts/check-prompts.mjs --fix`.
const SUMMARY_PROMPT = `You are summarising a chat transcript between a website visitor and "Ask workFlowers", the AI agent embedded on the work.flowers website. The summary is logged to a CRM database and read by the workFlowers team to spot leads and recurring questions.

You are given the transcript, plus the session title and message count as context.

Write a summary of **2–4 sentences, plain text only** (no markdown, no headings, no bullet points), covering:

1. What the visitor wanted or asked about.
2. What the agent answered or did.
3. Any follow-up signal worth acting on: buying intent, a request to talk to a human, contact details volunteered by the visitor, a question the agent could not answer, or visible frustration. If there is no such signal, say so in a short closing clause rather than inventing one.

Rules:

- Be concrete: name the actual topics and products discussed, not generic phrases like "the visitor asked some questions".
- Never quote long passages from the transcript; paraphrase.
- If the transcript is trivial (a greeting, a single test message, gibberish), say exactly that in one sentence — do not pad it.
- Do not include any preamble like "Summary:" — return only the summary text itself.`;

// --- Pure helpers --------------------------------------------------------------

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

/** A bare ping of the public catch URL (browser open, curl, Zapier UI "test"):
 *  no keys, or only known wrapper keys whose values are empty. */
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

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

/** A finite number, preserving absence — a missing count must stay missing,
 *  never become 0. */
function finiteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** First item of a runAction result ({ data: [...] } or a bare array). */
function firstResult(res: any): any {
  if (res && Array.isArray(res.data)) return res.data[0] ?? null;
  if (Array.isArray(res)) return res[0] ?? null;
  return res ?? null;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n\n…(truncated)`;
}

/**
 * Notion's markdown converter is line-based: every line becomes a block, so a
 * BLANK line becomes an empty paragraph block. A "\n\n"-separated transcript
 * therefore rendered with an empty block between every message (seen on the
 * first test page). Single newlines already start a new block, so blank lines
 * add nothing — drop them, except inside fenced code blocks, where a blank
 * line is real content.
 */
function stripBlankLines(md: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === "") continue;
    out.push(line);
  }
  return out.join("\n");
}

/** What the embeddable-agent-chat app POSTs on session end. Every field is
 *  extracted defensively; only the session id is load-bearing. */
interface SessionEndedEvent {
  sessionId: string;
  eventId: string | null;
  endReason: string | null;
  widgetName: string | null;
  agentId: string | null;
  agentName: string | null;
  visitorId: string | null;
  messageCount: number | null;
  startedAt: string | null;
  endedAt: string | null;
}

/**
 * Extract the session.ended event from the webhook payload.
 *
 * The Lovable app sends `{ event: "session.ended", event_id, end_reason,
 * widget: { agent_id, agent_name, name }, session: { notion_session_id,
 * visitor_id, message_count, started_at, ended_at } }`. hook_v2 may hand the
 * body over bare or under a wrapper key, so look in both places. Returns null
 * when no session id is found ANYWHERE — the caller throws on that, because a
 * non-empty payload we can't extract a session id from is a real event whose
 * shape we failed to understand (schema change or bug), never a skip.
 */
function extractEvent(raw: unknown): SessionEndedEvent | null {
  const o = (raw ?? {}) as Record<string, any>;
  // hook_v2 usually delivers the JSON body at the top level; `body`/`data` are
  // the observed wrapper spellings when it doesn't.
  const p = (
    typeof o.body === "object" && o.body !== null
      ? o.body
      : typeof o.data === "object" && o.data !== null
        ? o.data
        : o
  ) as Record<string, any>;
  const session = (p.session ?? {}) as Record<string, any>;
  const widget = (p.widget ?? {}) as Record<string, any>;

  const sessionId = firstString(
    session.notion_session_id,
    session.id,
    p.notion_session_id,
    p.session_id,
  );
  if (!sessionId) return null;

  return {
    sessionId,
    eventId: firstString(p.event_id),
    endReason: firstString(p.end_reason),
    widgetName: firstString(widget.name),
    agentId: firstString(widget.agent_id, p.agent_id),
    agentName: firstString(widget.agent_name),
    visitorId: firstString(session.visitor_id),
    messageCount: finiteNumber(session.message_count),
    startedAt: firstString(session.started_at),
    endedAt: firstString(session.ended_at, p.occurred_at),
  };
}

/** Flatten the structured messages[] into "User: …\n\nAgent: …" when the
 *  pre-flattened `transcript` string is missing. */
function transcriptFromMessages(messages: unknown): string | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const lines: string[] = [];
  for (const m of messages) {
    const text = firstString((m as any)?.text);
    if (!text) continue;
    const role = firstString((m as any)?.role) === "user" ? "User" : "Agent";
    lines.push(`${role}: ${text}`);
  }
  return lines.length > 0 ? lines.join("\n\n") : null;
}

/**
 * Create a Notion data source item, applying the data source's DEFAULT TEMPLATE
 * when one exists (repo rule 5). `template_mode: "default"` throws on a data
 * source with no default template — that one error is caught INSIDE the step
 * (so a template miss doesn't spin the retry loop) and the create retried
 * without the flag. A template and inline `content` are mutually exclusive, so
 * the body is appended in a second write/page_content call.
 */
async function createItemWithTemplate(
  ctx: any,
  stepPrefix: string,
  datasource: string,
  props: Record<string, unknown>,
  contentMarkdown?: string | null,
): Promise<{ pageId: string | null; usedTemplate: boolean }> {
  const created = await ctx.step(`${stepPrefix}-create`, async () => {
    const inputs = { datasource, ...props };
    try {
      const res = await sdk.runAction({
        appKey: NOTION_APP_KEY,
        actionType: "write",
        actionKey: "create_database_item",
        connection: NOTION_CONNECTION,
        inputs: { ...inputs, template_mode: "default" },
      });
      return { res, usedTemplate: true };
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (!/no default template/i.test(msg)) throw err;
      const res = await sdk.runAction({
        appKey: NOTION_APP_KEY,
        actionType: "write",
        actionKey: "create_database_item",
        connection: NOTION_CONNECTION,
        inputs,
      });
      return { res, usedTemplate: false };
    }
  });

  const pageId: string | null = firstResult(created?.res)?.id ?? null;

  if (pageId && contentMarkdown) {
    await ctx.step(`${stepPrefix}-content`, async () =>
      sdk.runAction({
        appKey: NOTION_APP_KEY,
        actionType: "write",
        actionKey: "page_content",
        connection: NOTION_CONNECTION,
        inputs: {
          page_id: pageId,
          content: contentMarkdown,
          content_format: "markdown",
        },
      }),
    );
  }

  return { pageId, usedTemplate: Boolean(created?.usedTemplate) };
}

// --- Workflow ------------------------------------------------------------------
// The embeddable-agent-chat Lovable app POSTs a `session.ended` event to this
// Zap's catch URL when a widget chat session ends (idle rollover or message
// cap). The workflow fetches the full transcript through the "Notion Agents
// Unofficial" custom integration, summarises it with AI by Zapier, and logs a
// record in the "Agent Chat Sessions" Notion database with the transcript as
// the page body.
//
// IDEMPOTENCY: the sender retries a failed delivery up to 5 times, and a catch
// hook 200s immediately, so duplicate deliveries are rare; per the repo's
// default posture this workflow accepts a rare duplicate page (the `Event ID`
// property carries the sender's idempotency key so duplicates are findable)
// rather than pretending a Table check-then-write is a real lock.
const workflow = defineDurable<Record<string, unknown>, unknown>(
  "agent-chat-session-to-notion",
  async (ctx, rawInput) => {
    const payload = InputSchema.parse(normalizeInput(rawInput));

    // A bare ping of the public catch URL is routine setup noise, never an
    // event. Anything past this guard is a real delivery.
    if (isEmptyPing(payload)) {
      console.log("empty payload — treating as a ping of the catch URL, not an event");
      return { skipped: "empty-payload" };
    }

    const event = extractEvent(payload);
    if (!event) {
      // A non-empty payload with no extractable session id is a real event
      // whose shape we failed to understand — surface it, never skip it.
      throw new Error(
        `Unrecognized payload: no session id found (keys: ${Object.keys(
          (payload ?? {}) as object,
        ).join(", ")})`,
      );
    }

    // 1. Fetch the full transcript. The custom integration resolves the
    //    session by id alone; agent_id is only a dropdown-narrowing input.
    const fetched = await ctx.step("fetch-transcript", async () =>
      sdk.runAction({
        appKey: AGENTS_APP_KEY,
        actionType: "search",
        actionKey: "get_session_transcript",
        connection: AGENTS_CONNECTION,
        inputs: { session_id: event.sessionId },
      }),
    );
    const session = firstResult(fetched);
    if (!session) {
      throw new Error(`Session ${event.sessionId} not found via get_session_transcript`);
    }

    const transcript =
      firstString(session.transcript) ??
      transcriptFromMessages(session.messages);
    const title =
      firstString(session.title) ?? `Agent session ${event.sessionId}`;
    const messageCount =
      event.messageCount ??
      (Array.isArray(session.messages) ? session.messages.length : null);

    // 2. Summarise. A session can end with no usable transcript (e.g. the
    //    visitor never sent a message before the idle rollover) — log the
    //    record anyway with a fixed summary, without spending an AI task.
    let summary: string;
    if (transcript) {
      const completion = await ctx.step("summarize-session", async () =>
        sdk.runAction({
          appKey: AI_APP_KEY,
          actionType: "write",
          actionKey: "get_completion",
          inputs: {
            provider_id: "",
            authentication_id: AI_AUTHENTICATION,
            model_id: AI_MODEL,
            instructions: SUMMARY_PROMPT,
            inputFields: {
              "Session title": title,
              "Message count": messageCount === null ? "unknown" : String(messageCount),
              Transcript: truncate(transcript, MAX_PROMPT_TRANSCRIPT_CHARS),
            },
          },
        }),
      );
      summary =
        firstString(firstResult(completion)?.output) ??
        "(AI step returned no summary)";
    } else {
      summary = "(No transcript content — the session ended without any messages.)";
    }

    // 3. Log the record. Only set properties whose value actually arrived —
    //    absence stays absent (empty property), never a fake 0/"".
    const props: Record<string, unknown> = {
      "properties|||Name|||title": title,
      "properties|||Summary|||rich_text": truncate(summary, MAX_SUMMARY_CHARS),
      "properties|||Session ID|||rich_text": event.sessionId,
    };
    const status = firstString(session.status);
    if (status) props["properties|||Session Status|||select"] = status;
    if (event.endReason) props["properties|||End Reason|||select"] = event.endReason;
    if (event.agentName) props["properties|||Agent|||select"] = event.agentName;
    const agentId = event.agentId ?? firstString(session.agent_id);
    if (agentId) props["properties|||Agent ID|||rich_text"] = agentId;
    if (event.widgetName) props["properties|||Widget|||rich_text"] = event.widgetName;
    if (event.visitorId) props["properties|||Visitor ID|||rich_text"] = event.visitorId;
    if (event.eventId) props["properties|||Event ID|||rich_text"] = event.eventId;
    if (messageCount !== null) props["properties|||Messages|||number"] = messageCount;
    const agentVersion = finiteNumber(session.agent_version?.number);
    if (agentVersion !== null) props["properties|||Agent Version|||number"] = agentVersion;
    const modelIds = Array.isArray(session.models?.ids)
      ? session.models.ids.filter((m: unknown) => typeof m === "string").join(", ")
      : null;
    if (modelIds) props["properties|||Model|||rich_text"] = modelIds;

    const startedAt = event.startedAt ?? firstString(session.created_at);
    const endedAt = event.endedAt ?? firstString(session.updated_at);
    if (startedAt || endedAt) props["use_zapier_datetime_fields"] = true;
    if (startedAt) props["properties|||Started At|||date__start"] = startedAt;
    if (endedAt) props["properties|||Ended At|||date__start"] = endedAt;

    const body = transcript
      ? stripBlankLines(`## Transcript\n${truncate(transcript, MAX_BODY_TRANSCRIPT_CHARS)}`)
      : null;

    const created = await createItemWithTemplate(ctx, "session", SESSIONS_DS, props, body);
    if (!created.pageId) {
      throw new Error("Notion page creation returned no page id");
    }

    return {
      pageId: created.pageId,
      sessionId: event.sessionId,
      title,
      messageCount,
      endReason: event.endReason,
      summarized: Boolean(transcript),
      usedTemplate: created.usedTemplate,
    };
  },
);

export default workflow;
