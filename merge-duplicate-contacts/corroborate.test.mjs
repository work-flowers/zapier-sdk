// Offline assertions over the real merge-decision code in workflow.ts — no Zapier
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
src += "\nexport const __test = { corroborate, archiveBlocker, isAlreadyTrashed };\n";

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
const { corroborate, archiveBlocker, isAlreadyTrashed } = mod.__test;

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

// --- a person set Duplicate of: merge unless the records contradict it ----------
check("different LinkedIn profiles are a hard decline",
  corroborate(
    contact({ name: "Lionel Sim", linkedin: "https://linkedin.com/in/lionel-sim" }),
    contact({ name: "Sachin Kolekar", linkedin: "https://linkedin.com/in/sachin-k" })).merge,
  false);

check("a LinkedIn conflict declines even when the names are equivalent",
  corroborate(
    contact({ name: "Grace Tang", linkedin: "https://linkedin.com/in/grace-tang-1" }),
    contact({ name: "Tang Grace", linkedin: "https://linkedin.com/in/grace-tang-2" })).merge,
  false);

check("equivalent names merge",
  corroborate(contact({ name: "Sim Lionel" }), contact({ name: "Lionel Sim" })).merge,
  true);

check("same LinkedIn profile merges",
  corroborate(contact({ name: "A B", linkedin: "https://www.linkedin.com/in/marcuscheu/" }),
              contact({ name: "C D", linkedin: "http://linkedin.com/in/marcuscheu" })).merge,
  true);

check("different names, no LinkedIn conflict: the person's call stands (Anna Gibaeva, 2026-10-21)",
  corroborate(
    contact({ name: "annag579 Gibeva", email: "annagibaeva05@gmail.com" }),
    contact({ name: "Anna Gibaeva", email: "anna.gibaeva@effem.com", linkedin: "https://www.linkedin.com/in/annagibaeva" })).merge,
  true);

check("LinkedIn on one side only is not a conflict",
  corroborate(contact({ name: "Ustaz Syakir" }),
              contact({ name: "Syakir Samsaimon", linkedin: "https://linkedin.com/in/syakir" })).merge,
  true);

check("the reason says a person decided when the names differ",
  corroborate(contact({ name: "New Contact" }), contact({ name: "Alasdair Bell" })).reason.startsWith("set by a person"),
  true);

// --- archiving the merged source -----------------------------------------------
check("a newer source with no page content is trashed",
  archiveBlocker({ hasContent: false, sourceOlder: false }), null);
check("page content blocks the trash (content is not merged)",
  archiveBlocker({ hasContent: true, sourceOlder: false }) !== null, true);
check("an unreadable content check blocks the trash",
  archiveBlocker({ hasContent: null, sourceOlder: false }) !== null, true);
check("an older source blocks the trash (Duplicate of may point the wrong way)",
  archiveBlocker({ hasContent: false, sourceOlder: true }) !== null, true);
check("Notion's already-archived 400 reads as success; nothing else does",
  [
    isAlreadyTrashed(400, '{"message":"Can\'t edit block that is archived. You must unarchive the block before editing."}'),
    isAlreadyTrashed(400, '{"message":"body failed validation"}'),
    isAlreadyTrashed(404, "archived"),
    isAlreadyTrashed(500, "archived"),
  ],
  [true, false, false, false]);

// -------------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n${failures}/${count} assertions FAILED`);
  process.exit(1);
}
console.log(`\nall ${count} assertions passed`);
