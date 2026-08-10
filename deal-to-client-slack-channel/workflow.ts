// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/deal-to-client-slack-channel
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
const NOTION_CONNECTION = "notion_wf"; // work.flowers workspace connection
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

const SLACK_APP_KEY = "SlackCLIAPI";
const SLACK_CONNECTION = "slack_wf";

const AI_APP_KEY = "AICLIAPI";
const AI_AUTHENTICATION = "0"; // Zapier's built-in AI credentials
const AI_MODEL = "standard/auto"; // 1x task cost; naming a channel needs no more

// [Table] Internal User IDs — Notion user id (f6) -> Slack user id (f3).
// Zapier Tables need no connection.
const USER_IDS_TABLE = "01JM3J9SG5X6S8GBSSC8AS28AT";

/** Dennis creates the channel through his own Slack connection, so inviting
 *  him would fail with already_in_channel. Skip the invite when he owns the
 *  deal. Value: Internal User IDs table, dennis@work.flowers -> f6. */
const DENNIS_NOTION_USER_ID = "121d872b-594c-810b-ba5a-000206eeef1e";

// --- Notion property names ----------------------------------------------------
const DEAL_TITLE_PROP = "Deal Name";
const DEAL_COMPANY_PROP = "Company";
const DEAL_OWNER_PROP = "Owner";

const COMPANY_TITLE_PROP = "Company Name";
const COMPANY_SLACK_ID_PROP = "Slack Channel ID";
// "Slack Channel" on Companies is now a FORMULA that renders the URL from
// Slack Channel ID, so the id write below is the only write needed. (The
// classic Zap still wrote an empty string to a long-gone url property.)

// Prompt lives in deal-to-client-slack-channel-prompt.md (repo rule 6).
// Edit the markdown, then `node scripts/check-prompts.mjs --fix`.
const CHANNEL_NAME_PROMPT = `Generate a short Slack channel name for the company named in the input fields.

Rules:
1. Include the prefix "deal-" at the start.
2. Strip common company suffixes like Inc, LLC, Ltd, Corp, Co., Pte. Ltd., etc.
3. Use only lowercase letters and hyphens.
4. Keep the whole name under 20 characters.
5. Make it concise and memorable.`;

const OUTPUT_FIELDS = [
  {
    name: "Slack Channel Name",
    description:
      "The generated short, readable Slack channel name with 'deal-' prefix and common suffixes removed.",
    type: "text",
    isRequired: true,
  },
];

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

function plainText(rich: unknown): string {
  if (!Array.isArray(rich)) return "";
  return rich
    .map((r: any) => firstString(r?.plain_text) || firstString(r?.text?.content))
    .join("")
    .trim();
}

function relationIds(prop: unknown): string[] {
  const rel = (prop as any)?.relation;
  if (!Array.isArray(rel)) return [];
  return rel
    .map((r: any) => firstString(r?.id))
    .filter((id) => id.length > 0)
    .map(dashUuid);
}

function peopleIds(prop: unknown): string[] {
  const people = (prop as any)?.people;
  if (!Array.isArray(people)) return [];
  return people
    .map((p: any) => firstString(p?.id))
    .filter((id) => id.length > 0)
    .map(dashUuid);
}

/** Pull the Notion page id out of whatever the trigger delivered. */
function extractPageId(raw: unknown): string {
  if (!raw) throw new Error("No input provided to workflow.");
  if (typeof raw === "string") return dashUuid(raw.trim());
  const o = raw as Record<string, any>;
  const candidate =
    o.pageId ||
    o.page_id ||
    (o.data && (o.data.id || o.data.page_id)) ||
    o.id ||
    (o.page && o.page.id) ||
    o["data.id"];
  const id = firstString(candidate).trim();
  if (!id) {
    throw new Error(`Could not find a Notion page id in the payload: ${JSON.stringify(raw).slice(0, 400)}`);
  }
  return dashUuid(id);
}

/**
 * True when the payload carries no event at all — an empty POST or a bare GET
 * of the catch URL. Pasting the URL into a Notion automation, hitting "test",
 * or curling it all deliver a body like `{"querystring":{}}`. Those are pings,
 * not events. A payload that DOES carry content but no page id still throws,
 * loudly — that is a real event whose shape we failed to understand.
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

/** First item of a runAction result ({ data: [...] } or a bare array). */
function firstResult(res: unknown): any {
  const rows = (res as any)?.data;
  if (Array.isArray(rows)) return rows[0];
  return Array.isArray(res) ? (res as any[])[0] : res;
}

