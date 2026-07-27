// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/email-db-updates
import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

const sdk = createZapierSdk();

// --- Bindings --------------------------------------------------------------
// Connection aliases are resolved at run/publish time via --connections.
const NOTION_APP_KEY = "NotionCLIAPI";
const NOTION_CONNECTION = "notion_wf"; // work.flowers workspace connection
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

// Mail blocks are not exposed by the public Notion API (they come back as
// `unsupported`), so the page is fetched through Notion MCP via the
// "MCP Client by Zapier" app — the same route the Worker this replaces used.
// When the API adds mail-block support, fetchMailPageText should switch to
// blocks.children and this dependency goes away.
const MCP_CLIENT_APP_KEY = "App222157CLIAPI";
const MCP_CONNECTION = "notion_mcp";
const MCP_FETCH_TOOL = "notion-fetch";

// AI by Zapier on Zapier's built-in credentials ("0" = Included in Plan).
// Tier = task cost: standard 1x / advanced 3x / premium 5x per run. Standard is
// Zapier's recommended tier for classification, which is exactly this workload
// (individual vs. service email address). Verified cases live in the README —
// re-run them before changing tier.
const AI_APP_KEY = "AICLIAPI";
const AI_MODEL = "standard/auto";
const AI_AUTHENTICATION = "0";

// Zapier Tables (free ops, no connection).
// Email -> Contact page id, kept in sync by contact-emails-to-zapier-table.
// One row per address, Primary AND Secondary, lowercased.
const CONTACT_EMAIL_TABLE = "01JYEPSEARXB2Z6BJRCMFGXBC2";
// Address blocklist: rows of { Pattern, Match Type: exact | substring }.
const BLOCKLIST_TABLE = "01KQY6RB1TJ9X7BAYBRRRKB35S";

// Notion data sources.
const CONTACTS_DS = "21991b07-11ac-81a6-a894-000be4a09a67";

const INTERNAL_DOMAIN = "@work.flowers";

/** New Contact pages created per run, at most (parity with the Worker and the
 *  original contact-resolution sub-Zap). */
const NEW_CONTACT_CAP = 10;

// The mail block is populated asynchronously after page creation; the Worker
// waited up to ~90s in 10s intervals, so: one fetch, then up to 8 wait+fetch
// rounds. Each MCP fetch is a billed action call, so the count is deliberate.
const POLL_WAIT_SECONDS = 10;
const MAX_FETCH_ATTEMPTS = 9;

// The Notion DB automation delivers `{ data: { id, properties... } }`; manual
// runs may deliver a bare `{ pageId }`. Accept anything, extract defensively.
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
  if (res && Array.isArray(res.data)) return res.data[0] ?? null;
  if (Array.isArray(res)) return res[0] ?? null;
  return res ?? null;
}

function extractPageId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, any>;
  return (
    firstString(o.pageId, o.page_id, o.data?.id, o.source?.id, o.id) ?? null
  );
}

// --- Mail-block parsing (ported verbatim from the Worker's mailBlock.ts) ----

interface MailMetadata {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  /** ISO timestamp when parseable, otherwise "". */
  timestamp: string;
  /** True when the timestamp came from the page's own Date Received property. */
  dateFromProperties: boolean;
  messageId: string;
  threadId: string;
  /** Contact page ids already related to the page (set natively by Notion). */
  existingContactIds: string[];
}

const EMAIL_REGEX = /[\w.+-]+@[\w.-]+\.\w+/g;

/**
 * Depth-first search of an arbitrary runAction result for the enhanced-
 * markdown page text (the string containing the <page>/<mail> markup).
 */
