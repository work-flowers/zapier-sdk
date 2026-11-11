// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/openai-image-to-cloudinary
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
const OPENAI_CONNECTION = "openai_wf"; // ChatGPT (OpenAI)
const OPENAI_API = "https://api.openai.com/v1";

const CLOUDINARY_APP_KEY = "CloudinaryCLIAPI";
const CLOUDINARY_CONNECTION = "cloudinary_wf"; // Cloudinary ddvqw2xgc
const CLOUDINARY_FOLDER = "hero-images";

/** Zapier caps an OUTBOUND request body (runAction inputs and sdk.fetch alike)
 *  at ~1 MB: 900 KB passed and 1.5 MB got HTTP 413 (probed 2026-11-11). A
 *  1824x1024 medium PNG is ~4.5 MB (6.1M base64 chars), so PNG can never reach
 *  Cloudinary from here. WebP at quality 80 is ~0.2-0.5 MB (q90 measured 573 KB on one low-quality image, too close to the cap). Cloudinary still
 *  serves a PNG on request: swap the URL's extension (see pngUrlFrom). */
const OUTPUT_FORMAT = "webp";
const OUTPUT_COMPRESSION = 80;
/** Leave headroom under the ~1 MB cap for the data-URI prefix and JSON envelope. */
const MAX_B64_CHARS = 950_000;

const NOTION_CONNECTION = "notion_wf"; // work.flowers workspace connection
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";
const BLOG_DS = "1d791b07-11ac-8146-9124-000b0d6dbcc8";
const COVER_FILE_PROP = "Cover Image File";

// --- Input -------------------------------------------------------------------
const MODELS = ["gpt-image-2.6-flare", "gpt-image-2.6-sunburst"] as const;
const LEVELS = ["low", "medium", "high"] as const;

const DEFAULTS = {
  model: "gpt-image-2.6-flare",
  size: "1824x1024",
  quality: "medium",
  complexity: "low",
} as const;

type Request = {
  prompt: string;
  model: (typeof MODELS)[number];
  size: string;
  quality: (typeof LEVELS)[number];
  complexity: (typeof LEVELS)[number];
  referenceImageUrl: string;
  filename: string;
  notionPageId: string;
};

function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline may deliver the body as a (sometimes double-encoded)
  // JSON string; unwrap it only when it looks like JSON.
  let v: unknown = rawInput;
  for (let i = 0; i < 4 && typeof v === "string"; i += 1) {
    const s = v.trim();
    if (!s.startsWith("{") && !s.startsWith('"')) break;
    try {
      v = JSON.parse(s);
    } catch {
      break;
    }
  }
  return v;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function pickEnum<T extends string>(raw: unknown, allowed: readonly T[], fallback: T, field: string): T {
  const s = str(raw).toLowerCase();
  if (!s) return fallback;
  if ((allowed as readonly string[]).includes(s)) return s as T;
  throw new Error(`invalid ${field} "${s}" — expected one of: ${allowed.join(", ")}`);
}

