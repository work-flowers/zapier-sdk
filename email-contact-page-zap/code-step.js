import { createZapierSdk } from "@zapier/zapier-sdk";

const zapier = createZapierSdk();

/**
 * [Sub-Zap] Retrieve Contact Page IDs for Email Addresses
 *
 * Single Code-by-Zapier step that replaces the original 24-node sub-zap.
 * Runs inside Run JavaScript with the @zapier/zapier-sdk toggle ON and
 * a connection attached for Notion (Account ID Variable: notion).
 * Zapier Tables and AI by Zapier are built-in and do not need connections;
 * AI by Zapier uses plan-included credentials (authentication_id "0").
 *
 * Input Data fields (mapped in the Zap UI):
 *   to, from, cc        -- raw email-header strings from the calling Zap
 *
 * Returns:
 *   { page_ids: "<comma-separated Notion page IDs>" }
 */

const ZAPIER_TABLE_ID = "01JYEPSEARXB2Z6BJRCMFGXBC2";
const BLOCKLIST_TABLE_ID = "01KQY6RB1TJ9X7BAYBRRRKB35S";
const BLOCKLIST_PATTERN_FIELD = "data__f1";
const BLOCKLIST_MATCH_TYPE_FIELD = "data__f2";
const NOTION_DATA_SOURCE_ID = "21991b07-11ac-81a6-a894-000be4a09a67";
const NEW_CONTACT_CAP = 10;

const INTERNAL_DOMAIN = "@work.flowers";

const TABLE_FIELD_EMAIL = "data__f3";
const TABLE_FIELD_PAGE_ID = "data__f2";
const TABLE_NEW_FIELD_EMAIL = "new__data__f3";
const TABLE_NEW_FIELD_PAGE_ID = "new__data__f2";

