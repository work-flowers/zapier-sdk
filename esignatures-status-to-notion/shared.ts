// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/esignatures-status-to-notion
//
// Shared implementation behind TWO durables:
//   - `esignatures-contract-sent-to-notion`   (workflow.sent.ts)
//   - `esignatures-contract-signed-to-notion` (workflow.signed.ts)
//
// Both replace a classic Zap of the same shape: eSignatures fires, we look the
// contract id up in the mapping Table to find which Notion record it belongs to,
// and move that record's status on. The two differ only in which trigger they
// listen to and which status they set — plus the signed one also files the
// executed PDF, which the classic Zap never actually did (it passed an empty
// array to the files property, a silent no-op).
import { createZapierSdk } from "@zapier/zapier-sdk";
import { defineDurable } from "@zapier/zapier-durable";

export const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
export const NOTION_APP_KEY = "NotionCLIAPI";
export const NOTION_CONNECTION = "notion_wf";

export const NOTION_API = "https://api.notion.com/v1";
export const NOTION_VERSION = "2026-03-11";

/**
 * "eSignatures Mapping" Zapier Table — written by `esignatures-send-for-signing`,
 * read-only here. Fields by name: "Page ID", "Contract ID", "Agreement Type"
 * (labeled_string: "SOW" | "Project Addendum"). Tables auth is automatic.
 */
export const ESIGN_TABLE = "01KHZEP4FA560E9GMTGTBR1E2N";
export const T_PAGE_ID = "Page ID";
export const T_CONTRACT_ID = "Contract ID";
export const T_AGREEMENT_TYPE = "Agreement Type";

// --- Per-agreement-type configuration --------------------------------------
type AgreementType = "SOW" | "Project Addendum";

interface TypeConfig {
  datasource: string;
  /** Status when the contract goes out for signature. Names differ. */
  sentStatus: string;
  /** Status when every signer has signed. */
  signedStatus: string;
  /** Files property that receives the executed PDF. Differs between the two. */
  fileProp: string;
}

const TYPES: Record<AgreementType, TypeConfig> = {
  SOW: {
    datasource: "07e4d8c1-24f2-44a8-ae9b-24628ee4a21b", // "SOWs"
    sentStatus: "Sent for signature", // lowercase s
    signedStatus: "Signed",
    fileProp: "Signed PDF",
  },
  "Project Addendum": {
    datasource: "46234707-641a-4aa4-96f6-295554e6543f", // "Project Addendums"
    sentStatus: "Sent for signing",
    signedStatus: "Executed",
    fileProp: "Executed Agreement",
  },
};

export type Phase = "sent" | "signed";

const PHASE_NAMES: Record<Phase, string> = {
  sent: "esignatures-contract-sent-to-notion",
  signed: "esignatures-contract-signed-to-notion",
};

// --- Pure helpers ----------------------------------------------------------

