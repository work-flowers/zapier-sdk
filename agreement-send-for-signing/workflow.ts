// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/agreement-send-for-signing
//
// Notion Agreement Pipeline "Send to eSignatures" button -> eSignatures.com
// DRAFT contract. The contract text is the row's own page body; the row's
// Document type picks the eSignatures shell template and where signer 1 comes
// from. Dennis (Company Flow Pte. Ltd.) is always signer 2.
//
// One deployment for every agreement type. It replaces sow-send-for-signing,
// project-addendum-send-for-signing and notion-nda-to-esignatures-draft
// (TKT-1088), so a new document type is one row in DOC_TYPES below.
//
// Drafting is not sending: nothing reaches a signer. The Zap writes the draft
// link to `eSignatures contract` and sets Status to "Ready to send". "Sent for
// signature" and "Signed" are written by esignatures-status-to-notion when
// eSignatures reports the real send and signature.
//
// Built from esignatures-send-for-signing/shared.ts (mapping row, resend
// handling, update-draft-in-place, markdown normaliser) plus the guards from
// notion-nda-to-esignatures-draft (wrong database throws, unfilled bracketed
// placeholders refuse, inline-code formatting stripped, partial export throws).
import { createZapierSdk } from "@zapier/zapier-sdk";
import { defineDurable } from "@zapier/zapier-durable";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
const NOTION_CONNECTION = "notion_wf";
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

/** "Agreement Pipeline" data source. A page from anywhere else throws. */
const PIPELINE_DS = "42491b07-11ac-8198-b685-000bf23f6e17";

// The PUBLIC eSignatures app, for every call: create_contract takes a template
// plus a markdown placeholder map AND a second signer, which the private
// "eSignatures.com (Unofficial)" app used by the SOW flow cannot do; it also
// reads a contract and updates a draft in place on a resend.
const ESIGN_APP_KEY = "EsignaturesioCLIAPI";
const ESIGN_CONNECTION = "esign";

/** Placeholder every shell template holds, and the body goes into. */
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
 * "eSignatures Mapping" Zapier Table — contract id <-> Notion page id, read by
 * esignatures-status-to-notion, which only has a contract id when eSignatures
 * fires. Rows written here carry Agreement Type = "Agreement" (exact string):
 * that is how the status sync knows the page is an Agreement Pipeline row.
 * Table ops cost no tasks.
 */
const ESIGN_TABLE = "01KHZEP4FA560E9GMTGTBR1E2N";
const T_PAGE_ID = "Page ID";
const T_CONTRACT_ID = "Contract ID";
const T_AGREEMENT_TYPE = "Agreement Type";
const AGREEMENT_TYPE = "Agreement";

// --- Pipeline properties ---------------------------------------------------
const P = {
  title: "Agreement Name",
  docType: "Document type",
  status: "Status",
  signatory: "Signatory",
  signerName: "Signer name",
  signerEmail: "Signer email",
  overrideEmail: "Override email",
  consultant: "Consultant",
  parent: "Parent agreement",
  counterparty: "Counterparty",
  contractUrl: "eSignatures contract",
} as const;

/** Status once the draft exists: waiting for a human to review and send it. */
const DRAFTED_STATUS = "Ready to send";

/** Status values that mean the agreement is past drafting. */
const DONE_STATUSES = new Set(["Sent for signature", "Signed", "Cancelled", "Lapsed"]);

const BUTTON = "Send to eSignatures";

// --- Config by Document type -------------------------------------------------

// eSignatures shell templates. All three are bare shells around the
// `contract-body` placeholder (read back 2026-11-27): Scope of Work and
// Consultant Project Addendum hold only `{{contract-body}}`; Mutual NDA adds a
// page break and a "Signatory Details" section asking every signer for their
// Title / Designation.
const TPL_SOW = "6eaa0583-2cde-42d2-bf3e-2fe9b0808f3e"; // "Scope of Work"
const TPL_ADDENDUM = "443d6bed-607d-458e-a0de-27dd627bf96f"; // "Consultant Project Addendum"
const TPL_NDA = "6325d51d-cd18-47fe-8925-0a0ccff24f3a"; // "Mutual NDA"
// Consulting agreement and Amendment have no shell of their own. Until Dennis
// decides on a generic one (proposed in the TKT-1088 PR), they use the bare
// Scope of Work shell, which holds nothing but the body.
const TPL_GENERIC = TPL_SOW;

