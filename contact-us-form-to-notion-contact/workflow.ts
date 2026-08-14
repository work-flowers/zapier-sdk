// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/contact-us-form-to-notion-contact
import { defineDurable, type DurableContext } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings ----------------------------------------------------------------
const NOTION_APP_KEY = "NotionCLIAPI";
const NOTION_CONNECTION = "notion_wf"; // work.flowers workspace connection
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

/** "Contacts" data source in the work.flowers CRM. */
const CONTACTS_DS = "21991b07-11ac-81a6-a894-000be4a09a67";
/** Email → contact-page-id map, owned by contact-emails-to-zapier-table. */
const CONTACT_EMAIL_TABLE = "01JYEPSEARXB2Z6BJRCMFGXBC2";
/** Dennis — Owner on contacts this form creates. */
const OWNER_PERSON_ID = "121d872b-594c-810b-ba5a-000206eeef1e";
const LEAD_SOURCE = "Contact Us";

/** Zapier Forms field ids on the "Contact Us" form (form cmgftzun0001zu2hlecmqnz3d).
 *  The trigger delivers answers keyed by these ids in `values`. */
const F_FIRST_NAME = "cmgftzuof0025u2hl56jygp0u";
const F_LAST_NAME = "cmggbzl3j000g3b6sw9n2oxid";
const F_EMAIL = "cmgfu0k5800013b6siwlm7w7e";
const F_JOB_TITLE = "cmgfu15th00033b6sdovbx68e";
const F_LINKEDIN = "cmgfu3w8900053b6slu04msul";
const F_MAILING_LIST = "cmgfu1dqb00043b6sm1dkhasq";
const F_MESSAGE_1 = "cmgfu47jf00063b6s2cz23zhl";
const F_MESSAGE_2 = "cmgfu5piz00073b6s19mkdswl";

const InputSchema = z.unknown();

/** `defineDurable`'s input generic is constrained to an object type, so the
 *  loose runtime shapes (wrapper keys, a double-encoded body) are handled by
 *  `normalizeInput` / `extractSubmission` rather than by the type. */
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

function firstString(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c.trim();
  }
  return "";
}

function truthy(v: unknown): boolean {
  if (v === true) return true;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "yes" || s === "on" || s === "1" || s === "checked";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function plainText(rich: unknown): string {
  return (Array.isArray(rich) ? rich : [])
    .map((t: any) => t?.plain_text ?? "")
    .join("")
    .trim();
}

type Submission = {
  firstName: string;
  lastName: string;
  email: string; // lowercased; "" when absent or invalid
  jobTitle: string;
  linkedin: string;
  mailingList: boolean;
  message: string; // both message fields, joined
  createdAt: string; // ISO from the form submission; "" when absent
};

function extractSubmission(raw: unknown): Submission | null {
  const o = (raw ?? {}) as Record<string, any>;
  const values =
    (typeof o.values === "object" && o.values) ||
    (typeof o.body === "object" && typeof o.body?.values === "object" && o.body.values) ||
    null;
  if (!values) return null;
  const rawEmail = firstString(values[F_EMAIL]).toLowerCase();
  return {
    firstName: firstString(values[F_FIRST_NAME]),
    lastName: firstString(values[F_LAST_NAME]),
    email: EMAIL_RE.test(rawEmail) ? rawEmail : "",
    jobTitle: firstString(values[F_JOB_TITLE]),
    linkedin: firstString(values[F_LINKEDIN]),
    mailingList: truthy(values[F_MAILING_LIST]),
    message: [firstString(values[F_MESSAGE_1]), firstString(values[F_MESSAGE_2])]
      .filter((s) => s !== "")
      .join("\n\n"),
    createdAt: firstString(o.createdAt, o.body?.createdAt),
  };
}

async function readPage(pageId: string): Promise<any | null> {
  const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
    connection: NOTION_CONNECTION,
    headers: { "Notion-Version": NOTION_VERSION },
  });
  if (!res.ok) {
    console.log(`Notion get page ${pageId} failed (${res.status}): ${await res.text()}`);
    return null;
  }
  return res.json();
}

