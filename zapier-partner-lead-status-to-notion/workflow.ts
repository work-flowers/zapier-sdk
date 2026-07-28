// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/zapier-partner-lead-status-to-notion
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
// The partner-tool credential lives on the TRIGGER, not here — the workflow
// code never calls the partner tool.
const NOTION_CONNECTION = "notion_wf";
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

// Core CRM Objects.
const COMPANIES_DS = "21991b07-11ac-80b0-b787-000b3d3995f6";

// Zapier Tables (free ops, no connection).
// client id -> Notion Company page id, written by `register-zapier-partner-lead`.
const LEAD_TABLE = "01KPZFHX4RP6SER3AEK4YJ62BF";
// email -> Notion Contact page id, owned by `contact-emails-to-zapier-table`.
const CONTACT_EMAIL_TABLE = "01JYEPSEARXB2Z6BJRCMFGXBC2";

/**
 * The five statuses the partner tool's `referral_lead_status_change` trigger
 * actually emits, verified against all 247 leads on the account (2026-07-28):
 * Approved 209 · Rejected 15 · Converted 10 · Expired 9 · Submitted 4.
 *
 * All five now exist as `Zapier Lead Status` options in Notion. `Converted` and
 * `Expired` were added for this migration — the classic Zap wrote the raw status
 * into the select with no option to land in. Notion's legacy `Accepted` option
 * is deliberately absent here: the API has never emitted it.
 *
 * An unrecognised status is never written to the select (a select write of an
 * unknown option is how you silently mint schema); it is logged and surfaced in
 * the run output instead.
 */
const KNOWN_STATUSES = [
  "Submitted",
  "Approved",
  "Converted",
  "Rejected",
  "Expired",
] as const;

/**
 * Statuses that let an **untracked** lead be adopted into the CRM.
 *
 * A lead is "tracked" if this system already knows about it — it has a row in
 * the lead Table, or its company carries its `Zapier Client Id`. Tracked leads
 * are always written, whatever their status: someone deliberately registered
 * them and wants to see what happened.
 *
 * An untracked lead is a different proposition. The account's lead history is
 * essentially one bulk event submission: of 45 leads sampled evenly across it,
 * 45 carried `source: mdfRequest-…` and 78% reported `zapier_account_status:
 * "No Account Found"` — the address isn't attached to any Zapier account. Those
 * are event attendees, not opportunities, and adopting them would stamp Zapier
 * lead fields onto most of the company list.
 *
 * The timing matters too. Those ~209 Approved leads each carry a 90-day expiry,
 * so they will all flip to Expired at roughly the same time and fire a status
 * change each. Without this gate that single wave would adopt the entire
 * attendee list at once.
 *
 * `Converted` is the signal that survives all of that: the lead became a paid,
 * owned account, so there is real revenue attached and the company belongs in
 * lead tracking. Everything else waits until someone registers it deliberately.
 *
 * To widen the policy, add statuses here — the rest of the workflow needs no
 * change. Note that widening it does NOT retroactively adopt anything; a lead
 * is only reconsidered when its status next changes (or when the backfill
 * script replays it).
 */
const ADOPTION_STATUSES: readonly string[] = ["Converted"];

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

function plainText(rich: any): string {
  return (Array.isArray(rich) ? rich : [])
    .map((t: any) => t?.plain_text ?? "")
    .join("")
    .trim();
}

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/** Lowercased, validated email — or "". Every row in the email Table is
 *  lowercase, so a raw-case address would never match. */
function cleanEmail(v: unknown): string {
  const s = firstString(v)?.toLowerCase() ?? "";
  return EMAIL_RE.test(s) ? s : "";
}

/**
 * The date part of a partner-tool timestamp.
 *
 * These fields arrive as `"2026-10-17T00:00:00"` — no timezone, and always at
 * midnight, because they name calendar dates (an expiry, a payout window
 * boundary) rather than moments. Feeding the raw string to Notion as a datetime
 * would invite a timezone shift onto a date that has no time in it, so the time
 * is dropped and Notion stores a date-only value.
 */
