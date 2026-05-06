/**
 * [Sub-Zap] Retrieve Contact Page IDs for Email Addresses
 *
 * Single Code-by-Zapier step that replaces the original 24-node sub-zap.
 * Runs inside Run JavaScript with the @zapier/zapier-sdk toggle ON and
 * connections attached for: Notion (var: notion) and ChatGPT/OpenAI (var: openai).
 * Zapier Tables is built-in and does not require a connection.
 *
 * Input Data fields (mapped in the Zap UI):
 *   to, from, cc        -- raw email-header strings from the calling Zap
 *
 * Returns:
 *   { page_ids: "<comma-separated Notion page IDs>" }
 */

const ZAPIER_TABLE_ID = "01JYEPSEARXB2Z6BJRCMFGXBC2";
const NOTION_DATA_SOURCE_ID = "21991b07-11ac-81a6-a894-000be4a09a67";
const NEW_CONTACT_CAP = 10;

const INTERNAL_DOMAIN = "@work.flowers";
const EMAIL_BLOCKLIST = new Set([
  "meeting.room@knoxxfoods.com",
  "team_awesome@knoxxfoods.com",
  "messaging-service@post.xero.com",
]);
const SUBSTRING_BLOCKLIST = [
  "@zapiermail.com",
  "@resource.calendar.google.com",
  "support",
  "billing",
  "contact",
];

const TABLE_FIELD_EMAIL = "data__f3";
const TABLE_FIELD_PAGE_ID = "data__f2";
const TABLE_NEW_FIELD_EMAIL = "new__data__f3";
const TABLE_NEW_FIELD_PAGE_ID = "new__data__f2";

const OPENAI_MODEL = "gpt-5-mini";
const CLASSIFIER_INSTRUCTIONS = `You are an email classifier. Given an email address, determine whether it belongs to a real individual person or a service/organisational account.Return only a raw JSON object with no markdown, explanation, or preamble:
{"is_individual": true} or {"is_individual": false}Classify as false (service/organisational) if the address contains prefixes such as:

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

const EMAIL_REGEX = /[\w.+-]+@[\w-]+\.[\w.-]+/;

function extractAddresses(field) {
  return (field || "")
    .split(",")
    .map((entry) => {
      const m = entry.match(EMAIL_REGEX);
      return m ? m[0].toLowerCase() : null;
    })
    .filter(Boolean);
}

function isExternal(email) {
  if (email.endsWith(INTERNAL_DOMAIN)) return false;
  if (EMAIL_BLOCKLIST.has(email)) return false;
  for (const fragment of SUBSTRING_BLOCKLIST) {
    if (email.includes(fragment)) return false;
  }
  return true;
}

function dedupeExternal(to, from, cc) {
  const all = [...extractAddresses(to), ...extractAddresses(from), ...extractAddresses(cc)];
  return [...new Set(all.filter(isExternal))];
}

async function lookupExisting(zapier, emails) {
  const { data } = await zapier.runAction({
    appKey: "TableCLIAPI",
    actionType: "search",
    actionKey: "find_record",
    inputs: {
      table_id: ZAPIER_TABLE_ID,
      filter_count: "1",
      use_stored_order: false,
      field_data_key: TABLE_FIELD_EMAIL,
      operator: "in",
      lookup_value: emails,
      _zap_search_success_on_miss: true,
      _zap_search_multiple_results: "group",
    },
  });

  const map = new Map();
  if (!data) return map;
  const rows = Array.isArray(data) ? data : [data];
  for (const row of rows) {
    const grouped = row?.["results[]old"] ?? row?.results ?? row;
    if (!grouped) continue;
    const emailField = grouped?.data?.f3;
    const pageField = grouped?.data?.f2;
    const emailList = Array.isArray(emailField) ? emailField : [emailField].filter(Boolean);
    const pageList = Array.isArray(pageField) ? pageField : [pageField].filter(Boolean);
    emailList.forEach((email, i) => {
      if (!email) return;
      const pageId = pageList[i] ?? pageList[0];
      if (pageId) map.set(String(email).toLowerCase(), String(pageId));
    });
  }
  return map;
}

async function classifyIsIndividual(zapier, connectionId, email) {
  const { data } = await zapier.runAction({
    appKey: "ChatGPTCLIAPI",
    actionType: "write",
    actionKey: "conversation_responses_api",
    connectionId,
    inputs: {
      model: OPENAI_MODEL,
      instructions: CLASSIFIER_INSTRUCTIONS,
      user_message: email,
      response_format: "json_object",
      max_tokens: 200,
    },
  });

  const raw = data?.response ?? data?.output_text ?? data?.text ?? data?.message ?? "";
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed?.is_individual === true;
  } catch {
    return false;
  }
}

async function createNotionContact(zapier, connectionId, email) {
  const { data } = await zapier.runAction({
    appKey: "NotionCLIAPI",
    actionType: "write",
    actionKey: "create_database_item",
    connectionId,
    inputs: {
      datasource: NOTION_DATA_SOURCE_ID,
      "properties|||Primary Email|||email": email,
    },
  });
  return data?.id ?? data?.page_id ?? data?.url?.split("-").pop() ?? null;
}

async function writeTableRow(zapier, email, pageId) {
  await zapier.runAction({
    appKey: "TableCLIAPI",
    actionType: "write",
    actionKey: "create_record",
    inputs: {
      table_id: ZAPIER_TABLE_ID,
      [TABLE_NEW_FIELD_EMAIL]: email,
      [TABLE_NEW_FIELD_PAGE_ID]: pageId,
    },
  });
}

export default async function main({ inputData }) {
  const filtered = dedupeExternal(inputData.to, inputData.from, inputData.cc);
  if (filtered.length === 0) return { page_ids: "" };

  const existingMap = await lookupExisting(zapier, filtered);
  const existingPageIds = filtered.map((e) => existingMap.get(e)).filter(Boolean);

  const newEmails = filtered.filter((e) => !existingMap.has(e)).slice(0, NEW_CONTACT_CAP);
  if (newEmails.length === 0) {
    return { page_ids: existingPageIds.join(",") };
  }

  const openaiConnectionId = connections["openai"];
  const notionConnectionId = connections["notion"];
  const newlyCreatedPageIds = [];

  for (const email of newEmails) {
    try {
      const isIndividual = await classifyIsIndividual(zapier, openaiConnectionId, email);
      if (!isIndividual) continue;

      const pageId = await createNotionContact(zapier, notionConnectionId, email);
      if (!pageId) {
        console.log(`No page id returned for ${email}`);
        continue;
      }
      newlyCreatedPageIds.push(pageId);

      try {
        await writeTableRow(zapier, email, pageId);
      } catch (err) {
        console.log(`Table row write failed for ${email}: ${err?.message || err}`);
      }
    } catch (err) {
      console.log(`Processing ${email} failed: ${err?.message || err}`);
    }
  }

  return { page_ids: [...existingPageIds, ...newlyCreatedPageIds].join(",") };
}