/** Where signer 1 comes from. */
type SignerSource = "signatory" | "consultant";

interface DocTypeConfig {
  /** Contract title prefix: "<label> – <Counterparty>". */
  label: string;
  templateId: string;
  signer: SignerSource;
  /** Parent agreement must be set. */
  needsParent: boolean;
  /** Counterparty must be set. */
  needsCounterparty: boolean;
}

const SOW: DocTypeConfig = {
  label: "Scope of Work",
  templateId: TPL_SOW,
  signer: "signatory",
  needsParent: false,
  needsCounterparty: false,
};

/** Keyed on the exact Document type option names (note the en dashes). */
const DOC_TYPES: Record<string, DocTypeConfig> = {
  "SOW – Fixed project": SOW,
  "SOW – Full retainer": SOW,
  "SOW – Support retainer": SOW,
  "Order form": { ...SOW, label: "Order Form" },
  "Project addendum": {
    label: "Project Addendum",
    templateId: TPL_ADDENDUM,
    signer: "consultant",
    needsParent: true,
    needsCounterparty: false,
  },
  NDA: {
    label: "Mutual NDA",
    templateId: TPL_NDA,
    signer: "signatory",
    needsParent: false,
    needsCounterparty: true,
  },
  "Consulting agreement": {
    label: "Consulting Agreement",
    templateId: TPL_GENERIC,
    signer: "signatory",
    needsParent: false,
    needsCounterparty: false,
  },
  Amendment: {
    label: "Amendment",
    templateId: TPL_GENERIC,
    signer: "signatory",
    needsParent: false,
    needsCounterparty: false,
  },
};

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

function relationIds(prop: unknown): string[] {
  const rel = (prop as any)?.relation;
  if (!Array.isArray(rel)) return [];
  return rel.map((r: any) => firstString(r?.id)).filter(Boolean).map(dashUuid);
}

/** The eSignatures contract id inside a contract URL (draft or sent form), or "". */
function contractIdFromUrl(url: string): string {
  const m = (url || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0].toLowerCase() : "";
}

function draftUrlFor(contractId: string): string {
  return `https://esignatures.com/draft_contracts/${contractId}/edit`;
}

/**
 * Contract id out of a create_contract result. The envelope nests a second
 * `data` inside each runAction row, so every plausible nesting is checked; a
 * miss is a loud error, never a wrong id.
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
 * The draft's edit link. The contract object carries it as
 * `draft_contract_url` (verified 2026-09-28 on the NDA flow); the URL pattern
 * is the fallback. Either way it contains the contract id, which
 * esignatures-status-to-notion's fallback search relies on.
 */
function extractDraftUrl(res: any, contractId: string): string {
  const row = firstResult(res);
  const direct = firstString(row?.data?.contract?.draft_contract_url, row?.contract?.draft_contract_url);
  return direct && direct.includes(contractId) ? direct : draftUrlFor(contractId);
}

/**
 * What a resend should do with the contract already on the row, from its
 * eSignatures status (probed 2026-11-25 for esignatures-send-for-signing):
 *
 *   - `draft`: not yet sent, and its body placeholder and signer CAN be updated
 *     in place, so update it. Pressing the button again never makes a second
 *     draft.
 *   - `withdrawn`, or the contract no longer exists (`contract-not-found`):
 *     nothing live to protect, so draft a new one.
 *   - `signed`, and anything else (out with the signer, or a status never seen):
 *     a person has to decide, so refuse and say why on the page.
 */