const AI_PROVIDER_ID = "openai";
const AI_MODEL_ID = "openai/gpt-5-mini";
const AI_AUTHENTICATION_ID = "0"; // "Included in Plan" — no API key needed
const CLASSIFIER_INSTRUCTIONS = `You are an email classifier. The "Emails" input contains one or more email addresses, one per line. For EACH email address in the list, classify whether it belongs to a real individual person or a service/organisational account, and produce one output object per input email. Preserve the original casing of the email in the Email output field.

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

function isExternal(email, { exact, substrings }) {
  if (email.endsWith(INTERNAL_DOMAIN)) return false;
  if (exact.has(email)) return false;
  for (const fragment of substrings) {
    if (email.includes(fragment)) return false;
  }
  return true;
}

function dedupeExternal(to, from, cc, blocklist) {
  const all = [...extractAddresses(to), ...extractAddresses(from), ...extractAddresses(cc)];
  return [...new Set(all.filter((e) => isExternal(e, blocklist)))];
}

async function loadBlocklist(zapier) {
  const { data } = await zapier.runAction({
    appKey: "TableCLIAPI",
    actionType: "search",
    actionKey: "find_record",
    inputs: {
      table_id: BLOCKLIST_TABLE_ID,
      filter_count: "1",
      use_stored_order: false,
      field_data_key: BLOCKLIST_MATCH_TYPE_FIELD,
      operator: "in",
      lookup_value: ["exact", "substring"],
      _zap_search_success_on_miss: true,
      _zap_search_multiple_results: "group",
    },
  });

  const exact = new Set();
  const substrings = [];
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  for (const row of rows) {
    const recordData = row?.old?.data ?? row?.new?.data ?? row?.data;
    if (!recordData) continue;
    const pattern = recordData.f1;
    const matchTypeRaw = recordData.f2;
    const matchType =
      typeof matchTypeRaw === "object" ? matchTypeRaw?.value : matchTypeRaw;
    if (!pattern || !matchType) continue;
    const normalised = String(pattern).toLowerCase();
    if (matchType === "exact") exact.add(normalised);
    else if (matchType === "substring") substrings.push(normalised);
  }
  console.log(
    `Loaded blocklist: ${exact.size} exact, ${substrings.length} substring`
  );
  return { exact, substrings };
}

async function lookupExisting(zapier, emails) {
  console.log(`Looking up ${emails.length} email(s):`, emails);
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

  console.log("find_record raw response:", JSON.stringify(data));
  const map = new Map();
  if (!data) return map;
  const rows = Array.isArray(data) ? data : [data];
  for (const row of rows) {
    const recordData = row?.old?.data ?? row?.new?.data ?? row?.data;
    if (!recordData) continue;
    const email = recordData.f3;
    const pageId = recordData.f2;
    if (email && pageId) {
      map.set(String(email).toLowerCase(), String(pageId));
    }
  }
  return map;
}

async function classifyBatch(zapier, emails) {
  const { data } = await zapier.runAction({
    appKey: "AICLIAPI",
    actionType: "write",
    actionKey: "get_completion",
    inputs: {
      provider_id: AI_PROVIDER_ID,
      authentication_id: AI_AUTHENTICATION_ID,
      model_id: AI_MODEL_ID,
      instructions: CLASSIFIER_INSTRUCTIONS,
      inputFields: { Emails: emails.join("\n") },
      outputSchema: {
        Email: "The email address being classified, copied verbatim from the input.",
        "Is Individual":
          "Indicates whether the email address belongs to a real individual person (true) or a service/organisational account (false).",
        Rationale: "Brief reasoning for the classification.",
      },
      required_Email: true,
      type_Email: "text",
      "required_Is Individual": true,
      "type_Is Individual": "boolean",
      required_Rationale: true,
      type_Rationale: "text",
      isOutputArray: true,
    },
  });

  console.log("AI batch raw response:", JSON.stringify(data));
  const outer = Array.isArray(data) ? data : data ? [data] : [];
  // AI by Zapier wraps array outputs under `result` when isOutputArray=true,
  // so flatten one level if present.
  const items = outer.flatMap((entry) =>
    Array.isArray(entry?.result) ? entry.result : [entry]
  );
  const individuals = new Set();
  for (const item of items) {
    const verdict = item?.["Is Individual"];
    if (verdict === true || verdict === "true") {
      const email = String(item?.Email ?? "").toLowerCase().trim();
      if (email) individuals.add(email);
    }
  }
  return individuals;
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
  console.log(`Notion create raw response for ${email}:`, JSON.stringify(data));
  const root = Array.isArray(data) ? data[0] : data;
  return root?.id ?? root?.page_id ?? null;
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
  const blocklist = await loadBlocklist(zapier);
  const filtered = dedupeExternal(inputData.to, inputData.from, inputData.cc, blocklist);
  if (filtered.length === 0) return { page_ids: "" };

  const existingMap = await lookupExisting(zapier, filtered);
  const existingPageIds = filtered.map((e) => existingMap.get(e)).filter(Boolean);

  const newEmails = filtered.filter((e) => !existingMap.has(e)).slice(0, NEW_CONTACT_CAP);
  if (newEmails.length === 0) {
    return { page_ids: existingPageIds.join(",") };
  }

  const notionConnectionId = connections["notion"];

  const individuals = await classifyBatch(zapier, newEmails);
  const toCreate = newEmails.filter((e) => individuals.has(e));

  const results = await Promise.allSettled(
    toCreate.map(async (email) => {
      const pageId = await createNotionContact(zapier, notionConnectionId, email);
      if (!pageId) {
        console.log(`No page id returned for ${email}`);
        return null;
      }

      try {
        await writeTableRow(zapier, email, pageId);
      } catch (err) {
        console.log(`Table row write failed for ${email}: ${err?.message || err}`);
      }
      return pageId;
    })
  );

  const newlyCreatedPageIds = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      if (r.value) newlyCreatedPageIds.push(r.value);
    } else {
      console.log(`Processing ${toCreate[i]} failed: ${r.reason?.message || r.reason}`);
    }
  });

  return { page_ids: [...existingPageIds, ...newlyCreatedPageIds].join(",") };
}
