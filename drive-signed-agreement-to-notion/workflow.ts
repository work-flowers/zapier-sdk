// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/drive-signed-agreement-to-notion
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
// Google Drive is needed in BOTH places: on the TRIGGER (publish --trigger
// authentication_id, which polls the folder) and as the `gdrive` alias here,
// because the code renames the file — same shape as drive-invoice-to-xero.
const DRIVE_APP_KEY = "GoogleDriveCLIAPI";
const DRIVE_CONNECTION = "gdrive";

const NOTION_APP_KEY = "NotionCLIAPI";
const NOTION_CONNECTION = "notion_wf";

const AI_APP_KEY = "AICLIAPI";

// AI by Zapier on Zapier's built-in credentials ("0" = Included in Plan).
// TIER = TASK COST: standard/auto | advanced/auto | premium/auto bill at
// 1x / 3x / 5x tasks per run. Standard was verified against 7 real signed
// agreements (see README) once the output schema was cut to the 2 fields this
// Zap actually needs — no tool calls are made, which is the main reason
// Zapier's own default is Advanced.
const AI_MODEL = "standard/auto";
const AI_AUTHENTICATION = "0";

/** "Signed Legal Agreements" data source. */
const AGREEMENTS_DS = "eb0a6e70-5cf7-4817-8140-d0e44d3ec396";

// The Google Drive "New File in Folder" trigger delivers a file object.
// Accept anything and extract defensively.
const InputSchema = z.unknown();

// --- Pure helpers ----------------------------------------------------------

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

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

/** First item of a runAction result ({ data: [...] } or a bare array). */
function firstResult(res: any): any {
  if (!res) return null;
  if (Array.isArray(res)) return res[0] ?? null;
  if (Array.isArray(res.data)) return res.data[0] ?? null;
  return res.data ?? res;
}

// --- Dates, without touching `Date` ----------------------------------------
//
// The durable runtime runs the workflow body in GUARDED mode and throws
// `DeterminismViolation` from the `Date` constructor's Proxy, which asserts
// before it inspects its arguments — so even a deterministic
// `new Date(Date.UTC(y, m, d))` is rejected exactly as hard as a clock read.
// Calendar arithmetic is therefore done in integers with no `Date` reference
// anywhere in this file; the one genuine clock read lives inside a `today`
// step. Same Hinnant civil-from-days pair already used in
// drive-invoice-to-xero and xero-overdue-invoice-to-gmail-reminder.

