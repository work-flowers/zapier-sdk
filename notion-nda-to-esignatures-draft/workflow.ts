// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/notion-nda-to-esignatures-draft
//
// Notion NDAs "Send for signature" button -> eSignatures.com DRAFT contract.
// The contract text is the NDA row's own page body, which starts from the NDAs
// database template: the full Mutual NDA with placeholders written as inline
// code, e.g. `[Short name]`, that the user overwrites in place. The page body is
// injected into the "Mutual NDA" eSignatures template, a bare shell holding one
// {{ contract-body }} placeholder plus the signatory-title signer field. Same
// pattern as esignatures-send-for-signing (SOWs and Project Addendums).
//
// Nothing reaches a signer: the contract is saved as a draft, and a human
// reviews it in eSignatures and sends it from there.
import { createZapierSdk } from "@zapier/zapier-sdk";
import { defineDurable } from "@zapier/zapier-durable";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
const NOTION_CONNECTION = "notion_wf";
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

/** "NDAs" data source. A page from anywhere else is refused. */
const NDAS_DS = "354e3731-d2e4-497d-8df0-8ac9738df959";

// The PUBLIC eSignatures app. Its create_contract takes a template plus a
// markdown placeholder map, so it can do what the private "eSignatures.com
// (Unofficial)" app does for SOWs, and it also takes a second signer and
// metadata.
const ESIGN_APP_KEY = "EsignaturesioCLIAPI";
const ESIGN_CONNECTION = "esign";

/** eSignatures template "Mutual NDA": {{ contract-body }} + Signatory Details. */
const NDA_TEMPLATE_ID = "6325d51d-cd18-47fe-8925-0a0ccff24f3a";
const BODY_PLACEHOLDER = "contract-body";

/** workFlowers' signatory — always signer 2, after the counterparty. */
const WF_SIGNER = {
  name: "Dennis Chiuten",
  email: "dennis@work.flowers",
  company: "Company Flow Pte. Ltd.",
};

/** eSignatures user who owns the contract and receives its notifications. */
const ASSIGNED_USER = "dennis@work.flowers";

/**
 * "eSignatures Mapping" Zapier Table — contract id -> Notion page id, read by
 * esignatures-status-to-notion when eSignatures reports the contract sent or
 * signed. Shared with the SOW/addendum flows; Table ops cost no tasks.
 */
const ESIGN_TABLE = "01KHZEP4FA560E9GMTGTBR1E2N";
const AGREEMENT_TYPE = "NDA";

/** Status values that mean this row has already been through the Zap. */
const DONE_STATUSES = new Set(["Sent", "Signed", "Withdrawn"]);

/**
 * Status once the draft exists: it is waiting for a human to review and send
 * it from eSignatures. "Sent" (and Sent Date) belong to whatever records the
 * actual send — nothing does yet.
 */
const DRAFTED_STATUS = "Ready to send";

// --- Pure helpers ----------------------------------------------------------

/**
 * The trigger pipeline can deliver input double-encoded (a JSON string of a JSON
 * string), while run-durable delivers it single-encoded. Parse until we reach a
 * non-string, or stop on a bare page id / parse failure.
 */
