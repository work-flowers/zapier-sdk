// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/supercut-to-youtube
//
// Publishes a Supercut recording to the workFlowers YouTube channel when its
// Supercut Recordings row's YouTube Status is set to "Ready for YouTube", and
// makes it public when the status is set to "Public". A Notion database
// automation on Supercut Recordings POSTs the row here. See README.md.
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";

const sdk = createZapierSdk();

// --- Bindings ------------------------------------------------------------------
const NOTION_CONNECTION = "notion_wf"; // work.flowers workspace connection
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

/** API by Zapier connection holding Dennis's personal Supercut token (sk_u_…):
 *  /download needs a personal token, a workspace token sees nothing. */
const SUPERCUT_CONNECTION = "supercut";
const SUPERCUT_API = "https://api.supercut.ai/v1";

const YOUTUBE_APP_KEY = "YouTubeV4CLIAPI";
const YOUTUBE_CONNECTION = "youtube"; // workFlowers channel UCbrz9V64Z2x5OBveDo5ee4w

// AI by Zapier on built-in credentials: no connection alias.
const AI_APP_KEY = "AICLIAPI";
const AI_MODEL = "standard/auto";
const AI_AUTHENTICATION = "0";

// --- Notion: Supercut Recordings (synced by the supercut-sync worker) ------------
const SUPERCUT_DS = "0f3fea21-11be-4158-ba98-9bb26936db89";
// Synced, read-only:
const PROP_NAME = "Name";
const PROP_RECORDING_ID = "Recording ID";
const PROP_DURATION = "Duration (s)";
// Hand-added (not declared by the worker, so writable):
const PROP_STATUS = "YouTube Status";
const PROP_VIDEO_ID = "YouTube Video ID";
const PROP_URL = "YouTube URL";
const PROP_ERROR = "YouTube Error";
const PROP_CLIENTS_OK = "YouTube Clients OK";

const STATUS_READY = "Ready for YouTube";
const STATUS_UPLOADING = "Uploading";
const STATUS_UPLOADED = "Uploaded (unlisted)";
const STATUS_PUBLIC = "Public";
const STATUS_NEEDS_REVIEW = "Needs review";
const STATUS_FAILED = "Failed";
/** Only these two statuses ask the Zap to do anything; every other value
 *  (including the ones this Zap writes itself) skips before any paid call. */
const ACTIONABLE = new Set([STATUS_READY, STATUS_PUBLIC]);

// --- Zapier Table: company IDs (free to read) --------------------------------------
const COMPANY_TABLE = "01JM8PH8YM93A482M8BFZ6WKW6";
const COMPANY_NAME_FIELD = "Company Name";
/** "A client" = a company with a Harvest Client ID, i.e. one we have billed. */
const CLIENT_MARKER_FIELD = "Harvest Client ID";
/** Never a client for this purpose. */
const NOT_CLIENTS = new Set(["workflowers"]);

// --- Download polling ---------------------------------------------------------------
/** Supercut renders asynchronously (typically 30–90 s): 202 "preparing", then
 *  200 with a signed URL. 30 s apart, 20 polls = 10 minutes, each poll a task. */
const DOWNLOAD_POLL_SECONDS = 30;
const DOWNLOAD_MAX_POLLS = 20;
/** Drop Supercut's branded outro (needs the download-options plan feature). */
const SKIP_OUTRO = true;

// --- YouTube upload settings (TKT-1069) ------------------------------------------
const YT_CATEGORY_SCIENCE_TECH = "28";
const YT_TITLE_MAX = 100;
const YT_DESCRIPTION_MAX = 4900; // YouTube's limit is 5,000 bytes; leave headroom
const YT_TAGS_MAX_CHARS = 450; // YouTube's limit is 500, counting quotes around spaced tags
const DESCRIPTION_FOOTER =
  "workFlowers helps mid-market teams with workflow automation, analytics and AI agent systems: https://work.flowers";
const MIN_CHAPTER_GAP_SECONDS = 10;
const MIN_CHAPTERS = 3;
/** What the AI step gets in place of a transcript for a recording with no speech. */
const NO_SPEECH_TRANSCRIPT = "(none: this recording has no speech)";