async function patchPage(pageId: string, properties: Record<string, unknown>) {
  const res = await sdk.fetch(`${NOTION_API}/pages/${pageId}`, {
    connection: NOTION_CONNECTION,
    method: "PATCH",
    headers: {
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) {
    throw new Error(`Notion patch page failed (${res.status}): ${await res.text()}`);
  }
}

/** Post a comment on a page. Best-effort — never fails the run. */
async function postComment(pageId: string, text: string): Promise<boolean> {
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
        rich_text: [{ type: "text", text: { content: text.slice(0, 1900) } }],
      }),
    });
    if (!res.ok) {
      console.log(`Failed to add comment (${res.status}): ${await res.text()}`);
    }
    return res.ok;
  } catch (err) {
    console.log(`Failed to add comment: ${String((err as Error)?.message ?? err)}`);
    return false;
  }
}

/** Create a data-source item applying its default template (repo rule 5),
 *  falling back to a plain create only when Notion reports there is none.
 *  The catch lives INSIDE the step so a template miss doesn't spin retries. */
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
  const first = Array.isArray(created?.res?.data) ? created.res.data[0] : null;
  return {
    pageId: firstString(first?.id) || null,
    usedTemplate: Boolean(created?.usedTemplate),
  };
}

// --- Workflow ------------------------------------------------------------------
const workflow = defineDurable<Input, unknown>(
  "contact-us-form-to-notion-contact",
  async (ctx: DurableContext, rawInput: Input) => {
    const payload = normalizeInput(InputSchema.parse(rawInput));
    const sub = extractSubmission(payload);
    if (!sub) {
      throw new Error(
        "No form `values` in trigger payload: " + JSON.stringify(payload).slice(0, 300),
      );
    }

    const title =
      [sub.firstName, sub.lastName].filter((s) => s !== "").join(" ") ||
      (sub.email ? sub.email.split("@")[0] : "");
    if (!title && !sub.email) {
      // A submission with no name and no usable email can't become a contact.
      throw new Error(
        "Submission carries neither a name nor a valid email: " +
          JSON.stringify(payload).slice(0, 300),
      );
    }

    // 1. Resolve through the email Table (the repo's identity oracle — a blind
    //    create here is what feeds the duplicate-merge loop). No email → no
    //    lookup; the classic Zap created unconditionally, so we still create.
    const existing = await ctx.step("contact-via-email-table", async () => {
      if (!sub.email) return null;
      try {
        const found = await sdk.listTableRecords({
          table: CONTACT_EMAIL_TABLE,
          keyMode: "names",
          filters: [{ fieldKey: "Email", operator: "exact", value: sub.email }],
          pageSize: 1,
        });
        return (
          firstString((found.data?.[0]?.data as Record<string, any>)?.["Page ID"]) || null
        );
      } catch (err) {
        console.log(
          `Contact email lookup failed: ${String((err as Error)?.message ?? err)}`,
        );
        return null;
      }
    });

    // 2a. Existing contact: fill blanks only — someone curated those fields, a
    //     web form did not. The message lands in Note when Note is empty,
    //     otherwise as a page comment so nothing is overwritten.
    if (existing) {
      const result = await ctx.step("contact-fill-blanks", async () => {
        const page = await readPage(existing);
        if (!page) return { filled: [] as string[], commented: false, archived: false };
        if (page.archived || page.in_trash) {
          console.log(`contact ${existing} is in the trash — leaving it alone`);
          return { filled: [] as string[], commented: false, archived: true };
        }
        const props = page.properties ?? {};
        const patch: Record<string, unknown> = {};

        if (sub.firstName && plainText(props["First Name"]?.rich_text) === "") {
          patch["First Name"] = {
            rich_text: [{ type: "text", text: { content: sub.firstName } }],
          };
        }
        if (sub.lastName && plainText(props["Last Name"]?.rich_text) === "") {
          patch["Last Name"] = {
            rich_text: [{ type: "text", text: { content: sub.lastName } }],
          };
        }
        if (sub.jobTitle && plainText(props["Job Title"]?.rich_text) === "") {
          patch["Job Title"] = {
            rich_text: [{ type: "text", text: { content: sub.jobTitle } }],
          };
        }
        if (sub.linkedin && !props["Linkedin"]?.url) {
          patch["Linkedin"] = { url: sub.linkedin };
        }
        // Opt-in only ever ticks — unticking is the unsubscribe flow's job.
        if (sub.mailingList && props["Mailing List"]?.checkbox !== true) {
          patch["Mailing List"] = { checkbox: true };
        }
        // Lead Source records how we FIRST met someone; an existing value is
        // the earlier truth. Same for First Contacted.
        if (!props["Lead Source"]?.select) {
          patch["Lead Source"] = { select: { name: LEAD_SOURCE } };
        }
        if (sub.createdAt && !props["First Contacted"]?.date) {
          patch["First Contacted"] = { date: { start: sub.createdAt } };
        }
        let commented = false;
        if (sub.message) {
          if (plainText(props["Note"]?.rich_text) === "") {
            patch["Note"] = {
              rich_text: [{ type: "text", text: { content: sub.message } }],
            };
          } else {
            commented = await postComment(
              existing,
              `Contact Us form submission:\n\n${sub.message}`,
            );
          }
        }

        if (Object.keys(patch).length > 0) await patchPage(existing, patch);
        return { filled: Object.keys(patch), commented, archived: false };
      });
      return {
        via: "email-table",
        contactPageId: existing,
        email: sub.email,
        ...result,
      };
    }

    // 2b. New contact, from the Contacts default template (repo rule 5).
    const props: Record<string, unknown> = {
      "properties|||Name|||title": title || sub.email,
      "properties|||Lead Source|||select": LEAD_SOURCE,
      "properties|||Owner|||people": [OWNER_PERSON_ID],
    };
    if (sub.email) props["properties|||Primary Email|||email"] = sub.email;
    if (sub.firstName) props["properties|||First Name|||rich_text"] = sub.firstName;
    if (sub.lastName) props["properties|||Last Name|||rich_text"] = sub.lastName;
    if (sub.jobTitle) props["properties|||Job Title|||rich_text"] = sub.jobTitle;
    if (sub.linkedin) props["properties|||Linkedin|||url"] = sub.linkedin;
    if (sub.mailingList) props["properties|||Mailing List|||checkbox"] = true;
    if (sub.message) props["properties|||Note|||rich_text"] = sub.message;
    if (sub.createdAt) {
      props["properties|||First Contacted|||date__start"] = sub.createdAt;
    }

    const created = await createItemWithTemplate(ctx, "contact", CONTACTS_DS, props);
    if (!created.pageId) {
      throw new Error("Contact creation returned no page id");
    }

    // 3. Index the new address immediately so a second submission from the
    //    same person resolves to this contact instead of creating another.
    //    contact-emails-to-zapier-table treats "row -> this page" as a no-op.
    if (sub.email) {
      const newPageId = created.pageId;
      await ctx.step("index-contact-email", async () => {
        try {
          await sdk.createTableRecords({
            table: CONTACT_EMAIL_TABLE,
            keyMode: "names",
            records: [
              {
                data: {
                  Email: sub.email,
                  "Page ID": newPageId,
                  Type: "Primary",
                  "Trigger Contact Creation": false,
                },
              },
            ],
          });
          return { indexed: true };
        } catch (err) {
          console.log(
            `Contact email indexing failed: ${String((err as Error)?.message ?? err)}`,
          );
          return { indexed: false };
        }
      });
    }

    return {
      via: "created",
      contactPageId: created.pageId,
      usedTemplate: created.usedTemplate,
      email: sub.email,
      title: title || sub.email,
    };
  },
);

export default workflow;
