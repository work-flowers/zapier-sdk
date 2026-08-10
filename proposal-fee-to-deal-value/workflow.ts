// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/proposal-fee-to-deal-value
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
const NOTION_CONNECTION = "notion_wf"; // work.flowers workspace connection
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

// --- Notion property names ----------------------------------------------------
// The SOURCE page arrives only via the webhook payload: the database it lives
// in is not shared with the Zapier integration (no visible data source carries
// a "Project Fee" property), so unlike this repo's other Notion durables the
// trigger snapshot cannot be re-read and IS the input. The Deals write-back
// side uses the normal re-readable page.
const SOURCE_FEE_PROP = "Project Fee";
const SOURCE_DEAL_PROPS = ["Deal", "Deals"]; // accept either relation spelling
const DEAL_VALUE_PROP = "Value";

const InputSchema = z.unknown();
type Input = Record<string, unknown>;
type Outcome = Record<string, unknown>;

// --- Helpers ------------------------------------------------------------------

function normalizeInput(rawInput: unknown): unknown {
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

function firstString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function dashUuid(id: string): string {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (hex.length !== 32) return id.trim();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** True when the payload carries no event at all — see repo CLAUDE.md,
 *  "A webhook-triggered durable must SKIP on an empty payload". */
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

function relationIds(prop: unknown): string[] {
  const rel = (prop as any)?.relation;
  if (!Array.isArray(rel)) return [];
  return rel
    .map((r: any) => firstString(r?.id))
    .filter((id) => id.length > 0)
    .map(dashUuid);
}

/** The page snapshot inside a Notion automation payload ({ data: {...} }),
 *  or the payload itself when it already looks like a page. */
function extractPage(raw: unknown): Record<string, any> | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, any>;
  if (o.data && typeof o.data === "object" && o.data.properties) return o.data;
  if (o.properties) return o;
  return null;
}

// --- Workflow -----------------------------------------------------------------

const workflow = defineDurable<Input, unknown>(
  "proposal-fee-to-deal-value",
  async (ctx: DurableContext, rawInput: Input) => {
    const payload = normalizeInput(InputSchema.parse(rawInput));

    if (isEmptyPing(payload)) {
      console.log("empty payload — treating as a ping of the catch URL, not an event");
      return { skipped: "empty-payload" } satisfies Outcome;
    }

    const page = extractPage(payload);
    if (!page) {
      // Content we cannot read as a page snapshot is a real event whose shape
      // we failed to understand — loud, per repo convention.
      throw new Error(
        `Payload carries content but no page snapshot: ${JSON.stringify(payload).slice(0, 400)}`,
      );
    }

    const props = page.properties ?? {};
    const sourcePageId = firstString(page.id) ? dashUuid(firstString(page.id)) : null;

    const dealProp = SOURCE_DEAL_PROPS.map((name) => props[name]).find((p) => p != null);
    const feeProp = props[SOURCE_FEE_PROP];

    if (dealProp === undefined && feeProp === undefined) {
      // Neither property is present at all: the sending automation's source
      // database no longer matches what this workflow understands.
      throw new Error(
        `Payload page ${sourcePageId ?? "?"} carries neither "${SOURCE_DEAL_PROPS.join('"/"')}" nor ` +
          `"${SOURCE_FEE_PROP}" — the source database's shape has changed. Properties seen: ` +
          JSON.stringify(Object.keys(props).slice(0, 30)),
      );
    }

    const dealId = relationIds(dealProp)[0] ?? null;
    if (!dealId) {
      // Same as the classic Zap's "Related Deal Exists" filter.
      return { skipped: "no-deal-linked", sourcePageId } satisfies Outcome;
    }

    const fee = typeof feeProp?.number === "number" ? feeProp.number : null;
    if (fee === null) {
      // An empty fee must never blank the deal's Value — skip, don't write.
      return { skipped: "fee-is-empty", sourcePageId, dealId } satisfies Outcome;
    }

    // Write the fee to the deal's Value. PATCHing the page directly avoids the
    // Notion action's stale schema cache, same as this repo's other durables.
    await ctx.step("write-deal-value", async () => {
      const res = await sdk.fetch(`${NOTION_API}/pages/${dealId}`, {
        connection: NOTION_CONNECTION,
        method: "PATCH",
        headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
        body: JSON.stringify({
          properties: { [DEAL_VALUE_PROP]: { number: fee } },
        }),
      });
      if (!res.ok) {
        throw new Error(
          `Notion write of ${DEAL_VALUE_PROP}=${fee} to deal ${dealId} failed (${res.status}): ${await res.text()}`,
        );
      }
      return res.json();
    });

    console.log(`set deal ${dealId} ${DEAL_VALUE_PROP} = ${fee} (from ${sourcePageId ?? "unknown source page"})`);

    return { updated: true, dealId, value: fee, sourcePageId } satisfies Outcome;
  },
);

export default workflow;
