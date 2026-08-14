// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/notion-blog-post-to-hero-image
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
const NOTION_CONNECTION = "notion_wf"; // work.flowers workspace connection
const NOTION_APP_KEY = "NotionCLIAPI";
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

const GEMINI_APP_KEY = "GoogleMakerSuiteCLIAPI";
const GEMINI_CONNECTION = "gemini_wf"; // Google AI Studio (Gemini)
/** Nano Banana Pro. Gemini image models are only offered under v1beta —
 *  the classic Zap's fallback path said v1alpha and worked by accident. */
const GEMINI_MODEL = "gemini-3-pro-image-preview";
const GEMINI_API_VERSION = "v1beta";

// AI by Zapier on built-in credentials — no connection alias needed.
const AI_APP_KEY = "AICLIAPI";
const AI_MODEL = "standard/auto";
const AI_AUTHENTICATION = "0";

// --- Notion: Blog database ----------------------------------------------------
const BLOG_DS = "1d791b07-11ac-8146-9124-000b0d6dbcc8";
const PROMPT_PROP = "Prompt (Optional)";
const COVER_FILE_PROP = "Cover Image File";

/** Appended to AI-written briefs only. A hand-written Prompt (Optional) is the
 *  author's to control and is passed to Gemini verbatim, like the classic Zap did. */
const IMAGE_SIZE_SUFFIX = "The image should be 1536x1024";

// PROMPT SOURCE OF TRUTH: ./notion-blog-post-to-hero-image-prompt.md
// Edit the markdown, then `node scripts/check-prompts.mjs --fix`.
const HERO_IMAGE_PROMPT = `You are the graphic designer for workFlowers (work.flowers). Read the blog post content provided and write one detailed AI image-generation prompt for the post's hero image. Your output goes directly to an image model, so the Hero Image Description must be a single continuous paragraph of concrete visual direction — no bullet points, no commentary, no preamble.

The image must capture the post's core argument or tension, not just its topic. A post about automation should feel human, not robotic; a post about AI tools should feel considered, not hype-y. Avoid surface-level topic illustration.

Choose exactly ONE of the two workFlowers house styles — never mix them:

Style A — Editorial illustration (2.5D). The "human at work" mode, best when the post is about practice, craft, daily work, or workflows, or when a human subject grounds the argument. 2.5D editorial illustration, vector forms with painterly soft shading and subtle gradients — never pure flat vector. A grounded foreground subject (a desk, a person at work, a workspace) in front of a decorative abstract backdrop of flowing ribbon and wave forms in Persian Indigo #2E1B88, Russian Violet #4E1B61, and Azure #1479E1, with halftone dot patterns overlaid on flat colour areas. Figures, when present, feel natural and expressive — glasses, sweaters, considered details, faces in 3/4 view. Warm directional light from above creating soft volumetric glow.

Style B — Paper craft / physical metaphor. The "abstract concept" mode, best when the post argues something conceptual, has no obvious human subject, or is best captured as a metaphor. Photographic paper sculpture scene that looks like a physical set built from cut and folded paper, photographed under studio lighting. Constructed paper objects in the foreground (paper stacks, origami forms, geometric solids) against layered cut-paper wave forms in tonal Persian Indigo #2E1B88, Russian Violet #4E1B61, and Non-Photo Blue #9CE1FC, with halftone dot patterns and subtle geometric paper textures. No people, no screens, no UI. Strong directional warm light creating a visible beam and real cast shadows. A soft deckled / torn paper edge frames the image.

Palette discipline (reference colours by these exact hex codes, not by name alone): Persian Indigo #2E1B88, Azure #1479E1, Russian Violet #4E1B61, Non-Photo Blue #9CE1FC, Ochre #E17A14, Peach #F6C696, Eerie Black #1F1F1F, White #FFFFFF. Indigo/violet dominant, blues for highlights, white as breathing room. Ochre and Peach are accents only — specify a SINGLE warm focal element per image, never a dominant fill.

Signature elements to encode in every prompt: halftone dot overlays on background regions (specifically dotted texture, not generic grain); layered, sculptural backdrops; warm directional light creating real shadow geometry (never even ambient lighting); editorial composition with generous negative space and clear hierarchy. Texture is the medium — halftone dots, paper grain, painterly shading — it is what prevents the flat generic-AI look.

State explicitly in the prompt that only a single PNG image is required and that the image must contain no text, typography, or labels. Do not specify pixel dimensions (the workflow appends sizing). The image must be suitable for web use, optimised for fast loading without compromising quality.

Always exclude, and say so in the prompt: embedded text or labels; stiff or stock-looking figure poses; faceless human silhouettes; robot-hands-on-keyboard, glowing-brain, or abstract-neural-network clichés; pure flat vector with no texture; clip-art drop shadows; hyper-saturated or neon palettes; disembodied or translucent limbs; watermarks or signatures.

Return the finished prompt in the Hero Image Description field.`;

