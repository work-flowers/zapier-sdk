// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/deal-won-to-newsletter-subscriber
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

const NOTION_CONNECTION = "notion_wf";
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

const BUTTONDOWN_APP_KEY = "ButtondownCLIAPI";
const BUTTONDOWN_CONNECTION = "buttondown_wf";

// Rollup on the Deals data source that pulls the linked Contact's email through.
const DEAL_CONTACT_EMAIL_PROP = "Contact Email";

const InputSchema = z.unknown();

/** `defineDurable`'s input generic is constrained to an object type; the loose
 *  runtime shapes (a bare page id, a double-encoded body) are handled by
 *  `normalizeInput` / `extractPageId` rather than by the type. */
type Input = Record<string, unknown>;

type Outcome = Record<string, unknown>;

// --- Helpers ------------------------------------------------------------------

function normalizeInput(rawInput: unknown): unknown {
  // The trigger pipeline may deliver the body double-encoded; run-durable
  // delivers it single. Unwrap up to four times, and only when the string
  // actually looks like JSON.
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

/** Notion page ids reach us in dashed and undashed spellings depending on the
 *  source (webhook payload vs REST response). Compare and store dashed. */
function dashUuid(id: string): string {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (hex.length !== 32) return id.trim();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Pull the Notion page id out of whatever the trigger delivered.
 *
 * A Notion database automation posts `{ data: { id, properties, ... } }`;
 * `run-durable` / `trigger-workflow` take a bare id or `{ pageId }` so a run
 * can be replayed by hand.
 */
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
    throw new Error(
      `Could not find a Notion page id in the payload: ${JSON.stringify(raw).slice(0, 400)}`,
    );
  }
  return dashUuid(id);
}

/**
 * True when the payload carries no event at all — an empty POST or a bare GET
 * of the catch URL.
 *
 * A catch hook is a public URL: pasting it into a browser, curling it, or
 * hitting "test" while wiring up the Notion side all deliver a body like
 * `{"querystring":{}}`. Those are pings, not events, and failing the run on
 * them means a Zapier error alert every time someone touches the URL.
 *
 * A payload that DOES carry content but no page id is a different thing: a
 * real event we failed to understand. That still throws, loudly.
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

/** Every distinct address a rollup property carries, lowercased. */
function rollupEmails(prop: unknown): string[] {
  const rollup = (prop as any)?.rollup;
  const array = Array.isArray(rollup?.array) ? rollup.array : [];
  const seen = new Set<string>();
  for (const entry of array) {
    // A `show_original` rollup over an email property yields {type:"email", email}.
    // Some configurations surface the value as a rich_text run instead.
    const raw =
      firstString(entry?.email) ||
      firstString(entry?.rich_text?.[0]?.plain_text) ||
      firstString(entry?.title?.[0]?.plain_text);
    const email = raw.trim().toLowerCase();
    if (email) seen.add(email);
  }
  return [...seen];
}

// --- Workflow -----------------------------------------------------------------

export default defineDurable<Input>(
  "deal-won-to-newsletter-subscriber",
  async (ctx, rawInput) => {
    const payload = normalizeInput(rawInput);

    // Guard first, before any id extraction — see isEmptyPing above.
    if (isEmptyPing(payload)) {
      console.log("empty payload — treating as a ping of the catch URL, not an event");
      return { skipped: "empty-payload" } satisfies Outcome;
    }

    const dealPageId = extractPageId(payload);

    // Never trust the payload's property values: a database automation delivers
    // a snapshot that may already be stale, and a rollup in particular is
    // computed downstream of the relation that triggered this. Re-read the page.
    const deal = await ctx.step("fetch-deal-page", async () => {
      const res = await sdk.fetch(`${NOTION_API}/pages/${dealPageId}`, {
        connection: NOTION_CONNECTION,
        headers: { "Notion-Version": NOTION_VERSION },
      });
      if (!res.ok) {
        throw new Error(
          `Notion get page ${dealPageId} failed (${res.status}): ${await res.text()}`,
        );
      }
      const page = (await res.json()) as any;
      // Reduce inside the step: a Notion deal page is large and checkpointing
      // the whole thing buys nothing downstream.
      return {
        archived: Boolean(page?.archived || page?.in_trash),
        emails: rollupEmails(page?.properties?.[DEAL_CONTACT_EMAIL_PROP]),
      };
    });

    if (deal.archived) {
      return { skipped: "deal-page-archived", dealPageId } satisfies Outcome;
    }

    const emails = deal.emails;

    // The classic Zap's "Contact Email Populated" filter. A won deal whose
    // contact has no email on file is a real event with nothing to do — skip,
    // don't raise.
    if (emails.length === 0) {
      console.log(
        `Deal ${dealPageId} has no ${DEAL_CONTACT_EMAIL_PROP} — nothing to subscribe, skipping.`,
      );
      return { skipped: "no-contact-email", dealPageId } satisfies Outcome;
    }

    // Usually exactly one, but a deal can carry more than one contact and the
    // classic Zap would have flattened them into a single unusable string.
    //
    // Look before writing. Buttondown answers a re-subscribe with "This
    // subscriber was blocked by your firewall" — indistinguishable from a
    // genuine firewall refusal of a brand-new address, and retrying it five
    // times cannot change the verdict. Checking first removes the ambiguity: a
    // known address short-circuits, so any refusal further down is real and
    // deserves to fail loudly. A miss returns `{data: []}`, not an error.
    const results = await Promise.all(
      emails.map(async (email, index) => {
        const existing = await ctx.step(`check-existing-${index}`, async () => {
          const res = await sdk.runAction({
            appKey: BUTTONDOWN_APP_KEY,
            actionType: "search",
            actionKey: "subscriber",
            connection: BUTTONDOWN_CONNECTION,
            inputs: { email },
          });
          return { subscriberId: (res.data?.[0] as any)?.id ?? null };
        });

        if (existing.subscriberId) {
          console.log(`${email} is already a Buttondown subscriber — nothing to do.`);
          return {
            email,
            alreadySubscribed: true,
            subscriberId: existing.subscriberId,
          };
        }

        return ctx.step(`subscribe-${index}`, async () => {
          try {
            const res = await sdk.runAction({
              appKey: BUTTONDOWN_APP_KEY,
              actionType: "write",
              actionKey: "subscriber",
              connection: BUTTONDOWN_CONNECTION,
              inputs: { email, automatically_activate: true },
            });
            return {
              email,
              subscribed: true,
              subscriberId: (res.data?.[0] as any)?.id ?? null,
            };
          } catch (err) {
            // Narrow race window only: the button-side sibling Zap can subscribe
            // the same address between the check above and this write. Anything
            // else — including a real firewall refusal — throws.
            const msg = String((err as Error)?.message ?? err);
            if (!/already exists|already subscribed|duplicate/i.test(msg)) throw err;
            console.log(`${email} was subscribed by another run mid-flight — treating as done.`);
            return { email, subscribed: true, raced: true };
          }
        });
      }),
    );

    return { dealPageId, emails, results } satisfies Outcome;
  },
);
