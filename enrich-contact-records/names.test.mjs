// Offline assertions over the real name handling in workflow.ts — no Zapier
// calls, no credentials. Run with `npm test` from this directory.
//
// Covers the 2026-10-01 failure: "Alice SY Peng (彭思瑀)" reached BetterContact's
// Zapier integration, which puts the name in an HTTP header, and the platform's
// client refused it ("SY Peng (彭思瑀) is not a legal HTTP header value").
//
// workflow.ts can't be imported directly (createZapierSdk() and defineDurable()
// run at module load), so this harness stubs those two imports, appends a test
// export, strips the types with the local tsc, and imports the emitted JS. The
// sdk stub is swappable per test, so the whole workflow body can be driven
// against a fake BetterContact that rejects header-unsafe names exactly as the
// real integration does.
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
    "const createZapierSdk = () => (globalThis as any).__sdkStub;",
  );
if (src.includes("@zapier/")) throw new Error("unstubbed @zapier import left in source");
src += "\nexport const __test = { matchName, asciiUrl, isHeaderSafe, extractContactData };\n";

const tmpTs = join(dir, ".names-under-test.ts");
const outDir = join(dir, ".names-under-test-out");
writeFileSync(tmpTs, src);
// One object for the module's whole life: `sdk` is captured at load, so tests
// swap its methods rather than the object.
const sdkStub = {};
globalThis.__sdkStub = sdkStub;
let mod;
try {
  execFileSync(
    "npx",
    ["tsc", tmpTs, "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler",
     "--skipLibCheck", "--noCheck", "--outDir", outDir],
    { cwd: dir, stdio: "inherit" },
  );
  mod = await import(pathToFileURL(join(outDir, ".names-under-test.js")));
} finally {
  unlinkSync(tmpTs);
  rmSync(outDir, { recursive: true, force: true });
}
const { matchName, asciiUrl, isHeaderSafe, extractContactData } = mod.__test;
const workflow = mod.default;

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

// --- isHeaderSafe mirrors the platform client's rule -------------------------
check("ASCII is header-safe", isHeaderSafe("SY Peng"), true);
check("Latin-1 accents are header-safe", isHeaderSafe("José Müller"), true);
check("CJK is not", isHeaderSafe("SY Peng (彭思瑀)"), false);
check("Ł is not", isHeaderSafe("Łukasz"), false);

// --- matchName ---------------------------------------------------------------
const m = (f, l, t) => matchName(f, l, t);
check("the 2026-10-01 title split", m("Alice", "SY Peng (彭思瑀)", true), { firstName: "Alice", lastName: "Peng" });
check("fullwidth parentheses", m("Alice", "Peng（彭思瑀）", true), { firstName: "Alice", lastName: "Peng" });
check("plain ASCII name untouched", m("Grace", "Tang", true), { firstName: "Grace", lastName: "Tang" });
check("dotted middle initial dropped from a title", m("John", "F. Kennedy", true), { firstName: "John", lastName: "Kennedy" });
check("particles kept", m("Jan", "van der Berg", true), { firstName: "Jan", lastName: "van der Berg" });
check("a lone all-caps surname is kept", m("Alice", "LEE", true), { firstName: "Alice", lastName: "LEE" });
check("short real surname is not an initial", m("Wei", "Ng", true), { firstName: "Wei", lastName: "Ng" });
check("properties are trusted — initials kept", m("Alice", "SY Peng", false), { firstName: "Alice", lastName: "SY Peng" });
check("properties still lose the aside", m("Alice", "Peng (彭思瑀)", false), { firstName: "Alice", lastName: "Peng" });
check("Latin-1 accents left as they are", m("José", "Müller", false), { firstName: "José", lastName: "Müller" });
check("beyond-Latin-1 accents folded", m("Łukasz", "Żukowski", false), { firstName: "Lukasz", lastName: "Zukowski" });
check("Vietnamese folded", m("Thị", "Nguyễn", false), { firstName: "Thi", lastName: "Nguyen" });
check("CJK-only name cannot be sent", m("思瑀", "彭", false), { firstName: "", lastName: "" });
check("Cyrillic name cannot be sent", m("Иван", "Петров", true), { firstName: "", lastName: "" });
check("aside was the only surname", m("Alice", "(彭思瑀)", true), { firstName: "Alice", lastName: "" });