type ExistingAction = "update-draft" | "create-new" | "refuse";

function existingContractAction(status: string): ExistingAction {
  const s = (status || "").trim().toLowerCase();
  if (s === "draft") return "update-draft";
  if (s === "withdrawn" || s === "not-found") return "create-new";
  return "refuse";
}

/**
 * Contract status out of a query_contract result: the contract's own status, or
 * "not-found" when eSignatures answers `contract-not-found`. Any other error
 * envelope throws — a failed read must not be mistaken for "no contract".
 */
function readContractStatus(res: any): { status: string; contract: any } {
  const row = firstResult(res);
  if (row?.status === "error") {
    const code = firstString(row?.data?.error_code);
    if (code === "contract-not-found") return { status: "not-found", contract: null };
    throw new Error(`eSignatures query_contract failed: ${code} ${firstString(row?.data?.error_message)}`);
  }
  const contract = row?.data?.contract ?? row?.contract ?? null;
  const status = firstString(contract?.status);
  if (!status) {
    throw new Error(`eSignatures query_contract returned no status: ${JSON.stringify(res).slice(0, 400)}`);
  }
  return { status, contract };
}

/** Throw unless an eSignatures write answered with something other than an error. */
function assertEsignOk(res: any, what: string): void {
  const row = firstResult(res);
  if (row?.status === "error") {
    throw new Error(
      `eSignatures ${what} failed: ${firstString(row?.data?.error_code)} ${firstString(row?.data?.error_message)}`,
    );
  }
}

/**
 * Signer 1 (the counterparty) on an existing contract. `signing_order` comes
 * back as a string ("1"); falls back to the first signer that isn't Dennis.
 * Matching by order, not email, matters when the counterparty signer IS
 * Dennis's address (a test row).
 */
