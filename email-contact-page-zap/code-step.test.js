import assert from "node:assert/strict";
import { test } from "node:test";

const codeStepUrl = new URL("./code-step.js", import.meta.url);

async function loadMain({ existingByEmail = {}, classifyAs = () => true, notionPageIds = {}, captureCalls } = {}) {
  globalThis.connections = { openai: "openai-conn", notion: "notion-conn" };

  const calls = { findRecord: [], createNotion: [], createTableRow: [], classify: [] };
  if (captureCalls) Object.assign(captureCalls, calls);

  globalThis.zapier = {
    async runAction({ appKey, actionType, actionKey, inputs, connectionId }) {
      if (appKey === "TableCLIAPI" && actionKey === "find_record") {
        calls.findRecord.push(inputs);
        const lookup = inputs.lookup_value;
        const matchedEmails = [];
        const matchedPageIds = [];
        for (const e of lookup) {
          if (existingByEmail[e]) {
            matchedEmails.push(e);
            matchedPageIds.push(existingByEmail[e]);
          }
        }
        if (matchedEmails.length === 0) return { data: null };
        return {
          data: [
            { "results[]old": { data: { f3: matchedEmails, f2: matchedPageIds } } },
          ],
        };
      }
      if (appKey === "ChatGPTCLIAPI" && actionKey === "conversation_responses_api") {
        calls.classify.push({ inputs, connectionId });
        const email = inputs.user_message;
        const verdict = classifyAs(email);
        return { data: { response: JSON.stringify({ is_individual: verdict, rationale: "test" }) } };
      }
      if (appKey === "NotionCLIAPI" && actionKey === "create_database_item") {
        calls.createNotion.push({ inputs, connectionId });
        const email = inputs["properties|||Primary Email|||email"];
        return { data: { id: notionPageIds[email] || `page-for-${email}` } };
      }
      if (appKey === "TableCLIAPI" && actionKey === "create_record") {
        calls.createTableRow.push(inputs);
        return { data: { id: "row" } };
      }
      throw new Error(`Unexpected runAction call: ${appKey} ${actionType} ${actionKey}`);
    },
  };

  const mod = await import(`${codeStepUrl.href}?t=${Date.now()}_${Math.random()}`);
  return mod.default;
}

test("returns empty when input is all-internal", async () => {
  const main = await loadMain();
  const result = await main({
    inputData: { to: "alice@work.flowers", from: "bob@work.flowers", cc: "" },
  });
  assert.equal(result.page_ids, "");
});

test("returns existing page IDs when all emails already exist, no Notion writes", async () => {
  const calls = {};
  const main = await loadMain({
    existingByEmail: { "alice@example.com": "page-a", "bob@example.com": "page-b" },
    captureCalls: calls,
  });
  const result = await main({
    inputData: { to: "Alice <alice@example.com>", from: "bob@example.com", cc: "" },
  });
  assert.equal(result.page_ids, "page-a,page-b");
  assert.equal(calls.createNotion.length, 0);
  assert.equal(calls.classify.length, 0);
  assert.equal(calls.createTableRow.length, 0);
});

test("creates Notion + Table row for new individual emails, returns combined page IDs", async () => {
  const calls = {};
  const main = await loadMain({
    existingByEmail: { "known@example.com": "page-known" },
    classifyAs: () => true,
    notionPageIds: { "new@example.com": "page-new" },
    captureCalls: calls,
  });
  const result = await main({
    inputData: { to: "known@example.com, new@example.com", from: "", cc: "" },
  });
  assert.equal(result.page_ids, "page-known,page-new");
  assert.equal(calls.createNotion.length, 1);
  assert.equal(calls.createTableRow.length, 1);
  assert.equal(calls.createTableRow[0].new__data__f3, "new@example.com");
  assert.equal(calls.createTableRow[0].new__data__f2, "page-new");
});

test("skips emails the AI classifies as non-individual", async () => {
  const calls = {};
  const main = await loadMain({
    classifyAs: (email) => !email.startsWith("info@"),
    captureCalls: calls,
  });
  const result = await main({
    inputData: { to: "info@example.com, jane.doe@example.com", from: "", cc: "" },
  });
  assert.equal(calls.classify.length, 2);
  assert.equal(calls.createNotion.length, 1);
  assert.equal(calls.createNotion[0].inputs["properties|||Primary Email|||email"], "jane.doe@example.com");
  assert.match(result.page_ids, /^page-for-jane\.doe@example\.com$/);
});

test("substring blocklist drops support/billing/contact addresses before AI", async () => {
  const calls = {};
  const main = await loadMain({ captureCalls: calls });
  const result = await main({
    inputData: {
      to: "support@vendor.com, billing@vendor.com, contact@vendor.com, real.person@vendor.com",
      from: "",
      cc: "",
    },
  });
  assert.equal(calls.classify.length, 1);
  assert.equal(calls.classify[0].inputs.user_message, "real.person@vendor.com");
  assert.match(result.page_ids, /real\.person/);
});

test("caps new contact creation at 10 even when more new emails arrive", async () => {
  const calls = {};
  const many = Array.from({ length: 15 }, (_, i) => `person${i}@vendor.com`).join(", ");
  const main = await loadMain({ classifyAs: () => true, captureCalls: calls });
  const result = await main({ inputData: { to: many, from: "", cc: "" } });
  assert.equal(calls.createNotion.length, 10);
  assert.equal(result.page_ids.split(",").filter(Boolean).length, 10);
});

test("a single failing Notion call does not abort the batch", async () => {
  const calls = {};
  const main = await loadMain({ captureCalls: calls });
  const originalRunAction = globalThis.zapier.runAction;
  globalThis.zapier.runAction = async (args) => {
    if (
      args.appKey === "NotionCLIAPI" &&
      args.inputs["properties|||Primary Email|||email"] === "broken@vendor.com"
    ) {
      throw new Error("notion exploded");
    }
    return originalRunAction(args);
  };
  const result = await main({
    inputData: { to: "broken@vendor.com, working@vendor.com", from: "", cc: "" },
  });
  assert.match(result.page_ids, /working/);
  assert.doesNotMatch(result.page_ids, /broken/);
});
