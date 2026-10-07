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
function fakeSdk(log, { harvest, bcRow, upload } = {}) {
  sdkStub.runAction = async ({ actionKey, inputs }) => {
    log.push({ actionKey, inputs });
    if (actionKey === "find_profile") {
      if (harvest === undefined) throw new Error("unexpected action find_profile");
      return { data: harvest ? [harvest] : [] };
    }
    if (actionKey === "update_database_item") return { data: [{ id: inputs.page }] };
    if (actionKey === "enrich_contact") {
      for (const v of Object.values(inputs)) {
        if (typeof v === "string" && !isHeaderSafe(v)) throw new Error(PLATFORM_HEADER_ERROR(v));
      }
      return { data: [{ id: "req-1", success: true }] };
    }
    if (actionKey === "get_contact") return { data: [{ status: "terminated", data: bcRow ? [bcRow] : [] }] };
    throw new Error(`unexpected action ${actionKey}`);
  };
  // Notion: file_uploads (create + poll) answer with `upload` (default: a
  // real 8 KB JPEG); everything else answers 200 {}.
  const up = { id: "up-1", status: "uploaded", content_type: "image/jpeg", content_length: 8000, ...upload };
  sdkStub.fetch = async (url, init) => {
    log.push({ fetch: url, method: init?.method, body: init?.body });
    const json = /\/file_uploads/.test(url) ? up : {};
    return { ok: true, status: 200, text: async () => "", json: async () => json, headers: new Map() };
  };
  sdkStub.listTableRecords = async () => ({ data: [] });
  sdkStub.createTableRecords = async ({ records }) => {
    log.push({ table: records });
    return { data: [] };
  };
}
const ctx = {
  step: async (_name, fn) => fn(),
  wait: async () => {},
  createCallback: async () => [Promise.resolve({ status: "timeout" }), "https://callback.invalid/x"],
};
async function run(input, fakes) {
  const log = [];
  fakeSdk(log, fakes);
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

// --- HarvestAPI first, BetterContact as the fallback --------------------------
// Row shapes trimmed from live responses (HarvestAPI find_profile 2026-10-07,
// BetterContact terminated body 2026-09-18).
const LI = "https://www.linkedin.com/in/alice-peng";
const harvestRow = (over = {}) => ({
  publicIdentifier: "alice-peng",
  firstName: "Alice",
  lastName: "Peng 🚀",
  linkedinUrl: LI,
  about: "Builds things.",
  currentJobTitle: "Head of Ops",
  location: { parsed: { city: "Taipei", country: "Taiwan" } },
  experience: [{ endDate: { text: "Present" }, company: { website: "https://www.moxa.com/en/" } }],
  email: "alice.peng@moxa.com",
  emails: [{ email: "alice.peng@moxa.com", deliverable: true, status: "valid" }],
  ...over,
});
const bcRow = {
  contact_email_address: "a.peng@moxa.com",
  contact_email_address_status: "deliverable",
  company_domain: "moxa.com",
};
const withLi = (over = {}) => payload({ Linkedin: { type: "url", url: LI }, ...over });
const updateOf = (log) => log.find((e) => e.actionKey === "update_database_item")?.inputs ?? {};
const commentOf = (log) => JSON.parse(log.find((e) => /\/comments$/.test(e.fetch ?? ""))?.body ?? "{}").rich_text?.[0]?.text?.content ?? "";
const iconPatchOf = (log) => {
  const e = log.find((x) => x.method === "PATCH" && /\/pages\//.test(x.fetch ?? ""));
  return e ? JSON.parse(e.body) : null;
};
const PHOTO = "https://media.licdn.com/dms/image/v2/abc/profile-displayphoto-shrink_800_800/0/1?e=1793232000&v=beta&t=x";

{
  const { out, log } = await run(withLi(), { harvest: harvestRow(), bcRow });
  check("LinkedIn URL → HarvestAPI is asked first", log[0]?.actionKey, "find_profile");
  check("…with the URL and email search on", [log[0]?.inputs.url, log[0]?.inputs.findEmail], [LI, "true"]);
  check("a verified HarvestAPI email skips BetterContact", log.some((e) => e.actionKey === "enrich_contact"), false);
  check("…and is written as Primary", updateOf(log)["properties|||Primary Email|||email"], "alice.peng@moxa.com");
  check("…sourced to HarvestAPI", [out.source, out.emailSource], ["harvestapi", undefined]);
  check("…with title, city, country and bio", [
    updateOf(log)["properties|||Job Title|||rich_text"],
    updateOf(log)["properties|||City|||select"],
    updateOf(log)["properties|||Country|||select"],
    updateOf(log)["properties|||Bio|||rich_text"],
  ], ["Head of Ops", "Taipei", "Taiwan", "Builds things."]);
  check("the CRM's own name is kept over LinkedIn's display name", updateOf(log)["properties|||Last Name|||rich_text"], "SY Peng (彭思瑀)");
  check("…and the email is indexed in the Table", log.find((e) => e.table)?.table[0].data.Email, "alice.peng@moxa.com");
  check("the comment names HarvestAPI", /enriched via HarvestAPI and updated/.test(commentOf(log)), true);
}
{
  const { out, log } = await run(withLi(), { harvest: harvestRow({ email: null, emails: [] }), bcRow });
  check("HarvestAPI profile without an email → BetterContact runs", log.some((e) => e.actionKey === "enrich_contact"), true);
  check("…its address is written", updateOf(log)["properties|||Primary Email|||email"], "a.peng@moxa.com");
  check("…HarvestAPI's profile fields are kept", updateOf(log)["properties|||Job Title|||rich_text"], "Head of Ops");
  check("…and both sources are reported", [out.source, out.emailSource], ["harvestapi", "bettercontact"]);
  check("…in the comment too", /via HarvestAPI \(email via BetterContact\)/.test(commentOf(log)), true);
}
{
  const { out, log } = await run(withLi(), {
    harvest: harvestRow({ emails: [{ email: "alice.peng@moxa.com", deliverable: false, status: "invalid" }] }),
    bcRow: null,
  });
  check("an unverified HarvestAPI email is not written", updateOf(log)["properties|||Primary Email|||email"], undefined);
  check("…the profile still is", [out.enriched, out.source], [true, "harvestapi"]);
  check("…and the comment names the address", /HarvestAPI: found alice\.peng@moxa\.com but could not verify it/.test(commentOf(log)), true);
}
{
  const { out, log } = await run(withLi(), { harvest: null, bcRow });
  check("no HarvestAPI profile → BetterContact does the work", out.source, "bettercontact");
  check("…and the comment says why", /HarvestAPI: no profile found/.test(commentOf(log)), true);
}
{
  const { out, log } = await run(payload(), { harvest: harvestRow(), bcRow });
  check("no LinkedIn URL → HarvestAPI is not called", log.some((e) => e.actionKey === "find_profile"), false);
  check("…BetterContact is", out.source, "bettercontact");
}
{
  const { out } = await run(withLi({ Domain: { type: "rollup", rollup: { type: "array", array: [] } } }), { harvest: null });
  check("neither source usable → skipped with both reasons", out.reasons?.length, 2);
}
{
  const { log } = await run(
    withLi({ Name: { type: "title", title: [{ plain_text: "alice@moxa.com" }] } }),
    { harvest: harvestRow({ lastName: "Peng" }) },
  );
  check("a contact with no name takes LinkedIn's", updateOf(log)["properties|||Name|||title"], "Alice Peng");
}

{
  // 2026-10-07 live failure: Notion rejects a select option with a comma.
  const { log } = await run(withLi(), {
    harvest: harvestRow({ location: { parsed: { city: "Seoul", country: "Korea, Republic of" } } }),
  });
  check("ISO country name mapped to the existing option", updateOf(log)["properties|||Country|||select"], "South Korea");
  const { log: log2 } = await run(withLi(), {
    harvest: harvestRow({ location: { parsed: { city: "Washington, D.C.", country: "Bonaire, Sint Eustatius and Saba" } } }),
  });
  check("no select value ever carries a comma", [
    updateOf(log2)["properties|||City|||select"],
    updateOf(log2)["properties|||Country|||select"],
  ], ["Washington D.C.", "Bonaire Sint Eustatius and Saba"]);
}

// --- Path C: HarvestAPI photo → page icon --------------------------------------
{
  const { out, log } = await run(withLi(), { harvest: harvestRow({ photo: PHOTO }) });
  const create = log.find((e) => /\/file_uploads$/.test(e.fetch ?? ""));
  check("the photo is imported into Notion, not linked", JSON.parse(create?.body ?? "{}").mode, "external_url");
  check("…from HarvestAPI's URL", JSON.parse(create?.body ?? "{}").external_url, PHOTO);
  check("…and set as both icon and cover, from the one upload", iconPatchOf(log), {
    icon: { type: "file_upload", file_upload: { id: "up-1" } },
    cover: { type: "file_upload", file_upload: { id: "up-1" } },
  });
  check("…reported in output and comment", [out.iconUpdated, /profile icon and cover/.test(commentOf(log))], [true, true]);
}
{
  const { out, log } = await run(withLi(), {
    harvest: harvestRow({ photo: "https://static.licdn.com/aero-v1/sc/h/9c8pery4andzj6ohjkjp54ma2" }),
  });
  check("LinkedIn's silhouette URL is never imported", log.some((e) => /file_uploads/.test(e.fetch ?? "")), false);
  check("…and the icon is left alone", [iconPatchOf(log), out.iconUpdated], [null, false]);
}
{
  const { out, log } = await run(withLi(), {
    harvest: harvestRow({ photo: PHOTO }),
    upload: { content_type: "image/svg+xml", content_length: 489 },
  });
  check("an imported SVG placeholder is not set", [iconPatchOf(log), out.iconUpdated, out.iconError], [null, false, undefined]);
}
{
  const { out, log } = await run(withLi(), { harvest: harvestRow({ photo: PHOTO }), upload: { status: "failed" } });
  check("a failed import does not fail the run", [out.enriched, out.iconUpdated], [true, false]);
  check("…and is named in the comment", /Profile photo not stored: Notion could not import the photo/.test(commentOf(log)), true);
}
{
  const { log } = await run(payload(), { bcRow });
  check("a BetterContact-only run never touches the icon", log.some((e) => /file_uploads/.test(e.fetch ?? "")), false);
}

console.log(`\n${count - failures}/${count} passed`);
if (failures) process.exit(1);
