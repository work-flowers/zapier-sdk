import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
const NOTION_CONNECTION = "notion_wf";
const BUTTONDOWN_CONNECTION = "buttondown";
const BUTTONDOWN_APP_KEY = "App240106CLIAPI";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";
const BUTTONDOWN_EMAIL_URL = "https://buttondown.com/emails/";

// Input arrives from a Catch Hook (the Notion "Send to Buttondown" button
// posts the page). The shape varies, so we accept anything and extract the
// page id ourselves; everything else is fetched fresh from Notion.
const InputSchema = z.unknown();

// --- Pure helpers ----------------------------------------------------------
function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline can deliver input double-encoded (a JSON string of a
  // JSON string), while run-durable delivers it single-encoded. Parse until we
  // reach a non-string, or stop on a bare page id string / parse failure.
  let v: unknown = rawInput;
  for (let i = 0; i < 4 && typeof v === "string"; i++) {
    const t = v.trim();
    if (t[0] !== "{" && t[0] !== "[" && t[0] !== '"') break; // bare id, not JSON
    try {
      v = JSON.parse(t);
    } catch {
      break;
    }
  }
  return v;
}

function extractPageId(raw: unknown): string {
  if (!raw) throw new Error("No input provided to workflow.");
  if (typeof raw === "string") return raw.trim();
  const o = raw as Record<string, any>;
  const candidate =
    o.page_id ||
    o.pageId ||
    (o.data && (o.data.id || o.data.page_id)) ||
    o.id ||
    (o.page && o.page.id) ||
    o["data.id"] ||
    o["data__id"];
  if (!candidate) {
    throw new Error(
      "Could not find a Notion page id in webhook payload: " +
        JSON.stringify(raw).slice(0, 300),
    );
  }
  return String(candidate).trim();
}

function plainText(rich: any): string {
  return (Array.isArray(rich) ? rich : []).map((t) => t?.plain_text ?? "").join("");
}

function mapButtondownStatus(status: unknown): string | null {
  const map: Record<string, string> = {
    draft: "Draft",
    scheduled: "Scheduled",
    sent: "Sent",
  };
  return map[String(status ?? "").toLowerCase()] ?? null;
}

/**
 * Notion's native markdown export (GET /v1/pages/{id}/markdown) is structurally
 * faithful — unlike the lossy Zapier "block_children" converter — but it emits
 * a handful of Notion-specific pseudo-tags that are not valid email markdown/HTML.
 * Convert just those to email-safe markdown. Inline images stay as ![](url);
 * the Buttondown create_draft action re-hosts them so expiring URLs don't break.
 */
