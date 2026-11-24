// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/zapier-partner-lead-status-to-notion
//
// Keeps the Notion **Partner Leads** database in step with Zapier's Solution
// Partner Operations Tool (SPOT). One row per SPOT record: every referral lead
// on the account, and every project request Zapier has sent us.
//
// Two deployments run this same source (see zap.json → deployments[]):
//   * `status-trigger` — SPOT's `referral_lead_status_change` polling trigger.
//     The payload is ONE referral lead; that lead's row is upserted. This is the
//     near-real-time path.
//   * `daily-sweep`    — Schedule by Zapier. The payload carries no lead, so the
//     run reads EVERY referral lead and project request from SPOT (one task
//     each) and upserts whatever changed since the last sync. This is the
//     backstop for anything the trigger missed, and its first runs are the
//     backfill.
//
// Both paths share one code path (`syncRecord`) and one free Zapier Table
// cache (SPOT id → page id + last-synced status/modified time), so running them
// side by side is safe: whichever handles a change first records it and the
// other finds nothing to do.
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
const NOTION_CONNECTION = "notion_wf";
const SPOT_CONNECTION = "spot";
const SPOT_APP_KEY = "App227952CLIAPI";
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

// Notion data sources.
const PARTNER_LEADS_DS = "42291b07-11ac-8142-af6a-000bf3227cd9";
const COMPANIES_DS = "21991b07-11ac-80b0-b787-000b3d3995f6";

// Zapier Tables (free ops, no connection).
/** SPOT id → Partner Leads page id + last-synced Status / Modified On. Owned here. */
const SYNC_TABLE = "01M86D6X6RPBV57GGHXYKTQ9P8";
/** client id → Notion Company page id, written by register-zapier-partner-lead. */
const LEAD_TABLE = "01KPZFHX4RP6SER3AEK4YJ62BF";
/** email → Notion Contact page id, owned by contact-emails-to-zapier-table. */
const CONTACT_EMAIL_TABLE = "01JYEPSEARXB2Z6BJRCMFGXBC2";
/** project request id → Deal/Contact/Company page ids, owned by spot-project-request-to-notion. */
const REQUEST_TABLE = "01KYV1R8BWAZ697HQ8P1QV80AF";
/** Notion user id ↔ Zapier partner contact id ("User IDs"). */
const USER_ID_TABLE = "01JM3J9SG5X6S8GBSSC8AS28AT";

/**
 * At most this many Notion writes per run. The first sweep has ~280 records to
 * create, each a handful of journaled steps; one run doing all of them would be
 * a very long journal. Capped, the backfill completes over a few runs (manual
 * `trigger-workflow` runs, or successive daily fires), and an unexpected burst
 * — like the expiry wave of ~200 event leads in October — is spread out rather
 * than landing in one run. Records left over are reported in the output.
 */
const MAX_WRITES_PER_RUN = 60;

// Select options that exist on Partner Leads → Status. An unknown value is
// never written: a select write of a new option silently mints schema.
const REFERRAL_STATUSES = ["Submitted", "Approved", "Converted", "Rejected", "Expired"];
const REQUEST_STATUSES = ["Pending", "Accepted", "Declined", "Lost", "Expired"];
const REQUEST_SOURCES = ["Directory", "Zapier Sales"];

// SPOT withholds a Pending request's identity behind this placeholder text.
const SENTINEL_RE = /\baccept or secure the lead\b/i;

type DurableCtx = DurableContext;

// --- Pure helpers ----------------------------------------------------------

