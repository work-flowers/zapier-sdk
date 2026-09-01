// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/notion-newsletter-to-buttondown
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

// Opening words of the confirmation comment this Zap posts on the page when a
// sync succeeds. Also the marker used to find the thread it started last time,
// so repeated syncs of one issue stack in a single discussion.
const COMMENT_MARKER = "Buttondown sync";

// Zapier Table that logs the Notion page id -> Buttondown email id mapping.
// Columns: "Page ID" (string), "Buttondown Email ID" (string), "Created at" (datetime).
// Tables auth is automatic (no connection needed), so this works from the durable.
const ZAPIER_TABLE_ID = "01KNJN2MSBAJVXRME6M1Y65F5B";

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

function extractPageId(raw: unknown): string | null {
  if (!raw) throw new Error("No input provided to workflow.");
  if (typeof raw === "string") return raw.trim() || null;
  const o = raw as Record<string, any>;
  const candidate =
    o.page_id ||
    o.pageId ||
    (o.data && (o.data.id || o.data.page_id)) ||
    o.id ||
    (o.page && o.page.id) ||
    o["data.id"] ||
    o["data__id"];
  if (!candidate) return null;
  return String(candidate).trim();
}

function plainText(rich: any): string {
  return (Array.isArray(rich) ? rich : []).map((t) => t?.plain_text ?? "").join("");
}

/**
 * Format a Notion date property's `start` for human eyes, for the confirmation
 * comment. Notion returns either "2026-08-18" or a full
 * "2026-08-18T09:00:00.000+08:00", and the offset is the one the date was
 * authored in — so the calendar date and clock time are already the local ones
 * and can simply be sliced out. Deliberately no `Date`: reformatting through it
 * would re-derive the same string via UTC, and the durable's determinism guard
 * forbids `new Date(...)` outside a `ctx.step` anyway.
 *
 * Midnight is how a date-only Send Date arrives once a time zone is attached, so
 * it reads as "no time set" and only the date is shown.
 */