// --- asciiUrl ----------------------------------------------------------------
check("ASCII URL unchanged", asciiUrl("https://www.linkedin.com/in/alice-peng"), "https://www.linkedin.com/in/alice-peng");
check("non-ASCII slug percent-encoded", asciiUrl("https://www.linkedin.com/in/彭思瑀-1"), "https://www.linkedin.com/in/%E5%BD%AD%E6%80%9D%E7%91%80-1");

// --- extractContactData on the real failing payload's shape ------------------
const PAGE = "3ec91b07-11ac-8135-bcfa-e8241cfa47a8";
const payload = (over = {}) => ({
  data: {
    id: PAGE,
    object: "page",
    properties: {
      Name: { type: "title", title: [{ plain_text: "Alice SY Peng (彭思瑀) " }] },
      "First Name": { type: "rich_text", rich_text: [] },
      "Last Name": { type: "rich_text", rich_text: [] },
      Domain: { type: "rollup", rollup: { type: "array", array: [{ type: "url", url: "moxa.com" }] } },
      "Primary Email": { type: "email", email: null },
      Linkedin: { type: "url", url: null },
      ...over,
    },
  },
});
const c = extractContactData(payload());
check("own name kept as the CRM holds it", [c.firstName, c.lastName], ["Alice", "SY Peng (彭思瑀)"]);
check("match name rendered for the request", [c.matchFirstName, c.matchLastName], ["Alice", "Peng"]);

// --- The workflow body against a fake BetterContact ---------------------------
// The fake rejects any header-unsafe string input with the platform's own
// message, the way the real integration fails before sending.
const PLATFORM_HEADER_ERROR = (v) => `Action execution failed: ${v} is not a legal HTTP header value`;
function fakeSdk(log) {
  sdkStub.runAction = async ({ actionKey, inputs }) => {
    log.push({ actionKey, inputs });
    if (actionKey === "enrich_contact") {
      for (const v of Object.values(inputs)) {
        if (typeof v === "string" && !isHeaderSafe(v)) throw new Error(PLATFORM_HEADER_ERROR(v));
      }
      return { data: [{ id: "req-1", success: true }] };
    }
    if (actionKey === "get_contact") return { data: [{ status: "terminated", data: [] }] };
    throw new Error(`unexpected action ${actionKey}`);
  };
  sdkStub.fetch = async (url, init) => {
    log.push({ fetch: url, body: init?.body });
    return { ok: true, status: 200, text: async () => "", headers: new Map() };
  };
}
const ctx = {
  step: async (_name, fn) => fn(),
  wait: async () => {},
  createCallback: async () => [Promise.resolve({ status: "timeout" }), "https://callback.invalid/x"],
};
async function run(input) {
  const log = [];
  fakeSdk(log);
  const out = await workflow.fn(ctx, input);
  return { out, log };
}

{
  const { out, log } = await run(payload());
  const submit = log.find((e) => e.actionKey === "enrich_contact");
  check("Alice SY Peng (彭思瑀) reaches BetterContact", Boolean(submit), true);
  check("…as Alice Peng", submit && [submit.inputs.first_name, submit.inputs.last_name], ["Alice", "Peng"]);
  check("…and no header error in the outcome", /legal HTTP header/.test(out.reason), false);
}
{
  const { out, log } = await run(payload({ Name: { type: "title", title: [{ plain_text: "彭思瑀 王" }] } }));
  check("a non-Latin-only name is not sent", log.some((e) => e.actionKey === "enrich_contact"), false);
  check("…and the skip names the fix", /romanised First Name and Last Name/.test(out.reason), true);
}
{
  const { log } = await run(payload({ Linkedin: { type: "url", url: "https://www.linkedin.com/in/彭思瑀" } }));
  const submit = log.find((e) => e.actionKey === "enrich_contact");
  check("a non-ASCII LinkedIn URL is sent encoded", submit?.inputs.linkedin_url, "https://www.linkedin.com/in/%E5%BD%AD%E6%80%9D%E7%91%80");
}

console.log(`\n${count - failures}/${count} passed`);
if (failures) process.exit(1);
