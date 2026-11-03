// Offline assertions over the real logic in workflow.ts — no Zapier calls, no
// credentials. Run with `npm test` from this directory.
//
// workflow.ts can't be imported directly (createZapierSdk() and defineDurable()
// run at module load), so this harness stubs those two imports, appends a test
// export, strips the types with the local tsc, and imports the emitted JS. The
// sdk stub is swappable per test, so the whole workflow body can be driven
// against a fake HarvestAPI, a fake Apollo and a fake Notion.
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
src += "\nexport const __test = { matchName, asciiUrl, extractContactData, isActionTimeout, isoToEpochMinutes, isOwnWriteEchoCandidate };\n";

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
const { matchName, asciiUrl, extractContactData, isActionTimeout, isoToEpochMinutes, isOwnWriteEchoCandidate } = mod.__test;
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
check("accents travel as they are", m("Łukasz", "Nguyễn", false), { firstName: "Łukasz", lastName: "Nguyễn" });
check("a non-Latin name is sent as it stands", m("思瑀", "彭", false), { firstName: "思瑀", lastName: "彭" });
check("aside was the only surname", m("Alice", "(彭思瑀)", true), { firstName: "Alice", lastName: "" });

// --- asciiUrl ----------------------------------------------------------------
check("ASCII URL unchanged", asciiUrl("https://www.linkedin.com/in/alice-peng"), "https://www.linkedin.com/in/alice-peng");
check("non-ASCII slug percent-encoded", asciiUrl("https://www.linkedin.com/in/彭思瑀-1"), "https://www.linkedin.com/in/%E5%BD%AD%E6%80%9D%E7%91%80-1");

// --- extractContactData on the real failing payload's shape ------------------
const PAGE = "3ec91b07-11ac-8135-bcfa-e8241cfa47a8";
const payload = (over = {}, data = {}, source = undefined) => ({
  ...(source ? { source } : {}),
  data: {
    id: PAGE,
    object: "page",
    last_edited_by: { object: "user", id: "121d872b-594c-810b-ba5a-000206eeef1e" },
    last_edited_time: "2026-11-02T02:23:00.000Z",
    ...data,
    properties: {
      Name: { type: "title", title: [{ plain_text: "Alice SY Peng (彭思瑀) " }] },
      "First Name": { type: "rich_text", rich_text: [] },
      "Last Name": { type: "rich_text", rich_text: [] },
      Domain: { type: "rollup", rollup: { type: "array", array: [{ type: "url", url: "moxa.com" }] } },
      "Primary Email": { type: "email", email: null },
      Linkedin: { type: "url", url: null },
      "Last Enriched": { type: "date", date: null },
      ...over,
    },
  },
});
const c = extractContactData(payload());
check("own name kept as the CRM holds it", [c.firstName, c.lastName], ["Alice", "SY Peng (彭思瑀)"]);
check("match name rendered for the request", [c.matchFirstName, c.matchLastName], ["Alice", "Peng"]);

// The Contacts template's default title is not a name (2026-09-28: "New
// Contact" at du.edu came back from BetterContact as new.contact@du.edu).
for (const title of ["New Contact ", "New Contact", "new contact", "Untitled"]) {
  const p = extractContactData(payload({ Name: { type: "title", title: [{ plain_text: title }] } }));
  check(`template placeholder title "${title}" is no name`, [p.firstName, p.lastName], ["", ""]);
}
const real = extractContactData(payload({ Name: { type: "title", title: [{ plain_text: "Newton Contreras" }] } }));
check("a real name starting with New is still a name", [real.firstName, real.lastName], ["Newton", "Contreras"]);
const addr = extractContactData(payload({ Name: { type: "title", title: [{ plain_text: "maxine.lotherington@gmail.com" }] } }));
check("an address title is still no name", [addr.firstName, addr.lastName], ["", ""]);