/** Structured output: a single prompt paragraph, ready for the image model. */
const OUTPUT_FIELDS = [
  {
    name: "Hero Image Description",
    description:
      "The finished image-generation prompt: one continuous paragraph of concrete visual direction for the hero image, in one of the two workFlowers house styles, with exact palette hex codes, signature elements, and the exclusions spelled out. No bullet points, no commentary.",
    type: "text",
    isRequired: true,
  },
];

// --- Types --------------------------------------------------------------------

type Input = Record<string, unknown>;
type Outcome = Record<string, unknown>;

// --- Helpers ------------------------------------------------------------------

function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline may deliver the body double-encoded; run-durable
  // delivers it single. Unwrap up to four times, and only when the string
  // actually looks like JSON.
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

/** Repo rule: a catch URL gets empty pings (Notion button setup, browser opens,
 *  curl checks) every time the sending side is configured — skip those, loudly
 *  throw on a real payload we can't understand. */
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

function previewOnlyFlag(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, any>;
  return o.previewOnly === true || o.previewOnly === "true";
}

function firstString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** First item of a runAction result ({ data: [...] } or a bare array). */
function firstResult(res: unknown): any {
  const anyRes = res as any;
  if (Array.isArray(anyRes?.data)) return anyRes.data[0];
  if (Array.isArray(anyRes)) return anyRes[0];
  return anyRes;
}

function dashUuid(raw: string): string {
  const hex = raw.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return raw;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Page id out of a Notion webhook payload — a button property or database
 *  automation both send `{ data: <page object> }`; be tolerant of wrappers. */
function extractPageId(payload: unknown): string {
  const candidates: unknown[] = [];
  const visit = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 4) return;
    const o = v as Record<string, any>;
    if (typeof o.id === "string" && (o.object === "page" || o.properties)) candidates.push(o.id);
    for (const key of ["data", "body", "page", "payload"]) visit(o[key], depth + 1);
    if (typeof o.id === "string" && candidates.length === 0) candidates.push(o.id);
  };
  visit(payload, 0);
  const id = firstString(candidates[0]);
  if (!id) {
    throw new Error(
      `payload carried content but no page id — shape not understood: ${JSON.stringify(payload).slice(0, 500)}`,
    );
  }
  return dashUuid(id);
}