function daysInMonth(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isoDateFromEpochMs(ms: number): string {
  let z = Math.floor(ms / 86400000) + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` from an ISO-ish date string, or null on anything unparseable
 *  or calendar-impossible (Date.UTC silently normalises overflow rather than
 *  failing, so the check is done by hand). */
function toIsoDate(v: unknown): string | null {
  const s = firstString(v);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const [, y, mo, d] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(Number(y), month)) return null;
  return `${y}-${mo}-${d}`;
}

/** Extract the trigger's file fields. `alternateLink` is the Drive UI URL the
 *  classic Zap wrote into the Notion `File Link` property — confirmed present
 *  on this trigger's live payload (a Drive API v2 field Zapier still surfaces
 *  under its legacy name), with `webViewLink` accepted as a fallback. */
function extractFile(payload: unknown): {
  id: string;
  title: string;
  mimeType: string;
  fileRef: string;
  driveLink: string | null;
  trashed: boolean;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, any>;
  const id = firstString(p.id, p.fileId);
  const fileRef = firstString(p.file);
  if (!id || !fileRef) return null;
  return {
    id,
    title: firstString(p.title, p.name, p.originalFilename) ?? "(untitled)",
    mimeType: (firstString(p.mimeType) ?? "").toLowerCase(),
    fileRef,
    driveLink: firstString(p.alternateLink, p.webViewLink),
    trashed: Boolean(p.labels?.trashed || p.explicitlyTrashed),
  };
}

/** Google Drive rejects `/` in a name; keep it tidy otherwise. */
function sanitizeNamePart(s: string): string {
  return s.replace(/[/\\]/g, "-").replace(/\s+/g, " ").trim();
}

/** `<signed date> <counterparty>`, skipping an empty counterparty (an
 *  internal-only document) rather than leaving a trailing space. One naming
 *  basis shared by the Drive rename and the Notion page title — the classic
 *  Zap used Contract Signed Date for the rename but Effective Date for the
 *  Notion title, an inconsistency not worth carrying forward. */
function buildAgreementName(args: { date: string; counterparty: string | null }): string {
  const parts = [args.date, args.counterparty ? sanitizeNamePart(args.counterparty) : null].filter(
    (p): p is string => Boolean(p && p.trim() !== ""),
  );
  return parts.join(" ").trim();
}

// --- Prompt ------------------------------------------------------------------
// Verbatim copy of legal-agreement-classification-prompt.md (repo rule 6).
// Edit the markdown, then run `node scripts/check-prompts.mjs --fix`.
const LEGAL_AGREEMENT_PROMPT = `You are a legal operations assistant for Company Flow Pte. Ltd. (dba workFlowers). Read the attached signed agreement in full and extract exactly two things needed to file it: who the other party is, and when it was signed.

## Counterparty

The counterparty is every party to this agreement OTHER than Company Flow Pte. Ltd. itself — also referred to in documents as workFlowers, Work Flowers, or by its director/shareholder Dennis Chiuten / Dennis Carl Chiuten signing on the company's behalf. NEVER return "Company Flow Pte. Ltd.", "workFlowers", "Work Flowers", "Dennis Chiuten", "Dennis Carl Chiuten", or "dennis@work.flowers" as the counterparty — these are us, not the other side, no matter how prominently they appear in the signature block or letterhead.

Some documents are entirely INTERNAL to Company Flow Pte. Ltd. and name no external counterparty at all: a salary revision letter, a board or shareholder resolution, a share allotment/subscription/certificate, a GIRO or direct-debit mandate, an insurance policy schedule taken out in the company's own name. For these, return an EMPTY STRING — do not invent a counterparty, and do not write "Not specified", "N/A" or similar placeholder text.

When there is a genuine external counterparty, give its full legal name exactly as the document states it (e.g. "Notion Labs, Inc.", "Lantern Labs Pte. Ltd."), without titles, explanatory asides, or parenthetical role descriptions such as "(the Subcontractor)". If more than one external party is named — a subcontractor and an end client, or two customers on one order form — list each full legal name separated by "; " and nothing else.

## Contract Signed Date

The date the LAST party actually signed the document — not an effective date, not a deadline mentioned in the body — in YYYY-MM-DD format. If the document is unsigned or carries no date at all, return an empty string.`;

/**
 * Structured output for the extraction call. Descriptions are kept in step
 * with the wording in legal-agreement-classification-prompt.md. Just the two
 * fields the rename/title actually needs — no Agreement Type. (An earlier
 * version of this workflow also classified Agreement Type into a
 * consolidated 9-category taxonomy, but it was never written to Notion
 * anyway — see the README — and Dennis asked to drop it entirely rather than
 * carry an unused classification step.)
 */
const OUTPUT_FIELDS = [
  {
    name: "Counterparty",
    description:
      "Full legal name(s) of every party other than Company Flow Pte. Ltd. (workFlowers). Empty string for an internal-only document with no external party.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Contract Signed Date",
    description: "Date the last party signed, ISO-8601 YYYY-MM-DD. Empty string if unsigned or undated.",
    type: "date",
    isRequired: true,
  },
];

/**
 * Create a Notion data source item, applying the data source's DEFAULT
 * TEMPLATE when one exists (repo rule 5), so an automation-created page looks
 * like a hand-made one. Copied from luma-guest-registered-to-event-attendance
 * — see that file for the two constraints this works around (a
 * `template_mode: "default"` throws when no default template is configured,
 * caught inside the step; a template and inline `content` are mutually
 * exclusive, so body content — unused by this Zap — would need a second call).
 */
async function createItemWithTemplate(
  ctx: any,
  stepPrefix: string,
  datasource: string,
  props: Record<string, unknown>,
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
  return { pageId, usedTemplate: Boolean(created?.usedTemplate) };
}

// --- Workflow ----------------------------------------------------------------
// Simplified, intentionally: renames the file and files it into Notion with
// the Drive link and the file itself attached. A separate Notion agent
// (triggered on new pages in this data source) extracts everything else —
// dates, currency, amount, signatories, the AI summary. See the README for
// why the scope was cut down from the classic Zap's single do-everything AI
// call to just the 2 fields needed to name and title the record.
const workflow = defineDurable<Record<string, unknown>, unknown>(
  "drive-signed-agreement-to-notion",
  async (ctx, rawInput) => {
    const file = extractFile(InputSchema.parse(normalizeInput(rawInput)));
    if (!file) {
      console.log("skipping: no file in payload (empty/test delivery)");
      return { skipped: true, reason: "no file in payload" };
    }
    if (file.trashed) {
      console.log(`skipping ${file.title}: file is in the trash`);
      return { skipped: true, reason: "file is in the trash", file: file.title };
    }
    if (!file.mimeType.includes("application/pdf")) {
      console.log(`skipping ${file.title}: not a PDF (${file.mimeType || "unknown"})`);
      return { skipped: true, reason: `not a PDF (${file.mimeType || "unknown"})`, file: file.title };
    }

    // 1. Extract: counterparty, signed date. Nothing else —
    //    see the module comment above.
    const completion = await ctx.step("extract-agreement-fields", async () =>
      sdk.runAction({
        appKey: AI_APP_KEY,
        actionType: "write",
        actionKey: "get_completion",
        inputs: {
          authentication_id: AI_AUTHENTICATION,
          model_id: AI_MODEL,
          isOutputArray: false,
          instructions: LEGAL_AGREEMENT_PROMPT,
          inputFields: { Document: file.fileRef },
          inputFieldConfig_Document_isFileUrl: true,
          outputFields: OUTPUT_FIELDS,
        },
      }),
    );

    const raw = firstResult(completion)?.result ?? firstResult(completion) ?? {};
    const counterparty = firstString(raw["Counterparty"]);

    // Reading the clock IS non-deterministic, so today's date comes from a
    // step, fixing it for every retry of this run.
    const today = await ctx.step("today", async () => isoDateFromEpochMs(Date.now()));
    const extractedSignedDate = toIsoDate(raw["Contract Signed Date"]);
    const signedDate = extractedSignedDate ?? today;
    if (!extractedSignedDate) {
      console.log(`no usable signed date extracted from ${file.title}; falling back to today (${signedDate})`);
    }

    const agreementName = buildAgreementName({ date: signedDate, counterparty });

    // 2. Rename the Drive file to the same basis as the Notion title.
    await ctx.step("rename-drive-file", async () =>
      sdk.runAction({
        appKey: DRIVE_APP_KEY,
        actionType: "write",
        actionKey: "update_file_name",
        connection: DRIVE_CONNECTION,
        inputs: { file: file.id, new_name: agreementName, rename_folder: "false" },
      }),
    );

    // 3. Create the Notion page — title, Drive link, and the file itself.
    //    Everything else is left for the separate Notion extraction agent.
    const createInputs: Record<string, unknown> = {
      "properties|||Agreement Name|||title": agreementName,
    };
    if (file.driveLink) createInputs["properties|||File Link|||url"] = file.driveLink;

    const createdPage = await createItemWithTemplate(ctx, "agreement", AGREEMENTS_DS, createInputs);
    if (!createdPage.pageId) {
      throw new Error("Notion page creation returned no page id");
    }

    await ctx.step("attach-file-to-page", async () =>
      sdk.runAction({
        appKey: NOTION_APP_KEY,
        actionType: "write",
        actionKey: "upload_file_to_page_block",
        connection: NOTION_CONNECTION,
        inputs: { page_id: createdPage.pageId, file: file.fileRef },
      }),
    );

    return {
      file: file.title,
      agreementName,
      counterparty,
      signedDate,
      signedDateExtracted: extractedSignedDate !== null,
      notionPageId: createdPage.pageId,
      usedTemplate: createdPage.usedTemplate,
    };
  },
);

export default workflow;