// PROMPT SOURCE OF TRUTH: ./supercut-to-youtube-prompt.md
// Edit the markdown, then `node scripts/check-prompts.mjs --fix`.
const YOUTUBE_METADATA_PROMPT = `You write YouTube metadata for screen-recorded demo videos by Dennis Chiuten, founder of workFlowers (work.flowers), a consultancy that helps mid-market teams with workflow automation, analytics and AI agent systems. The videos show real builds in Notion, Zapier and AI tools. You are given the recording's working title, its timestamped transcript, its duration, and a list of workFlowers clients.

Write the following.

YouTube Title: a searchable, descriptive title of at most 90 characters that says what the viewer will learn or see built, using the product names a person would search for (for example "Notion", "Zapier", "Notion AI agent"). Do not reuse the working title if it is vague, internal or addressed to one person. No clickbait, no emoji, no ALL CAPS, no quotation marks.

Description: two or three short paragraphs in Dennis's own first-person voice ("I", "my"), plain and direct, as if he were telling a peer what the video covers. Open with the problem or idea, then say what the video walks through and what the viewer can take away. Mention the tools by name. Do not invent features, results or numbers that are not in the transcript. Do not include chapters, links, hashtags, a sign-off or a call to subscribe; the workflow adds the chapters and the closing line. Never use the words "quietly" or "silently". At most 1,200 characters.

Tags: 5 to 12 search tags, one per line, most specific first (for example "Notion custom agent", "Zapier automation", "Notion API"). Lowercase is fine. No hashtags.

Chapters: 3 to 8 chapters that follow the transcript's real topic changes, one per line, formatted exactly as "m:ss Chapter title" (or "h:mm:ss Chapter title" past an hour). Take the times from the transcript's timestamps; never invent a time later than the duration. The first chapter must be at 0:00. Space chapters at least 30 seconds apart. Keep each title under 50 characters. If the video is too short for three distinct chapters, still return three that split it sensibly.

If the transcript says the recording has no speech, it is a short silent or music-only demo. Write the title, description and tags from the working title alone: keep the description to two or three sentences that say only what the working title supports, still in Dennis's first-person voice, and invent no details of what the video shows. Return "0:00 Overview" as the only chapter.

Clients Mentioned: every name from the client list that the transcript or working title mentions as a client, customer, or the organisation whose work or data is being shown, one per line, spelled exactly as it appears in the client list. Ignore a company named only as a software product or tool being used (for example Notion, Zapier, LinkedIn, Zoom, Microsoft), and ignore workFlowers itself. If none is mentioned, return the single word "none".`;

const OUTPUT_FIELDS = [
  { name: "YouTube Title", description: "Searchable, descriptive title, at most 90 characters.", type: "text", isRequired: true },
  { name: "Description", description: "Two or three short first-person paragraphs, no chapters, links or sign-off.", type: "text", isRequired: true },
  { name: "Tags", description: "5 to 12 search tags, one per line.", type: "text", isRequired: true },
  { name: "Chapters", description: "3 to 8 lines, each 'm:ss Chapter title', first at 0:00.", type: "text", isRequired: true },
  { name: "Clients Mentioned", description: "Client-list names mentioned, one per line, or 'none'.", type: "text", isRequired: true },
];

// --- Types ----------------------------------------------------------------------------

type Outcome = Record<string, unknown>;

interface RowState {
  title: string;
  recordingId: string;
  durationSeconds: number | null;
  status: string;
  videoId: string;
  clientsOk: boolean;
  dataSourceId: string;
}

interface Metadata {
  title: string;
  description: string;
  tags: string[];
  chapters: string[];
  clientsMentioned: string[];
}

// --- Payload helpers -----------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function normalizeInput(rawInput: unknown): unknown {
  // The trigger may deliver the body double-encoded; run-durable delivers it single.
  let v: unknown = rawInput;
  for (let i = 0; i < 4 && typeof v === "string"; i += 1) {
    const s = v.trim();
    if (!s.startsWith("{") && !s.startsWith("[") && !s.startsWith('"')) break;
    try {
      v = JSON.parse(s);
    } catch {
      break;
    }
  }
  return v;
}

/** Repo rule: a catch URL gets empty pings whenever the Notion side is set up.
 *  Skip those; throw on a real payload we can't understand. */
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