export function normalizeInput(rawInput: unknown): unknown {
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

export function firstString(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

export function firstResult(res: any): any {
  if (!res) return null;
  if (Array.isArray(res)) return res[0] ?? null;
  if (Array.isArray(res.data)) return res.data[0] ?? null;
  return res.data ?? res;
}

export function dashUuid(id: string): string {
  const hex = (id || "").replace(/-/g, "").toLowerCase();
  if (hex.length !== 32) return (id || "").trim();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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

/**
 * The contract id, wherever this trigger put it.
 *
 * The two triggers disagree: `contract_sent_to_signer` nests the contract
 * (`.contract.id`), while `contract_signed` delivers it flat (`.id`). Reading
 * both paths rather than branching on phase means neither deployment can be
 * broken by that asymmetry, and a hand-built replay payload works either way.
 */
export function extractContractId(raw: unknown): string {
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  const o = (raw ?? {}) as Record<string, any>;
  const id = firstString(
    o.contract?.id,
    o.data?.contract?.id,
    o.contract_id,
    o.id,
    o.data?.id,
  );
  if (!id) {
    throw new Error(
      `Could not find an eSignatures contract id in the payload: ${JSON.stringify(raw).slice(0, 400)}`,
    );
  }
  return id;
}

/**
 * URL of the executed PDF in an eSignatures payload.
 *
 * eSignatures hands over a **presigned S3 link that expires in 72 hours**
 * (`X-Amz-Expires=259200`), and the app exposes no Get-Contract action, so the
 * webhook is the only chance to fetch it — see attachSignedPdf.
 *
 * The exact field is read from an ordered candidate list, then falls back to
 * scanning the payload for any https URL whose path ends in .pdf. The fallback
 * exists because no CLI command exposes a trigger's output shape, so the field
 * name could not be pinned from a schema; it is deliberately a scan rather than a
 * guess, and returns "" rather than something wrong.
 */
export function extractSignedPdfUrl(raw: unknown): string {
  const o = (raw ?? {}) as Record<string, any>;
  const named = firstString(
    o.contract_pdf_url,
    o.signed_contract_pdf_url,
    o.final_contract_pdf_url,
    o.pdf_url,
    o.contract?.contract_pdf_url,
    o.contract?.pdf_url,
    o.data?.contract?.contract_pdf_url,
  );
  if (named) return named;

  // Fallback: first https URL in the payload that points at a .pdf.
  const seen = new Set<unknown>();
  const isPdf = (s: string) => {
    if (!/^https:\/\//i.test(s)) return false;
    const path = s.split("?")[0] ?? "";
    return /\.pdf$/i.test(path);
  };
  const walk = (v: unknown, depth: number): string => {
    if (depth > 6 || v === null || v === undefined) return "";
    if (typeof v === "string") return isPdf(v) ? v : "";
    if (typeof v !== "object" || seen.has(v)) return "";
    seen.add(v);
    for (const child of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) {
      const hit = walk(child, depth + 1);
      if (hit) return hit;
    }
    return "";
  };
  return walk(o, 0);
}

/**
 * A tidy filename for the executed PDF, taken from the URL when it carries one.
 *
 * Notion caps a files-entry name at **100 characters** and rejects the whole
 * PATCH otherwise (`files[0].name.length should be ≤ 100`). eSignatures names its
 * PDFs after the full agreement title plus both signers, which runs well past
 * that, so the stem is truncated while ".pdf" is preserved — a name ending in
 * ".pd" would be both ugly and misleading about the file type.
 */
export const NOTION_FILENAME_MAX = 100;

export function pdfFilename(url: string, title: string): string {
  const fromUrl = decodeURIComponent((url.split("?")[0] ?? "").split("/").pop() ?? "");
  const base = fromUrl && /\.pdf$/i.test(fromUrl) ? fromUrl : `${title || "signed-agreement"}.pdf`;
  const safe = base.replace(/[\\/:*?"<>|]+/g, "-").trim();
  if (safe.length <= NOTION_FILENAME_MAX) return safe;
  const ext = ".pdf";
  return safe.slice(0, NOTION_FILENAME_MAX - ext.length).trimEnd() + ext;
}

function readAgreementType(row: any): AgreementType | null {
  const cell = (row?.data ?? {})[T_AGREEMENT_TYPE];
  // labeled_string cells arrive as { value, label }; tolerate a bare string too.
  const raw = firstString(typeof cell === "string" ? cell : cell?.value, cell?.label);
  if (raw === "SOW" || raw === "Project Addendum") return raw;
  return null;
}

// --- Signed-PDF attachment -------------------------------------------------

/**
 * File the executed PDF into the record's files property.
 *
 * Notion's `files` property will NOT re-host an external URL — handing it the
 * eSignatures link stores `{type:"external"}`, which looks populated and then
 * dies with the presigned URL 72 hours later. And Notion's `external_url` upload
 * mode probes the URL with HEAD, which an S3 GET-scoped presigned URL answers
 * with 403. So the bytes have to come through us:
 *
 *   1. GET the PDF (plain fetch — the signature is GET-scoped).
 *   2. Create a single_part file upload.
 *   3. POST the bytes, with the file part declaring the SAME content type the
 *      upload was created with — Notion 400s on application/octet-stream.
 *   4. PATCH the property with { type: "file_upload", file_upload: { id } }.
 *
 * All four in ONE step: a retry must not re-download against a URL that has since
 * expired, and must not attach a second copy.
 *
 * Never throws. The status write has already happened by this point and must not
 * be undone by a filing problem — a missing PDF is re-attachable by hand, a
 * rolled-back status is worse.
 *
 * Failures come back as `{ ok: false, stage, detail }` and are surfaced in the
 * workflow's own output rather than only logged, because a durable run's console
 * output is NOT retrievable from `get-durable-run` — the run object exposes step
 * status but no logs. A silent `null` here would be undiagnosable in production.
 */
type AttachResult =
  | { ok: true; uploadId: string; bytes: number }
  | { ok: false; stage: string; detail: string };

async function attachSignedPdf(
  ctx: any,
  args: { pageId: string; fileProp: string; url: string; filename: string },
): Promise<AttachResult> {
  return ctx.step("attach-signed-pdf", async (): Promise<AttachResult> => {
    try {
      // `sdk.fetch` with NO connection, not a plain `fetch`. The durable sandbox
      // has no DNS for arbitrary hosts — a bare fetch dies with
      // `getaddrinfo ENOTFOUND`, so all egress has to go through Zapier's proxy.
      // No connection is passed deliberately: the URL is already presigned, and
      // binding one would hand a Zapier-held credential to AWS.
      const dl = await sdk.fetch(args.url, { method: "GET" });
      if (!dl.ok) {
        return { ok: false, stage: "download", detail: `HTTP ${dl.status}` };
      }
      const bytes = new Uint8Array(await dl.arrayBuffer());
      if (!bytes.length) {
        return { ok: false, stage: "download", detail: "empty body" };
      }
      const contentType = firstString(dl.headers.get("content-type")) || "application/pdf";

      const createRes = await sdk.fetch(`${NOTION_API}/file_uploads`, {
        connection: NOTION_CONNECTION,
        method: "POST",
        headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
        body: JSON.stringify({ filename: args.filename, content_type: contentType }),
      });
      const upload: any = await createRes.json();
      if (!createRes.ok || !upload?.id) {
        return {
          ok: false,
          stage: "create-upload",
          detail: `HTTP ${createRes.status}: ${JSON.stringify(upload).slice(0, 300)}`,
        };
      }

      // Send the bytes as multipart/form-data, hand-built.
      //
      // The file part MUST declare the same content type the upload was created
      // with, or Notion rejects the send with "Current file content type of
      // `application/octet-stream` does not match the original content type".
      //
      // Built by hand rather than with FormData because this exact byte layout is
      // the one verified to work against Notion, whereas relying on a fetch
      // wrapper to pass a FormData object through untouched (and let the runtime
      // set the boundary header) is not something this repo has ever tested. The
      // boundary is derived from the upload id, so it stays deterministic across
      // retries of this step.
      const boundary = `----wfEsignBoundary${String(upload.id).replace(/-/g, "")}`;
      const enc = new TextEncoder();
      const head = enc.encode(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${args.filename}"\r\n` +
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
        return {
          ok: false,
          stage: "send-bytes",
          detail: `HTTP ${sendRes.status}: ${JSON.stringify(sent).slice(0, 300)}`,
        };
      }

      const patchRes = await sdk.fetch(`${NOTION_API}/pages/${args.pageId}`, {
        connection: NOTION_CONNECTION,
        method: "PATCH",
        headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
        body: JSON.stringify({
          properties: {
            [args.fileProp]: {
              files: [
                { type: "file_upload", file_upload: { id: upload.id }, name: args.filename },
              ],
            },
          },
        }),
      });
      if (!patchRes.ok) {
        return {
          ok: false,
          stage: "attach",
          detail: `HTTP ${patchRes.status}: ${(await patchRes.text()).slice(0, 300)}`,
        };
      }
      return { ok: true, uploadId: String(upload.id), bytes: bytes.length };
    } catch (err) {
      return {
        ok: false,
        stage: "exception",
        detail: String((err as Error)?.message ?? err).slice(0, 300),
      };
    }
  });
}

// --- Workflow factory ------------------------------------------------------

export function defineStatusSync(phase: Phase) {
  const name = PHASE_NAMES[phase];

  return defineDurable<Record<string, unknown>, unknown>(name, async (ctx, rawInput) => {
    const payload = normalizeInput(rawInput);

    if (isEmptyPing(payload)) {
      console.log("empty payload — treating as a ping, not an event");
      return { skipped: "empty-payload" };
    }

    const contractId = extractContractId(payload);

    // 1. Which Notion record does this contract belong to? A contract created
    //    outside the send-for-signing flows has no row here — that is a SKIP, not
    //    an error. The classic Zap's search was configured to fail on a miss,
    //    which turned every unrelated contract into an alert.
    const row = await ctx.step("table-find-by-contract-id", async () => {
      const found = await sdk.listTableRecords({
        table: ESIGN_TABLE,
        keyMode: "names",
        filters: [{ fieldKey: T_CONTRACT_ID, operator: "exact", value: contractId }],
        pageSize: 10,
      });
      const rows = ((found as any)?.data ?? []) as any[];
      rows.sort((a, b) => String(a?.id ?? "").localeCompare(String(b?.id ?? "")));
      return rows[0] ?? null;
    });

    if (!row) {
      console.log(`no mapping row for contract ${contractId} — not one of ours, skipping`);
      return { skipped: "no-mapping-row", contractId };
    }

    const pageId = dashUuid(firstString((row.data ?? {})[T_PAGE_ID]));
    if (!pageId) {
      console.log(`mapping row ${row.id} has no Page ID — nothing to update`);
      return { skipped: "row-has-no-page-id", contractId, tableRowId: row.id };
    }

    const agreementType = readAgreementType(row);
    if (!agreementType) {
      const raw = JSON.stringify((row.data ?? {})[T_AGREEMENT_TYPE]);
      console.log(`mapping row ${row.id} has an unrecognised Agreement Type: ${raw}`);
      return { skipped: "unknown-agreement-type", contractId, agreementTypeRaw: raw };
    }
    const cfg = TYPES[agreementType];
    const status = phase === "sent" ? cfg.sentStatus : cfg.signedStatus;

    // 2. Move the status on.
    await ctx.step("update-status", async () =>
      sdk.runAction({
        appKey: NOTION_APP_KEY,
        actionType: "write",
        actionKey: "update_database_item",
        connection: NOTION_CONNECTION,
        inputs: {
          datasource: cfg.datasource,
          page: pageId,
          "properties|||Status|||status": status,
        },
      }),
    );

    // 3. On signature, file the executed PDF. New behaviour — the classic Zap
    //    passed an empty files array and so never filed anything.
    let attach: AttachResult | null = null;
    let pdfUrl = "";
    if (phase === "signed") {
      pdfUrl = extractSignedPdfUrl(payload);
      if (!pdfUrl) {
        attach = {
          ok: false,
          stage: "extract-url",
          detail: `no https .pdf URL in payload; keys: ${Object.keys(
            (payload ?? {}) as Record<string, unknown>,
          ).join(",")}`,
        };
      } else {
        attach = await attachSignedPdf(ctx, {
          pageId,
          fileProp: cfg.fileProp,
          url: pdfUrl,
          filename: pdfFilename(pdfUrl, `${agreementType} ${contractId}`),
        });
      }
    }

    console.log(
      `${name}: contract ${contractId} -> ${agreementType} ${pageId} status "${status}"` +
        (attach
          ? ` (pdf: ${attach.ok ? `${attach.bytes} bytes` : `NOT FILED at ${attach.stage} — ${attach.detail}`})`
          : ""),
    );

    return {
      contractId,
      agreementType,
      pageId,
      status,
      tableRowId: row.id,
      ...(phase === "signed"
        ? {
            fileProperty: cfg.fileProp,
            pdfFound: Boolean(pdfUrl),
            pdfFiled: attach?.ok === true,
            pdfBytes: attach?.ok ? attach.bytes : null,
            // Surfaced in the output because run logs are not retrievable.
            pdfError: attach && !attach.ok ? `${attach.stage}: ${attach.detail}` : null,
          }
        : {}),
    };
  });
}
