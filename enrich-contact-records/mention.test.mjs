// Offline assertions over the outcome-comment mention logic in workflow.ts —
// no Zapier calls, no credentials. Run with `npm test` from this directory.
//
// workflow.ts can't be imported directly (createZapierSdk() and defineDurable()
// run at module load), so this harness stubs those imports, appends a test
// export, strips the types with the local tsc, and imports the emitted JS. The
// stubbed sdk.fetch answers GET /v1/users/{id} from the USERS table below and
// records every request, so the tests see exactly what would reach Notion.
import { readFileSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = dirname(fileURLToPath(import.meta.url));
let src = readFileSync(join(dir, "workflow.ts"), "utf8");

src = src
  .replace(
    'import { defineDurable, type DurableContext } from "@zapier/zapier-durable";',
    "type DurableContext = any;\nconst defineDurable = (name: string, fn: unknown) => ({ name, fn });",
  )
  .replace(
    'import { createZapierSdk } from "@zapier/zapier-sdk";',
    "const createZapierSdk = () => ({ fetch: (url: string, init: any): Promise<any> => (globalThis as any).__fetch(url, init) });",
  );
if (src.includes("@zapier/")) throw new Error("unstubbed @zapier import left in source");
src += "\nexport const __test = { extractContactData, isNotionSystemUserId, personIdFromUser, resolveMentionUserId, addOutcomeComment };\n";

const tmpTs = join(dir, ".mention-under-test.ts");
const outDir = join(dir, ".mention-under-test-out");
writeFileSync(tmpTs, src);
let mod;
try {
  execFileSync(
    "npx",
    ["tsc", tmpTs, "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler",
     "--skipLibCheck", "--noCheck", "--outDir", outDir],
    { cwd: dir, stdio: "inherit" },
  );
  mod = await import(pathToFileURL(join(outDir, ".mention-under-test.js")));
} finally {
  unlinkSync(tmpTs);
  rmSync(outDir, { recursive: true, force: true });
}
const { extractContactData, isNotionSystemUserId, personIdFromUser, resolveMentionUserId, addOutcomeComment } =
  mod.__test;

// --- fixtures (ids as seen in production run history) -----------------------
const DENNIS = "121d872b-594c-810b-ba5a-000206eeef1e"; // type: person
const ZAPIER_BOT = "142d872b-594c-81a3-971a-00274ec71b63"; // type: bot
const WORKER_BOT = "36091b07-11ac-81f8-a411-00277191cc62"; // type: bot
const UNSEEN = "3e491b07-11ac-8131-8052-00274c88d9a1"; // 404 to this integration
const SYSTEM = "00000000-0000-0000-0000-000000000003"; // Notion system user

const USERS = {
  [DENNIS]: { status: 200, body: { object: "user", id: DENNIS, type: "person", person: {} } },
  [ZAPIER_BOT]: { status: 200, body: { object: "user", id: ZAPIER_BOT, type: "bot", bot: {} } },
  [WORKER_BOT]: { status: 200, body: { object: "user", id: WORKER_BOT, type: "bot", bot: {} } },
};

let requests = [];
let transientFor = new Set();
globalThis.__fetch = async (url, init) => {
  requests.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
  const m = url.match(/\/v1\/users\/([^/?]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const hit = transientFor.has(id) ? { status: 503, body: {} } : USERS[id] ?? {
      status: 404,
      body: { object: "error", status: 404, code: "object_not_found" },
    };
    return response(hit.status, hit.body);
  }
  if (url.endsWith("/v1/comments")) return response(200, { object: "comment" });
  throw new Error(`unexpected fetch ${url}`);
};
function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// A ctx whose step mirrors the durable's retry: up to 5 attempts, then throw.
const ctx = {
  step: async (_id, fn) => {
    let last;
    for (let i = 0; i < 5; i++) {
      try {
        return await fn();
      } catch (e) {
        last = e;
      }
    }
    throw new Error(`Step exhausted all retry attempts: ${last}`);
  },
};

let failures = 0;
let count = 0;
function check(name, actual, expected) {
  count++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`ok ${count} - ${name}`);
  } else {
    failures++;
    console.error(`NOT OK ${count} - ${name}\n  expected ${e}\n  got      ${a}`);
  }
}
const lookups = () => requests.filter((r) => r.url.includes("/v1/users/")).map((r) => r.url.split("/").pop());
const reset = () => {
  requests = [];
  transientFor = new Set();
};