// --- Fakes -------------------------------------------------------------------
// Row shapes trimmed from live responses (HarvestAPI find_profile 2026-10-07,
// Apollo people/match 2026-11-03).
const BOT = "142d872b-594c-81a3-971a-00274ec71b63";
function fakeSdk(log, { harvest, harvestByUrl, harvestErrors = [], apollo, apolloStatus = 200, upload, botId = BOT } = {}) {
  const pendingHarvestErrors = [...harvestErrors];
  sdkStub.runAction = async ({ actionKey, inputs }) => {
    log.push({ actionKey, inputs });
    if (actionKey === "find_profile") {
      if (pendingHarvestErrors.length) throw new Error(pendingHarvestErrors.shift());
      const row = harvestByUrl ? harvestByUrl[inputs.url] ?? null : harvest;
      if (row === undefined) throw new Error("unexpected action find_profile");
      return { data: row ? [row] : [] };
    }
    if (actionKey === "update_database_item") return { data: [{ id: inputs.page }] };
    throw new Error(`unexpected action ${actionKey}`);
  };
  // Notion: file_uploads (create + poll) answer with `upload` (default: a
  // real 8 KB JPEG), users/me with the bot; Apollo with `apollo` as `person`.
  const up = { id: "up-1", status: "uploaded", content_type: "image/jpeg", content_length: 8000, ...upload };
  sdkStub.fetch = async (url, init) => {
    log.push({ fetch: url, method: init?.method, body: init?.body });
    if (/api\.apollo\.io/.test(url)) {
      if (apollo === undefined) throw new Error("unexpected Apollo call");
      const body = JSON.stringify({ person: apollo });
      return { ok: apolloStatus < 300, status: apolloStatus, text: async () => (apolloStatus < 300 ? body : '{"error":"insufficient credits"}') };
    }
    const json = /\/file_uploads/.test(url) ? up : /\/users\/me$/.test(url) ? { id: botId, type: "bot" } : {};
    return { ok: true, status: 200, text: async () => "", json: async () => json, headers: new Map() };
  };
  sdkStub.listTableRecords = async () => ({ data: [] });
  sdkStub.createTableRecords = async ({ records }) => {
    log.push({ table: records });
    return { data: [] };
  };
}
const ctx = { step: async (_name, fn) => fn(), wait: async () => {} };
async function run(input, fakes) {
  const log = [];
  fakeSdk(log, fakes);
  const out = await workflow.fn(ctx, input);
  return { out, log };
}

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
const apolloPerson = (over = {}) => ({
  first_name: "Alice",
  last_name: "Peng",
  linkedin_url: "http://www.linkedin.com/in/alice-peng",
  title: "Operations Lead",
  headline: "Ops at Moxa",
  city: "Taipei",
  country: "Taiwan",
  email: "a.peng@moxa.com",
  email_status: "verified",
  photo_url: null,
  organization: { primary_domain: "moxa.com" },
  ...over,
});
const withLi = (over = {}, data = {}, source) => payload({ Linkedin: { type: "url", url: LI }, ...over }, data, source);
const updateOf = (log) => log.find((e) => e.actionKey === "update_database_item")?.inputs ?? {};
const commentOf = (log) => JSON.parse(log.find((e) => /\/comments$/.test(e.fetch ?? ""))?.body ?? "{}").rich_text?.[0]?.text?.content ?? "";
const apolloBodyOf = (log) => JSON.parse(log.find((e) => /api\.apollo\.io/.test(e.fetch ?? ""))?.body ?? "null");
const calledApollo = (log) => log.some((e) => /api\.apollo\.io/.test(e.fetch ?? ""));
const harvestUrls = (log) => log.filter((e) => e.actionKey === "find_profile").map((e) => e.inputs.url);
const iconPatchOf = (log) => {
  const e = log.find((x) => x.method === "PATCH" && /\/pages\//.test(x.fetch ?? ""));
  return e ? JSON.parse(e.body) : null;
};
const PHOTO = "https://media.licdn.com/dms/image/v2/abc/profile-displayphoto-shrink_800_800/0/1?e=1793232000&v=beta&t=x";

// --- HarvestAPI first ------------------------------------------------------------
{
  const { out, log } = await run(withLi(), { harvest: harvestRow(), apollo: apolloPerson() });
  check("LinkedIn URL → HarvestAPI is asked first", log[0]?.actionKey, "find_profile");
  check("…with the URL and email search on", [log[0]?.inputs.url, log[0]?.inputs.findEmail], [LI, "true"]);
  check("a verified HarvestAPI email skips Apollo", calledApollo(log), false);
  check("…and is written as Primary", updateOf(log)["properties|||Primary Email|||email"], "alice.peng@moxa.com");
  check("…sourced to HarvestAPI", [out.source, out.emailSource], ["harvestapi", undefined]);
  check("…with title, city, country and bio", [
    updateOf(log)["properties|||Job Title|||rich_text"],
    updateOf(log)["properties|||City|||select"],
    updateOf(log)["properties|||Country|||select"],
    updateOf(log)["properties|||Bio|||rich_text"],
  ], ["Head of Ops", "Taipei", "Taiwan", "Builds things."]);
  check("the CRM's own name is kept over LinkedIn's display name", updateOf(log)["properties|||Last Name|||rich_text"], "SY Peng (彭思瑀)");
  check("the same profile URL is not rewritten (no automation echo)", updateOf(log)["properties|||Linkedin|||url"], "");
  check("…and the email is indexed in the Table", log.find((e) => e.table)?.table[0].data.Email, "alice.peng@moxa.com");
  check("the comment names HarvestAPI", /enriched via HarvestAPI and updated/.test(commentOf(log)), true);
}
{
  const { log } = await run(payload({ Linkedin: { type: "url", url: "linkedin.com/in/alice-peng/" } }), { harvest: harvestRow() });
  check("a differently-spelled URL for the same slug is left alone", updateOf(log)["properties|||Linkedin|||url"], "");
}
{
  const { log } = await run(withLi(), { harvest: harvestRow({ linkedinUrl: "https://www.linkedin.com/in/alice-peng-renamed" }) });
  check("a renamed slug from HarvestAPI is written", updateOf(log)["properties|||Linkedin|||url"], "https://www.linkedin.com/in/alice-peng-renamed");
}

// --- Apollo as the fallback --------------------------------------------------------
{
  const { out, log } = await run(withLi(), { harvest: harvestRow({ email: null, emails: [] }), apollo: apolloPerson() });
  check("HarvestAPI profile without an email → Apollo runs", calledApollo(log), true);
  check("…sent the contact's identifiers", apolloBodyOf(log), {
    reveal_personal_emails: false, reveal_phone_number: false,
    first_name: "Alice", last_name: "Peng", domain: "moxa.com", linkedin_url: LI,
  });
  check("…its address is written", updateOf(log)["properties|||Primary Email|||email"], "a.peng@moxa.com");
  check("…HarvestAPI's profile fields are kept", updateOf(log)["properties|||Job Title|||rich_text"], "Head of Ops");
  check("…and both sources are reported", [out.source, out.emailSource], ["harvestapi", "apollo"]);
  check("…in the comment too", /via HarvestAPI \(email via Apollo\)/.test(commentOf(log)), true);
}
{
  // Apollo's address merged into a HarvestAPI profile is judged on Apollo's
  // record: here a stranger at another company, so it is not written even
  // though HarvestAPI's profile (the contact's own URL) is the right person.
  const { out, log } = await run(withLi(), {
    harvest: harvestRow({ email: null, emails: [] }),
    apollo: apolloPerson({ linkedin_url: "http://www.linkedin.com/in/other-alice", email: "alice@elsewhere.io", organization: { primary_domain: "elsewhere.io" } }),
  });
  check("an uncorroborated Apollo address is not merged into the profile", updateOf(log)["properties|||Primary Email|||email"], undefined);
  check("…Path U names it", [out.emailPath, out.unverifiedEmail], ["unverified-email", "alice@elsewhere.io"]);
}
{
  const { out, log } = await run(withLi(), { harvest: harvestRow({ emails: [{ email: "alice.peng@moxa.com", deliverable: false, status: "invalid" }] }), apollo: null });
  check("an unverified HarvestAPI email is not written", updateOf(log)["properties|||Primary Email|||email"], undefined);
  check("…the profile still is", [out.enriched, out.source], [true, "harvestapi"]);
  check("…and the comment names the address", /HarvestAPI: found alice\.peng@moxa\.com but could not verify it/.test(commentOf(log)), true);
}
{
  const { out, log } = await run(withLi(), { harvest: null, apollo: apolloPerson({ linkedin_url: "http://www.linkedin.com/in/someone-else" }) });
  check("no HarvestAPI profile → Apollo does the work", out.source, "apollo");
  check("…and the comment says why", /HarvestAPI: no profile found/.test(commentOf(log)), true);
  check("an Apollo URL never replaces the contact's own", updateOf(log)["properties|||Linkedin|||url"], "");
  check("…and is not handed back to HarvestAPI", harvestUrls(log), [LI]);
}
{
  const { out, log } = await run(payload(), { apollo: apolloPerson({ email_status: "unverified" }) });
  check("an unverified Apollo address is not written", updateOf(log)["properties|||Primary Email|||email"], undefined);
  check("…the comment names it and its status", /Apollo: found a\.peng@moxa\.com but its status is unverified/.test(commentOf(log)), true);
  check("…the rest of the match still is", out.source, "apollo");
}
{
  const { out, log } = await run(payload(), { apollo: apolloPerson({ email: "email_not_unlocked@moxa.com" }) });
  check("Apollo's locked-email placeholder is no address", [updateOf(log)["properties|||Primary Email|||email"], /email_not_unlocked/.test(commentOf(log))], [undefined, false]);
  check("…the match is still used", out.source, "apollo");
}
{
  const { out } = await run(payload(), { apollo: apolloPerson(), apolloStatus: 422 });
  check("an Apollo HTTP error is a reason, not a failed run", [out.enriched, /^apollo error: http 422/.test(out.reasons?.[0] ?? "")], [false, true]);
}
{
  const { out, log } = await run(payload({
    Name: { type: "title", title: [{ plain_text: "alice@gmail.com" }] },
    Domain: { type: "rollup", rollup: { type: "array", array: [] } },
  }), {});
  check("nothing to match on → Apollo not called", calledApollo(log), false);
  check("…skipped with a reason", /apollo skipped/.test(out.reason), true);
}

// --- The handoff: Apollo finds the LinkedIn URL, HarvestAPI reads it ------------------
const APOLLO_LI = "http://www.linkedin.com/in/alice-peng";
{
  const { out, log } = await run(payload(), {
    apollo: apolloPerson({ email: null }),
    harvestByUrl: { [APOLLO_LI]: harvestRow({ photo: PHOTO }) },
  });
  check("no URL → Apollo first, then HarvestAPI with Apollo's URL", [calledApollo(log), harvestUrls(log)], [true, [APOLLO_LI]]);
  check("…HarvestAPI's profile and verified address are written", [
    out.source, updateOf(log)["properties|||Primary Email|||email"], updateOf(log)["properties|||Job Title|||rich_text"],
  ], ["harvestapi", "alice.peng@moxa.com", "Head of Ops"]);
  check("…vouched for by Apollo's corroborated match", out.unverifiedEmail, undefined);
  check("…the LinkedIn URL is written (HarvestAPI's spelling)", updateOf(log)["properties|||Linkedin|||url"], LI);
  check("…and the photo becomes the icon", out.iconUpdated, true);
  check("…the comment names the handoff", /via HarvestAPI \(LinkedIn profile found by Apollo\) and updated: primary email, LinkedIn URL/.test(commentOf(log)), true);
}
{
  const { out, log } = await run(payload(), {
    apollo: apolloPerson(),
    harvestByUrl: { [APOLLO_LI]: harvestRow({ email: null, emails: [] }) },
  });
  check("handoff profile without an email takes Apollo's", [out.source, out.emailSource, updateOf(log)["properties|||Primary Email|||email"]], ["harvestapi", "apollo", "a.peng@moxa.com"]);
}
{
  const { out, log } = await run(payload(), { apollo: apolloPerson(), harvestByUrl: {} });
  check("handoff finds nothing → Apollo's data stands", [out.source, updateOf(log)["properties|||Primary Email|||email"]], ["apollo", "a.peng@moxa.com"]);
  check("…including the URL it found", updateOf(log)["properties|||Linkedin|||url"], APOLLO_LI);
}
{
  // The Grace Tang shape: a personal Gmail, no Company, no LinkedIn — Apollo
  // matches someone of the same name elsewhere. Nothing ties it to the contact.
  const { out, log } = await run(payload({
    Name: { type: "title", title: [{ plain_text: "Grace Tang" }] },
    "Primary Email": { type: "email", email: "grace.t@gmail.com" },
    Domain: { type: "rollup", rollup: { type: "array", array: [] } },
  }), {
    apollo: apolloPerson({ first_name: "Grace", last_name: "Tang", email: "grace@leaps.sg", linkedin_url: "http://www.linkedin.com/in/gracetang", photo_url: PHOTO, organization: { primary_domain: "leaps.sg" } }),
  });
  check("uncorroborated Apollo match → no handoff", harvestUrls(log), []);
  check("…its URL is not written", updateOf(log)["properties|||Linkedin|||url"], "");
  check("…its photo is not used", [out.iconUpdated, log.some((e) => /file_uploads/.test(e.fetch ?? ""))], [false, false]);
  check("…its address goes to Path U", [out.emailPath, out.unverifiedEmail], ["unverified-email", "grace@leaps.sg"]);
  check("…and the comment says so", /Email grace@leaps\.sg NOT written/.test(commentOf(log)), true);
}

// --- Selects ---------------------------------------------------------------------
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
{
  const { log } = await run(
    withLi({ Name: { type: "title", title: [{ plain_text: "alice@moxa.com" }] } }),
    { harvest: harvestRow({ lastName: "Peng" }) },
  );
  check("a contact with no name takes LinkedIn's", updateOf(log)["properties|||Name|||title"], "Alice Peng");
}

// --- Path C: photo → page icon -------------------------------------------------------
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
  const { out } = await run(payload(), { apollo: apolloPerson({ photo_url: PHOTO }), harvestByUrl: {} });
  check("a corroborated Apollo match's photo is used", out.iconUpdated, true);
}