function dashUuid(raw: string): string {
  const hex = raw.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error(`notion_page_id "${raw}" is not a Notion page id (32 hex chars, dashes optional)`);
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Cloudinary public_id from a caller filename: drop any extension and path,
 *  keep it URL-safe. Empty means "let Cloudinary assign one". */
export function publicIdFrom(filename: string): string {
  return filename
    .replace(/^.*[\\/]/, "")
    .replace(/\.(png|jpe?g|webp|gif)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

/** Every field is validated before anything is spent: an empty body has no
 *  prompt and throws, so there is no payload that silently does a default write. */
export function parseRequest(raw: unknown): Request {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`input must be a JSON object with at least a "prompt" — got ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  const o = raw as Record<string, unknown>;
  const prompt = str(o.prompt);
  if (!prompt) throw new Error(`"prompt" is required — got keys: ${Object.keys(o).join(", ") || "(none)"}`);

  const size = str(o.size) || DEFAULTS.size;
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (!m || Number(m[1]) % 16 !== 0 || Number(m[2]) % 16 !== 0 || Number(m[1]) === 0 || Number(m[2]) === 0) {
    throw new Error(`invalid size "${size}" — expected WIDTHxHEIGHT with both sides multiples of 16 (e.g. 1824x1024)`);
  }

  const referenceImageUrl = str(o.reference_image_url);
  if (referenceImageUrl && !/^https?:\/\//i.test(referenceImageUrl)) {
    throw new Error(`reference_image_url must be an http(s) URL — got "${referenceImageUrl.slice(0, 100)}"`);
  }

  const notionRaw = str(o.notion_page_id);
  return {
    prompt,
    model: pickEnum(o.model, MODELS, DEFAULTS.model, "model"),
    size,
    quality: pickEnum(o.quality, LEVELS, DEFAULTS.quality, "quality"),
    complexity: pickEnum(o.complexity, LEVELS, DEFAULTS.complexity, "complexity"),
    referenceImageUrl,
    filename: str(o.filename),
    notionPageId: notionRaw ? dashUuid(notionRaw) : "",
  };
}

function firstResult(res: unknown): any {
  const r = res as any;
  if (Array.isArray(r?.data)) return r.data[0];
  if (Array.isArray(r)) return r[0];
  return r;
}

/** Cloudinary converts on delivery: the same asset with a .png extension is
 *  served as PNG. */
export function pngUrlFrom(secureUrl: string): string {
  return secureUrl.replace(/\.[a-z0-9]+$/i, ".png");
}

/** OpenAI's own error text, so a 400 reads as what OpenAI said, not a status code. */
function openAiErrorMessage(status: number, bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText);
    const msg = str(parsed?.error?.message);
    if (msg) return `OpenAI ${status}: ${msg}`;
  } catch {
    // not JSON — fall through to the raw text
  }
  return `OpenAI ${status}: ${bodyText.slice(0, 500) || "(empty body)"}`;
}

type GenerateResult =
  | { ok: true; imageUrl: string; publicId: string; width: number; height: number; bytes: number; b64Chars: number; usage: unknown }
  | { ok: false; error: string };

// --- Workflow ----------------------------------------------------------------

const workflow = defineDurable("openai-image-to-cloudinary", async (ctx, rawInput) => {
  const req = parseRequest(normalizeInput(rawInput));

  // 1. Guard the Notion target BEFORE paying for an image: a page outside the
  //    Blog data source must never get its Cover Image File overwritten.
  if (req.notionPageId) {
    const page = await ctx.step("check-notion-page", async () => {
      const res = await sdk.fetch(`${NOTION_API}/pages/${req.notionPageId}`, {
        connection: NOTION_CONNECTION,
        headers: { "Notion-Version": NOTION_VERSION },
      });
      if (!res.ok) return { ok: false as const, error: `Notion get page ${req.notionPageId} failed (${res.status}): ${(await res.text()).slice(0, 300)}` };
      const body: any = await res.json();
      const parent = body?.parent ?? {};
      return { ok: true as const, dataSource: str(parent.data_source_id) || str(parent.database_id) };
    });
    if (!page.ok) throw new Error(page.error);
    if (page.dataSource.replace(/-/g, "") !== BLOG_DS.replace(/-/g, "")) {
      throw new Error(`notion_page_id ${req.notionPageId} is not in the Blog data source (parent ${page.dataSource || "none"}) — refusing to touch it`);
    }
  }

  // 2. Generate and host in ONE step, returning only the hosted URL. The
  //    base64 (~MBs) never leaves this step, so it never lands in a step
  //    checkpoint or the run output — which is the whole point of this Zap.
  //    One attempt only: a retry would pay OpenAI for a second image, and an
  //    exhausted-retries error would replace OpenAI's message with a generic
  //    one. Failures come back as data and are thrown below, verbatim.
  const generated: GenerateResult = await ctx.step({
    name: "generate-and-upload",
    maxAttempts: 1,
    run: async (): Promise<GenerateResult> => {
      const endpoint = req.referenceImageUrl ? "images/edits" : "images/generations";
      const body: Record<string, unknown> = {
        model: req.model,
        prompt: req.prompt,
        size: req.size,
        quality: req.quality,
        complexity: req.complexity,
        n: 1,
        output_format: OUTPUT_FORMAT,
        output_compression: OUTPUT_COMPRESSION,
      };
      if (req.referenceImageUrl) body.images = [{ image_url: req.referenceImageUrl }];

      const res = await sdk.fetch(`${OPENAI_API}/${endpoint}`, {
        connection: OPENAI_CONNECTION,
        method: "POST",
        // Required: without an explicit JSON content type OpenAI answers 400.
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, error: openAiErrorMessage(res.status, text) };

      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { ok: false, error: `OpenAI ${res.status}: response was not JSON (${text.slice(0, 200)})` };
      }
      const b64 = str(parsed?.data?.[0]?.b64_json);
      if (!b64) {
        return { ok: false, error: `OpenAI returned no data[0].b64_json (keys: ${Object.keys(parsed?.data?.[0] ?? {}).join(", ")})` };
      }

      if (b64.length > MAX_B64_CHARS) {
        return {
          ok: false,
          error: `image is ${b64.length} base64 chars, over the ${MAX_B64_CHARS} Zapier can send to Cloudinary (~1 MB request cap) — try a smaller size or lower quality`,
        };
      }

      const publicId = publicIdFrom(req.filename);
      const inputs: Record<string, unknown> = {
        file: `data:image/${OUTPUT_FORMAT};base64,${b64}`,
        resource_type: "image",
        type: "upload",
        folder: CLOUDINARY_FOLDER,
      };
      if (publicId) inputs.public_id = publicId;

      let uploaded: any;
      try {
        uploaded = firstResult(
          await sdk.runAction({
            appKey: CLOUDINARY_APP_KEY,
            actionType: "write",
            actionKey: "upload_signed",
            connection: CLOUDINARY_CONNECTION,
            inputs,
          }),
        );
      } catch (err) {
        return { ok: false, error: `Cloudinary upload failed (image was generated and paid for): ${String((err as Error)?.message ?? err).slice(0, 500)}` };
      }
      const imageUrl = str(uploaded?.secure_url);
      if (!imageUrl) {
        return { ok: false, error: `Cloudinary returned no secure_url (keys: ${Object.keys(uploaded ?? {}).join(", ")})` };
      }
      return {
        ok: true,
        imageUrl,
        publicId: str(uploaded?.public_id),
        width: Number(uploaded?.width) || 0,
        height: Number(uploaded?.height) || 0,
        bytes: Number(uploaded?.bytes) || 0,
        b64Chars: b64.length,
        usage: parsed?.usage ?? null,
      };
    },
  });

  if (!generated.ok) throw new Error(generated.error);

  // 3. Optionally attach the hosted URL to the Blog page's Cover Image File.
  //    An external file pointing at Cloudinary: it doesn't expire, unlike a
  //    signed vendor URL. Replaces whatever the property held.
  let notionUpdated = false;
  if (req.notionPageId) {
    const patched = await ctx.step("attach-cover-image-file", async () => {
      const res = await sdk.fetch(`${NOTION_API}/pages/${req.notionPageId}`, {
        connection: NOTION_CONNECTION,
        method: "PATCH",
        headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
        body: JSON.stringify({
          properties: {
            [COVER_FILE_PROP]: {
              files: [
                {
                  type: "external",
                  name: `${generated.publicId.split("/").pop() || "hero-image"}.${OUTPUT_FORMAT}`,
                  external: { url: generated.imageUrl },
                },
              ],
            },
          },
        }),
      });
      if (!res.ok) return { ok: false as const, error: `Notion update ${COVER_FILE_PROP} failed (${res.status}): ${(await res.text()).slice(0, 300)}` };
      return { ok: true as const };
    });
    if (!patched.ok) throw new Error(`${patched.error} — the image itself is at ${generated.imageUrl}`);
    notionUpdated = true;
  }

  return {
    image_url: generated.imageUrl,
    png_url: pngUrlFrom(generated.imageUrl),
    format: OUTPUT_FORMAT,
    model: req.model,
    size: req.size,
    quality: req.quality,
    complexity: req.complexity,
    mode: req.referenceImageUrl ? "edit" : "generate",
    public_id: generated.publicId,
    width: generated.width,
    height: generated.height,
    bytes: generated.bytes,
    base64_chars: generated.b64Chars,
    usage: generated.usage,
    notion_page_id: req.notionPageId || null,
    notion_updated: notionUpdated,
  };
});

export default workflow;