function dateOnly(v: unknown): string {
  const s = firstString(v) ?? "";
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
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

/** The canonical spelling of a status, or "" when it isn't one we know. */
function canonicalStatus(raw: unknown): string {
  const s = firstString(raw)?.toLowerCase() ?? "";
  return KNOWN_STATUSES.find((k) => k.toLowerCase() === s) ?? "";
}

// --- Lead data extracted from the trigger payload --------------------------

interface LeadData {
  leadId: string;
  clientId: string;
  status: string;
  rawStatus: string;
  reason: string;
  email: string;
  firstName: string;
  lastName: string;
  name: string;
  partnerContact: string;
  expirationDate: string;
  convertedDate: string;
  commission: number | null;
  payoutY1Start: string;
  payoutY1End: string;
  payoutY2Start: string;
  payoutY2End: string;
  modifiedOn: string;
}

function extractLeadData(raw: unknown): LeadData {
  const o = (raw ?? {}) as Record<string, any>;
  // A polling trigger delivers one item per run, but tolerate a wrapped or
  // batched shape.
  const lead = Array.isArray(o) ? o[0] ?? {} : (o.data ?? o);

  return {
    leadId: firstString(lead.lead_id) ?? "",
    clientId: firstString(lead.client_id) ?? "",
    status: canonicalStatus(lead.status),
    rawStatus: firstString(lead.status) ?? "",
    reason: firstString(lead.reason) ?? "",
    email: cleanEmail(lead.email),
    firstName: firstString(lead.first_name) ?? "",
    lastName: firstString(lead.last_name) ?? "",
    name: firstString(lead.name) ?? "",
    partnerContact: firstString(lead.partner_contact) ?? "",
    expirationDate: dateOnly(lead.expiration_date),
    convertedDate: dateOnly(lead.converted_date),
    commission: toNumber(lead.commission_percentage),
    payoutY1Start: dateOnly(lead.payout_y1_start),
    payoutY1End: dateOnly(lead.payout_y1_end),
    payoutY2Start: dateOnly(lead.payout_y2_start),
    payoutY2End: dateOnly(lead.payout_y2_end),
    modifiedOn: firstString(lead.lead_status_modified_on) ?? "",
  };
}

// --- Company resolution ----------------------------------------------------

// `defineDurable` is overloaded, so deriving the ctx type from its parameters
// (as the older Zaps here do) resolves to the options overload and collapses to
// `never`. The durable package exports the type directly.
type DurableCtx = DurableContext;

/**
 * How the company page was found — reported so a fallback match is auditable.
 *
 * The first two mean the lead was **already tracked**: something deliberately
 * recorded it. `contact-email` is an *adoption* — this workflow inferring a link
 * nobody made — and is gated on `ADOPTION_STATUSES`.
 */
type ResolvedVia = "lead-table" | "notion-client-id" | "contact-email";

interface Resolution {
  pageId: string;
  via: ResolvedVia;
  /** The Table row to update, when the mapping already existed. */
  tableRecordId: string | null;
}

/**
 * Find the Notion Companies page this lead belongs to.
 *
 * The classic Zap had only the first of these paths and treated a miss as an
 * error, which is why it did nothing for ~99% of leads: 247 leads exist in the
 * partner tool and the Table held 3 real rows, because everything submitted
 * straight from the partner portal never passed through the register Zap.
 *
 * Order is cheapest-and-most-certain first:
 *   1. the lead Table (free, and an exact mapping this system wrote itself)
 *   2. Notion Companies by `Zapier Client Id` (exact, survives a lost Table row)
 *   3. the lead's email -> Contact -> that contact's `Related Company`
 *      (inexact by nature: it trusts that the person Zapier calls the account
 *      owner is filed under the right company in the CRM)
 *
 * Paths 1 and 2 establish that the lead is already tracked. Path 3 is an
 * adoption and only runs when `allowAdoption` is set — which also means an
 * ungated event lead costs nothing beyond the free Table read and one Notion
 * query, rather than a two-hop contact lookup as well.
 */
async function resolveCompanyPage(
  ctx: DurableCtx,
  lead: LeadData,
  allowAdoption: boolean,
): Promise<Resolution | null> {
  // 1. The lead Table.
  if (lead.clientId) {
    const fromTable = await ctx.step("resolve-via-lead-table", async () => {
      try {
        const found = await sdk.listTableRecords({
          table: LEAD_TABLE,
          keyMode: "names",
          filters: [
            { fieldKey: "Client Id", operator: "exact", value: lead.clientId },
          ],
          pageSize: 1,
        });
        const row = found.data?.[0];
        const pageId = firstString(
          (row?.data as Record<string, any> | undefined)?.[
            "Notion Company Page ID"
          ],
        );
        return pageId ? { pageId, recordId: row!.id } : null;
      } catch (err) {
        console.log(
          `Lead table lookup failed: ${String((err as Error)?.message ?? err)}`,
        );
        return null;
      }
    });
    if (fromTable) {
      return {
        pageId: fromTable.pageId,
        via: "lead-table",
        tableRecordId: fromTable.recordId,
      };
    }

    // 2. Notion Companies, by the client id the register workflow stamps on.
    const fromNotion = await ctx.step("resolve-via-notion-client-id", async () => {
      try {
        const res = await sdk.fetch(
          `${NOTION_API}/data_sources/${COMPANIES_DS}/query`,
          {
            connection: NOTION_CONNECTION,
            method: "POST",
            headers: {
              "Notion-Version": NOTION_VERSION,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              filter: {
                property: "Zapier Client Id",
                rich_text: { equals: lead.clientId },
              },
              page_size: 2,
            }),
          },
        );
        if (!res.ok) {
          console.log(
            `Companies query failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
          );
          return null;
        }
        const body = (await res.json()) as any;
        const results = Array.isArray(body?.results) ? body.results : [];
        // Two companies claiming one client id is a data problem, not something
        // to guess at.
        if (results.length !== 1) {
          if (results.length > 1) {
            console.log(
              `${results.length} companies carry client id ${lead.clientId}; not choosing between them`,
            );
          }
          return null;
        }
        return firstString(results[0]?.id);
      } catch (err) {
        console.log(
          `Companies query failed: ${String((err as Error)?.message ?? err)}`,
        );
        return null;
      }
    });
    if (fromNotion) {
      return { pageId: fromNotion, via: "notion-client-id", tableRecordId: null };
    }
  }

  // 3. The lead's email -> Contact -> Related Company. An adoption, so gated.
  if (!allowAdoption || !lead.email) return null;
  const fromContact = await ctx.step("resolve-via-contact-email", async () => {
    try {
      const found = await sdk.listTableRecords({
        table: CONTACT_EMAIL_TABLE,
        keyMode: "names",
        filters: [{ fieldKey: "Email", operator: "exact", value: lead.email }],
        pageSize: 1,
      });
      const contactPageId = firstString(
        (found.data?.[0]?.data as Record<string, any> | undefined)?.["Page ID"],
      );
      if (!contactPageId) return null;

      const res = await sdk.fetch(`${NOTION_API}/pages/${contactPageId}`, {
        connection: NOTION_CONNECTION,
        headers: { "Notion-Version": NOTION_VERSION },
      });
      if (!res.ok) {
        console.log(`Contact page read failed (${res.status})`);
        return null;
      }
      const page = (await res.json()) as any;
      const related = page?.properties?.["Related Company"]?.relation ?? [];
      // A contact linked to several companies gives no single answer.
      if (related.length !== 1) return null;
      return firstString(related[0]?.id);
    } catch (err) {
      console.log(
        `Contact-email resolution failed: ${String((err as Error)?.message ?? err)}`,
      );
      return null;
    }
  });
  if (fromContact) {
    return { pageId: fromContact, via: "contact-email", tableRecordId: null };
  }

  return null;
}

// --- Notion write ----------------------------------------------------------

/**
 * Build the Notion property patch for this lead.
 *
 * **Only fields the event actually carries are written.** The partner tool sends
 * a different subset per status — `expiration_date` on Approved and Expired,
 * `converted_date` and the payout windows only on Converted — so patching the
 * absent ones to null would wipe a lead's approval expiry the moment it
 * converted. Nothing here ever clears a value.
 */
function buildCompanyPatch(
  lead: LeadData,
  needsClientIdBackfill: boolean,
): Record<string, unknown> {
  const props: Record<string, unknown> = {};

  if (needsClientIdBackfill && lead.clientId) {
    props["Zapier Client Id"] = {
      rich_text: [{ type: "text", text: { content: lead.clientId } }],
    };
  }
  if (lead.leadId) {
    props["Referral Lead Id"] = {
      rich_text: [{ type: "text", text: { content: lead.leadId } }],
    };
  }
  if (lead.status) {
    props["Zapier Lead Status"] = { select: { name: lead.status } };
  }
  if (lead.reason) {
    props["Zapier Lead Status Reason"] = {
      rich_text: [{ type: "text", text: { content: lead.reason } }],
    };
  }
  if (lead.expirationDate) {
    props["Zapier Lead Expires"] = { date: { start: lead.expirationDate } };
  }
  if (lead.convertedDate) {
    props["Zapier Lead Converted On"] = { date: { start: lead.convertedDate } };
  }
  if (lead.commission !== null) {
    props["Zapier Commission %"] = { number: lead.commission };
  }
  // Notion date ranges need both ends; a start without an end is a single date.
  if (lead.payoutY1Start) {
    props["Zapier Payout Year 1"] = {
      date: {
        start: lead.payoutY1Start,
        end: lead.payoutY1End || null,
      },
    };
  }
  if (lead.payoutY2Start) {
    props["Zapier Payout Year 2"] = {
      date: {
        start: lead.payoutY2Start,
        end: lead.payoutY2End || null,
      },
    };
  }

  return props;
}

/** Post a comment on the company page. Best-effort — never fails the run. */
async function addComment(
  ctx: DurableCtx,
  stepName: string,
  pageId: string,
  summary: string,
): Promise<void> {
  await ctx.step(stepName, async () => {
    try {
      const res = await sdk.fetch(`${NOTION_API}/comments`, {
        connection: NOTION_CONNECTION,
        method: "POST",
        headers: {
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          parent: { page_id: pageId },
          rich_text: [{ type: "text", text: { content: summary } }],
        }),
      });
      if (!res.ok) {
        console.log(`Failed to add comment (${res.status}): ${await res.text()}`);
      }
      return { commented: res.ok };
    } catch (err) {
      console.log(
        `Failed to add comment: ${String((err as Error)?.message ?? err)}`,
      );
      return { commented: false };
    }
  });
}

// --- Workflow --------------------------------------------------------------

const workflow = defineDurable<Record<string, unknown>, unknown>(
  "zapier-partner-lead-status-to-notion",
  async (ctx, rawInput) => {
    const lead = extractLeadData(normalizeInput(rawInput));

    console.log(
      `Lead ${lead.leadId || "?"} (client ${lead.clientId || "?"}) -> ` +
        `${lead.rawStatus || "no status"}`,
    );

    // Without a client id or an email there is nothing to resolve against.
    if (!lead.clientId && !lead.email) {
      return {
        skipped: true,
        reason: "payload carried neither a client id nor an email",
        leadId: lead.leadId,
      };
    }

    // An untracked lead is only adopted into the CRM at a status that says it
    // matters — see ADOPTION_STATUSES. A tracked one is always written.
    const allowAdoption = ADOPTION_STATUSES.includes(lead.status);

    const resolved = await resolveCompanyPage(ctx, lead, allowAdoption);
    if (!resolved) {
      // A permanent condition for this event. Return rather than throw:
      // retrying can't change the answer, and the lead is reconsidered on its
      // next status change (or when the backfill script replays it).
      const reason = allowAdoption
        ? "no matching Notion company (not in the lead table, no company carries this client id, and the lead email resolves to no single company)"
        : `not adopted — this lead isn't tracked in the CRM and its status (${lead.rawStatus || "unknown"}) isn't one that earns adoption (${ADOPTION_STATUSES.join(", ")})`;
      console.log(`${reason} — lead ${lead.leadId} (${lead.email})`);
      return {
        skipped: true,
        reason,
        adoptionBlocked: !allowAdoption,
        leadId: lead.leadId,
        clientId: lead.clientId,
        email: lead.email,
        status: lead.rawStatus,
      };
    }

    if (!lead.status && lead.rawStatus) {
      console.log(
        `Unrecognised lead status "${lead.rawStatus}" — every other field will ` +
          `be written, the select left alone`,
      );
    }

    // 1. Patch the company record. The client id is backfilled whenever this
    //    lead was resolved by something other than an existing mapping, so the
    //    next event for it takes the cheap path.
    const patch = buildCompanyPatch(lead, resolved.via !== "lead-table");
    await ctx.step("patch-company-page", async () => {
      if (Object.keys(patch).length === 0) return { patched: [] };
      const res = await sdk.fetch(`${NOTION_API}/pages/${resolved.pageId}`, {
        connection: NOTION_CONNECTION,
        method: "PATCH",
        headers: {
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ properties: patch }),
      });
      if (!res.ok) {
        throw new Error(
          `Notion page PATCH failed (${res.status}): ${(await res.text()).slice(0, 300)}`,
        );
      }
      return { patched: Object.keys(patch) };
    });

    // 2. Keep the lead Table current, so the next status change for this lead
    //    resolves in one free lookup. An existing row has its Status refreshed
    //    — the classic Zap never wrote back here, which is why that column was
    //    null on every row it created.
    await ctx.step("sync-lead-table", async () => {
      try {
        if (resolved.tableRecordId) {
          await sdk.updateTableRecords({
            table: LEAD_TABLE,
            keyMode: "names",
            records: [
              {
                id: resolved.tableRecordId,
                data: {
                  Status: lead.status || lead.rawStatus,
                  Success: true,
                },
              },
            ],
          });
          return { table: "updated" as const };
        }
        // Resolved by a fallback path: index it, so this lead stops costing a
        // Notion query (or a two-hop contact lookup) on every status change.
        await sdk.createTableRecords({
          table: LEAD_TABLE,
          keyMode: "names",
          records: [
            {
              data: {
                "Notion Company Page ID": resolved.pageId,
                "Client Id": lead.clientId,
                "Client Email": lead.email,
                "Client First Name": lead.firstName,
                "Client Last Name": lead.lastName,
                "Client Name": lead.name,
                "Client Contact": lead.partnerContact,
                Status: lead.status || lead.rawStatus,
                Success: true,
              },
            },
          ],
        });
        return { table: "created" as const };
      } catch (err) {
        // The Notion record — the thing a human reads — is already correct. A
        // Table write failure only costs the next event a slower lookup, so log
        // it rather than retry the whole run.
        console.log(
          `Lead table sync failed: ${String((err as Error)?.message ?? err)}`,
        );
        return { table: "failed" as const };
      }
    });

    // 3. A fallback match is a link this workflow inferred rather than one the
    //    register workflow recorded, so it gets said out loud on the page for a
    //    human to sanity-check. Routine status changes stay silent.
    if (resolved.via !== "lead-table") {
      const how =
        resolved.via === "notion-client-id"
          ? `its Zapier Client Id \`${lead.clientId}\``
          : `the lead's email ${lead.email} (matched to this company's contact)`;
      const summary =
        `Linked to Zapier partner lead \`${lead.leadId}\` (client ` +
        `\`${lead.clientId}\`, status ${lead.status || lead.rawStatus}) via ${how}. ` +
        `Lead details written to the Zapier fields on this record.` +
        (resolved.via === "contact-email"
          ? ` This company was adopted into Zapier lead tracking because the lead reached ${lead.status}.`
          : "");
      await addComment(ctx, "comment-fallback-match", resolved.pageId, summary);
    }

    return {
      leadId: lead.leadId,
      clientId: lead.clientId,
      pageId: resolved.pageId,
      resolvedVia: resolved.via,
      adopted: resolved.via === "contact-email",
      status: lead.status || null,
      rawStatus: lead.rawStatus,
      unknownStatus: !lead.status && Boolean(lead.rawStatus),
      written: Object.keys(patch),
    };
  },
);

export default workflow;
