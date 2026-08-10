// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/notion-contact-to-newsletter-subscriber
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

const NOTION_CONNECTION = "notion_wf";
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

const BUTTONDOWN_APP_KEY = "ButtondownCLIAPI";
const BUTTONDOWN_CONNECTION = "buttondown_wf";

// Email property on the Contacts data source.
const CONTACT_EMAIL_PROP = "Primary Email";

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
 * A Notion button property posts `{ data: { id, properties, ... } }`;
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
 * A catch hook is a public URL, and a Notion **button property** in particular
 * delivers an empty body every time someone tests it while wiring it up. Those
 * are pings, not events, and failing the run on them means a Zapier error alert
 * for something that never happened.
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

// --- Workflow -----------------------------------------------------------------

export default defineDurable<Input>(
  "notion-contact-to-newsletter-subscriber",
  async (ctx, rawInput) => {
    const payload = normalizeInput(rawInput);

    // Guard first, before any id extraction — see isEmptyPing above.
    if (isEmptyPing(payload)) {
      console.log("empty payload — treating as a ping of the catch URL, not an event");
      return { skipped: "empty-payload" } satisfies Outcome;
    }

    const contactPageId = extractPageId(payload);

    // Never trust the payload snapshot — the address may have been edited in the
    // same breath as the click. Re-read the page.
    const contact = await ctx.step("fetch-contact-page", async () => {
      const res = await sdk.fetch(`${NOTION_API}/pages/${contactPageId}`, {
        connection: NOTION_CONNECTION,
        headers: { "Notion-Version": NOTION_VERSION },
      });
      if (!res.ok) {
        throw new Error(
          `Notion get page ${contactPageId} failed (${res.status}): ${await res.text()}`,
        );
      }
      const page = (await res.json()) as any;
      // Reduce inside the step: a Notion contact page is large (bio, cover,
      // every relation) and checkpointing the whole thing buys nothing.
      return {
        archived: Boolean(page?.archived || page?.in_trash),
        email: firstString(page?.properties?.[CONTACT_EMAIL_PROP]?.email)
          .trim()
          .toLowerCase(),
      };
    });

    if (contact.archived) {
      return { skipped: "contact-page-archived", contactPageId } satisfies Outcome;
    }

    const email = contact.email;

    // The classic Zap's "Primary Email Populated" filter. Clicking the button on
    // a contact with no address is a real event with nothing to do — skip, don't
    // raise.
    if (!email) {
      console.log(
        `Contact ${contactPageId} has no ${CONTACT_EMAIL_PROP} — nothing to subscribe, skipping.`,
      );
      return { skipped: "no-primary-email", contactPageId } satisfies Outcome;
    }

    // Look before writing. Buttondown answers a re-subscribe with "This
    // subscriber was blocked by your firewall" — indistinguishable from a
    // genuine firewall refusal of a brand-new address, and retrying it five
    // times cannot change the verdict. Checking first removes the ambiguity: a
    // known address short-circuits here, so any refusal further down is real
    // and deserves to fail loudly. A miss returns `{data: []}`, not an error.
    const existing = await ctx.step("check-existing-subscriber", async () => {
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
        contactPageId,
        email,
        alreadySubscribed: true,
        subscriberId: existing.subscriberId,
      } satisfies Outcome;
    }

    const created = await ctx.step("subscribe-to-buttondown", async () => {
      try {
        const res = await sdk.runAction({
          appKey: BUTTONDOWN_APP_KEY,
          actionType: "write",
          actionKey: "subscriber",
          connection: BUTTONDOWN_CONNECTION,
          inputs: { email, automatically_activate: true },
        });
        return { subscriberId: (res.data?.[0] as any)?.id ?? null };
      } catch (err) {
        // Narrow race window only: the deal-won sibling Zap can subscribe the
        // same address between the check above and this write. Anything else —
        // including a real firewall refusal — throws.
        const msg = String((err as Error)?.message ?? err);
        if (!/already exists|already subscribed|duplicate/i.test(msg)) throw err;
        console.log(`${email} was subscribed by another run mid-flight — treating as done.`);
        return { subscriberId: null, raced: true };
      }
    });

    return { contactPageId, email, subscribed: true, ...created } satisfies Outcome;
  },
);
