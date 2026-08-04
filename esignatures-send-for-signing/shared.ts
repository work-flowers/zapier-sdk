// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/esignatures-send-for-signing
//
// Shared implementation behind TWO durables:
//   - `sow-send-for-signing`               (workflow.sow.ts)
//   - `project-addendum-send-for-signing`  (workflow.addendum.ts)
//
// Both replace a classic Zap of the same shape: a Notion "Send for signing"
// button posts a page, and we turn that page's body into an eSignatures draft
// contract. The two flows differ only in configuration — data source, which
// property holds the contract URL, which status value means "out for
// signature", where the signer comes from, and the eSignatures template — so
// they share one code path and one config table rather than two near-identical
// workflows that drift apart.
import { createZapierSdk } from "@zapier/zapier-sdk";
import { defineDurable } from "@zapier/zapier-durable";

export const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
export const NOTION_APP_KEY = "NotionCLIAPI";
export const NOTION_CONNECTION = "notion_wf";

// "eSignatures.com (Unofficial)" — the private app whose create_contract takes a
// single `markdown` body plus the name of the placeholder to inject it into.
// The public `EsignaturesioCLIAPI` app cannot do that (it has no markdown field,
// only a placeholder map), which is why the send flows use this one while
// esignatures-status-to-notion consumes the public app's triggers.
export const ESIGN_APP_KEY = "App236843CLIAPI";
export const ESIGN_CONNECTION = "esign_unofficial";

export const NOTION_API = "https://api.notion.com/v1";
export const NOTION_VERSION = "2026-03-11";

/**
 * "eSignatures Mapping" Zapier Table — the contract-id <-> Notion-page-id map.
 * Written here (Page ID + Agreement Type on create, Contract ID once the draft
 * exists) and read by `esignatures-status-to-notion`, which has only a contract
 * id to work from when eSignatures fires.
 *
 * Fields, by name: "Page ID" (f1), "Contract ID" (f2), "Agreement Type" (f3,
 * labeled_string). Tables auth is automatic — no connection needed.
 */
export const ESIGN_TABLE = "01KHZEP4FA560E9GMTGTBR1E2N";
export const T_PAGE_ID = "Page ID";
export const T_CONTRACT_ID = "Contract ID";
export const T_AGREEMENT_TYPE = "Agreement Type";

// --- Per-kind configuration ------------------------------------------------
export type Kind = "sow" | "addendum";

interface KindConfig {
  /** Deployment name, also the durable's registered name. */
  name: string;
  /** Notion data source the trigger page belongs to. */
  datasource: string;
  /** URL property that receives the eSignatures draft link. Names differ. */
  urlProp: string;
  /** Status option meaning "out for signature". Differs between the two. */
  sentStatus: string;
  /** Value written to the Table's Agreement Type cell. */
  agreementType: string;
  /** eSignatures template — a bare shell holding one {{contract-body}}. */
  templateId: string;
  /** Placeholder in that template the markdown body is injected into. */
  placeholderField: string;
  /** Comment posted on the page when required data is missing. */
  missingDataComment: string;
}

const CONFIG: Record<Kind, KindConfig> = {
  sow: {
    name: "sow-send-for-signing",
    datasource: "07e4d8c1-24f2-44a8-ae9b-24628ee4a21b", // "SOWs"
    urlProp: "eSignature contract", // singular, lowercase c
    sentStatus: "Sent for signature", // lowercase s
    agreementType: "SOW",
    templateId: "6eaa0583-2cde-42d2-bf3e-2fe9b0808f3e", // "Scope of Work"
    placeholderField: "contract-body",
    missingDataComment:
      "The related Contact must have a Primary email set (this is the email address that the " +
      "contract will be sent to). Please enter one and re-submit. \n\nAlternatively, if you want " +
      "the contract sent to a different email address from the Primary email on the related " +
      "contact, enter the value in the Override Email property on this page and re-submit.",
  },
  addendum: {
    name: "project-addendum-send-for-signing",
    datasource: "46234707-641a-4aa4-96f6-295554e6543f", // "Project Addendums"
    urlProp: "eSignatures Contract", // plural, capital C
    sentStatus: "Sent for signing",
    agreementType: "Project Addendum",
    // The classic Zap used the "Scope of Work" template here too — a bug: it
    // generated addenda from the SOW shell. Fixed to the addendum's own
    // template, which uses the same {{contract-body}} placeholder.
    templateId: "443d6bed-607d-458e-a0de-27dd627bf96f", // "Consultant Project Addendum"
    placeholderField: "contract-body",
    missingDataComment: "Missing data! Please read the instructions and re-submit.",
  },
};

/** "Deals" data source — the SOW flow advances the linked deal's status. */
const DEALS_DS = "21a91b07-11ac-808d-9657-000b1390d20b";
const DEAL_IN_SIGNING = "In signing";