function counterpartySigner(contract: any): any {
  const signers: any[] = Array.isArray(contract?.signers) ? contract.signers : [];
  return (
    signers.find((s) => firstString(s?.signing_order) === "1") ??
    signers.find((s) => firstString(s?.email).toLowerCase() !== WF_SIGNER.email) ??
    signers[0] ??
    null
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
 * Placeholders still in the body. Templates write each one as inline code
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
 * faithful but emits Notion-specific pseudo-tags that are not valid markdown.
 * Convert just those, so what lands in the contract is what the page shows.
 *
 * Copied verbatim from esignatures-send-for-signing/shared.ts (also copied in
 * notion-nda-to-esignatures-draft). A fix to one copy belongs in all three
 * until those two are retired in the cutover task.
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

interface Signer {
  name: string;
  email: string;
  company: string;
}

interface Snapshot {
  pageId: string;
  dataSourceId: string;
  agreementName: string;
  docType: string;
  status: string;
  counterparty: string;
  contractUrl: string;
  /** Null when Document type is empty or not in DOC_TYPES. */
  cfg: DocTypeConfig | null;
  title: string;
  signer: Signer;
  missing: string[];
}

function readRow(page: any): Snapshot {
  const props = page?.properties ?? {};
  const docType = firstString(props[P.docType]?.select?.name);
  const cfg = Object.prototype.hasOwnProperty.call(DOC_TYPES, docType) ? DOC_TYPES[docType] : null;
  const agreementName = plainText(props[P.title]?.title);
  // Registered legal name, typed by hand. Not derived from Companies, where the
  // name is often a trading name and an individual consultant has no Company.
  const counterparty = plainText(props[P.counterparty]?.rich_text);
  // The override wins over every other source, which is the whole point of it.
  const override = firstString(props[P.overrideEmail]?.email);
  const missing: string[] = [];

  const signer: Signer = { name: "", email: "", company: counterparty };
  if (cfg?.signer === "signatory") {
    // Single-page relation to Contacts; name and email come through rollups,
    // which the REST API computes (SQL-mode queries cannot see them).
    const set = relationIds(props[P.signatory]).length > 0;
    signer.name = plainText(rollupFirst(props[P.signerName])?.title);
    signer.email = override || firstString(rollupFirst(props[P.signerEmail])?.email);
    if (!set) missing.push(P.signatory);
    else {
      if (!signer.name) missing.push(`${P.signerName} (the Signatory contact has no name)`);
      if (!signer.email) {
        missing.push(`${P.signerEmail} (the Signatory contact has no Primary Email, and ${P.overrideEmail} is empty)`);
      }
    }
  } else if (cfg?.signer === "consultant") {
    // A Notion person (limit 1); the email comes from their Notion account.
    const person = (props[P.consultant]?.people ?? [])[0] ?? null;
    signer.name = firstString(person?.name);
    signer.email = override || firstString(person?.person?.email);
    if (!person) missing.push(P.consultant);
    else {
      if (!signer.name) missing.push(`${P.consultant} (that person has no name)`);
      if (!signer.email) missing.push(`${P.consultant} email (that person has no email, and ${P.overrideEmail} is empty)`);
    }
  }
  if (cfg?.needsParent && relationIds(props[P.parent]).length === 0) missing.push(P.parent);
  if (cfg?.needsCounterparty && !counterparty) missing.push(P.counterparty);

  const label = cfg?.label ?? docType;
  const title = counterparty
    ? `${label} – ${counterparty}`
    : agreementName
      ? `${label} – ${agreementName}`
      : label;

  return {
    pageId: dashUuid(firstString(page?.id)),
    dataSourceId: dashUuid(firstString(page?.parent?.data_source_id)),
    agreementName,
    docType,
    status: firstString(props[P.status]?.status?.name),
    counterparty,
    contractUrl: firstString(props[P.contractUrl]?.url),
    cfg,
    title,
    signer,
    missing,
  };
}

interface Refusal {
  reason: string;
  comment: string;
}

/** Why this row must not get a draft (before any paid eSignatures call), or null. */
function propertyRefusal(snap: Snapshot): Refusal | null {
  if (!snap.cfg) {
    const known = Object.keys(DOC_TYPES).join(", ");
    return {
      reason: snap.docType ? "unknown-document-type" : "missing-document-type",
      comment: snap.docType
        ? `No draft was created: Document type "${snap.docType}" has no eSignatures setup yet. ` +
          `Supported types: ${known}. Ask Dennis to add it to the agreement-send-for-signing Zap.`
        : `No draft was created: Document type is empty. Set it (one of: ${known}) and press ${BUTTON} again.`,
    };
  }
  if (DONE_STATUSES.has(snap.status)) {
    return {
      reason: "status-not-draftable",
      comment:
        `Status is "${snap.status}", so no draft was created or changed. ` +
        `Set Status back to Draft or Ready to send to draft this agreement again.`,
    };
  }
  if (snap.missing.length) {
    return {
      reason: "missing-required-properties",
      comment: `No draft was created. Fill in these properties and press ${BUTTON} again: ${snap.missing.join("; ")}.`,
    };
  }
  return null;
}

/** Why the page body can't become a contract, or null. */
function bodyRefusal(body: string, unfilled: string[]): Refusal | null {
  if (!body) {
    return {
      reason: "empty-body",
      comment:
        `No draft was created: this page has no contract text. Write or paste the agreement into the page ` +
        `body (or start the row from its database template) and press ${BUTTON} again.`,
    };
  }
  if (unfilled.length) {
    return {
      reason: "unfilled-placeholders",
      comment:
        `No draft was created. These placeholders in the page are still unfilled: ${unfilled.join(", ")}. ` +
        `Type over each one (a filled value has no square brackets) and press ${BUTTON} again.`,
    };
  }
  return null;
}

/** Comment explaining why an existing contract was left alone. */
function existingContractComment(cfg: DocTypeConfig, contractId: string, status: string): string {
  return status === "signed"
    ? `This ${cfg.label} already has a signed eSignatures contract (${contractId}), so nothing was changed. ` +
        `To send a new version, clear ${P.contractUrl} and press ${BUTTON} again.`
    : `This ${cfg.label} already has an eSignatures contract (${contractId}) with status "${status}", so ` +
        `nothing was changed. If it has gone out to the signer, withdraw it in eSignatures first, then press ` +
        `${BUTTON} again to draft a new version.`;
}

/**
 * Post a comment on the page. Never throws: a failed comment must not turn a
 * clean skip into a red run. Called as the BODY of a ctx.step with a literal id.
 */
async function postPageComment(pageId: string, text: string): Promise<void> {
  try {
    const res = await sdk.fetch(`${NOTION_API}/comments`, {
      connection: NOTION_CONNECTION,
      method: "POST",
      headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify({ parent: { page_id: pageId }, rich_text: [{ text: { content: text } }] }),
    });
    if (!res.ok) console.log(`Failed to add page comment (${res.status}): ${await res.text()}`);
  } catch (err) {
    console.log(`Failed to add page comment: ${String((err as Error)?.message ?? err)}`);
  }
}

/** The page's mapping rows, oldest ULID first. Free (Zapier Tables). */
async function findMappingRows(pageId: string): Promise<any[]> {
  const found = await sdk.listTableRecords({
    table: ESIGN_TABLE,
    keyMode: "names",
    filters: [{ fieldKey: T_PAGE_ID, operator: "exact", value: pageId }],
    pageSize: 10,
  });
  const rows = (((found as any)?.data ?? []) as any[]).slice();
  rows.sort((a, b) => String(a?.id ?? "").localeCompare(String(b?.id ?? "")));
  return rows;
}

// --- Workflow --------------------------------------------------------------

export default defineDurable("agreement-send-for-signing", async (ctx, rawInput) => {
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
  const page = await ctx.step("fetch-agreement-page", async () => {
    const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
      connection: NOTION_CONNECTION,
      headers: { "Notion-Version": NOTION_VERSION },
    });
    if (!res.ok) {
      throw new Error(`Notion get page ${pageId} failed (${res.status}): ${await res.text()}`);
    }
    return res.json();
  });

  const snap = readRow(page);

  // A page from another data source means the button (or a replay) is wired to
  // the wrong database — a misconfiguration nobody would otherwise see.
  if (snap.dataSourceId !== PIPELINE_DS) {
    throw new Error(
      `Page ${pageId} is not an Agreement Pipeline row (parent data source ` +
        `${snap.dataSourceId || "none"}, expected ${PIPELINE_DS})`,
    );
  }

  // 2. Refuse what properties alone rule out, before any paid eSignatures call.
  //    A person has to fix these, so each is a skip with a page comment.
  const propRefused = propertyRefusal(snap);
  if (propRefused || !snap.cfg) {
    const refused = propRefused ?? { reason: "missing-document-type", comment: "" };
    await ctx.step("comment-not-drafted", async () => postPageComment(snap.pageId, refused.comment));
    console.log(`not drafted: ${refused.reason}`);
    return { skipped: refused.reason, pageId: snap.pageId, docType: snap.docType, missing: snap.missing };
  }
  const cfg = snap.cfg;

  // 3. A resend? The page's contract URL is what a person sees, so it wins;
  //    the mapping row's Contract ID covers a URL someone cleared by hand.
  const mapping = await ctx.step("table-find-mapping", async () => {
    const rows = await findMappingRows(snap.pageId);
    return { contractId: firstString(rows[0]?.data?.[T_CONTRACT_ID]) };
  });
  const existingId = contractIdFromUrl(snap.contractUrl) || mapping.contractId;

  let action: ExistingAction = "create-new";
  let existing: { status: string; contract: any } = { status: "none", contract: null };
  if (existingId) {
    existing = await ctx.step("check-existing-contract", async () =>
      readContractStatus(
        await sdk.runAction({
          appKey: ESIGN_APP_KEY,
          actionType: "search",
          actionKey: "query_contract",
          connection: ESIGN_CONNECTION,
          inputs: { contract_id: existingId },
        }),
      ),
    );
    action = existingContractAction(existing.status);
    console.log(`existing contract ${existingId} is ${existing.status} -> ${action}`);
  }

  if (action === "refuse") {
    const text = existingContractComment(cfg, existingId, existing.status);
    await ctx.step("comment-existing-contract", async () => postPageComment(snap.pageId, text));
    console.log(`not redrafting: existing contract ${existingId} is ${existing.status}`);
    return { skipped: "existing-contract", pageId: snap.pageId, contractId: existingId, contractStatus: existing.status };
  }

  // 4. The page body is the contract.
  const markdown = await ctx.step("fetch-agreement-markdown", async () => {
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
  const unfilled = unfilledPlaceholders(raw);
  const body = unwrapInlineCode(raw);
  const bodyRefused = bodyRefusal(body, unfilled);
  if (bodyRefused) {
    await ctx.step("comment-body-not-ready", async () => postPageComment(snap.pageId, bodyRefused.comment));
    console.log(`not drafted: ${bodyRefused.reason}`);
    return { skipped: bodyRefused.reason, pageId: snap.pageId, unfilled };
  }

  let contractId: string;
  let contractUrl: string;
  let signerUpdated = false;
  let titleStale = false;
  let wfSignerMissing = false;
  if (action === "update-draft") {
    // 5a. Update the existing draft in place. A draft's content is still the
    //     shell, so rewriting the body placeholder replaces the whole body.
    //     Replaying either write lands in the same state.
    contractId = existingId;
    contractUrl = contractIdFromUrl(snap.contractUrl) === contractId ? snap.contractUrl : draftUrlFor(contractId);
    await ctx.step("update-draft-body", async () =>
      assertEsignOk(
        await sdk.runAction({
          appKey: ESIGN_APP_KEY,
          actionType: "write",
          actionKey: "update_contract_placeholder_fields",
          connection: ESIGN_CONNECTION,
          inputs: {
            contract_id: contractId,
            placeholder_fields_markdown_map: { [BODY_PLACEHOLDER]: body },
          },
        }),
        "update_contract_placeholder_fields",
      ),
    );

    // Signer 1 may have changed (a new override email, a new consultant, a
    // corrected Counterparty). Only written when it differs, to save the task.
    const current = counterpartySigner(existing.contract);
    const signerId = firstString(current?.id);
    if (!signerId) throw new Error(`existing draft ${contractId} has no signer to update`);
    if (
      firstString(current?.name) !== snap.signer.name ||
      firstString(current?.email).toLowerCase() !== snap.signer.email.toLowerCase() ||
      firstString(current?.company_name) !== snap.signer.company
    ) {
      await ctx.step("update-draft-signer", async () =>
        assertEsignOk(
          await sdk.runAction({
            appKey: ESIGN_APP_KEY,
            actionType: "write",
            actionKey: "update_signer",
            connection: ESIGN_CONNECTION,
            inputs: {
              contract_id: contractId,
              signer_id: signerId,
              name: snap.signer.name,
              email: snap.signer.email,
              company_name: snap.signer.company,
            },
          }),
          "update_signer",
        ),
      );
      signerUpdated = true;
    }

    // Neither eSignatures app can add a signer or rename a contract, so these
    // are reported, not fixed.
    const signers: any[] = Array.isArray(existing.contract?.signers) ? existing.contract.signers : [];
    wfSignerMissing = !signers.some(
      (s) => s !== current && firstString(s?.email).toLowerCase() === WF_SIGNER.email,
    );
    if (wfSignerMissing) console.log(`draft ${contractId} has no workFlowers signer — add Dennis in eSignatures`);
    titleStale = firstString(existing.contract?.title) !== snap.title;
    if (titleStale) {
      console.log(`draft title left as "${firstString(existing.contract?.title)}" — eSignatures cannot rename`);
    }
  } else {
    // 5b. Create the draft. ONE attempt: create_contract is not idempotent, and
    //     a failure after eSignatures accepted the request would otherwise leave
    //     a duplicate draft per retry. Pressing the button again is the retry.
    const contract = await ctx.step({
      name: "create-esignatures-draft",
      maxAttempts: 1,
      run: async () =>
        sdk.runAction({
          appKey: ESIGN_APP_KEY,
          actionType: "write",
          actionKey: "create_contract",
          connection: ESIGN_CONNECTION,
          inputs: {
            template_id: cfg.templateId,
            title: snap.title,
            placeholder_fields_markdown_map: { [BODY_PLACEHOLDER]: body },
            metadata: snap.pageId,
            assigned_user_email: ASSIGNED_USER,
            zapier_signer_name_1: snap.signer.name,
            zapier_signer_email_1: snap.signer.email,
            zapier_signer_company_name_1: snap.signer.company,
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
    assertEsignOk(contract, "create_contract");
    contractId = extractContractId(contract);
    if (!contractId) {
      throw new Error(`eSignatures create_contract returned no contract id: ${JSON.stringify(contract).slice(0, 600)}`);
    }
    contractUrl = extractDraftUrl(contract, contractId);
  }

  // 6. Write the draft link and Status in one PATCH; replaying it lands in the
  //    same state. Raw REST rather than update_database_item because the
  //    action's schema cache lags newly created databases. The link contains the
  //    contract id, which esignatures-status-to-notion's fallback search uses.
  await ctx.step("update-agreement-row", async () => {
    const res = await sdk.fetch(`${NOTION_API}/pages/${snap.pageId}`, {
      connection: NOTION_CONNECTION,
      method: "PATCH",
      headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify({
        properties: {
          [P.contractUrl]: { url: contractUrl },
          [P.status]: { status: { name: DRAFTED_STATUS } },
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`Notion update page ${snap.pageId} failed (${res.status}): ${await res.text()}`);
    }
    return { ok: true };
  });

  // 7. Map the contract so esignatures-status-to-notion can find this row.
  //    After the Notion write on purpose: the row's link is what a second press
  //    reads first. Find-then-write in one step, so a retry re-reads instead of
  //    adding a second row; an existing row gets the new Contract ID (a
  //    replaced contract) and Agreement Type "Agreement".
  const tableRow = await ctx.step("table-write-mapping", async () => {
    const rows = await findMappingRows(snap.pageId);
    const data = {
      [T_PAGE_ID]: snap.pageId,
      [T_CONTRACT_ID]: contractId,
      // labeled_string cells take { value, label }.
      [T_AGREEMENT_TYPE]: { value: AGREEMENT_TYPE, label: AGREEMENT_TYPE },
    };
    const rowId = firstString(rows[0]?.id);
    if (rowId) {
      await sdk.updateTableRecords({ table: ESIGN_TABLE, keyMode: "names", records: [{ id: rowId, data }] });
      return { id: rowId, created: false };
    }
    const created = await sdk.createTableRecords({ table: ESIGN_TABLE, keyMode: "names", records: [{ data }] });
    const id = firstString(firstResult(created)?.id);
    if (!id) throw new Error("Zapier Table create returned no record id");
    return { id, created: true };
  });

  console.log(
    `${action === "update-draft" ? "updated" : "drafted"} ${contractId} (${snap.docType}) for ` +
      `${snap.signer.email}, ${body.length} chars of body`,
  );

  return {
    pageId: snap.pageId,
    docType: snap.docType,
    title: snap.title,
    signer: snap.signer.email,
    contractId,
    contractUrl,
    mode: action === "update-draft" ? "updated-draft" : "created",
    replacedContract: action === "create-new" && existingId ? existingId : null,
    signerUpdated,
    titleStale,
    wfSignerMissing,
    status: DRAFTED_STATUS,
    tableRowId: tableRow.id,
    tableRowCreated: tableRow.created,
    bodyChars: body.length,
  };
});