// --- HarvestAPI's 30s action timeout: one retry, then Apollo --------------------------
// The message is verbatim from the 2026-10-14 run (Meighan O'Toole).
const TIMEOUT = "Action execution failed: RequestId: 71d22aa1-2031-4793-b26f-036ffbaa59e9 Error: Task timed out after 30.00 seconds";
check("the platform timeout is recognised", isActionTimeout(new Error(TIMEOUT)), true);
check("another HarvestAPI error is not", isActionTimeout(new Error("Action execution failed: 502 Bad Gateway")), false);
{
  const { out, log } = await run(withLi(), { harvest: harvestRow(), harvestErrors: [TIMEOUT], apollo: apolloPerson() });
  check("a timeout is retried once", log.filter((e) => e.actionKey === "find_profile").length, 2);
  check("…and the retry's profile is used, Apollo skipped", [out.source, calledApollo(log)], ["harvestapi", false]);
}
{
  const { out, log } = await run(withLi(), { harvest: harvestRow(), harvestErrors: [TIMEOUT, TIMEOUT], apollo: apolloPerson() });
  check("a second timeout is not retried again", log.filter((e) => e.actionKey === "find_profile").length, 2);
  check("…and falls back to Apollo", [out.source, /harvestapi error: .*timed out/.test(out.reasons.join(" "))], ["apollo", true]);
}
{
  const { log } = await run(withLi(), { harvest: harvestRow(), harvestErrors: ["Action execution failed: 502 Bad Gateway"], apollo: apolloPerson() });
  check("a non-timeout error is not retried", log.filter((e) => e.actionKey === "find_profile").length, 1);
}

