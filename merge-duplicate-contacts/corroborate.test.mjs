// Offline assertions over the real corroboration code in workflow.ts — no Zapier
// calls, no credentials. Run with `npm test` from this directory.
//
// workflow.ts can't be imported directly (createZapierSdk() and defineDurable()
// run at module load), so this harness stubs those two imports, appends a test
// export, strips the types with the local tsc, and imports the emitted JS.
import { readFileSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = dirname(fileURLToPath(import.meta.url));
let src = readFileSync(join(dir, "workflow.ts"), "utf8");

src = src
  .replace(
    'import { defineDurable } from "@zapier/zapier-durable";',
    "const defineDurable = (name: string, fn: unknown) => ({ name, fn });",
  )
  .replace(
    'import { createZapierSdk } from "@zapier/zapier-sdk";',
    "const createZapierSdk = () => ({ fetch: async (..._: unknown[]): Promise<any> => { throw new Error('no network in tests'); } });",
  );
if (src.includes("@zapier/")) throw new Error("unstubbed @zapier import left in source");
src += "\nexport const __test = { corroborate, contactSummary, jevVerdict, isRetryableJevStatus, JEV_QUESTIONS };\n";

const tmpTs = join(dir, ".corroborate-under-test.ts");
const outDir = join(dir, ".corroborate-under-test-out");
writeFileSync(tmpTs, src);
let mod;
try {
  execFileSync(
    "npx",
    ["tsc", tmpTs, "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler",
     "--skipLibCheck", "--noCheck", "--outDir", outDir],
    { cwd: dir, stdio: "inherit" },
  );
  mod = await import(pathToFileURL(join(outDir, ".corroborate-under-test.js")));
} finally {
  unlinkSync(tmpTs);
  rmSync(outDir, { recursive: true, force: true });
}
const { corroborate, contactSummary, jevVerdict, isRetryableJevStatus, JEV_QUESTIONS } = mod.__test;

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

// --- page fixtures, shaped like a Notion page read ------------------------------
const rt = (s) => [{ plain_text: s }];
const page = (props) => ({ id: "x", gone: false, createdTime: null, properties: props });
const contact = ({ name, first, last, email, secondary, linkedin, note, company } = {}) =>
  page({
    Name: { type: "title", title: name ? rt(name) : [] },
    "First Name": { type: "rich_text", rich_text: first ? rt(first) : [] },
    "Last Name": { type: "rich_text", rich_text: last ? rt(last) : [] },
    "Primary Email": { type: "email", email: email ?? null },
    "Secondary Email": { type: "multi_select", multi_select: (secondary ?? []).map((n) => ({ name: n })) },
    Linkedin: { type: "url", url: linkedin ?? null },
    Note: { type: "rich_text", rich_text: note ? rt(note) : [] },
    Company: { type: "rollup", rollup: { type: "array", array: company ? [{ type: "title", title: rt(company) }] : [] } },
    "Duplicate of": { type: "relation", relation: [] },
    Mailing: { type: "checkbox", checkbox: false },
  });

// --- which declines Jev may look at --------------------------------------------
const ustaz = contact({ name: "Ustaz Syakir", first: "Ustaz", last: "Syakir", email: "sykreativ@gmail.com" });
const syakir = contact({ name: "Syakir Samsaimon", email: "syakir@alfalah.sg", note: "Also known as Ustaz Syakir." });

check("name mismatch with no LinkedIn is Jev-eligible",
  [corroborate(ustaz, syakir).merge, corroborate(ustaz, syakir).jevEligible],
  [false, true]);

check("different LinkedIn profiles are a hard decline Jev never sees",
  (() => {
    const v = corroborate(
      contact({ name: "Lionel Sim", linkedin: "https://linkedin.com/in/lionel-sim" }),
      contact({ name: "Sachin Kolekar", linkedin: "https://linkedin.com/in/sachin-k" }));
    return [v.merge, v.jevEligible ?? false];
  })(),
  [false, false]);

check("equivalent names still merge on the rules alone, no Jev call",
  (() => { const v = corroborate(contact({ name: "Sim Lionel" }), contact({ name: "Lionel Sim" })); return [v.merge, v.jevEligible ?? false]; })(),
  [true, false]);

check("same LinkedIn profile still merges on the rules alone",
  corroborate(contact({ name: "A B", linkedin: "https://www.linkedin.com/in/marcuscheu/" }),
              contact({ name: "C D", linkedin: "http://linkedin.com/in/marcuscheu" })).merge,
  true);

// --- what Jev is shown ----------------------------------------------------------
check("summary keeps identity fields, drops empties and non-identity properties",
  contactSummary(contact({ name: "Alasdair Bell", first: "Alasdair", last: "Bell", email: "ab@alasdairbell.com",
    secondary: ["alasdair.bell@gmail.com"], linkedin: "https://linkedin.com/in/alasdairbell", company: "Bell & Co" })),
  { Name: "Alasdair Bell", "First Name": "Alasdair", "Last Name": "Bell", "Primary Email": "ab@alasdairbell.com",
    "Secondary Email": ["alasdair.bell@gmail.com"], Linkedin: "https://linkedin.com/in/alasdairbell", Company: ["Bell & Co"] });

check("a placeholder record summarises to just what it has",
  contactSummary(contact({ name: "New Contact", first: "New", last: "Contact", email: "ab@alasdairbell.com" })),
  { Name: "New Contact", "First Name": "New", "Last Name": "Contact", "Primary Email": "ab@alasdairbell.com" });

check("long notes are capped",
  contactSummary(contact({ name: "A B", note: "x".repeat(2000) })).Note.length,
  600);

check("questions are one yes/no and one 4-level score",
  [JEV_QUESTIONS.same_person.type, JEV_QUESTIONS.evidence.type, JEV_QUESTIONS.evidence.criteria.length],
  ["noul", "score", 4]);

// --- Jev answers -> decision (real jev-1.13.0 scores from the offline check) ------
const answer = (p, e) => ({ model: "jev-1.13.0", answers: { same_person: { type: "noul", noul: p }, evidence: { type: "score", score: e } } });

check("Ustaz Syakir / Syakir Samsaimon (0.96, 2.37) merges", jevVerdict(answer(0.96, 2.37)).merge, true);
check("New Contact / Alasdair Bell (0.88, 2.01) merges", jevVerdict(answer(0.88, 2.01)).merge, true);
check("one shared address, different names (0.07, 0.99) declines", jevVerdict(answer(0.07, 0.99)).merge, false);
check("two Grace Tangs (0.35, 1.03) declines", jevVerdict(answer(0.35, 1.03)).merge, false);
check("confident but weak evidence (0.9, 1.5) declines: both bars must clear", jevVerdict(answer(0.9, 1.5)).merge, false);
check("strong evidence but unsure (0.6, 2.5) declines", jevVerdict(answer(0.6, 2.5)).merge, false);
check("a malformed response declines rather than merges",
  [jevVerdict({}).merge, jevVerdict({ answers: { same_person: { noul: 0.99 } } }).merge],
  [false, false]);
check("the reason carries the scores and the model",
  jevVerdict(answer(0.96, 2.37)).reason.includes("jev-1.13.0: same person 0.96, evidence 2.4/3"),
  true);

check("only 429 and 5xx retry",
  [429, 500, 503, 400, 401, 422].map(isRetryableJevStatus),
  [true, true, true, false, false, false]);

// -------------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n${failures}/${count} assertions FAILED`);
  process.exit(1);
}
console.log(`\nall ${count} assertions passed`);