function formatSendDate(raw: string): string {
  const [date, time] = raw.split("T");
  if (!time) return date;
  const hhmm = time.slice(0, 5);
  return hhmm === "00:00" ? date : `${date} at ${hhmm}`;
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
      // Each line here is a separate Notion block (paragraph, list item, ...).
      // Adjacent "> a" / "> b" lines are ONE Markdown paragraph whose soft
      // breaks collapse to spaces when rendered, so separate blocks with a
      // blank ">" line — except between list items, which stay tight.
      const isListItem = (l: string) => /^\s*([-*+]|\d+[.)])\s/.test(l);
      const quotedLines: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        quotedLines.push(l.trim() === "" ? ">" : `> ${l}`);
        const next = lines[i + 1];
        if (
          next !== undefined &&
          l.trim() !== "" &&
          next.trim() !== "" &&
          !(isListItem(l) && isListItem(next))
        ) {
          quotedLines.push(">");
        }
      }
      return `\n\n${quotedLines.join("\n")}\n\n`;
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

  // Notion exports an image caption into the Markdown alt-text slot: ![caption](url).
  // Alt text only surfaces for screen readers or when the image fails to load, so
  // mirror it into a visible italic line under the image while keeping the alt
  // attribute intact. Uncaptioned images export as ![](url) and are left alone, as
  // are inline images (the line must be nothing but the image) and anything inside
  // a code fence.
  //
  // A caption that is nothing but a Markdown link is the way to author a CLICKABLE
  // image, which Notion itself cannot do — image blocks carry no link target, and
  // the export has no linked-image form. Notion nests the caption inside the alt
  // slot as ![[text](href)](src), which renders as an image with junk alt text and
  // the href silently lost. Rewrite it to a real linked image plus a linked italic
  // line, so the link survives even when the client blocks images. A caption that
  // merely CONTAINS a link (surrounding prose, or link text with brackets) still
  // can't be parsed unambiguously out of the alt slot, so it is left as-is.
  //
  // Runs AFTER the tab strip above: images inside Notion column layouts arrive
  // indented, and would not match an anchored ^!\[ before those tabs are gone.
  {
    // ![[text](href)](src) — caption is a bare link. Checked first; the plain
    // pattern cannot match this line anyway (its alt group stops at the inner
    // "]", leaving "](src)" to fail the anchored tail), so the two are disjoint.
    const LINKED_CAPTION = /^!\[\[([^\]]+)\]\(([^)]+)\)\]\(([^)]+)\)[ \t]*$/;
    // ![caption](src) — ordinary caption.
    const PLAIN_CAPTION = /^!\[([^\]]+)\]\(([^)]+)\)[ \t]*$/;

    const lines = out.split("\n");
    let inFence = false;
    const result: string[] = [];
    for (const line of lines) {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        result.push(line);
        continue;
      }
      if (inFence) {
        result.push(line);
        continue;
      }
      const linked = line.match(LINKED_CAPTION);
      if (linked) {
        const [, text, href, src] = linked;
        result.push(`[![${text}](${src})](${href})`, "", `*[${text}](${href})*`);
        continue;
      }
      const plain = line.match(PLAIN_CAPTION);
      result.push(line);
      if (plain) result.push("", `*${plain[1]}*`);
    }
    out = result.join("\n");
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
    // Webhooks by Zapier sends periodic GET probes with an empty body
    // ({"querystring": {}}) to verify the hook is alive. Return early rather
    // than failing — there is nothing to process.
    if (pageId === null) {
      return { skipped: true, reason: "no Notion page id in payload — likely a platform probe" };
    }
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

    // 6. Log the page id -> Buttondown email id mapping to a Zapier Table.
    // Best-effort: the email + Notion write above are the real work, so a Tables
    // hiccup must not fail the run. Keyed on Page ID so re-runs/updates don't pile
    // up duplicate rows — create on first sync, refresh the email id thereafter.
    const tableLog = await ctx.step("log-to-zapier-table", async () => {
      try {
        const existing = await sdk.listTableRecords({
          table: ZAPIER_TABLE_ID,
          keyMode: "names",
          filters: [{ fieldKey: "Page ID", operator: "exact", value: pageId }],
          pageSize: 1,
        });
        const found = existing.data?.[0];
        if (found) {
          if (found.data?.["Buttondown Email ID"] !== buttondownId) {
            await sdk.updateTableRecords({
              table: ZAPIER_TABLE_ID,
              keyMode: "names",
              records: [{ id: found.id, data: { "Buttondown Email ID": buttondownId } }],
            });
            return { logged: "updated" as const, recordId: found.id };
          }
          return { logged: "unchanged" as const, recordId: found.id };
        }
        const created = await sdk.createTableRecords({
          table: ZAPIER_TABLE_ID,
          keyMode: "names",
          records: [
            {
              data: {
                "Page ID": pageId,
                "Buttondown Email ID": buttondownId,
                "Created at": new Date().toISOString(),
              },
            },
          ],
        });
        return { logged: "created" as const, recordId: created.data?.[0]?.id ?? null };
      } catch (err) {
        return { logged: "error" as const, error: String((err as Error)?.message ?? err) };
      }
    });

    // 7. Post a confirmation comment on the Notion page — the sync is done and
    // everything above succeeded, so this is the "it worked" signal an editor
    // sees without leaving the page.
    // Best-effort, like the Tables log: the email and the property write-back
    // are the real work, and a comment that fails to post must not fail a run
    // whose newsletter was pushed successfully. The outcome is returned so a
    // persistent failure is visible in run history rather than silent.
    const commentLog = await ctx.step("comment-on-notion-page", async () => {
      const modeLine =
        mode === "created"
          ? "created a new Buttondown email"
          : "updated the Buttondown email";
      const scheduleLine = willSchedule
        ? `Scheduled to send on ${formatSendDate(String(page.sendDate))}.`
        : "Saved as a draft — no Send Date set.";
      const richText = [
        {
          type: "text",
          text: { content: `${COMMENT_MARKER} ✅ — ${modeLine}.\n${scheduleLine}\n` },
        },
        {
          type: "text",
          text: { content: "Open in Buttondown", link: { url: buttondownUrl } },
        },
      ];
      try {
        // Reply into the thread a previous sync started, so an issue that gets
        // re-synced a few times while it is being edited collects one growing
        // discussion instead of a pile of top-level comments. Notion only
        // returns UNRESOLVED comments here, so resolving the thread in Notion
        // starts a fresh one on the next sync — which is the sensible
        // behaviour, not a bug.
        let discussionId: string | null = null;
        const list = await sdk.fetch(
          `${NOTION_API}/comments?block_id=${pageId}`,
          {
            connection: NOTION_CONNECTION,
            headers: { "Notion-Version": NOTION_VERSION },
          },
        );
        if (list.ok) {
          const data: any = await list.json();
          const previous = (data.results || []).find((c: any) =>
            plainText(c.rich_text).startsWith(COMMENT_MARKER),
          );
          discussionId = previous?.discussion_id ?? null;
        }
        const payload = discussionId
          ? { discussion_id: discussionId, rich_text: richText }
          : { parent: { page_id: pageId }, rich_text: richText };
        const res = await sdk.fetch(`${NOTION_API}/comments`, {
          connection: NOTION_CONNECTION,
          method: "POST",
          headers: {
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          throw new Error(
            `Notion comment failed (${res.status}): ${await res.text()}`,
          );
        }
        const comment: any = await res.json();
        return {
          commented: (discussionId ? "replied" : "created") as
            | "replied"
            | "created",
          commentId: comment?.id ?? null,
          discussionId: comment?.discussion_id ?? null,
        };
      } catch (err) {
        return {
          commented: "error" as const,
          error: String((err as Error)?.message ?? err),
        };
      }
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
      tableLog,
      commentLog,
    };
  },
});

export default workflow;