function dashUuid(raw: string): string {
  const hex = raw.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return "";
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The page a Notion database automation sent: `{ source, data: <page> }`. A
 *  hand-run test may pass `{ pageId }` instead. Empty string when absent. */
export function extractPageId(payload: unknown): string {
  const o = (payload ?? {}) as Record<string, any>;
  const candidates = [o?.data?.id, o?.body?.data?.id, o?.pageId, o?.page_id, o?.id];
  for (const c of candidates) {
    const id = dashUuid(str(c));
    if (id) return id;
  }
  return "";
}

/** YouTube Status as the automation reported it, or "" when the payload did
 *  not include the property (then the page read decides). */
export function statusFromPayload(payload: unknown): string {
  const o = (payload ?? {}) as Record<string, any>;
  const props = o?.data?.properties ?? o?.body?.data?.properties;
  if (!props || typeof props !== "object") return "";
  return str(props?.[PROP_STATUS]?.select?.name);
}

function previewOnlyFlag(payload: unknown): boolean {
  const o = (payload ?? {}) as Record<string, any>;
  return o.previewOnly === true || o.previewOnly === "true";
}

function plainText(prop: any): string {
  const parts = prop?.rich_text ?? prop?.title ?? [];
  if (!Array.isArray(parts)) return "";
  return parts.map((r: any) => str(r?.plain_text)).join("").trim();
}

function richText(content: string): { rich_text: { text: { content: string } }[] } {
  const text = content.slice(0, 2000);
  return { rich_text: text ? [{ text: { content: text } }] : [] };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// --- Formatting helpers (pure, exported for tests) ----------------------------------

export function formatTimestamp(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Transcript as one `[m:ss] sentence` line per sentence. */
export function transcriptLines(sentences: { text: string; start: number }[]): string {
  return sentences
    .map((s) => `[${formatTimestamp(Number(s.start) || 0)}] ${str(s.text)}`)
    .filter((l) => !l.endsWith("] "))
    .join("\n");
}

/** Rebuild the AI's chapter lines to YouTube's rules: parse `m:ss Title`, sort,
 *  first at 0:00, each at least 10 s after the previous and 10 s before the end.
 *  Fewer than three survivors means no chapters at all, since YouTube ignores
 *  a partial list anyway. */
export function buildChapters(raw: string, durationSeconds: number | null): string[] {
  const parsed: { at: number; title: string }[] = [];
  for (const line of raw.split("\n")) {
    const m = line.trim().match(/^[-*•\s]*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*[-–—:|]?\s*(.+)$/);
    if (!m) continue;
    const at = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    const title = cleanText(m[4]).slice(0, 80);
    if (title) parsed.push({ at, title });
  }
  parsed.sort((a, b) => a.at - b.at);
  if (!parsed.length) return [];
  parsed[0].at = 0;
  const limit = durationSeconds && durationSeconds > 0 ? durationSeconds - MIN_CHAPTER_GAP_SECONDS : Infinity;
  const kept: { at: number; title: string }[] = [];
  for (const c of parsed) {
    if (c.at > limit) continue;
    const prev = kept[kept.length - 1];
    if (prev && c.at - prev.at < MIN_CHAPTER_GAP_SECONDS) continue;
    kept.push(c);
  }
  if (kept.length < MIN_CHAPTERS) return [];
  return kept.map((c) => `${formatTimestamp(c.at)} ${c.title}`);
}

/** YouTube rejects < and > in titles and descriptions; the ticket bans two words. */
export function cleanText(s: string): string {
  return s
    .replace(/[<>]/g, "")
    .replace(/\b(quietly|silently)\b\s*/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function buildTags(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const piece of raw.split(/[\n,]/)) {
    const tag = cleanText(piece.replace(/^[-*•#\s]+/, "")).replace(/"/g, "").slice(0, 60);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    const cost = tag.length + (tag.includes(" ") ? 2 : 0) + (out.length ? 1 : 0);
    if (used + cost > YT_TAGS_MAX_CHARS) break;
    seen.add(key);
    out.push(tag);
    used += cost;
  }
  return out;
}

export function buildDescription(body: string, chapters: string[]): string {
  const tail = (chapters.length ? `\n\nChapters\n${chapters.join("\n")}` : "") + `\n\n${DESCRIPTION_FOOTER}`;
  let text = cleanText(body).replace(/\n{3,}/g, "\n\n");
  if (text.length + tail.length > YT_DESCRIPTION_MAX) {
    text = text.slice(0, Math.max(0, YT_DESCRIPTION_MAX - tail.length - 1)).trimEnd() + "…";
  }
  return text + tail;
}

/** Keep only names that really are on the client list (the model's spelling
 *  must match, case-insensitively); drop "none" and anything invented. */
export function matchClients(raw: string, clients: string[]): string[] {
  const byKey = new Map(clients.map((c) => [c.toLowerCase(), c]));
  const out = new Set<string>();
  for (const piece of raw.split("\n")) {
    const key = piece.replace(/^[-*•\s]+/, "").trim().toLowerCase();
    if (!key || key === "none") continue;
    const hit = byKey.get(key);
    if (hit) out.add(hit);
  }
  return [...out];
}

// --- App calls (each runs inside a ctx.step) -----------------------------------------

async function notionPatch(pageId: string, properties: Record<string, unknown>): Promise<void> {
  const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
    connection: NOTION_CONNECTION,
    method: "PATCH",
    headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) throw new Error(`Notion update of ${pageId} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
}

async function supercutGet(path: string): Promise<{ status: number; body: any }> {
  const res = await sdk.fetch(`${SUPERCUT_API}${path}`, { connection: SUPERCUT_CONNECTION, method: "GET" });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  // 5xx and 429 are worth the step's retry; everything else is an answer.
  if (res.status >= 500 || res.status === 429) {
    throw new Error(`Supercut ${path} answered ${res.status}: ${text.slice(0, 300)}`);
  }
  return { status: res.status, body };
}

/** Polls Supercut's download endpoint until the render is ready. Step and wait
 *  ids carry the poll index, which is why this helper takes ctx (the
 *  publish-time analyzer only accepts literal ids in the workflow body). */
async function waitForDownloadUrl(ctx: DurableContext, recordingId: string): Promise<string> {
  const path = `/recordings/${recordingId}/download${SKIP_OUTRO ? "?skip_outro=true" : ""}`;
  for (let i = 1; i <= DOWNLOAD_MAX_POLLS; i++) {
    if (i > 1) await ctx.wait(`download-wait-${i}`, DOWNLOAD_POLL_SECONDS);
    const res = await ctx.step(`download-poll-${i}`, async () => supercutGet(path));
    const url = str(res.body?.data?.url);
    if (res.status === 200 && url) return url;
    if (res.status === 202) continue;
    if (res.status === 409) {
      throw new Error(`Supercut says recording ${recordingId} can never produce a download (409).`);
    }
    throw new Error(
      `Supercut download for ${recordingId} answered ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}` +
        (res.status === 403 && SKIP_OUTRO ? " (skip_outro needs Supercut's download-options plan feature)" : ""),
    );
  }
  throw new Error(
    `Supercut had not finished rendering ${recordingId} after ${DOWNLOAD_MAX_POLLS} polls (${(DOWNLOAD_MAX_POLLS - 1) * DOWNLOAD_POLL_SECONDS} s). Set YouTube Status to Ready for YouTube again to retry.`,
  );
}

// --- Workflow -------------------------------------------------------------------------

const workflow = defineDurable("supercut-to-youtube", async (ctx, rawInput) => {
  const payload = normalizeInput(rawInput);

  if (isEmptyPing(payload)) {
    console.log("empty payload: a ping of the catch URL, not an event");
    return { skipped: "empty-payload" } as Outcome;
  }

  const pageId = extractPageId(payload);
  if (!pageId) {
    throw new Error(`Unrecognised payload: no Notion page id. Keys: ${Object.keys(payload as object).join(", ")}`);
  }
  const previewOnly = previewOnlyFlag(payload);

  // 0. Free skip: the automation reports the status it fired on. Every write
  //    this Zap makes to YouTube Status (Uploading, Uploaded, Failed …) fires
  //    the automation again, and those runs end here without a paid call.
  const reported = statusFromPayload(payload);
  if (reported && !ACTIONABLE.has(reported) && !previewOnly) {
    console.log(`page ${pageId}: YouTube Status is "${reported}", nothing to do`);
    return { skipped: "status-not-actionable", status: reported } as Outcome;
  }

  // 1. Re-read the row: the payload may be stale by the time the run starts.
  const row: RowState = await ctx.step("read-row", async () => {
    const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
      connection: NOTION_CONNECTION,
      headers: { "Notion-Version": NOTION_VERSION },
    });
    if (!res.ok) throw new Error(`Notion get page ${pageId} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const page: any = await res.json();
    const p = page?.properties ?? {};
    const duration = p[PROP_DURATION]?.number;
    return {
      title: plainText(p[PROP_NAME]),
      recordingId: plainText(p[PROP_RECORDING_ID]),
      durationSeconds: typeof duration === "number" ? duration : null,
      status: str(p[PROP_STATUS]?.select?.name),
      videoId: plainText(p[PROP_VIDEO_ID]),
      clientsOk: p[PROP_CLIENTS_OK]?.checkbox === true,
      dataSourceId: dashUuid(str(page?.parent?.data_source_id)),
    };
  });

  if (row.dataSourceId !== SUPERCUT_DS) {
    throw new Error(`page ${pageId} is not a Supercut Recordings row (parent ${row.dataSourceId || "unknown"}); refusing to act on it`);
  }

  // --- Make public --------------------------------------------------------------------
  if (row.status === STATUS_PUBLIC && !previewOnly) {
    if (!row.videoId) {
      await ctx.step("mark-public-failed", async () =>
        notionPatch(pageId, {
          [PROP_STATUS]: { select: { name: STATUS_FAILED } },
          [PROP_ERROR]: richText("Set to Public, but the row has no YouTube Video ID. Publish it first (Ready for YouTube)."),
        }),
      );
      throw new Error(`"${row.title}" was set to Public but has no YouTube Video ID`);
    }
    // videos.update with part=status resets any status field left out, so all
    // of them are resent with the values this Zap uploads with. Idempotent, so
    // the step may retry.
    let updated: { privacyStatus: string; raw: string };
    try {
      updated = await ctx.step("make-public", async () => {
      const res = await sdk.runAction({
        appKey: YOUTUBE_APP_KEY,
        actionType: "write",
        actionKey: "_zap_raw_request",
        connection: YOUTUBE_CONNECTION,
        inputs: {
          fail_on_errors: true,
          method: "PUT",
          url: "https://www.googleapis.com/youtube/v3/videos?part=status",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: row.videoId,
            status: {
              privacyStatus: "public",
              embeddable: true,
              license: "youtube",
              publicStatsViewable: true,
              selfDeclaredMadeForKids: false,
            },
          }),
        },
      });
      const r: any = (res as any)?.data?.[0] ?? {};
      const body = typeof r.body === "string" ? safeJson(r.body) : r.body ?? r.response?.body ?? r;
      return { privacyStatus: str(body?.status?.privacyStatus), raw: JSON.stringify(r).slice(0, 300) };
      });
      if (updated.privacyStatus !== "public") {
        throw new Error(`YouTube did not confirm ${row.videoId} as public: ${updated.raw}`);
      }
    } catch (e) {
      const message = errorMessage(e);
      await ctx.step("mark-public-error", async () =>
        notionPatch(pageId, {
          [PROP_STATUS]: { select: { name: STATUS_FAILED } },
          [PROP_ERROR]: richText(`Making ${row.videoId} public failed: ${message}`),
        }),
      );
      throw e;
    }
    await ctx.step("clear-error-after-public", async () => notionPatch(pageId, { [PROP_ERROR]: richText("") }));
    console.log(`"${row.title}": ${row.videoId} is now public`);
    return { action: "made-public", pageId, videoId: row.videoId } as Outcome;
  }

  // --- Publish unlisted ------------------------------------------------------------------
  if (row.status !== STATUS_READY && !previewOnly) {
    console.log(`page ${pageId}: YouTube Status is "${row.status}" on re-read, nothing to do`);
    return { skipped: "status-not-actionable", status: row.status } as Outcome;
  }
  if (row.videoId && !previewOnly) {
    // Re-triggering an uploaded row does nothing (TKT-1069): no second upload.
    console.log(`"${row.title}" already has YouTube Video ID ${row.videoId}; not uploading again`);
    return { skipped: "already-uploaded", videoId: row.videoId } as Outcome;
  }
  if (!row.recordingId) {
    throw new Error(`page ${pageId} ("${row.title}") has no Recording ID`);
  }

  if (!previewOnly) {
    await ctx.step("mark-uploading", async () =>
      notionPatch(pageId, {
        [PROP_STATUS]: { select: { name: STATUS_UPLOADING } },
        [PROP_ERROR]: richText(""),
      }),
    );
  }

  try {
    // 2. Transcript (timestamps in seconds).
    const transcript = await ctx.step("read-transcript", async () => {
      const res = await supercutGet(`/recordings/${row.recordingId}/transcript`);
      if (res.status !== 200) {
        throw new Error(`Supercut transcript answered ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
      }
      const d = res.body?.data ?? {};
      return {
        status: str(d.status),
        durationMs: typeof d.duration_ms === "number" ? d.duration_ms : null,
        text: Array.isArray(d.sentences) ? transcriptLines(d.sentences) : "",
      };
    });
    // "unavailable" is final: the recording has no speech (a silent or
    // music-only cut). Dennis chose on 2026-11-20 to publish those anyway, with
    // metadata written from the working title alone and no chapters.
    // "pending"/"processing" are not final, so those still stop the run.
    const noSpeech = transcript.status === "unavailable" || (transcript.status === "completed" && !transcript.text);
    if (transcript.status === "pending" || transcript.status === "processing") {
      throw new Error(
        `Supercut is still transcribing this recording ("${transcript.status}"); set Ready for YouTube again in a few minutes.`,
      );
    }
    if (!noSpeech && transcript.status !== "completed") {
      throw new Error(`Supercut could not transcribe this recording ("${transcript.status || "no status"}").`);
    }
    if (noSpeech) console.log(`"${row.title}" has no speech: writing metadata from the working title only, no chapters`);
    const durationSeconds = row.durationSeconds ?? (transcript.durationMs ? transcript.durationMs / 1000 : null);

    // 3. Client list: free Zapier Table read.
    const clients = await ctx.step("read-client-list", async () => {
      const res = await sdk.listTableRecords({
        table: COMPANY_TABLE,
        keyMode: "names",
        filters: [{ fieldKey: CLIENT_MARKER_FIELD, operator: "isnull", value: false }],
        pageSize: 1000,
        maxItems: 5000,
      });
      const names = new Set<string>();
      for (const r of (res as any)?.data ?? []) {
        const name = str(r?.data?.[COMPANY_NAME_FIELD] ?? r?.[COMPANY_NAME_FIELD]);
        if (name && !NOT_CLIENTS.has(name.toLowerCase())) names.add(name);
      }
      return [...names].sort();
    });
    if (!clients.length) {
      throw new Error("The company-ID Table returned no clients; refusing to publish without a client check.");
    }

    // 4. Title, description, tags, chapters, client mentions.
    const ai = await ctx.step("write-youtube-metadata", async () => {
      const res = await sdk.runAction({
        appKey: AI_APP_KEY,
        actionType: "write",
        actionKey: "get_completion",
        inputs: {
          provider_id: "",
          authentication_id: AI_AUTHENTICATION,
          model_id: AI_MODEL,
          isOutputArray: false,
          instructions: YOUTUBE_METADATA_PROMPT,
          inputFields: {
            "Working Title": row.title,
            Duration: durationSeconds ? formatTimestamp(durationSeconds) : "unknown",
            Transcript: noSpeech ? NO_SPEECH_TRANSCRIPT : transcript.text,
            "Client List": clients.join("\n"),
          },
          outputFields: OUTPUT_FIELDS,
        },
      });
      // With isOutputArray:false the fields sit at the top level of data[0].
      const r: any = (res as any)?.data?.[0] ?? {};
      const pick = (k: string) => str(r?.[k]) || str(r?.result?.[k]);
      return {
        title: pick("YouTube Title"),
        description: pick("Description"),
        tags: pick("Tags"),
        chapters: pick("Chapters"),
        clients: pick("Clients Mentioned"),
      };
    });
    if (!ai.title || !ai.description) {
      throw new Error(`AI step returned no title or description: ${JSON.stringify(ai).slice(0, 300)}`);
    }

    // No transcript means no timestamps to hang chapters on, whatever the model returned.
    const chapters = noSpeech ? [] : buildChapters(ai.chapters, durationSeconds);
    const meta: Metadata = {
      title: cleanText(ai.title).replace(/^["']|["']$/g, "").slice(0, YT_TITLE_MAX),
      description: buildDescription(ai.description, chapters),
      tags: buildTags(ai.tags),
      chapters,
      clientsMentioned: matchClients(ai.clients, clients),
    };
    if (!chapters.length) console.log(`AI chapters unusable, uploading without chapters: ${ai.chapters.slice(0, 200)}`);

    if (previewOnly) {
      return { previewOnly: true, pageId, workingTitle: row.title, ...meta } as Outcome;
    }

    // 5. Never publish a recording that names a client, unless a person has
    //    reviewed it and ticked YouTube Clients OK.
    if (meta.clientsMentioned.length && !row.clientsOk) {
      const names = meta.clientsMentioned.join(", ");
      await ctx.step("mark-needs-review", async () =>
        notionPatch(pageId, {
          [PROP_STATUS]: { select: { name: STATUS_NEEDS_REVIEW } },
          [PROP_ERROR]: richText(
            `Transcript appears to mention client(s): ${names}. Not uploaded. If that's fine, tick YouTube Clients OK and set Ready for YouTube again.`,
          ),
        }),
      );
      console.log(`"${row.title}" mentions ${names}; flagged for review, not uploaded`);
      return { action: "needs-review", pageId, clients: meta.clientsMentioned } as Outcome;
    }

    // 6. Render and fetch a signed download URL (expires within hours, so it is
    //    used in this run and never written anywhere).
    const videoUrl = await waitForDownloadUrl(ctx, row.recordingId);

    // 7. Upload. ONE attempt: a retry after an ambiguous failure could put a
    //    second copy on the channel.
    const uploaded = await ctx.step({
      name: "upload-to-youtube",
      maxAttempts: 1,
      run: async () => {
        const res = await sdk.runAction({
          appKey: YOUTUBE_APP_KEY,
          actionType: "write",
          actionKey: "upload_video",
          connection: YOUTUBE_CONNECTION,
          inputs: {
            title: meta.title,
            description: meta.description,
            video: videoUrl,
            privacy_status: "unlisted",
            tags: meta.tags,
            default_language: "en",
            default_audio_language: "en",
            license: "youtube",
            embeddable: true,
            public_stats_viewable: true,
            category_id: YT_CATEGORY_SCIENCE_TECH,
            made_for_kids: false,
            notify_subscribers: false,
          },
        });
        const r: any = (res as any)?.data?.[0] ?? {};
        const id = str(r?.id) || str(r?.video_id) || str(r?.videoId) || str(r?.resourceId?.videoId);
        return { id, keys: Object.keys(r).slice(0, 30).join(", ") };
      },
    });
    if (!/^[A-Za-z0-9_-]{11}$/.test(uploaded.id)) {
      throw new Error(
        `YouTube upload returned no recognisable video id (fields: ${uploaded.keys}). The video may be on the channel anyway: check YouTube Studio before retrying.`,
      );
    }

    // 8. Write back.
    const youtubeUrl = `https://www.youtube.com/watch?v=${uploaded.id}`;
    await ctx.step("write-back", async () =>
      notionPatch(pageId, {
        [PROP_STATUS]: { select: { name: STATUS_UPLOADED } },
        [PROP_VIDEO_ID]: richText(uploaded.id),
        [PROP_URL]: { url: youtubeUrl },
        [PROP_ERROR]: richText(""),
      }),
    );
    console.log(`"${row.title}" uploaded unlisted as ${uploaded.id}`);
    return { action: "uploaded", pageId, videoId: uploaded.id, url: youtubeUrl, title: meta.title } as Outcome;
  } catch (e) {
    if (previewOnly) throw e;
    // Leave the row saying what went wrong, then fail the run so Zapier alerts.
    const message = errorMessage(e);
    await ctx.step("mark-failed", async () =>
      notionPatch(pageId, {
        [PROP_STATUS]: { select: { name: STATUS_FAILED } },
        [PROP_ERROR]: richText(message),
      }),
    );
    throw e;
  }
});

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export default workflow;