/** First row of a Tables search result, or null. `find_record` returns
 *  `{ data: [] }` on a miss — not a row of nulls. Hits wrap the row as
 *  `{ new, old, ... }`; searches carry it under `old`. */
function firstTableRow(res: unknown): Record<string, any> | null {
  const rows = (res as any)?.data;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return (rows[0]?.old ?? rows[0]?.new ?? rows[0]) as Record<string, any>;
}

/** Slack channel id out of the new_channel result ({ channel: { id } }). */
function extractChannelId(res: unknown): string {
  const row = firstResult(res);
  return firstString(row?.channel?.id) || firstString(row?.id);
}

// --- Workflow -----------------------------------------------------------------

const workflow = defineDurable<Input, unknown>(
  "deal-to-client-slack-channel",
  async (ctx: DurableContext, rawInput: Input) => {
    const payload = normalizeInput(InputSchema.parse(rawInput));

    if (isEmptyPing(payload)) {
      console.log("empty payload — treating as a ping of the catch URL, not an event");
      return { skipped: "empty-payload" } satisfies Outcome;
    }

    const dealPageId = extractPageId(payload);

    // 1. Never trust the payload's property values — the automation delivers a
    //    snapshot that may be stale by the time this runs. Re-read the deal.
    const dealPage = await ctx.step("fetch-deal-page", async () => {
      const res = await sdk.fetch(`${NOTION_API}/pages/${dealPageId}`, {
        connection: NOTION_CONNECTION,
        headers: { "Notion-Version": NOTION_VERSION },
      });
      if (!res.ok) {
        throw new Error(`Notion get deal ${dealPageId} failed (${res.status}): ${await res.text()}`);
      }
      return res.json();
    });

    if ((dealPage as any)?.archived || (dealPage as any)?.in_trash) {
      return { skipped: "deal-page-archived", dealPageId } satisfies Outcome;
    }

    const dealProps = (dealPage as any)?.properties ?? {};
    const dealName = plainText(dealProps[DEAL_TITLE_PROP]?.title);
    const companyId = relationIds(dealProps[DEAL_COMPANY_PROP])[0] ?? null;
    const ownerId = peopleIds(dealProps[DEAL_OWNER_PROP])[0] ?? null;

    if (!companyId) {
      return { skipped: "deal-has-no-company", dealPageId, deal: dealName } satisfies Outcome;
    }

    // 2. The company page carries both the channel guard and the name.
    const companyPage = await ctx.step("fetch-company-page", async () => {
      const res = await sdk.fetch(`${NOTION_API}/pages/${companyId}`, {
        connection: NOTION_CONNECTION,
        headers: { "Notion-Version": NOTION_VERSION },
      });
      if (!res.ok) {
        throw new Error(`Notion get company ${companyId} failed (${res.status}): ${await res.text()}`);
      }
      return res.json();
    });

    const companyProps = (companyPage as any)?.properties ?? {};
    const companyName = plainText(companyProps[COMPANY_TITLE_PROP]?.title);
    const existingChannelId = plainText(companyProps[COMPANY_SLACK_ID_PROP]?.rich_text);

    // 3. Idempotence guard, carried over from the classic Zap's Table lookup.
    //    Read straight off the company page: the [Table] Company IDs copy is
    //    fed FROM this property by notion-companies-to-zapier-table, so the
    //    page is the fresher of the two and it is already in hand.
    if (existingChannelId) {
      return {
        skipped: "channel-already-exists",
        companyId,
        company: companyName,
        slackChannelId: existingChannelId,
      } satisfies Outcome;
    }

    if (!companyName) {
      return { skipped: "company-has-no-name", companyId } satisfies Outcome;
    }

    // 4. Let the model shorten the name; deterministically enforce the rules
    //    afterwards so a sloppy completion can't produce an invalid channel.
    const completion = await ctx.step("generate-channel-name", async () =>
      sdk.runAction({
        appKey: AI_APP_KEY,
        actionType: "write",
        actionKey: "get_completion",
        inputs: {
          provider_id: "",
          authentication_id: AI_AUTHENTICATION,
          model_id: AI_MODEL,
          isOutputArray: false,
          instructions: CHANNEL_NAME_PROMPT,
          inputFields: { "Company Name": companyName },
          outputFields: OUTPUT_FIELDS,
        },
      }),
    );

    const aiName = firstString(
      (firstResult(completion)?.result ?? firstResult(completion) ?? {})["Slack Channel Name"],
    );
    const channelName = normalizeChannelName(aiName || companyName);

    // 5. Create the channel. Slack rejects a duplicate name with
    //    name_taken — loud is right, since the guard above said we have no
    //    channel on record for this company.
    const created = await ctx.step("create-slack-channel", async () =>
      sdk.runAction({
        appKey: SLACK_APP_KEY,
        actionType: "write",
        actionKey: "new_channel",
        connection: SLACK_CONNECTION,
        inputs: { name: channelName },
      }),
    );

    const channelId = extractChannelId(created);
    if (!channelId) {
      throw new Error(
        `Created a Slack channel for "${companyName}" but could not read a channel id out of the ` +
          `result: ${JSON.stringify(firstResult(created)).slice(0, 300)}`,
      );
    }

    // 6. Write the id back so the guard has teeth on the next run. The
    //    "Slack Channel" formula property renders the URL from it, and
    //    notion-companies-to-zapier-table mirrors it into [Table] Company IDs.
    await ctx.step("write-channel-id-to-notion", async () => {
      const res = await sdk.fetch(`${NOTION_API}/pages/${companyId}`, {
        connection: NOTION_CONNECTION,
        method: "PATCH",
        headers: { "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
        body: JSON.stringify({
          properties: {
            [COMPANY_SLACK_ID_PROP]: { rich_text: [{ text: { content: channelId } }] },
          },
        }),
      });
      if (!res.ok) {
        throw new Error(
          `Notion write-back of ${COMPANY_SLACK_ID_PROP} to ${companyId} failed (${res.status}): ${await res.text()}`,
        );
      }
      return res.json();
    });

    // 7. Invite the deal owner — unless it is Dennis, whose connection created
    //    the channel and who is therefore already in it.
    let invite: string;
    if (!ownerId) {
      invite = "skipped-no-owner";
    } else if (ownerId === DENNIS_NOTION_USER_ID) {
      invite = "skipped-owner-is-dennis";
    } else {
      // Notion user id -> Slack user id via [Table] Internal User IDs. A miss
      // is a config gap (a teammate missing from the table), and silencing it
      // would hide the gap forever — throw, loudly.
      const ownerRow = await ctx.step("find-owner-slack-id", async () =>
        sdk.runAction({
          appKey: "TableCLIAPI",
          actionType: "search",
          actionKey: "find_record",
          inputs: {
            table_id: USER_IDS_TABLE,
            filter_count: "1",
            use_stored_order: false,
            field_data_key: "data__f6",
            operator: "exact",
            lookup_value: ownerId,
          },
        }),
      );
      const row = firstTableRow(ownerRow);
      const slackUserId = firstString(row?.data?.f3) || firstString(row?.data?.["Slack User ID"]);
      if (!slackUserId) {
        throw new Error(
          `Deal owner ${ownerId} has no Slack User ID in [Table] Internal User IDs (${USER_IDS_TABLE}) — ` +
            `channel ${channelId} was created but the owner was not invited. Add the mapping and replay.`,
        );
      }
      await ctx.step("invite-owner-to-channel", async () =>
        sdk.runAction({
          appKey: SLACK_APP_KEY,
          actionType: "write",
          actionKey: "channels_invite_v2",
          connection: SLACK_CONNECTION,
          inputs: { channel: channelId, users: [slackUserId] },
        }),
      );
      invite = `invited-${slackUserId}`;
    }

    console.log(
      `created Slack channel #${channelName} (${channelId}) for "${companyName}" from deal "${dealName}" — invite: ${invite}`,
    );

    return {
      created: true,
      companyId,
      company: companyName,
      dealPageId,
      deal: dealName,
      channelName,
      channelId,
      invite,
    } satisfies Outcome;
  },
);

/** Enforce the channel-name rules no matter what the model returned:
 *  lowercase, hyphens only, `deal-` prefix, under 20 characters. */
function normalizeChannelName(name: string): string {
  let n = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!n.startsWith("deal-")) n = `deal-${n.replace(/^deal-?/, "")}`;
  if (n.length > 20) n = n.slice(0, 20).replace(/-$/, "");
  return n;
}

export default workflow;