function notionMarkdownToEmail(md: string): string {
  let out = (md || "").replace(/\r\n/g, "\n");

  // <callout icon="💡" color="blue_bg"> ... </callout>  ->  blockquote with icon
  out = out.replace(
    /<callout([^>]*)>([\s\S]*?)<\/callout>/g,
    (_m: string, attrs: string, inner: string) => {
      const iconMatch = attrs.match(/icon="([^"]*)"/);
      const icon = iconMatch ? iconMatch[1].trim() : "";
      const lines = inner
        .split("\n")
        .map((l) => l.replace(/^\t+/, "").replace(/^ {1,4}/, ""));
      while (lines.length && lines[0].trim() === "") lines.shift();
      while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
      if (icon && lines.length) lines[0] = `${icon} ${lines[0]}`;
      const quoted = lines
        .map((l) => (l.trim() === "" ? ">" : `> ${l}`))
        .join("\n");
      return `\n\n${quoted}\n\n`;
    },
  );

  // Column layouts -> flatten (stack content vertically; email is single-column).
  out = out.replace(/<\/?columns>/g, "\n\n").replace(/<\/?column>/g, "\n\n");

  // Spacer blocks -> blank line.
  out = out.replace(/<empty-block\s*\/?>/g, "\n\n");

  // Inline spans -> unwrap (keep inner text).
  out = out.replace(/<\/?span[^>]*>/g, "");

  // Explicit line breaks -> Markdown hard break (two trailing spaces + newline).
  out = out.replace(/<br\s*\/?>/g, "  \n");

  // Strip Notion's structural tab indentation (used for callouts/columns/nesting)
  // OUTSIDE fenced code blocks. Leftover leading tabs would otherwise turn former
  // column content (e.g. images) into Markdown indented code blocks. Code fences
  // are preserved verbatim so real code samples keep their indentation.
  {
    const lines = out.split("\n");
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(```|~~~)/.test(lines[i])) {
        inFence = !inFence;
        continue;
      }
      if (!inFence) lines[i] = lines[i].replace(/^\t+/, "");
    }
    out = lines.join("\n");
  }

  // Notion's native export separates EVERY block with a single newline, which
  // Markdown collapses into one paragraph (soft break). Insert a blank line
  // between adjacent blocks so each renders on its own — but keep list items and
  // blockquote lines tight, preserve hard breaks, and never touch code fences.
  {
    const lines = out.split("\n");
    const result: string[] = [];
    let inFence = false;
    const isList = (l: string) => /^\s*([-*+]|\d+[.)])\s/.test(l);
    const isQuote = (l: string) => /^\s*>/.test(l);
    const isHardBreak = (l: string) => / {2,}$/.test(l) || /\\$/.test(l);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      result.push(line);
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const next = lines[i + 1];
      if (next === undefined) continue;
      if (line.trim() === "" || next.trim() === "") continue;
      const tight =
        (isList(line) && isList(next)) ||
        (isQuote(line) && isQuote(next)) ||
        isHardBreak(line);
      if (!tight) result.push("");
    }
    out = result.join("\n");
  }

  // Collapse runs of blank lines.
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

// --- Workflow --------------------------------------------------------------
const workflow = defineDurable({
  name: "notion-newsletter-to-buttondown",
  description:
    "Turn a Notion Newsletter Issues page into a Buttondown draft/scheduled email. Uses Notion's native markdown export (fixes callouts/columns the old Zap lost) and the custom Buttondown integration (which re-hosts cover + inline images). Create-or-update keyed on the page's Buttondown ID.",
  inputSchema: InputSchema,
  run: async (ctx, rawInput) => {
    const norm = normalizeInput(rawInput);
    const pageId = extractPageId(norm);
    const flags =
      norm && typeof norm === "object"
        ? {
            previewOnly: Boolean((norm as any).previewOnly),
            forceDraft: Boolean((norm as any).forceDraft),
          }
        : { previewOnly: false, forceDraft: false };

    // 1. Read the Notion page: title, send date, cover, existing Buttondown ID.
    const page = await ctx.step("fetch-notion-page", async () => {
      const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
        connection: NOTION_CONNECTION,
        headers: { "Notion-Version": NOTION_VERSION },
      });
      if (!res.ok) {
        throw new Error(
          `Notion get page failed (${res.status}): ${await res.text()}`,
        );
      }
      const p: any = await res.json();
      const props = p.properties || {};
      const cover = p.cover || null;
      return {
        subject: plainText(props["Name"]?.title).trim() || "(untitled)",
        sendDate: props["Send Date"]?.date?.start || null,
        coverUrl: cover ? cover.external?.url || cover.file?.url || null : null,
        existingButtondownId:
          plainText(props["Buttondown ID"]?.rich_text).trim() || null,
        blogPostId: (props["Blog post"]?.relation || [])[0]?.id || null,
      };
    });

    // 2. Export the page body as Notion-native markdown.
    const markdown = await ctx.step("fetch-notion-markdown", async () => {
      const res = await sdk.fetch(
        `${NOTION_API}/pages/${pageId}/markdown`,
        {
          connection: NOTION_CONNECTION,
          headers: { "Notion-Version": NOTION_VERSION },
        },
      );
      if (!res.ok) {
        throw new Error(
          `Notion markdown export failed (${res.status}): ${await res.text()}`,
        );
      }
      const data: any = await res.json();
      return String(data.markdown || "");
    });

    // 3. Convert Notion pseudo-tags (callouts, columns, ...) to email markdown.
    const body = notionMarkdownToEmail(markdown);

    // 3b. Pull metadata from the related Blog post: the canonical URL (its
    // "Published URL" formula) and the "Description" rich_text, for the email.
    const blogMeta = await ctx.step("fetch-blog-metadata", async () => {
      if (!page.blogPostId) return { canonicalUrl: null, description: null };
      const res = await sdk.fetch(`${NOTION_API}/pages/${page.blogPostId}`, {
        connection: NOTION_CONNECTION,
        headers: { "Notion-Version": NOTION_VERSION },
      });
      if (!res.ok) {
        throw new Error(
          `Notion get blog page failed (${res.status}): ${await res.text()}`,
        );
      }
      const b: any = await res.json();
      const pub: any = b.properties?.["Published URL"];
      const canonicalUrl =
        (pub?.formula?.string || pub?.url || plainText(pub?.rich_text) || "")
          .trim() || null;
      const description =
        plainText(b.properties?.["Description"]?.rich_text).trim() || null;
      return { canonicalUrl, description };
    });
    const canonicalUrl = blogMeta.canonicalUrl;
    const description = blogMeta.description;

    // Side-effect-free preview path (for testing the conversion end to end).
    if (flags.previewOnly) {
      return {
        previewOnly: true,
        pageId,
        subject: page.subject,
        sendDate: page.sendDate,
        coverUrl: page.coverUrl,
        canonicalUrl,
        description,
        existingButtondownId: page.existingButtondownId,
        bodyLength: body.length,
        bodyPreview: body.slice(0, 1500),
      };
    }

    const willSchedule = Boolean(page.sendDate) && !flags.forceDraft;

    // 4. Create or update the Buttondown email (idempotent on Buttondown ID).
    let email: any;
    let mode: "created" | "updated";
    if (page.existingButtondownId) {
      mode = "updated";
      email = await ctx.step("update-buttondown-email", async () => {
        const inputs: Record<string, unknown> = {
          email_id: page.existingButtondownId,
          subject: page.subject,
          body,
        };
        if (page.coverUrl) inputs.image_url = page.coverUrl;
        if (willSchedule) inputs.publish_date = page.sendDate;
        if (canonicalUrl) inputs.canonical_url = canonicalUrl;
        if (description) inputs.description = description;
        return sdk.runAction({
          appKey: BUTTONDOWN_APP_KEY,
          actionType: "write",
          actionKey: "update_scheduled_email",
          connection: BUTTONDOWN_CONNECTION,
          inputs,
        });
      });
    } else {
      mode = "created";
      email = await ctx.step("create-buttondown-draft", async () => {
        const inputs: Record<string, unknown> = {
          subject: page.subject,
          body,
        };
        if (page.coverUrl) inputs.image_url = page.coverUrl;
        if (willSchedule) inputs.publish_date = page.sendDate;
        if (canonicalUrl) inputs.canonical_url = canonicalUrl;
        if (description) inputs.description = description;
        return sdk.runAction({
          appKey: BUTTONDOWN_APP_KEY,
          actionType: "write",
          actionKey: "create_draft",
          connection: BUTTONDOWN_CONNECTION,
          inputs,
        });
      });
    }

    // sdk.runAction returns results as an array under `.data` (data[0] = first result).
    const emailData: any = Array.isArray(email?.data)
      ? email.data[0]
      : email?.data ?? email;
    const buttondownId = String(
      emailData?.id ?? page.existingButtondownId ?? "",
    );
    if (!buttondownId) {
      throw new Error(
        "Could not determine Buttondown email id from action result: " +
          JSON.stringify(email).slice(0, 600),
      );
    }
    const buttondownStatus = emailData?.status ?? null;
    const buttondownUrl = `${BUTTONDOWN_EMAIL_URL}${buttondownId}`;
    const notionStatus = mapButtondownStatus(buttondownStatus);

    // 5. Write Buttondown ID / URL / Status back to the Notion page.
    await ctx.step("update-notion-page", async () => {
      const properties: Record<string, unknown> = {
        "Buttondown ID": {
          rich_text: [{ type: "text", text: { content: buttondownId } }],
        },
      };
      if (buttondownUrl) properties["Buttondown URL"] = { url: buttondownUrl };
      if (notionStatus) {
        properties["Status"] = { status: { name: notionStatus } };
      }
      const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
        connection: NOTION_CONNECTION,
        method: "PATCH",
        headers: {
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ properties }),
      });
      if (!res.ok) {
        throw new Error(
          `Notion page update failed (${res.status}): ${await res.text()}`,
        );
      }
      return { ok: true };
    });

    return {
      pageId,
      mode,
      subject: page.subject,
      buttondownId,
      buttondownUrl,
      buttondownStatus,
      notionStatus,
      canonicalUrl,
      buttondownCanonicalUrl: emailData?.canonical_url ?? null,
      description,
      buttondownDescription: emailData?.description ?? null,
      scheduled: willSchedule,
    };
  },
});

export default workflow;