// A Notion DB automation payload, shaped like production's.
const payload = ({ actor, lastEditedBy, createdBy }) => ({
  source: { type: "automation", ...(actor ? { user_id: actor } : {}) },
  data: {
    id: "page-1",
    object: "page",
    created_by: createdBy ? { object: "user", id: createdBy } : undefined,
    last_edited_by: lastEditedBy ? { object: "user", id: lastEditedBy } : undefined,
    properties: {},
  },
});

// --- pure helpers -------------------------------------------------------------
check("system user id recognised", isNotionSystemUserId(SYSTEM), true);
check("ordinary user id is not a system user", isNotionSystemUserId(DENNIS), false);
check("person answer → id", personIdFromUser(200, USERS[DENNIS].body), DENNIS);
check("bot answer → null", personIdFromUser(200, USERS[ZAPIER_BOT].body), null);
check("404 → null", personIdFromUser(404, { object: "error" }), null);
check("non-object body → null", personIdFromUser(200, null), null);
check("person without id → null", personIdFromUser(200, { object: "user", type: "person" }), null);

// --- candidate extraction -----------------------------------------------------
check(
  "candidates: actor first, then last editor, then creator, deduped",
  extractContactData(payload({ actor: DENNIS, lastEditedBy: SYSTEM, createdBy: DENNIS })).mentionCandidateIds,
  [DENNIS, SYSTEM],
);
check(
  "candidates: no actor → page fallbacks only",
  extractContactData(payload({ lastEditedBy: SYSTEM, createdBy: ZAPIER_BOT })).mentionCandidateIds,
  [SYSTEM, ZAPIER_BOT],
);
check("candidates: none in payload → empty", extractContactData(payload({})).mentionCandidateIds, []);

// --- resolution ---------------------------------------------------------------
reset();
check("actor is a person → mentioned", await resolveMentionUserId(ctx, [DENNIS, SYSTEM]), DENNIS);
check("…with a single lookup", lookups(), [DENNIS]);

reset();
check(
  "the failing production shape (system last editor, bot creator) → no mention",
  await resolveMentionUserId(ctx, [SYSTEM, ZAPIER_BOT]),
  null,
);
check("…system user is never looked up", lookups(), [ZAPIER_BOT]);

reset();
check(
  "bot last editor, person creator → the creator",
  await resolveMentionUserId(ctx, [WORKER_BOT, DENNIS]),
  DENNIS,
);

reset();
check("unseen user (404) → skipped, falls through", await resolveMentionUserId(ctx, [UNSEEN, DENNIS]), DENNIS);

reset();
check("only system users → null without any lookup", await resolveMentionUserId(ctx, [SYSTEM]), null);
check("…no requests", requests.length, 0);

reset();
check("no candidates → null", await resolveMentionUserId(ctx, []), null);

reset();
check(
  "lookups are capped",
  (await resolveMentionUserId(ctx, [ZAPIER_BOT, WORKER_BOT, UNSEEN, DENNIS]), lookups()),
  [ZAPIER_BOT, WORKER_BOT, UNSEEN],
);

reset();
transientFor = new Set([DENNIS]);
check("lookup never clears → no mention, no throw", await resolveMentionUserId(ctx, [DENNIS]), null);

// --- the comment actually posted ----------------------------------------------
const skipped = { pageId: "page-1", enriched: false, reasons: ["bettercontact returned no result"] };
const commentBody = () => requests.find((r) => r.url.endsWith("/v1/comments"))?.body;

reset();
check(
  "comment posts on the failing production shape",
  await addOutcomeComment(ctx, extractContactData(payload({ lastEditedBy: SYSTEM, createdBy: ZAPIER_BOT })), skipped),
  { posted: true },
);
check(
  "…with no mention in it",
  commentBody().rich_text.map((t) => t.type),
  ["text"],
);

reset();
await addOutcomeComment(ctx, extractContactData(payload({ actor: DENNIS, lastEditedBy: SYSTEM })), skipped);
check(
  "person actor → comment opens with their mention",
  commentBody().rich_text.map((t) => (t.type === "mention" ? t.mention.user.id : t.type)),
  [DENNIS, "text"],
);

console.log(`\n${count - failures}/${count} passed`);
if (failures) process.exit(1);