// --- Pure helpers ----------------------------------------------------------

/**
 * The trigger pipeline can deliver input double-encoded (a JSON string of a JSON
 * string), while run-durable delivers it single-encoded. Parse until we reach a
 * non-string, or stop on a bare page id / parse failure.
 */
export function normalizeInput(rawInput: unknown): unknown {
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

export function firstString(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

/** First item of a runAction result ({ data: [...] } or a bare array). */
export function firstResult(res: any): any {
  if (!res) return null;
  if (Array.isArray(res)) return res[0] ?? null;
  if (Array.isArray(res.data)) return res.data[0] ?? null;
  return res.data ?? res;
}

/**
 * Contract id out of a create_contract result.
 *
 * The shape is doubly nested and easy to get wrong:
 * `{ data: [ { status: "queued", data: { contract: { id } } } ] }` — runAction
 * supplies the outer `data` array, and the app's own envelope adds a second
 * `data` inside each row. (The classic Zap's `gives[...]["data"]["contract"]["id"]`
 * was addressing that INNER `data`, not runAction's.) Both nestings are checked,
 * plus a flat fallback, so an envelope change degrades to a clear error rather
 * than a wrong id.
 */
export function extractContractId(res: any): string {
  const row = firstResult(res);
  return firstString(
    row?.data?.contract?.id,
    row?.contract?.id,
    row?.data?.id,
    row?.id,
  );
}

export function dashUuid(id: string): string {
  const hex = (id || "").replace(/-/g, "").toLowerCase();
  if (hex.length !== 32) return (id || "").trim();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function plainText(rich: unknown): string {
  if (!Array.isArray(rich)) return "";
  return rich
    .map((r: any) => firstString(r?.plain_text) || firstString(r?.text?.content))
    .join("")
    .trim();
}

/**
 * True when the payload carries no event at all — an empty POST or a bare GET
 * of the catch URL.
 *
 * A catch hook is a public URL: pasting it into a Notion button, hitting "test"
 * while wiring the Notion side up, or opening it in a browser all deliver a body
 * like `{"querystring":{}}`. Those are pings, not events; failing the run on them
 * means a Zapier error alert every time someone touches the URL.
 *
 * A payload that DOES carry content but no page id is a different thing — a real
 * event whose shape we failed to understand. That still throws, loudly.
 */
export function isEmptyPing(raw: unknown): boolean {
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
 * Pull the Notion page id out of whatever the trigger delivered. A button
 * property posts `{ data: { id, properties, ... } }`; run-durable and
 * trigger-workflow accept a bare id or `{ pageId }` so a run can be replayed.
 */
export function extractPageId(raw: unknown): string {
  if (!raw) throw new Error("No input provided to workflow.");
  if (typeof raw === "string") return dashUuid(raw.trim());
  const o = raw as Record<string, any>;
  const candidate =
    o.pageId ||
    o.page_id ||
    (o.data && (o.data.id || o.data.page_id)) ||
    o.id ||
    (o.page && o.page.id) ||
    o["data.id"] ||
    o["data__id"];
  const id = firstString(candidate);
  if (!id) {
    throw new Error(
      `Could not find a Notion page id in the payload: ${JSON.stringify(raw).slice(0, 400)}`,
    );
  }
  return dashUuid(id);
}

/** First entry of a rollup's array, or null. Rollups arrive as {rollup:{array:[…]}}. */
function rollupFirst(prop: unknown): any {
  const arr = (prop as any)?.rollup?.array;
  return Array.isArray(arr) ? (arr[0] ?? null) : null;
}

/** A rollup of a title property -> its text. */
function rollupTitle(prop: unknown): string {
  return plainText(rollupFirst(prop)?.title);
}

/** A rollup of an email property -> the address. */
function rollupEmail(prop: unknown): string {
  return firstString(rollupFirst(prop)?.email);
}

function relationIds(prop: unknown): string[] {
  const rel = (prop as any)?.relation;
  if (!Array.isArray(rel)) return [];
  return rel.map((r: any) => firstString(r?.id)).filter(Boolean).map(dashUuid);
}

/**
 * Notion's native markdown export (GET /v1/pages/{id}/markdown) is structurally
 * faithful — unlike the Zapier "block_children" converter the classic Zap's
 * hidden action extension used — but it emits Notion-specific pseudo-tags that
 * are not valid markdown. Convert just those, so what lands in the contract is
 * what the page shows.
 *
 * Adapted from `notion-newsletter-to-buttondown`'s notionMarkdownToEmail, minus
 * its image-caption mirroring and re-hosting concerns, which are email-specific
 * and meaningless in a signed PDF.
 */
export function notionMarkdownToContract(md: string): string {
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
}

interface PageSnapshot {
  pageId: string;
  title: string;
  signer: Signer;
  /** Relation ids that must be non-empty for the addendum flow. */
  clientSowIds: string[];
  /** Deal relation — SOW flow only. */
  dealIds: string[];
}

function readPage(kind: Kind, page: any): PageSnapshot {
  const props = page?.properties ?? {};
  const pageId = dashUuid(firstString(page?.id));

  if (kind === "sow") {
    // The signatory's address rolls up through "Counterparty signatory". The
    // override wins when set, which is the whole point of it — an SOW can be
    // sent to a different address than the contact's Primary email.
    const override = firstString(props["Override Email (Optional)"]?.email);
    const rolled = rollupEmail(props["Signatory Primary Email"]);
    return {
      pageId,
      title: plainText(props["Agreement Name"]?.title),
      signer: {
        name: rollupTitle(props["Signatory Name"]),
        email: override || rolled,
      },
      clientSowIds: [],
      dealIds: relationIds(props["Deal"]),
    };
  }

  // Addendum: the signer is the Consultant (a Notion person, limit 1), whose
  // email comes from their Notion account rather than a property.
  const person = (props["Consultant"]?.people ?? [])[0] ?? null;
  return {
    pageId,
    title: `[Project Addendum] ${rollupTitle(props["SOW Name"])}`.trim(),
    signer: {
      name: firstString(person?.name),
      email: firstString(person?.person?.email),
    },
    clientSowIds: relationIds(props["Client SOW"]),
    dealIds: [],
  };
}

/** Why the page isn't ready to send, or null when it is. */
function validate(kind: Kind, snap: PageSnapshot): string | null {
  if (kind === "sow") {
    if (!snap.signer.email) return "no signatory email (neither the rollup nor the override is set)";
    return null;
  }
  if (!snap.signer.email) return "Consultant is empty, or that person has no email on their Notion account";
  if (!snap.clientSowIds.length) return "Client SOW relation is empty";
  return null;
}

// --- Table access ----------------------------------------------------------

/**
 * Find the row for this page, or create it. Read and write happen in ONE step so
 * a retry re-reads rather than committing a create over state a previous attempt
 * already wrote. Oldest ULID wins if two rows somehow exist, matching
 * drive-invoice-to-xero's race handling.
 */
async function findOrCreateRow(
  ctx: any,
  pageId: string,
  agreementType: string,
): Promise<{ id: string; created: boolean }> {
  const row = await ctx.step("table-find-or-create", async () => {
    const found = await sdk.listTableRecords({
      table: ESIGN_TABLE,
      keyMode: "names",
      filters: [{ fieldKey: T_PAGE_ID, operator: "exact", value: pageId }],
      pageSize: 10,
    });
    const rows = ((found as any)?.data ?? []) as any[];
    rows.sort((a, b) => String(a?.id ?? "").localeCompare(String(b?.id ?? "")));
    if (rows[0]?.id) return { id: String(rows[0].id), created: false };

    const createdRes = await sdk.createTableRecords({
      table: ESIGN_TABLE,
      keyMode: "names",
      records: [
        {
          data: {
            [T_PAGE_ID]: pageId,
            // labeled_string cells take { value, label }.
            [T_AGREEMENT_TYPE]: { value: agreementType, label: agreementType },
          },
        },
      ],
    });
    const newId = firstString(firstResult(createdRes)?.id);
    if (!newId) throw new Error("Zapier Table create returned no record id");
    return { id: newId, created: true };
  });
  return row;
}

// --- Workflow factory ------------------------------------------------------

export function defineSendForSigning(kind: Kind) {
  const cfg = CONFIG[kind];

  return defineDurable<Record<string, unknown>, unknown>(cfg.name, async (ctx, rawInput) => {
    const payload = normalizeInput(rawInput);

    // Guard BEFORE any id extraction — see isEmptyPing.
    if (isEmptyPing(payload)) {
      console.log("empty payload — treating as a ping of the catch URL, not an event");
      return { skipped: "empty-payload" };
    }

    const pageId = extractPageId(payload);

    // 1. Read the page fresh. Fetched rather than taken from the payload
    //    because the signer lives behind ROLLUPS ("Signatory Primary Email",
    //    "SOW Name"), which the Notion actions' cached schema and SQL-mode
    //    queries both omit — they are listed as not-available-in-query.
    const page = await ctx.step("fetch-page", async () => {
      const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
        connection: NOTION_CONNECTION,
        headers: { "Notion-Version": NOTION_VERSION },
      });
      if (!res.ok) {
        throw new Error(`Notion get page ${pageId} failed (${res.status}): ${await res.text()}`);
      }
      return res.json();
    });

    const snap = readPage(kind, page);

    // 2. Validate. A person has to fix the data, so this is a skip with a
    //    comment on the page — not an error alert nobody can action.
    const problem = validate(kind, snap);
    if (problem) {
      await ctx.step("comment-missing-data", async () => {
        try {
          const res = await sdk.fetch(`${NOTION_API}/comments`, {
            connection: NOTION_CONNECTION,
            method: "POST",
            headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
            body: JSON.stringify({
              parent: { page_id: snap.pageId },
              rich_text: [{ text: { content: cfg.missingDataComment } }],
            }),
          });
          if (!res.ok) {
            console.log(`Failed to add missing-data comment (${res.status}): ${await res.text()}`);
          }
        } catch (err) {
          console.log(`Failed to add missing-data comment: ${String((err as Error)?.message ?? err)}`);
        }
      });
      console.log(`not ready to send: ${problem}`);
      return { skipped: "missing-required-properties", reason: problem, pageId: snap.pageId };
    }

    // 3. Claim the Table row before creating the contract, so the contract id
    //    always has somewhere to go.
    const row = await findOrCreateRow(ctx, snap.pageId, cfg.agreementType);

    // 4. The page body becomes the contract body.
    const markdown = await ctx.step("fetch-page-markdown", async () => {
      const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}/markdown`, {
        connection: NOTION_CONNECTION,
        headers: { "Notion-Version": NOTION_VERSION },
      });
      if (!res.ok) {
        throw new Error(`Notion markdown export failed (${res.status}): ${await res.text()}`);
      }
      const data: any = await res.json();
      return String(data?.markdown ?? "");
    });

    const body = notionMarkdownToContract(markdown);
    if (!body) {
      // An empty body would produce a contract with no terms in it. That is a
      // real problem with a real event, so it raises.
      throw new Error(`Notion page ${snap.pageId} exported an empty body — nothing to put in the contract`);
    }

    // 5. Create the draft contract. save_as_draft keeps it out of the signer's
    //    inbox until a human sends it; test:false is explicit because the
    //    action's own default is "true" and would create throwaway contracts.
    const contract = await ctx.step("create-esignatures-draft", async () =>
      sdk.runAction({
        appKey: ESIGN_APP_KEY,
        actionType: "write",
        actionKey: "create_contract",
        connection: ESIGN_CONNECTION,
        inputs: {
          template_id: cfg.templateId,
          title: snap.title,
          signers__name: [snap.signer.name],
          signers__email: [snap.signer.email],
          signers__signing_order: [1],
          markdown: body,
          placeholder_field_name: cfg.placeholderField,
          save_as_draft: true,
          test: false,
        },
      }),
    );

    const contractId = extractContractId(contract);
    if (!contractId) {
      throw new Error(
        `eSignatures create_contract returned no contract id: ${JSON.stringify(contract).slice(0, 400)}`,
      );
    }
    const contractUrl = `https://esignatures.com/draft_contracts/${contractId}/edit`;

    // 6. Write the draft link and status back in one call. `Status` is a
    //    status-type property; update_database_item handles it (verified against
    //    both data sources) so no raw PATCH is needed.
    await ctx.step("update-notion-record", async () =>
      sdk.runAction({
        appKey: NOTION_APP_KEY,
        actionType: "write",
        actionKey: "update_database_item",
        connection: NOTION_CONNECTION,
        inputs: {
          datasource: cfg.datasource,
          page: snap.pageId,
          [`properties|||${cfg.urlProp}|||url`]: contractUrl,
          "properties|||Status|||status": cfg.sentStatus,
        },
      }),
    );

    // 7. Record the contract id, so esignatures-status-to-notion can find this
    //    page when eSignatures fires.
    await ctx.step("table-write-contract-id", async () =>
      sdk.updateTableRecords({
        table: ESIGN_TABLE,
        keyMode: "names",
        records: [{ id: row.id, data: { [T_CONTRACT_ID]: contractId } }],
      }),
    );

    // 8. SOW only: advance the linked deal. Skipped cleanly when there is no
    //    deal, which is normal — not every SOW hangs off one.
    let dealUpdated = false;
    if (kind === "sow" && snap.dealIds.length) {
      await ctx.step("update-deal-status", async () =>
        sdk.runAction({
          appKey: NOTION_APP_KEY,
          actionType: "write",
          actionKey: "update_database_item",
          connection: NOTION_CONNECTION,
          inputs: {
            datasource: DEALS_DS,
            page: snap.dealIds[0],
            "properties|||Status|||status": DEAL_IN_SIGNING,
          },
        }),
      );
      dealUpdated = true;
    }

    console.log(
      `${cfg.name}: drafted ${contractId} for ${snap.signer.email} (${body.length} chars of body)`,
    );

    return {
      pageId: snap.pageId,
      title: snap.title,
      signer: snap.signer.email,
      contractId,
      contractUrl,
      status: cfg.sentStatus,
      tableRowId: row.id,
      tableRowCreated: row.created,
      dealUpdated,
      bodyChars: body.length,
    };
  });
}