function normalizeInput(rawInput: unknown): unknown {
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

function firstString(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

/** First item of a runAction result ({ data: [...] } or a bare array). */
function firstResult(res: any): any {
  if (!res) return null;
  if (Array.isArray(res)) return res[0] ?? null;
  if (Array.isArray(res.data)) return res.data[0] ?? null;
  return res.data ?? res;
}

function dashUuid(id: string): string {
  const hex = (id || "").replace(/-/g, "").toLowerCase();
  if (hex.length !== 32) return (id || "").trim();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function plainText(rich: unknown): string {
  if (!Array.isArray(rich)) return "";
  return rich
    .map((r: any) => firstString(r?.plain_text) || firstString(r?.text?.content))
    .join("")
    .trim();
}

/**
 * True when the payload carries no event at all — an empty POST or a bare GET
 * of the catch URL. Pasting the URL into the Notion button and hitting "test"
 * delivers exactly this, so it is a skip, not an error.
 *
 * A payload that DOES carry content but no page id is a real event whose shape
 * we failed to understand. That still throws, loudly (see extractPageId).
 */
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

/**
 * The Notion page id out of whatever the trigger delivered. A button property
 * posts `{ data: { id, properties, ... } }`; run-durable and trigger-workflow
 * accept a bare id or `{ pageId }` so a run can be replayed by hand.
 */
function extractPageId(raw: unknown): string {
  if (typeof raw === "string") return dashUuid(raw.trim());
  const o = (raw ?? {}) as Record<string, any>;
  const id = firstString(
    o.pageId,
    o.page_id,
    o.data?.id,
    o.data?.page_id,
    o.id,
    o.page?.id,
    o["data.id"],
    o["data__id"],
  );
  if (!id) {
    throw new Error(`Could not find a Notion page id in the payload: ${JSON.stringify(raw).slice(0, 400)}`);
  }
  return dashUuid(id);
}

/** A rollup's first array entry. Rollups arrive as {rollup:{array:[…]}}. */
function rollupFirst(prop: unknown): any {
  const arr = (prop as any)?.rollup?.array;
  return Array.isArray(arr) ? (arr[0] ?? null) : null;
}

/**
 * Contract id out of a create_contract result. The envelope can nest a second
 * `data` inside each runAction row (it does on the private eSignatures app), so
 * every plausible nesting is checked; a miss is a loud error, never a wrong id.
 */
function extractContractId(res: any): string {
  const row = firstResult(res);
  return firstString(
    row?.data?.contract?.id,
    row?.contract?.id,
    row?.data?.contract_id,
    row?.contract_id,
    row?.data?.id,
    row?.id,
  );
}

/**
 * The draft's edit link. Verified 2026-09-28: the contract object carries it as
 * `draft_contract_url`. Kept defensive anyway — any https URL carrying the
 * contract id, then the URL pattern esignatures-send-for-signing uses for
 * drafts on this account — because the field is undocumented in the schema.
 */
function extractDraftUrl(res: any, contractId: string): string {
  const row = firstResult(res);
  const direct = firstString(row?.data?.contract?.draft_contract_url, row?.contract?.draft_contract_url);
  if (direct) return direct;
  const found: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 6 || v == null) return;
    if (typeof v === "string") {
      if (/^https:\/\//.test(v) && v.includes(contractId)) found.push(v);
      return;
    }
    if (typeof v !== "object") return;
    for (const child of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) walk(child, depth + 1);
  };
  walk(res, 0);
  return (
    found.find((u) => /draft|edit/i.test(u)) ??
    found[0] ??
    `https://esignatures.com/draft_contracts/${contractId}/edit`
  );
}

// --- Placeholders ----------------------------------------------------------

/**
 * Apply `fn` to every line outside fenced code blocks. Inline-code handling must
 * never touch a fence, the one place a backtick means something else.
 */
function mapOutsideFences(md: string, fn: (line: string) => string): string {
  let inFence = false;
  return md
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : fn(line);
    })
    .join("\n");
}