export function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline can deliver input double-encoded (a JSON string of a
  // JSON string), while run-durable delivers it single-encoded.
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

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/** Lowercased, validated email — or "". The email Table is all lowercase. */
function cleanEmail(v: unknown): string {
  const s = firstString(v)?.toLowerCase() ?? "";
  return EMAIL_RE.test(s) ? s : "";
}

/**
 * The date part of a SPOT timestamp. These name calendar dates (an expiry, a
 * payout boundary) and arrive as `…T00:00:00` with no zone, so the time is
 * dropped rather than letting Notion shift it.
 */
function dateOnly(v: unknown): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(firstString(v) ?? "");
  return m ? m[1] : "";
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickOption(raw: unknown, options: readonly string[]): string {
  const s = firstString(raw)?.toLowerCase() ?? "";
  return options.find((o) => o.toLowerCase() === s) ?? "";
}

function richText(content: string) {
  return { rich_text: [{ type: "text", text: { content: content.slice(0, 1900) } }] };
}

// --- SPOT records ----------------------------------------------------------

/** One SPOT record, normalised for either kind. */
export interface SpotRecord {
  kind: "Referral Lead" | "Project Request";
  spotId: string;
  name: string;
  email: string;
  clientId: string;
  status: string; // canonical option, or "" when unrecognised
  rawStatus: string;
  reason: string;
  source: string;
  partnerContact: string;
  submittedOn: string;
  changedOn: string;
  /** Change marker compared against the cache: SPOT's last-modified stamp. */
  modifiedOn: string;
  expires: string;
  convertedOn: string;
  commission: number | null;
  payoutY1: [string, string];
  payoutY2: [string, string];
}

export function extractReferralLead(raw: unknown): SpotRecord {
  const o = (raw ?? {}) as Record<string, any>;
  const lead = Array.isArray(o) ? (o[0] ?? {}) : (o.data && !Array.isArray(o.data) ? o.data : o);
  const first = firstString(lead.first_name) ?? "";
  const last = firstString(lead.last_name) ?? "";
  const email = cleanEmail(lead.email);
  const modifiedOn = firstString(lead.lead_status_modified_on) ?? "";
  return {
    kind: "Referral Lead",
    spotId: firstString(lead.lead_id) ?? "",
    name: firstString(lead.name) ?? (`${first} ${last}`.trim() || email),
    email,
    clientId: firstString(lead.client_id) ?? "",
    status: pickOption(lead.status, REFERRAL_STATUSES),
    rawStatus: firstString(lead.status) ?? "",
    reason: firstString(lead.reason) ?? "",
    source: "",
    partnerContact: firstString(lead.partner_contact) ?? "",
    submittedOn: dateOnly(lead.created_on),
    changedOn: dateOnly(modifiedOn),
    modifiedOn,
    expires: dateOnly(lead.expiration_date),
    convertedOn: dateOnly(lead.converted_date),
    commission: toNumber(lead.commission_percentage),
    payoutY1: [dateOnly(lead.payout_y1_start), dateOnly(lead.payout_y1_end)],
    payoutY2: [dateOnly(lead.payout_y2_start), dateOnly(lead.payout_y2_end)],
  };
}

export function extractProjectRequest(raw: unknown): SpotRecord {
  const r = (raw ?? {}) as Record<string, any>;
  const spotId = firstString(r.project_request_id) ?? "";
  const withheld = [r.company, r.first_name, r.email].some(
    (v) => typeof v === "string" && SENTINEL_RE.test(v),
  );
  const email = withheld ? "" : cleanEmail(r.email);
  const person = withheld
    ? ""
    : `${firstString(r.first_name) ?? ""} ${firstString(r.last_name) ?? ""}`.trim();
  const company = withheld ? "" : (firstString(r.company) ?? "");
  const modifiedOn = firstString(r.modified_on) ?? "";
  return {
    kind: "Project Request",
    spotId,
    name: company || person || email || `Project request ${spotId}`,
    email,
    clientId: firstString(r.client_id) ?? "",
    status: pickOption(r.lead_stage, REQUEST_STATUSES),
    rawStatus: firstString(r.lead_stage) ?? "",
    reason: "",
    source: pickOption(r.source, REQUEST_SOURCES),
    partnerContact: firstString(r.partner_contact) ?? "",
    submittedOn: dateOnly(r.created_on),
    changedOn: dateOnly(modifiedOn),
    modifiedOn,
    expires: "",
    convertedOn: "",
    commission: null,
    payoutY1: ["", ""],
    payoutY2: ["", ""],
  };
}

/**
 * The properties written on EVERY sync of a record — the ones SPOT owns.
 * Only fields the record actually carries are written: SPOT sends a different
 * subset per status (an expiry on Approved/Expired, the payout windows only on
 * Converted), so writing the absent ones as empty would erase history. Nothing
 * here ever clears a value. Relations are not in here — see `syncRecord`.
 */
export function spotOwnedProps(rec: SpotRecord, ownerUserId: string): Record<string, unknown> {
  const p: Record<string, unknown> = {
    "Lead Name": { title: [{ type: "text", text: { content: rec.name.slice(0, 200) } }] },
    Type: { select: { name: rec.kind } },
    Program: { select: { name: "Zapier" } },
    "SPOT Id": richText(rec.spotId),
  };
  if (rec.status) p["Status"] = { select: { name: rec.status } };
  if (rec.reason) p["Status Reason"] = richText(rec.reason);
  if (rec.clientId) p["Zapier Client Id"] = richText(rec.clientId);
  if (rec.email) p["Lead Email"] = { email: rec.email };
  if (rec.source) p["Source"] = { select: { name: rec.source } };
  if (rec.submittedOn) p["Submitted On"] = { date: { start: rec.submittedOn } };
  if (rec.changedOn) p["Status Changed On"] = { date: { start: rec.changedOn } };
  if (rec.expires) p["Expires"] = { date: { start: rec.expires } };
  if (rec.convertedOn) p["Converted On"] = { date: { start: rec.convertedOn } };
  if (rec.commission !== null) p["Commission %"] = { number: rec.commission };
  if (rec.payoutY1[0]) p["Payout Year 1"] = { date: { start: rec.payoutY1[0], end: rec.payoutY1[1] || null } };
  if (rec.payoutY2[0]) p["Payout Year 2"] = { date: { start: rec.payoutY2[0], end: rec.payoutY2[1] || null } };
  if (ownerUserId) p["Owner"] = { people: [{ object: "user", id: ownerUserId }] };
  return p;
}

function relation(ids: string[]) {
  return { relation: ids.filter(Boolean).map((id) => ({ id })) };
}

// --- Notion I/O (each call is one task; always inside a step) --------------

async function notion(path: string, method: string, body?: unknown): Promise<any> {
  const res = await sdk.fetch(`${NOTION_API}${path}`, {
    connection: NOTION_CONNECTION,
    method,
    headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Notion ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    (err as any).status = res.status;
    (err as any).body = text;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

/**
 * Create a Partner Leads page, applying the data source's default template
 * when it has one (repo rule 5). The raw API takes `template: {type:"default"}`
 * and refuses it on a data source with no default template; that refusal —
 * and only that one — is retried without the template, inside the same step so
 * it never spins the step-retry loop. A template added later is picked up with
 * no code change.
 */
export function isNoDefaultTemplateError(status: unknown, body: unknown): boolean {
  return status === 400 && /default template/i.test(String(body ?? ""));
}

async function createLeadPage(props: Record<string, unknown>): Promise<string> {
  const base = { parent: { type: "data_source_id", data_source_id: PARTNER_LEADS_DS }, properties: props };
  try {
    const page = await notion("/pages", "POST", { ...base, template: { type: "default" } });
    return String(page.id);
  } catch (err) {
    if (!isNoDefaultTemplateError((err as any).status, (err as any).body)) throw err;
    const page = await notion("/pages", "POST", base);
    return String(page.id);
  }
}

// --- Free Table lookups ----------------------------------------------------

interface CacheRow {
  recordId: string;
  pageId: string;
  status: string;
  modifiedOn: string;
}

function toCacheRow(row: any): CacheRow {
  const d = (row?.data ?? {}) as Record<string, unknown>;
  return {
    recordId: String(row?.id ?? ""),
    pageId: firstString(d["Page ID"]) ?? "",
    status: firstString(d["Status"]) ?? "",
    modifiedOn: firstString(d["Modified On"]) ?? "",
  };
}

async function readAllCache(): Promise<Record<string, CacheRow>> {
  const out: Record<string, CacheRow> = {};
  for await (const row of sdk.listTableRecords({ table: SYNC_TABLE, keyMode: "names" }).items()) {
    const id = firstString((row as any)?.data?.["SPOT Id"]);
    if (id) out[id] = toCacheRow(row);
  }
  return out;
}

/**
 * SPOT ids are Salesforce ids, and Salesforce ids are CASE-SENSITIVE: of the
 * 263 referral leads on 2026-11-24, 82 lead ids collide with another lead's id
 * once case is ignored (`…6wV00hE` / `…6wv00hE`), and so do 79 client ids and
 * one project request id. Notion's `rich_text.equals` filter ignores case, and
 * the first backfill run matched 12 records to the wrong row because of it.
 * Every lookup by a SPOT id therefore re-checks the match exactly, client-side.
 * Zapier Table `exact` filters get the same treatment, since nothing promises
 * they are case-sensitive either.
 */
async function tableRows(table: string, field: string, value: string): Promise<any[]> {
  if (!value) return [];
  const found = await sdk.listTableRecords({
    table,
    keyMode: "names",
    filters: [{ fieldKey: field, operator: "exact", value }],
    pageSize: 10,
  });
  return (found.data ?? []).filter((r: any) => firstString(r?.data?.[field]) === value);
}

async function readOneCache(spotId: string): Promise<CacheRow | null> {
  const rows = await tableRows(SYNC_TABLE, "SPOT Id", spotId);
  return rows[0] ? toCacheRow(rows[0]) : null;
}

async function tableLookup(table: string, field: string, value: string): Promise<Record<string, unknown> | null> {
  const rows = await tableRows(table, field, value);
  return (rows[0]?.data as Record<string, unknown> | undefined) ?? null;
}

/** A page's text property, exactly as stored. */
export function pageText(page: any, prop: string): string {
  return (page?.properties?.[prop]?.rich_text ?? []).map((t: any) => t?.plain_text ?? "").join("").trim();
}

/** partner contact id → Notion user id, from the User IDs Table. */
async function readPartnerContactMap(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for await (const row of sdk.listTableRecords({ table: USER_ID_TABLE, keyMode: "names" }).items()) {
    const d = ((row as any)?.data ?? {}) as Record<string, unknown>;
    const pc = firstString(d["Zapier Partner Contact ID"]);
    const user = firstString(d["Notion User ID"]);
    if (pc && user) out[pc] = user;
  }
  return out;
}

// --- The shared upsert -----------------------------------------------------

interface SyncContext {
  /** SPOT id → cache row, pre-loaded by the sweep; null means "look it up". */
  cache: Record<string, CacheRow> | null;
  partnerContacts: Record<string, string>;
  /** client id → company page id, for legacy companies stamped with a client id. */
  legacyCompanies: Record<string, string>;
}

type SyncOutcome = "unchanged" | "created" | "updated" | "skipped";

/**
 * Upsert one SPOT record's Partner Leads row. Step ids carry the SPOT id, so
 * this lives in a function that takes `ctx` (the publish-time analyzer rejects
 * template-literal step ids in the workflow body but does not follow `ctx` into
 * a helper; the runtime still needs them unique per record).
 *
 * Cost: unchanged = free (Table reads only). Update = 1 task. Create = 2–3
 * tasks (a duplicate-guard query, the create, and for a referral lead whose
 * owner is in the CRM, one contact read to find their company).
 */
async function syncRecord(ctx: DurableCtx, rec: SpotRecord, sc: SyncContext): Promise<SyncOutcome> {
  const key = `${rec.kind === "Referral Lead" ? "lead" : "req"}-${rec.spotId}`;
  if (!rec.spotId) return "skipped";

  const cached =
    sc.cache !== null
      ? (sc.cache[rec.spotId] ?? null)
      : await ctx.step(`${key}-cache`, async () => readOneCache(rec.spotId));

  // Nothing changed since the last sync: the whole point of the cache.
  if (cached?.pageId && cached.modifiedOn === rec.modifiedOn && cached.status === (rec.status || rec.rawStatus)) {
    return "unchanged";
  }

  const ownerUserId = sc.partnerContacts[rec.partnerContact] ?? "";
  const props = spotOwnedProps(rec, ownerUserId);

  // Project requests: the Deal/Contact/Company the intake Zaps filed are
  // authoritative, and appear only once a request is Accepted, so they are
  // (re)written on every sync rather than only at create.
  let requestLinks: Record<string, unknown> | null = null;
  if (rec.kind === "Project Request") {
    requestLinks = await ctx.step(`${key}-request-links`, async () => {
      const row = await tableLookup(REQUEST_TABLE, "Request Id", rec.spotId);
      if (!row) return null;
      return {
        deal: firstString(row["Deal Page ID"]) ?? "",
        contact: firstString(row["Contact Page ID"]) ?? "",
        company: firstString(row["Company Page ID"]) ?? "",
        companyName: firstString(row["Company Name"]) ?? "",
      };
    });
    if (requestLinks) {
      const l = requestLinks as { deal: string; contact: string; company: string; companyName: string };
      // SPOT withholds a non-accepted request's identity, so its name is a
      // placeholder; the intake Zap recorded the real one once it was filed.
      if (l.companyName && rec.name.startsWith("Project request ")) {
        props["Lead Name"] = { title: [{ type: "text", text: { content: l.companyName.slice(0, 200) } }] };
      }
      if (l.deal) props["Deal"] = relation([l.deal]);
      if (l.contact) props["Account Owner"] = relation([l.contact]);
      if (l.company) props["Company"] = relation([l.company]);
    }
  }

  // Find the page: cache, else an existing row (one the register Zap created
  // before SPOT assigned a lead id, or one whose cache write was lost).
  let pageId = cached?.pageId ?? "";
  if (!pageId) {
    pageId = await ctx.step(`${key}-find-page`, async () => {
      const or: unknown[] = [{ property: "SPOT Id", rich_text: { equals: rec.spotId } }];
      if (rec.kind === "Referral Lead" && rec.clientId) {
        or.push({ property: "Zapier Client Id", rich_text: { equals: rec.clientId } });
      }
      const body = await notion(`/data_sources/${PARTNER_LEADS_DS}/query`, "POST", {
        filter: { or },
        page_size: 20,
      });
      // Notion matched case-insensitively; keep only exact matches.
      const results = (Array.isArray(body?.results) ? body.results : []).filter(
        (p: any) =>
          pageText(p, "SPOT Id") === rec.spotId ||
          // A row the register Zap created before SPOT assigned a lead id. Only
          // rows with no SPOT Id yet: a re-registered client can get a second
          // lead under the same client id, and that must be its own row.
          (rec.kind === "Referral Lead" &&
            rec.clientId !== "" &&
            pageText(p, "SPOT Id") === "" &&
            pageText(p, "Zapier Client Id") === rec.clientId),
      );
      if (results.length > 1) {
        // Two rows for one lead is a data problem a human should see; don't
        // pick one, and don't mint a third.
        throw new Error(`${results.length} Partner Leads rows match SPOT id ${rec.spotId}; resolve by hand`);
      }
      return firstString(results[0]?.id) ?? "";
    });
  }

  let outcome: SyncOutcome;
  if (pageId) {
    await ctx.step(`${key}-update`, async () => notion(`/pages/${pageId}`, "PATCH", { properties: props }));
    outcome = "updated";
  } else {
    // Relations for a brand-new referral lead row. Set at create only: after
    // that they belong to whoever curates the row.
    if (rec.kind === "Referral Lead") {
      const links = await ctx.step(`${key}-resolve-links`, async () => {
        let company = "";
        let source = "";
        if (rec.clientId) {
          const reg = await tableLookup(LEAD_TABLE, "Client Id", rec.clientId);
          company = firstString(reg?.["Notion Company Page ID"]) ?? "";
          if (reg) source = "Notion CRM";
        }
        if (!company && rec.clientId) company = sc.legacyCompanies[rec.clientId] ?? "";
        const contactRow = await tableLookup(CONTACT_EMAIL_TABLE, "Email", rec.email);
        const contact = firstString(contactRow?.["Page ID"]) ?? "";
        if (!company && contact) {
          // One task: the contact's Related Company. Linked only when it names
          // exactly one company — a contact at several gives no single answer.
          try {
            const page = await notion(`/pages/${contact}`, "GET");
            const related = page?.properties?.["Related Company"]?.relation ?? [];
            if (related.length === 1) company = firstString(related[0]?.id) ?? "";
          } catch (err) {
            console.log(`Contact read failed for ${rec.spotId}: ${String((err as Error)?.message ?? err)}`);
          }
        }
        return { company, contact, source };
      });
      if (links.company) props["Company"] = relation([links.company]);
      if (links.contact) props["Account Owner"] = relation([links.contact]);
      if (links.source && !props["Source"]) props["Source"] = { select: { name: links.source } };
    } else if (!requestLinks && rec.email) {
      const contact = await ctx.step(`${key}-resolve-contact`, async () =>
        firstString((await tableLookup(CONTACT_EMAIL_TABLE, "Email", rec.email))?.["Page ID"]) ?? "",
      );
      if (contact) props["Account Owner"] = relation([contact]);
    }
    pageId = await ctx.step(`${key}-create`, async () => createLeadPage(props));
    outcome = "created";
  }

  // Record what was synced. Written last, so the cache never claims a write
  // that didn't happen. A failure is logged, not retried: the Notion row is
  // already right, and the next sync finds it through the duplicate guard.
  await ctx.step(`${key}-cache-write`, async () => {
    const data = {
      "SPOT Id": rec.spotId,
      "Page ID": pageId,
      Type: rec.kind,
      Status: rec.status || rec.rawStatus,
      "Modified On": rec.modifiedOn,
    };
    try {
      if (cached?.recordId) {
        await sdk.updateTableRecords({ table: SYNC_TABLE, keyMode: "names", records: [{ id: cached.recordId, data }] });
      } else {
        await sdk.createTableRecords({ table: SYNC_TABLE, keyMode: "names", records: [{ data }] });
      }
      return { ok: true };
    } catch (err) {
      console.log(`Cache write failed for ${rec.spotId}: ${String((err as Error)?.message ?? err)}`);
      return { ok: false };
    }
  });

  if (!rec.status && rec.rawStatus) {
    console.log(`Unrecognised status "${rec.rawStatus}" on ${rec.spotId}; Status left unset`);
  }
  return outcome;
}

/** Sweep a batch through `syncRecord`, stopping at the write cap. */
async function syncAll(
  ctx: DurableCtx,
  records: SpotRecord[],
  sc: SyncContext,
  budget: { left: number },
): Promise<Record<SyncOutcome | "deferred", number>> {
  const tally: Record<SyncOutcome | "deferred", number> = { unchanged: 0, created: 0, updated: 0, skipped: 0, deferred: 0 };
  for (const rec of records) {
    const cached = sc.cache?.[rec.spotId];
    const changed = !(cached?.pageId && cached.modifiedOn === rec.modifiedOn && cached.status === (rec.status || rec.rawStatus));
    if (changed && budget.left <= 0) {
      tally.deferred++;
      continue;
    }
    const outcome = await syncRecord(ctx, rec, sc);
    tally[outcome]++;
    if (outcome === "created" || outcome === "updated") budget.left--;
  }
  return tally;
}

function listFrom(res: unknown): unknown[] {
  const r = res as { data?: unknown; results?: unknown };
  if (Array.isArray(r?.data)) return r.data;
  if (Array.isArray(r?.results)) return r.results;
  return Array.isArray(res) ? res : [];
}

/** A payload that is one referral lead (the trigger) rather than a schedule fire. */
export function isLeadEvent(payload: unknown): boolean {
  const o = (payload ?? {}) as Record<string, any>;
  const lead = Array.isArray(o) ? o[0] : (o.data && !Array.isArray(o.data) ? o.data : o);
  return Boolean(firstString(lead?.lead_id));
}

// --- Workflow --------------------------------------------------------------

const workflow = defineDurable(
  "zapier-partner-lead-status-to-notion",
  async (ctx, rawInput) => {
    const payload = normalizeInput(rawInput);

    // ---- status-trigger deployment: one referral lead ----------------------
    if (isLeadEvent(payload)) {
      const rec = extractReferralLead(payload);
      console.log(`Lead ${rec.spotId} (client ${rec.clientId || "?"}) -> ${rec.rawStatus || "no status"}`);
      const partnerContacts = await ctx.step("event-partner-contacts", async () => readPartnerContactMap());
      const outcome = await syncRecord(ctx, rec, { cache: null, partnerContacts, legacyCompanies: {} });
      return { mode: "event", spotId: rec.spotId, status: rec.status || rec.rawStatus, outcome };
    }

    // ---- daily-sweep deployment: everything --------------------------------
    // Any payload without a lead in it is a schedule fire (or a manual run).
    // The sweep is idempotent — an extra one only costs its two SPOT reads.
    const leads = await ctx.step("list-referral-leads", async () =>
      sdk.runAction({
        appKey: SPOT_APP_KEY,
        actionType: "read",
        actionKey: "referral_lead_status_change",
        connection: SPOT_CONNECTION,
        inputs: {},
      }),
    );
    const requests = await ctx.step("list-project-requests", async () =>
      sdk.runAction({
        appKey: SPOT_APP_KEY,
        actionType: "search",
        actionKey: "find_project_request",
        connection: SPOT_CONNECTION,
        inputs: {},
      }),
    );
    const cache = await ctx.step("read-cache", async () => readAllCache());
    const partnerContacts = await ctx.step("partner-contacts", async () => readPartnerContactMap());
    // One task: the few companies still stamped with a Zapier Client Id from
    // before this database existed, so their leads link to them.
    const legacyCompanies = await ctx.step("legacy-companies", async () => {
      const body = await notion(`/data_sources/${COMPANIES_DS}/query`, "POST", {
        filter: { property: "Zapier Client Id", rich_text: { is_not_empty: true } },
        page_size: 100,
      });
      const out: Record<string, string> = {};
      for (const p of Array.isArray(body?.results) ? body.results : []) {
        const id = pageText(p, "Zapier Client Id");
        if (id) out[id] = String(p.id);
      }
      return out;
    });

    const dedupe = (recs: SpotRecord[]) => {
      const seen = new Set<string>();
      return recs.filter((r) => r.spotId && !seen.has(r.spotId) && seen.add(r.spotId));
    };
    const leadRecs = dedupe(listFrom(leads).map(extractReferralLead));
    const requestRecs = dedupe(listFrom(requests).map(extractProjectRequest));
    if (leadRecs.length === 0 && requestRecs.length === 0) {
      // SPOT always has history; an empty read means the read broke.
      throw new Error("SPOT returned no referral leads and no project requests");
    }

    const sc: SyncContext = { cache, partnerContacts, legacyCompanies };
    const budget = { left: MAX_WRITES_PER_RUN };
    // Project requests first: there are few, and they carry Deals.
    const requestTally = await syncAll(ctx, requestRecs, sc, budget);
    const leadTally = await syncAll(ctx, leadRecs, sc, budget);

    const deferred = requestTally.deferred + leadTally.deferred;
    if (deferred > 0) {
      console.log(`${deferred} changed record(s) deferred to the next run (write cap ${MAX_WRITES_PER_RUN})`);
    }
    return {
      mode: "sweep",
      referralLeads: { total: leadRecs.length, ...leadTally },
      projectRequests: { total: requestRecs.length, ...requestTally },
      deferred,
    };
  },
);

export default workflow;