function findPageText(value: unknown, depth = 0): string | null {
  if (depth > 6 || value == null) return null;
  if (typeof value === "string") {
    if (value.includes("<mail>") || value.includes("<page ")) {
      // The MCP tool may return the full JSON envelope as a string.
      try {
        const parsed = JSON.parse(value);
        return findPageText(parsed, depth + 1) ?? value;
      } catch {
        return value;
      }
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPageText(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) {
      const found = findPageText(item, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function extractField(body: string, fieldName: string): string {
  // Headers sit at the start of the block or immediately after a <br>;
  // requiring that boundary avoids matching "Cc:"/"To:" fragments buried
  // inside quoted reply chains or signatures.
  const regex = new RegExp(
    "(?:^|<br>)\\s*" + fieldName + ":\\s*(.+?)\\s*(?:<br>|$)",
    "i",
  );
  const match = body.match(regex);
  return match ? match[1].trim() : "";
}

function extractEmails(str: string): string[] {
  return (str.match(EMAIL_REGEX) || []).map((s) => s.toLowerCase());
}

function pageUrlToUuid(url: string): string | null {
  const m = url.match(/([0-9a-f]{32})\s*$/i);
  if (!m) return null;
  const h = m[1].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Parse email metadata out of the enhanced-markdown page text. Messages inside
 * <mail> are delimited by "---" separators (latest first); Gmail Thread ID and
 * Date Received come from the <properties> JSON outside the <mail> block.
 */
function parseMailMetadata(text: string): MailMetadata | null {
  const mailMatch = text.match(/<mail>([\s\S]*?)<\/mail>/);
  if (!mailMatch) return null;
  const mailBody = mailMatch[1];

  const messages = mailBody
    .split(/(?:<br>|\s)*-{3,}(?:<br>|\s)*/)
    .map((s) => s.trim())
    .filter(Boolean);
  const latest = messages[0] || mailBody;

  const fromRaw = extractField(latest, "From");
  const toRaw = extractField(latest, "To");
  const ccRaw = extractField(latest, "Cc");
  const subject = extractField(latest, "Subject");
  const messageId = extractField(latest, "MessageId");

  let threadId = "";
  let dateRaw = "";
  let existingContactIds: string[] = [];
  const propsMatch = text.match(/<properties>\s*([\s\S]*?)\s*<\/properties>/);
  if (propsMatch) {
    try {
      const props = JSON.parse(propsMatch[1]);
      threadId = props["Gmail Thread ID"] || "";
      dateRaw = props["date:Date Received:start"] || "";
      if (Array.isArray(props["Contacts"])) {
        existingContactIds = props["Contacts"]
          .map((url: unknown) => pageUrlToUuid(String(url)))
          .filter((id: string | null): id is string => Boolean(id));
      }
    } catch {
      // fall through to header-based date parsing
    }
  }
  const dateFromProperties = Boolean(dateRaw);
  if (!dateRaw) {
    dateRaw =
      extractField(latest, "Date") ||
      extractField(latest, "Sent") ||
      extractField(latest, "Timestamp");
  }

  let timestamp = "";
  if (dateRaw) {
    const parsed = new Date(dateRaw);
    if (!Number.isNaN(parsed.getTime())) timestamp = parsed.toISOString();
  }

  return {
    from: extractEmails(fromRaw)[0] ?? "",
    to: extractEmails(toRaw),
    cc: extractEmails(ccRaw),
    subject,
    timestamp,
    dateFromProperties,
    messageId,
    threadId,
    existingContactIds,
  };
}

// --- Blocklist ---------------------------------------------------------------

interface Blocklist {
  exact: string[];
  substrings: string[];
}

function isBlockedOrInternal(email: string, blocklist: Blocklist): boolean {
  if (email.endsWith(INTERNAL_DOMAIN)) return true;
  if (blocklist.exact.includes(email)) return true;
  return blocklist.substrings.some((fragment) => email.includes(fragment));
}

/** Lowercased, deduped external addresses, minus blocklisted ones. */
function dedupeExternal(emails: string[], blocklist: Blocklist): string[] {
  return [
    ...new Set(
      emails
        .map((e) => e.toLowerCase())
        .filter((e) => !isBlockedOrInternal(e, blocklist)),
    ),
  ];
}

// --- AI classifier -----------------------------------------------------------

/**
 * PROMPT SOURCE OF TRUTH: ./contact-classifier-prompt.md
 *
 * The markdown file is the reviewable copy and this literal must match its
 * "## Prompt" section verbatim (repo rule 6). `node scripts/check-prompts.mjs`
 * from the repo root fails the moment the two drift apart.
 */
const CONTACT_CLASSIFIER_PROMPT = `You are an email classifier. The "Emails" input contains one or more email addresses, one per line. For EACH email address in the list, classify whether it belongs to a real individual person or a service/organisational account, and produce one output object per input email. Preserve the original casing of the email in the Email output field.

Classify as false (service/organisational) if the address contains prefixes such as:

Generic roles: info, contact, hello, support, help, admin, administrator
No-reply patterns: noreply, no-reply, donotreply, do-not-reply
Team/group aliases: team, staff, crew, group, all, everyone
Operational: billing, accounts, finance, legal, hr, careers, jobs, recruiting, sales, marketing, press, media, pr
Technical: webmaster, postmaster, hostmaster, abuse, security, devops, it
Automated: bot, automated, notification, alerts, mailer, daemon
Classify as true (individual) if the address:

Appears to contain a personal name (e.g. john.smith@, jsmith@, j.doe@)
Uses a name with numbers that suggest a person (e.g. sarah92@)
Does not match any of the service patterns above

When uncertain, default to false. Include rationale for your decision in your output in a separate field.`;

/** Structured output, one object per input email (isOutputArray: true).
 *  Descriptions are kept in step with the wording in the prompt markdown. */
const CLASSIFIER_OUTPUT_FIELDS = [
  {
    name: "Email",
    description:
      "The email address being classified, copied verbatim from the input.",
    type: "text",
    isRequired: true,
  },
  {
    name: "Is Individual",
    description:
      "Whether the email address belongs to a real individual person (true) or a service/organisational account (false).",
    type: "boolean",
    isRequired: true,
  },
  {
    name: "Rationale",
    description: "Brief reasoning for the classification.",
    type: "text",
    isRequired: true,
  },
];

/** Rows of an isOutputArray completion ({ data: [{ result: { items } } ] }). */
function completionRows(res: any): any[] {
  const outer = Array.isArray(res?.data) ? res.data : res ? [res] : [];
  return outer.flatMap((entry: any) => {
    const result = entry?.result;
    if (Array.isArray(result?.items)) return result.items;
    if (Array.isArray(result)) return result;
    return [entry];
  });
}

/** Emails the classifier marked as belonging to a real individual. */
function individualEmails(rows: any[]): string[] {
  const out = new Set<string>();
  for (const row of rows) {
    const verdict = row?.["Is Individual"];
    if (verdict === true || String(verdict).toLowerCase() === "true") {
      const email = String(row?.Email ?? "").toLowerCase().trim();
      if (email) out.add(email);
    }
  }
  return [...out];
}

// --- Notion helpers ----------------------------------------------------------

/**
 * Create a Notion data source item, applying the data source's DEFAULT TEMPLATE
 * when one exists, so automation-created pages look like hand-made ones (repo
 * rule 5). `template_mode: "default"` THROWS on a data source with no default
 * template, so that one error is caught — inside the step, so a template miss
 * doesn't spin the durable's step-retry loop — and the create retried without
 * it. (Contacts has a default template: the blue user-circle icon.)
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
// Notion DB automation on the Emails data source ("page added" -> webhook) ->
// poll for the page's mail block via Notion MCP -> parse the latest message's
// headers -> resolve Contacts (Zapier Table lookup, AI-classify unknowns,
// create individuals) and internal users -> patch the page.
//
// Replaces the notion-worker-email-db-updates Notion Worker. Differences from
// the Worker, on purpose:
//  - Contact lookup goes through the email -> page-id Zapier Table
//    (CONTACT_EMAIL_TABLE) instead of querying the Contacts data source
//    directly. Table reads are free; the table carries one row per address
//    (Primary AND Secondary, lowercased), kept in sync by
//    contact-emails-to-zapier-table — the same resolution path the Luma guest
//    workflows use.
//  - New Contact pages apply the Contacts default template (repo rule 5); the
//    Worker created bare pages.
//  - New contacts are indexed into the Table immediately, so back-to-back
//    emails from the same new sender can't race the sync durable into
//    creating a duplicate contact.
//  - The classifier runs on AI by Zapier standard/auto (repo convention)
//    instead of openai/gpt-5-mini.
const workflow = defineDurable<Record<string, unknown>, unknown>(
  "email-db-updates",
  async (ctx, rawInput) => {
    const pageId = extractPageId(InputSchema.parse(normalizeInput(rawInput)));
    if (!pageId) {
      console.log("skipping: no pageId in webhook payload (empty/test delivery)");
      return { skipped: true, reason: "no pageId in webhook payload" };
    }

    console.log(`Processing Email page ${pageId}`);

    // 1. Poll for the mail block (populated asynchronously after creation).
    // Each MCP fetch is a billed action call; the wait between rounds is free.
    let pageText: string | null = null;
    for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt++) {
      const text = await ctx.step(`fetch-mail-${attempt}`, async () => {
        const res = await sdk.runAction({
          appKey: MCP_CLIENT_APP_KEY,
          actionType: "write",
          actionKey: "call_tool_as_create",
          connection: MCP_CONNECTION,
          inputs: {
            _tool_name: MCP_FETCH_TOOL,
            _tool_error: true,
            _tool_parse: true,
            id: pageId,
            include_transcript: false,
            include_discussions: false,
          },
        });
        return findPageText(res);
      });
      if (text && /<mail>[\s\S]*?<\/mail>/.test(text)) {
        pageText = text;
        break;
      }
      if (attempt < MAX_FETCH_ATTEMPTS - 1) {
        await ctx.wait(`poll-${attempt}`, POLL_WAIT_SECONDS);
      }
    }
    if (!pageText) {
      console.log(`No mail block found on ${pageId}; skipping.`);
      return { skipped: true, reason: "no mail block", pageId };
    }

    const meta = parseMailMetadata(pageText);
    if (!meta) {
      console.log(`Mail block on ${pageId} could not be parsed; skipping.`);
      return { skipped: true, reason: "mail block unparseable", pageId };
    }
    console.log(
      `Parsed mail: from=${meta.from} to=${meta.to.length} cc=${meta.cc.length} messageId=${meta.messageId}`,
    );

    const allEmails = [meta.from, ...meta.to, ...meta.cc].filter(Boolean);

    // 2. Internal users: lowercase email -> Notion user id, via users.list.
    const internalMap = await ctx.step("build-internal-user-map", async () => {
      const map: Record<string, string> = {};
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ page_size: "100" });
        if (cursor) query.set("start_cursor", cursor);
        const res = await sdk.fetch(`${NOTION_API}/users?${query.toString()}`, {
          connection: NOTION_CONNECTION,
          headers: { "Notion-Version": NOTION_VERSION },
        });
        if (!res.ok) {
          throw new Error(`Notion users.list failed: ${res.status} ${await res.text()}`);
        }
        const body: any = await res.json();
        for (const user of body.results ?? []) {
          if (user?.type === "person" && user.person?.email) {
            map[String(user.person.email).toLowerCase()] = user.id;
          }
        }
        cursor = body.has_more ? body.next_cursor : null;
      } while (cursor);
      return map;
    });
    const internalUserIds = [
      ...new Set(
        allEmails
          .map((e) => internalMap[e.toLowerCase()])
          .filter((id): id is string => Boolean(id)),
      ),
    ];

    // 3. Blocklist (Zapier Table; free read).
    const blocklist: Blocklist = await ctx.step("load-blocklist", async () => {
      const exact: string[] = [];
      const substrings: string[] = [];
      const res = await sdk.listTableRecords({
        table: BLOCKLIST_TABLE,
        keyMode: "names",
        pageSize: 100,
      });
      for (const row of res?.data ?? []) {
        const pattern = firstString(row?.data?.["Pattern"]);
        const matchTypeRaw = row?.data?.["Match Type"];
        const matchType =
          typeof matchTypeRaw === "object"
            ? firstString((matchTypeRaw as any)?.value)
            : firstString(matchTypeRaw);
        if (!pattern || !matchType) continue;
        const normalised = pattern.toLowerCase();
        if (matchType === "exact") exact.push(normalised);
        else if (matchType === "substring") substrings.push(normalised);
      }
      console.log(
        `Loaded blocklist: ${exact.length} exact, ${substrings.length} substring`,
      );
      return { exact, substrings };
    });

    const externalEmails = dedupeExternal(allEmails, blocklist);

    // 4. Resolve known addresses via the email -> page-id Table (free reads;
    // covers Primary and Secondary emails — one row per known address).
    const contactHits: Record<string, string | null> = await ctx.step(
      "find-contacts-in-table",
      async () => {
        const hits: Record<string, string | null> = {};
        for (const email of externalEmails) {
          const res = await sdk.listTableRecords({
            table: CONTACT_EMAIL_TABLE,
            keyMode: "names",
            filters: [{ fieldKey: "Email", operator: "exact", value: email }],
            pageSize: 1,
          });
          hits[email] = firstString(res?.data?.[0]?.data?.["Page ID"]) ?? null;
        }
        return hits;
      },
    );

    const existingPageIds = [
      ...new Set(
        externalEmails
          .map((e) => contactHits[e])
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const newEmails = externalEmails
      .filter((e) => !contactHits[e])
      .slice(0, NEW_CONTACT_CAP);

    // 5. Classify unknown addresses (individual vs. service) and create a
    // Contact page for each individual, indexed straight into the Table.
    const createdContacts: Array<{ email: string; pageId: string }> = [];
    let classifiedRows: any[] = [];
    if (newEmails.length > 0) {
      const completion = await ctx.step("classify-new-emails", async () =>
        sdk.runAction({
          appKey: AI_APP_KEY,
          actionType: "write",
          actionKey: "get_completion",
          inputs: {
            provider_id: "",
            authentication_id: AI_AUTHENTICATION,
            model_id: AI_MODEL,
            isOutputArray: true,
            instructions: CONTACT_CLASSIFIER_PROMPT,
            inputFields: { Emails: newEmails.join("\n") },
            outputFields: CLASSIFIER_OUTPUT_FIELDS,
          },
        }),
      );
      classifiedRows = completionRows(completion);
      const toCreate = newEmails.filter((e) =>
        individualEmails(classifiedRows).includes(e),
      );

      for (let i = 0; i < toCreate.length; i++) {
        const email = toCreate[i];
        // Contacts HAS a default template (blue user-circle icon), so the
        // created page matches hand-made ones. Parity with the Worker: the
        // page carries only Primary Email — no name is known at this point.
        const created = await createItemWithTemplate(ctx, `contact-${i}`, CONTACTS_DS, {
          "properties|||Primary Email|||email": email,
        });
        if (!created.pageId) {
          console.log(`Contact creation for ${email} returned no page id`);
          continue;
        }
        createdContacts.push({ email, pageId: created.pageId });

        // Index the new address immediately. contact-emails-to-zapier-table
        // will also index it off the Notion automation, but its upsert treats
        // "row -> this page" as a no-op — and waiting on its timing is what
        // would let back-to-back emails create duplicate contacts.
        // "Trigger Contact Creation" stays false: the contact already exists.
        const newPageId = created.pageId;
        await ctx.step(`index-contact-${i}`, async () => {
          try {
            await sdk.createTableRecords({
              table: CONTACT_EMAIL_TABLE,
              keyMode: "names",
              records: [
                {
                  data: {
                    Email: email,
                    "Page ID": newPageId,
                    Type: "Primary",
                    "Trigger Contact Creation": false,
                  },
                },
              ],
            });
            return { logged: "created" as const };
          } catch (err) {
            return {
              logged: "error" as const,
              error: String((err as Error)?.message ?? err),
            };
          }
        });
      }
    }

    // 6. Patch the Email page.
    const properties: Record<string, any> = {};
    if (meta.from) {
      properties["From"] = { email: meta.from };
    }
    if (meta.to.length > 0) {
      properties["To"] = { multi_select: meta.to.map((name) => ({ name })) };
    }
    if (meta.cc.length > 0) {
      properties["Cc"] = { multi_select: meta.cc.map((name) => ({ name })) };
    }
    // Notion sets Date Received itself on most pages; only fill it in when it
    // was missing and a date could be parsed from the mail headers.
    if (meta.timestamp && !meta.dateFromProperties) {
      properties["Date Received"] = { date: { start: meta.timestamp } };
    }
    if (meta.messageId) {
      properties["Gmail Message ID"] = {
        rich_text: [{ type: "text", text: { content: meta.messageId } }],
      };
    }
    const threadId = meta.threadId || meta.messageId;
    if (threadId) {
      properties["Gmail Thread ID"] = {
        rich_text: [{ type: "text", text: { content: threadId } }],
      };
    }

    // Merge with relations Notion may have set natively so we never drop them.
    const mergedContactIds = [
      ...new Set([
        ...meta.existingContactIds,
        ...existingPageIds,
        ...createdContacts.map((c) => c.pageId),
      ]),
    ];
    if (mergedContactIds.length > 0) {
      properties["Contacts"] = {
        relation: mergedContactIds.map((id) => ({ id })),
      };
    }

    if (internalUserIds.length > 0) {
      properties["Internal Recipients"] = {
        people: internalUserIds.map((id) => ({ id })),
      };
      // Deliberately overwritten with the internal recipients (parity with the
      // Worker and the original Zap) — this replaces any permission-group
      // default Notion put there.
      properties["Comment Access"] = {
        people: internalUserIds.map((id) => ({ id })),
      };
    }

    if (Object.keys(properties).length > 0) {
      await ctx.step("update-email-page", async () => {
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
          throw new Error(
            `Notion pages.update failed: ${res.status} ${await res.text()}`,
          );
        }
        return { ok: true };
      });
    } else {
      console.log(`Nothing to update on ${pageId}.`);
    }

    console.log(
      `Updated ${pageId}: contacts=${mergedContactIds.length} (existing=${meta.existingContactIds.length}, resolved=${existingPageIds.length}, created=${createdContacts.length}), internal=${internalUserIds.length}`,
    );

    return {
      pageId,
      from: meta.from,
      subject: meta.subject,
      messageId: meta.messageId,
      threadId,
      externalEmails,
      contactsExistingOnPage: meta.existingContactIds.length,
      contactsResolved: existingPageIds.length,
      contactsCreated: createdContacts,
      contactsTotal: mergedContactIds.length,
      internalRecipients: internalUserIds.length,
      newEmailsClassified: newEmails,
    };
  },
);

export default workflow;
