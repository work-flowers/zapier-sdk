// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/sow-signed-to-deal-won
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
const NOTION_APP_KEY = "NotionCLIAPI";
const NOTION_CONNECTION = "notion_wf"; // work.flowers workspace connection
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

/** "SOWs" data source — the trigger automation lives on it. */
const SOWS_DS = "07e4d8c1-24f2-44a8-ae9b-24628ee4a21b";
/** "Deals" data source — where the win is recorded. */
const DEALS_DS = "21a91b07-11ac-808d-9657-000b1390d20b";
/** The deal's lifecycle end-state once its SOW is signed. Upstream,
 *  esignatures-send-for-signing sets "In signing" when the SOW goes out. */
const DEAL_WON_STATUS = "Closed Won";

const InputSchema = z.unknown();

/** `defineDurable`'s input generic is constrained to an object type, so the
 *  loose runtime shapes (wrapper keys, a double-encoded body) are handled by
 *  `normalizeInput` / `extractPageId` rather than by the type. */
type Input = Record<string, unknown>;

// --- Helpers -----------------------------------------------------------------
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

function firstString(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c.trim();
  }
  return "";
}

function dashUuid(id: string): string {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return id;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function extractPageId(raw: unknown): string {
  const o = (raw ?? {}) as Record<string, any>;
  const body = (typeof o.body === "object" && o.body) || o;
  return dashUuid(
    firstString(
      body.data?.id,
      o.data?.id,
      body.page_id,
      o.page_id,
      body.entity?.id,
      o.entity?.id,
      body.id,
      o.id,
    ),
  );
}

// --- Workflow ------------------------------------------------------------------
const workflow = defineDurable<Input, unknown>(
  "sow-signed-to-deal-won",
  async (ctx: DurableContext, rawInput: Input) => {
    const payload = normalizeInput(InputSchema.parse(rawInput));

    if (isEmptyPing(payload)) {
      console.log("empty payload — treating as a ping of the catch URL, not an event");
      return { skipped: "empty-payload" };
    }

    const sowPageId = extractPageId(payload);
    if (!sowPageId) {
      throw new Error(
        "No SOW page id in webhook payload: " + JSON.stringify(payload).slice(0, 300),
      );
    }

    // Never trust the webhook snapshot — the Deal relation may have changed by
    // the time this runs, and the payload shape may not carry it at all.
    const sow = await ctx.step("fetch-sow-page", async () => {
      const res = await sdk.fetch(`${NOTION_API}/pages/${sowPageId}`, {
        connection: NOTION_CONNECTION,
        headers: { "Notion-Version": NOTION_VERSION },
      });
      if (!res.ok) {
        throw new Error(`Notion get page failed (${res.status}): ${await res.text()}`);
      }
      const p: any = await res.json();
      const props = p.properties ?? {};
      return {
        archived: Boolean(p.archived || p.in_trash),
        dataSourceId: dashUuid(
          firstString(p.parent?.data_source_id, p.parent?.database_id),
        ),
        dealIds: ((props["Deal"]?.relation ?? []) as any[])
          .map((rel) => dashUuid(firstString(rel?.id)))
          .filter((s) => s !== ""),
        title: ((props["Agreement Name"]?.title ?? props["Name"]?.title ?? []) as any[])
          .map((t) => t?.plain_text ?? "")
          .join(""),
      };
    });

    if (sow.archived) {
      console.log(`SOW ${sowPageId} is archived/trashed — skipping`);
      return { skipped: "sow-archived", sowPageId };
    }
    if (sow.dataSourceId && sow.dataSourceId !== SOWS_DS) {
      console.log(
        `page ${sowPageId} belongs to data source ${sow.dataSourceId}, not SOWs — skipping`,
      );
      return { skipped: "not-a-sow", sowPageId, dataSourceId: sow.dataSourceId };
    }
    if (!sow.dealIds.length) {
      // Normal, not an error — not every SOW hangs off a deal (parity with the
      // classic Zap's "Related Deal Exists" filter).
      console.log(`SOW ${sowPageId} has no Deal relation — nothing to mark won`);
      return { skipped: "no-deal-relation", sowPageId };
    }

    // One SOW, one deal — matching esignatures-send-for-signing, which advances
    // dealIds[0] to "In signing". Extra relations are surfaced, not written.
    const dealId = sow.dealIds[0];
    if (sow.dealIds.length > 1) {
      console.log(
        `SOW ${sowPageId} has ${sow.dealIds.length} Deal relations — updating only ${dealId}`,
      );
    }

    await ctx.step("mark-deal-won", async () =>
      sdk.runAction({
        appKey: NOTION_APP_KEY,
        actionType: "write",
        actionKey: "update_database_item",
        connection: NOTION_CONNECTION,
        inputs: {
          datasource: DEALS_DS,
          page: dealId,
          "properties|||Status|||status": DEAL_WON_STATUS,
        },
      }),
    );

    return {
      sowPageId,
      sowTitle: sow.title,
      dealId,
      status: DEAL_WON_STATUS,
      extraDealIds: sow.dealIds.slice(1),
    };
  },
);

export default workflow;