function richTextToPlain(prop: any): string {
  const parts = prop?.rich_text ?? prop?.title ?? [];
  if (!Array.isArray(parts)) return "";
  return parts.map((r: any) => firstString(r?.plain_text)).join("").trim();
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// --- Workflow -------------------------------------------------------------------

const workflow = defineDurable<Input, Outcome>(
  "notion-blog-post-to-hero-image",
  async (ctx, rawInput) => {
    const payload = normalizeInput(rawInput);

    if (isEmptyPing(payload)) {
      console.log("empty payload — treating as a ping of the catch URL, not an event");
      return { skipped: "empty-payload" };
    }

    const pageId = extractPageId(payload);
    const previewOnly = previewOnlyFlag(payload);

    // 1. Never trust the payload's property values — re-read the page so the
    //    Prompt (Optional) branch decision is made on fresh data.
    const page = await ctx.step("fetch-page", async () => {
      const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
        connection: NOTION_CONNECTION,
        headers: { "Notion-Version": NOTION_VERSION },
      });
      if (!res.ok) {
        throw new Error(`Notion get page ${pageId} failed (${res.status}): ${await res.text()}`);
      }
      const body: any = await res.json();
      const props = body?.properties ?? {};
      const titleProp = Object.values(props).find((p: any) => p?.type === "title");
      const parent = body?.parent ?? {};
      return {
        title: richTextToPlain(titleProp),
        promptText: richTextToPlain(props[PROMPT_PROP]),
        dataSourceId: dashUuid(
          firstString(parent.data_source_id) || firstString(parent.database_id),
        ),
      };
    });

    if (page.dataSourceId && page.dataSourceId !== BLOG_DS) {
      throw new Error(
        `page ${pageId} ("${page.title}") is not in the Blog data source (parent ${page.dataSourceId}) — refusing to set a cover on it`,
      );
    }

    // 2. Prompt (Optional) wins; otherwise brief the image model from the post body.
    let imagePrompt: string;
    let promptSource: "notion-property" | "ai-brief";

    if (page.promptText) {
      imagePrompt = page.promptText;
      promptSource = "notion-property";
    } else {
      const content = await ctx.step("fetch-post-content", async () =>
        sdk.runAction({
          appKey: NOTION_APP_KEY,
          actionType: "search",
          actionKey: "block_children",
          connection: NOTION_CONNECTION,
          inputs: { blockId: pageId },
        }),
      );
      const markdown = firstString(firstResult(content)?.markdown);
      if (!markdown) {
        throw new Error(
          `page ${pageId} ("${page.title}") has no body content and no ${PROMPT_PROP} — nothing to brief the image model with`,
        );
      }

      const brief = await ctx.step("write-hero-image-brief", async () =>
        sdk.runAction({
          appKey: AI_APP_KEY,
          actionType: "write",
          actionKey: "get_completion",
          inputs: {
            provider_id: "",
            authentication_id: AI_AUTHENTICATION,
            model_id: AI_MODEL,
            isOutputArray: false,
            instructions: HERO_IMAGE_PROMPT,
            inputFields: { "Blog Post Content": markdown },
            outputFields: OUTPUT_FIELDS,
          },
        }),
      );
      // With isOutputArray:false the output fields sit at the TOP level of
      // data[0] (verified 2026-08-14); `.result.items` is the array shape only.
      const row = firstResult(brief);
      const description =
        firstString(row?.["Hero Image Description"]) ||
        firstString(row?.result?.["Hero Image Description"]);
      if (!description) {
        throw new Error(
          `AI brief returned no Hero Image Description: ${JSON.stringify(firstResult(brief)).slice(0, 500)}`,
        );
      }
      imagePrompt = `${description} ${IMAGE_SIZE_SUFFIX}`;
      promptSource = "ai-brief";
    }

    // 3. Generate the image. Return ONLY the URL: the raw result can carry
    //    base64/binary fields that must never enter a step checkpoint.
    const image = await ctx.step("generate-image", async () => {
      const res = await sdk.runAction({
        appKey: GEMINI_APP_KEY,
        actionType: "write",
        actionKey: "generate_image",
        connection: GEMINI_CONNECTION,
        inputs: {
          apiVersion: GEMINI_API_VERSION,
          model: GEMINI_MODEL,
          safetySetting: "BLOCK_FEW",
          prompt: imagePrompt,
        },
      });
      const row = firstResult(res);
      const url = firstString(row?.url);
      if (!url) {
        throw new Error(
          `Gemini returned no image URL (fields: ${Object.keys(row ?? {}).join(", ")})`,
        );
      }
      return { url };
    });

    if (previewOnly) {
      return { previewOnly: true, pageId, title: page.title, promptSource, imagePrompt, imageUrl: image.url };
    }

    const filename = `hero-${slugify(page.title) || pageId.slice(0, 8)}.png`;

    // 4. Set the page cover as a NOTION-HOSTED file (not an external URL, which
    //    would rot when the Gemini link expires): download the bytes through
    //    Zapier's proxy, single_part-upload them to Notion, attach as cover.
    const cover = await ctx.step("host-and-set-cover", async () => {
      // sdk.fetch with NO connection, deliberately: the sandbox has no DNS for
      // arbitrary hosts (a bare fetch dies), and the image URL needs no auth.
      const dl = await sdk.fetch(image.url, { method: "GET" });
      if (!dl.ok) throw new Error(`image download failed: HTTP ${dl.status}`);
      const bytes = new Uint8Array(await dl.arrayBuffer());
      if (!bytes.length) throw new Error("image download returned an empty body");
      const headerType = firstString(dl.headers.get("content-type")).split(";")[0];
      const contentType = headerType.startsWith("image/") ? headerType : "image/png";

      const createRes = await sdk.fetch(`${NOTION_API}/file_uploads`, {
        connection: NOTION_CONNECTION,
        method: "POST",
        headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
        body: JSON.stringify({ filename, content_type: contentType }),
      });
      const upload: any = await createRes.json();
      if (!createRes.ok || !upload?.id) {
        throw new Error(`create file upload failed (${createRes.status}): ${JSON.stringify(upload).slice(0, 300)}`);
      }

      // Multipart built by hand — the exact byte layout this repo has verified
      // against Notion. The file part MUST declare the content type the upload
      // was created with. Boundary derives from the upload id, so it stays
      // deterministic across retries of this step.
      const boundary = `----wfHeroBoundary${String(upload.id).replace(/-/g, "")}`;
      const enc = new TextEncoder();
      const head = enc.encode(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: ${contentType}\r\n\r\n`,
      );
      const tail = enc.encode(`\r\n--${boundary}--\r\n`);
      const multipart = new Uint8Array(head.length + bytes.length + tail.length);
      multipart.set(head, 0);
      multipart.set(bytes, head.length);
      multipart.set(tail, head.length + bytes.length);

      const sendRes = await sdk.fetch(`${NOTION_API}/file_uploads/${upload.id}/send`, {
        connection: NOTION_CONNECTION,
        method: "POST",
        headers: {
          "Notion-Version": NOTION_VERSION,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body: multipart,
      });
      const sent: any = await sendRes.json();
      if (!sendRes.ok || sent?.status !== "uploaded") {
        throw new Error(`send file bytes failed (${sendRes.status}): ${JSON.stringify(sent).slice(0, 300)}`);
      }

      const patchRes = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
        connection: NOTION_CONNECTION,
        method: "PATCH",
        headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
        body: JSON.stringify({
          cover: { type: "file_upload", file_upload: { id: upload.id } },
        }),
      });
      if (!patchRes.ok) {
        throw new Error(`set page cover failed (${patchRes.status}): ${await patchRes.text()}`);
      }
      return { uploadId: upload.id as string, bytes: bytes.length, contentType };
    });

    // 5. Mirror the image into the Cover Image File files property. The Zapier
    //    action does its own hosted upload from the URL (a file_upload id can
    //    only be attached once, so the cover's upload can't be reused here).
    await ctx.step("upload-cover-image-file-property", async () =>
      sdk.runAction({
        appKey: NOTION_APP_KEY,
        actionType: "write",
        actionKey: "upload_file_to_data_source_item",
        connection: NOTION_CONNECTION,
        inputs: {
          datasource: BLOG_DS,
          page: pageId,
          file_property: COVER_FILE_PROP,
          file: image.url,
        },
      }),
    );

    return {
      pageId,
      title: page.title,
      promptSource,
      coverUploadId: cover.uploadId,
      coverBytes: cover.bytes,
      filename,
    };
  },
);

export default workflow;