// --- Loop guard: the echo of this workflow's own LinkedIn write ------------------------
check("Notion timestamp to minutes (Z)", isoToEpochMinutes("1970-01-02T00:01:00.000Z"), 1441);
check("…with an offset", isoToEpochMinutes("2026-06-25T13:41:00.000+08:00"), isoToEpochMinutes("2026-06-25T05:41:00.000Z"));
check("…a date with no time is no timestamp", isoToEpochMinutes("2026-06-25"), null);

// The 2026-11-02 phoebekee echo, verbatim: our bot edited at 02:24, Last
// Enriched 02:24 (set by the run a minute earlier).
const echo = (over = {}, source) => withLi(
  { "Last Enriched": { type: "date", date: { start: "2026-11-02T02:24:00.000+00:00" } }, ...over },
  { last_edited_by: { object: "user", id: BOT }, last_edited_time: "2026-11-02T02:24:00.000Z" },
  source,
);
check("the echo shape is a candidate", isOwnWriteEchoCandidate(extractContactData(echo())), true);
{
  const { out, log } = await run(echo(), { harvest: harvestRow(), apollo: apolloPerson() });
  check("our own write's echo is skipped", out, { skipped: "own-write-echo", pageId: PAGE });
  check("…before any enrichment call or comment", log.map((e) => e.actionKey ?? e.fetch), ["https://api.notion.com/v1/users/me"]);
}
{
  const { out } = await run(echo(), { harvest: harvestRow(), botId: "some-other-bot" });
  check("another integration's edit is not our echo", out.enriched, true);
}
{
  const { out } = await run(echo({}, { type: "automation", user_id: "121d872b-594c-810b-ba5a-000206eeef1e" }), { harvest: harvestRow() });
  check("a button press is never skipped", out.enriched, true);
}
{
  const late = withLi(
    { "Last Enriched": { type: "date", date: { start: "2026-11-02T02:24:00.000+00:00" } } },
    { last_edited_by: { object: "user", id: BOT }, last_edited_time: "2026-11-02T02:40:00.000Z" },
  );
  check("a bot edit long after enrichment is not an echo", isOwnWriteEchoCandidate(extractContactData(late)), false);
  const person = withLi(
    { "Last Enriched": { type: "date", date: { start: "2026-11-02T02:24:00.000+00:00" } } },
    { last_edited_by: { object: "user", id: "121d872b-594c-810b-ba5a-000206eeef1e" }, last_edited_time: "2026-11-02T02:25:00.000Z" },
  );
  const { out } = await run(person, { harvest: harvestRow() });
  check("a person correcting the URL right after enrichment still runs", out.enriched, true);
  check("never enriched → not a candidate", isOwnWriteEchoCandidate(extractContactData(payload())), false);
}

console.log(`\n${count - failures}/${count} passed`);
if (failures) process.exit(1);