const INLINE_CODE = /`([^`\n]+)`/g;

/**
 * Placeholders still in the body. The template writes each one as inline code
 * holding a bracketed label, e.g. `[Short name]`. A filled-in value keeps the
 * inline-code formatting (Notion carries it over when you type over the
 * selection) but loses the brackets, so a bracketed span means "not filled in".
 */
function unfilledPlaceholders(md: string): string[] {
  const found = new Set<string>();
  mapOutsideFences(md, (line) => {
    for (const m of line.matchAll(INLINE_CODE)) {
      const inner = (m[1] ?? "").trim();
      if (/^\[[^\]]+\]$/.test(inner)) found.add(inner);
    }
    return line;
  });
  return [...found];
}

/**
 * Strip inline-code formatting, so filled-in values print as ordinary contract
 * text. It also matters to eSignatures: its Extended Markdown reads a
 * backticked span at the end of a line as a signer-field JSON config.
 */
function unwrapInlineCode(md: string): string {
  return mapOutsideFences(md, (line) => line.replace(INLINE_CODE, "$1"));
}

// --- Notion markdown -> contract markdown ----------------------------------

/**
 * Notion's native markdown export (GET /v1/pages/{id}/markdown) is structurally
 * faithful — unlike the Zapier "block_children" converter the classic Zap's
 * hidden action extension used — but it emits Notion-specific pseudo-tags that
 * are not valid markdown. Convert just those, so what lands in the contract is
 * what the page shows.
 *
 * Copied verbatim from esignatures-send-for-signing's shared.ts (itself adapted
 * from notion-newsletter-to-buttondown). A fix to either copy belongs in both.
 */
function notionMarkdownToContract(md: string): string {
  let out = (md || "").replace(/\r\n/g, "\n");

  // <callout icon="💡" color="blue_bg"> ... </callout>  ->  blockquote with icon
  out = out.replace(
    /<callout([^>]*)>([\s\S]*?)<\/callout>/g,
    (_m: string, attrs: string, inner: string) => {
      const iconMatch = attrs.match(/icon="([^"]*)"/);
      const icon = iconMatch ? iconMatch[1].trim() : "";
      const lines = inner.split("\n").map((l) => l.replace(/^\t+/, "").replace(/^ {1,4}/, ""));
      while (lines.length && lines[0].trim() === "") lines.shift();
      while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
      if (icon && lines.length) lines[0] = `${icon} ${lines[0]}`;
      const quoted = lines.map((l) => (l.trim() === "" ? ">" : `> ${l}`)).join("\n");
      return `\n\n${quoted}\n\n`;
    },
  );

  // Column layouts -> flatten. A contract is a single column of text.
  out = out.replace(/<\/?columns>/g, "\n\n").replace(/<\/?column>/g, "\n\n");

  // Spacer blocks -> blank line.
  out = out.replace(/<empty-block\s*\/?>/g, "\n\n");

  // Inline spans -> unwrap (keep inner text).
  out = out.replace(/<\/?span[^>]*>/g, "");

  // Explicit line breaks -> Markdown hard break (two trailing spaces + newline).
  out = out.replace(/<br\s*\/?>/g, "  \n");

  // Notion exports tables as HTML (<table><tr><td>), which the block-separation
  // pass below would shred into one block per tag — and these carry the fee,
  // timeline and party tables that make up much of a real agreement. Convert them
  // to Markdown pipe tables instead of leaving raw HTML, so rendering does not
  // depend on eSignatures' markdown engine passing HTML through.
  out = out.replace(/<table([^>]*)>([\s\S]*?)<\/table>/g, (_m: string, attrs: string, inner: string) => {
    const hasHeaderRow = /header-row="true"/.test(attrs);
    const rows: string[][] = [];
    for (const rowMatch of inner.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells: string[] = [];
      for (const cellMatch of (rowMatch[1] ?? "").matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)) {
        // A cell's own newlines would break the single-line pipe row.
        cells.push((cellMatch[1] ?? "").replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim());
      }
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return "\n\n";

    // Notion emits a leading all-empty row for header-row tables whose header
    // cells were never filled in. Dropping it would silently delete a real row if
    // it had content, so only an entirely blank first row goes.
    if (rows.length > 1 && rows[0].every((c) => c === "")) rows.shift();

    const width = Math.max(...rows.map((r) => r.length));
    const pad = (r: string[]) => {
      const c = r.slice();
      while (c.length < width) c.push("");
      return c;
    };
    const line = (r: string[]) => `| ${pad(r).join(" | ")} |`;
    const sep = `| ${Array(width).fill("---").join(" | ")} |`;

    // A pipe table needs a header row to be a table at all. When Notion says
    // there is none, emit an empty header so every data row survives.
    const outLines = hasHeaderRow
      ? [line(rows[0]), sep, ...rows.slice(1).map(line)]
      : [line(Array(width).fill("")), sep, ...rows.map(line)];
    return `\n\n${outLines.join("\n")}\n\n`;
  });

  // Notion's <colgroup>/<col> sizing hints carry no content.
  out = out.replace(/<colgroup>[\s\S]*?<\/colgroup>/g, "").replace(/<col\s*[^>]*\/?>/g, "");

  // Handle Notion's structural tab indentation OUTSIDE fenced code blocks.
  // Leftover leading tabs would turn former column content into Markdown indented
  // code blocks — but they are NOT all noise:
  //   - on a list item, a tab is real nesting, so convert it to the 4 spaces
  //     Markdown wants. Stripping it outright promotes a sub-clause to a clause,
  //     which changes what the agreement says.
  //   - directly under a blockquote, it is a callout's continuation line, so
  //     carry the "> " prefix down rather than letting it fall out of the quote.
  //   - otherwise, strip.
  {
    const lines = out.split("\n");
    let inFence = false;
    let prevWasQuote = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;

      const tabs = line.match(/^\t+/);
      const rest = line.replace(/^\t+/, "");
      if (tabs && /^([-*+]|\d+[.)])\s/.test(rest)) {
        lines[i] = " ".repeat(4 * tabs[0].length) + rest;
      } else if (tabs && prevWasQuote && rest.trim() !== "") {
        lines[i] = `> ${rest}`;
      } else if (tabs) {
        lines[i] = rest;
      }
      prevWasQuote = /^\s*>/.test(lines[i]);
    }
    out = lines.join("\n");
  }

  // Notion's export separates EVERY block with a single newline, which Markdown
  // collapses into one paragraph. Insert a blank line between adjacent blocks so
  // each renders on its own — but keep list items and blockquote lines tight,
  // preserve hard breaks, and never touch code fences. Without this, a contract's
  // clauses run together into a wall of text.
  {
    const lines = out.split("\n");
    const result: string[] = [];
    let inFence = false;
    const isList = (l: string) => /^\s*([-*+]|\d+[.)])\s/.test(l);
    const isQuote = (l: string) => /^\s*>/.test(l);
    // A pipe table is only a table while its rows stay on consecutive lines, so
    // these must never be separated — same reasoning as list items.
    const isTableRow = (l: string) => /^\s*\|/.test(l);
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
        (isTableRow(line) && isTableRow(next)) ||
        isHardBreak(line);
      if (!tight) result.push("");
    }
    out = result.join("\n");
  }

  return out.replace(/\n{3,}/g, "\n\n").trim();
}

// --- Page reading ----------------------------------------------------------

interface NdaSnapshot {
  pageId: string;
  dataSourceId: string;
  status: string;
  contractUrl: string;
  legalName: string;
  signerName: string;
  signerEmail: string;
  missing: string[];
}

function readNda(page: any): NdaSnapshot {
  const props = page?.properties ?? {};
  const missing: string[] = [];

  const legalName = plainText(props["Counterparty Legal Name"]?.title);
  if (!legalName) missing.push("Counterparty Legal Name");

  // Signer is a single-page relation to Contacts; name and email come through
  // the "Signer Name" / "Signer Email" rollups, which the REST API computes.
  // The override wins when set, which is the whole point of it — as on SOWs, an
  // NDA can go to a different address than the contact's Primary Email.
  const signerSet = Array.isArray(props["Signer"]?.relation) && props["Signer"].relation.length > 0;
  const signerName = plainText(rollupFirst(props["Signer Name"])?.title);
  const signerEmail =
    firstString(props["Override Email (Optional)"]?.email) || firstString(rollupFirst(props["Signer Email"])?.email);
  if (!signerSet) missing.push("Signer");
  else {
    if (!signerName) missing.push("Signer Name (the Signer contact has no name)");
    if (!signerEmail) missing.push("Signer Email (the Signer contact has no Primary Email, and Override Email is empty)");
  }

  return {
    pageId: dashUuid(firstString(page?.id)),
    dataSourceId: dashUuid(firstString(page?.parent?.data_source_id)),
    // A `status`-type property since 2026-09-28 (was `select`). Reading the
    // wrong key returns nothing, which would silently disarm the Status guard.
    status: firstString(props["Status"]?.status?.name),
    contractUrl: firstString(props["Contract URL"]?.url),
    legalName,
    signerName,
    signerEmail,
    missing,
  };
}

/** Why this row must not get a draft (before reading the body), or null. */
function propertyRefusal(snap: NdaSnapshot): { reason: string; comment: string } | null {
  // Already drafted — the guard against a second click creating a second
  // contract. Contract URL is the one place the row records the contract.
  if (snap.contractUrl) {
    return {
      reason: "already-drafted",
      comment:
        `This NDA already has an eSignatures contract (${snap.contractUrl}), so no new draft was created. ` +
        "To start over, clear Contract URL and press the button again.",
    };
  }
  if (DONE_STATUSES.has(snap.status)) {
    return {
      reason: "status-not-draftable",
      comment: `Status is "${snap.status}", so no draft was created. Set Status to Draft or Ready to send to create one.`,
    };
  }
  if (snap.missing.length) {
    return {
      reason: "missing-required-properties",
      comment: `No draft was created. Fill in these properties and press the button again: ${snap.missing.join(", ")}.`,
    };
  }
  return null;
}

/** Why the page body can't become a contract, or null. */
function bodyRefusal(body: string, unfilled: string[]): { reason: string; comment: string } | null {
  if (!body) {
    return {
      reason: "empty-body",
      comment:
        "No draft was created: this page has no contract text. Create the NDA from the Mutual NDA database " +
        "template (or paste its text into the page), fill in the placeholders, and press the button again.",
    };
  }
  if (unfilled.length) {
    return {
      reason: "unfilled-placeholders",
      comment:
        `No draft was created. These placeholders in the page are still unfilled: ${unfilled.join(", ")}. ` +
        "Type over each one (a filled value has no square brackets) and press the button again.",
    };
  }
  return null;
}

// --- Workflow --------------------------------------------------------------

export default defineDurable("notion-nda-to-esignatures-draft", async (ctx, rawInput) => {
  const payload = normalizeInput(rawInput);

  // Guard BEFORE any id extraction — see isEmptyPing.
  if (isEmptyPing(payload)) {
    console.log("empty payload — treating as a ping of the catch URL, not an event");
    return { skipped: "empty-payload" };
  }

  const pageId = extractPageId(payload);

  // 1. Read the row fresh. Fetched rather than taken from the button payload so
  //    a replay by page id sees the same thing, and because the signer lives
  //    behind rollups that SQL-mode queries cannot see.
  const page = await ctx.step("fetch-nda-page", async () => {
    const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
      connection: NOTION_CONNECTION,
      headers: { "Notion-Version": NOTION_VERSION },
    });
    if (!res.ok) {
      throw new Error(`Notion get page ${pageId} failed (${res.status}): ${await res.text()}`);
    }
    return res.json();
  });

  const snap = readNda(page);

  // A page from another data source means the button (or a replay) is wired to
  // the wrong database. That is a misconfiguration nobody would otherwise see.
  if (snap.dataSourceId !== NDAS_DS) {
    throw new Error(
      `Page ${pageId} is not an NDAs row (parent data source ${snap.dataSourceId || "none"}, expected ${NDAS_DS})`,
    );
  }

  // 2. The page body is the contract. Skipped when the properties already rule
  //    the row out, so a second click doesn't pay for an export.
  let refused = propertyRefusal(snap);
  let body = "";
  let unfilled: string[] = [];
  if (!refused) {
    const markdown = await ctx.step("fetch-nda-markdown", async () => {
      const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}/markdown`, {
        connection: NOTION_CONNECTION,
        headers: { "Notion-Version": NOTION_VERSION },
      });
      if (!res.ok) {
        throw new Error(`Notion markdown export failed (${res.status}): ${await res.text()}`);
      }
      const data: any = await res.json();
      // A contract missing a clause is worse than no contract, so a partial
      // export is a loud failure rather than a draft.
      if (data?.truncated === true) {
        throw new Error(`Notion markdown export of ${pageId} was truncated`);
      }
      const unknown = Array.isArray(data?.unknown_block_ids) ? data.unknown_block_ids : [];
      if (unknown.length) {
        throw new Error(`Notion could not export ${unknown.length} block(s) of ${pageId}: ${unknown.join(", ")}`);
      }
      return String(data?.markdown ?? "");
    });

    const raw = notionMarkdownToContract(markdown);
    unfilled = unfilledPlaceholders(raw);
    body = unwrapInlineCode(raw);
    refused = bodyRefusal(body, unfilled);
  }

  // 3. Refuse rows that are already drafted, finished, or incomplete. A person
  //    has to act on these, so it is a skip with a comment on the page rather
  //    than an error alert.
  if (refused) {
    const comment = refused.comment;
    await ctx.step("comment-not-drafted", async () => {
      // Never throws: a failed comment must not turn a clean skip into a red run.
      try {
        const res = await sdk.fetch(`${NOTION_API}/comments`, {
          connection: NOTION_CONNECTION,
          method: "POST",
          headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
          body: JSON.stringify({
            parent: { page_id: snap.pageId },
            rich_text: [{ text: { content: comment } }],
          }),
        });
        if (!res.ok) console.log(`Failed to add comment (${res.status}): ${await res.text()}`);
      } catch (err) {
        console.log(`Failed to add comment: ${String((err as Error)?.message ?? err)}`);
      }
    });
    console.log(`not drafted: ${refused.reason}`);
    return { skipped: refused.reason, pageId: snap.pageId, missing: snap.missing, unfilled };
  }

  // 4. Create the draft. ONE attempt: create_contract is not idempotent, and a
  //    failure after eSignatures accepted the request would otherwise leave a
  //    duplicate draft per retry. A failed run is readable; pressing the button
  //    again is the retry.
  const contract = await ctx.step({
    name: "create-nda-draft",
    maxAttempts: 1,
    run: async () =>
      sdk.runAction({
        appKey: ESIGN_APP_KEY,
        actionType: "write",
        actionKey: "create_contract",
        connection: ESIGN_CONNECTION,
        inputs: {
          template_id: NDA_TEMPLATE_ID,
          title: `Mutual NDA – ${snap.legalName}`,
          placeholder_fields_markdown_map: { [BODY_PLACEHOLDER]: body },
          metadata: snap.pageId,
          assigned_user_email: ASSIGNED_USER,
          zapier_signer_name_1: snap.signerName,
          zapier_signer_email_1: snap.signerEmail,
          zapier_signer_company_name_1: snap.legalName,
          zapier_signer_signing_order_1: 1,
          zapier_signer_name_2: WF_SIGNER.name,
          zapier_signer_email_2: WF_SIGNER.email,
          zapier_signer_company_name_2: WF_SIGNER.company,
          zapier_signer_signing_order_2: 2,
          save_as_draft: "yes",
          test: "no",
        },
      }),
  });

  const contractId = extractContractId(contract);
  if (!contractId) {
    throw new Error(`eSignatures create_contract returned no contract id: ${JSON.stringify(contract).slice(0, 600)}`);
  }
  const contractUrl = extractDraftUrl(contract, contractId);

  // 5. Write back in one PATCH. Replaying it lands in the same state, so the
  //    default retries are safe. Raw REST rather than update_database_item
  //    because the action's schema cache lags newly created databases.
  await ctx.step("update-nda-row", async () => {
    const res = await sdk.fetch(`${NOTION_API}/pages/${snap.pageId}`, {
      connection: NOTION_CONNECTION,
      method: "PATCH",
      headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify({
        properties: {
          "Contract URL": { url: contractUrl },
          Status: { status: { name: DRAFTED_STATUS } },
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`Notion update page ${snap.pageId} failed (${res.status}): ${await res.text()}`);
    }
    return { ok: true };
  });

  // 6. Map the contract so esignatures-status-to-notion can move this row to
  //    Sent / Signed later. After the Notion write-back on purpose: Contract URL
  //    is what stops a second press making a duplicate draft, so it lands
  //    first. Find-then-create in one step, so a retry re-reads instead of
  //    adding a second row.
  const mapping = await ctx.step("table-map-contract", async () => {
    const found = await sdk.listTableRecords({
      table: ESIGN_TABLE,
      keyMode: "names",
      filters: [{ fieldKey: "Contract ID", operator: "exact", value: contractId }],
      pageSize: 10,
    });
    const existing = firstString(((found as any)?.data ?? [])[0]?.id);
    if (existing) return { id: existing, created: false };
    const created = await sdk.createTableRecords({
      table: ESIGN_TABLE,
      keyMode: "names",
      records: [
        {
          data: {
            "Page ID": snap.pageId,
            "Contract ID": contractId,
            // labeled_string cells take { value, label }.
            "Agreement Type": { value: AGREEMENT_TYPE, label: AGREEMENT_TYPE },
          },
        },
      ],
    });
    const id = firstString(firstResult(created)?.id);
    if (!id) throw new Error("Zapier Table create returned no record id");
    return { id, created: true };
  });

  console.log(`drafted ${contractId} for ${snap.signerEmail} (${snap.legalName}, ${body.length} chars)`);

  return {
    pageId: snap.pageId,
    counterparty: snap.legalName,
    signer: snap.signerEmail,
    contractId,
    contractUrl,
    status: DRAFTED_STATUS,
    tableRowId: mapping.id,
    bodyChars: body.length,
  };
});
