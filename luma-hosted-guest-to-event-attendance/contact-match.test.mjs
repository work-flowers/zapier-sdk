// Offline assertions over the real contact-reuse rule in workflow.ts — no
// Zapier calls, no credentials. Run with `npm test` from this directory.
//
// workflow.ts can't be imported directly (createZapierSdk() and defineDurable()
// run at module load), so this harness stubs those two imports, strips the
// types with the local tsc, and imports the emitted JS.
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
    "const createZapierSdk = (): any => ({});",
  );
if (src.includes("@zapier/")) throw new Error("unstubbed @zapier import left in source");

const tmpTs = join(dir, ".contact-match-under-test.ts");
const outDir = join(dir, ".contact-match-under-test-out");
writeFileSync(tmpTs, src);
let mod;
try {
  execFileSync(
    "npx",
    ["tsc", tmpTs, "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler",
     "--skipLibCheck", "--noCheck", "--outDir", outDir],
    { cwd: dir, stdio: "inherit" },
  );
  mod = await import(pathToFileURL(join(outDir, ".contact-match-under-test.js")));
} finally {
  unlinkSync(tmpTs);
  rmSync(outDir, { recursive: true, force: true });
}
const { pickSameOrgNameMatch, sharedDomainsWithSoleMatch, flagCandidateReasons, decideFlag, linkedinConflict } = mod;

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

const verdicts = {
  "aheadgaining.com": "organisation",
  "gmail.com": "personal",
  "eber.co": "organisation",
  "icai-aviation.org": "organisation",
  "makenotion.com": "organisation",
};
const m = (id, emails, isMergedAway = false) => ({ id, emails, isMergedAway });

// Manuel Denoual, 2026-10-19: the case this rule exists for.
const manuelOriginal = m("orig", ["manuel.denoual@aheadgaining.com"]);
check(
  "Manuel: sole name match at the same organisation domain is reused",
  pickSameOrgNameMatch([manuelOriginal], ["manuel@aheadgaining.com"], verdicts),
  { id: "orig", domain: "aheadgaining.com" },
);
check(
  "Manuel today: the merged-away duplicate is not a rival, original still reused",
  pickSameOrgNameMatch(
    [m("orig", ["manuel.denoual@aheadgaining.com", "manuel@aheadgaining.com"]), m("dupe", ["manuel@aheadgaining.com"], true)],
    ["manuel@aheadgaining.com"],
    verdicts,
  ),
  { id: "orig", domain: "aheadgaining.com" },
);
check(
  "Manuel: shared domain is what gets sent for judging",
  sharedDomainsWithSoleMatch([manuelOriginal], ["manuel@aheadgaining.com"]),
  ["aheadgaining.com"],
);

// The cases a name alone must never merge.
check(
  "same name, personal domain only -> create + flag",
  pickSameOrgNameMatch([m("a", ["lionel@gmail.com"])], ["lionel.sim@gmail.com"], verdicts),
  null,
);
check(
  "Grace Tang (real): only gmail.com shared -> no reuse",
  pickSameOrgNameMatch(
    [m("a", ["grace@linkby.com", "grace.tang.ym@gmail.com", "grace@work.flowers"])],
    ["tepg.grace@gmail.com", "grace@leaps.sg"],
    { ...verdicts, "linkby.com": "organisation", "work.flowers": "organisation", "leaps.sg": "organisation" },
  ),
  null,
);
check(
  "Ian Lim (real): different organisations -> no reuse",
  pickSameOrgNameMatch([m("a", ["ian@eber.co"])], ["ian_lim@icai-aviation.org"], verdicts),
  null,
);
check(
  "Nancy Chen (real): personal vs organisation -> no reuse",
  pickSameOrgNameMatch([m("a", ["nchen@makenotion.com"])], ["nancy.y.chen@gmail.com"], verdicts),
  null,
);
check(
  "two live same-name contacts, even at the same org -> ambiguous, no reuse",
  pickSameOrgNameMatch(
    [m("a", ["j.tan@acme.com"]), m("b", ["john.tan@acme.com"])],
    ["john@acme.com"],
    { "acme.com": "organisation" },
  ),
  null,
);
check(
  "two live same-name contacts -> nothing sent for judging",
  sharedDomainsWithSoleMatch([m("a", ["j.tan@acme.com"]), m("b", ["x@acme.com"])], ["john@acme.com"]),
  [],
);
check(
  "unjudged shared domain (Jev unavailable for it) -> no reuse",
  pickSameOrgNameMatch([m("a", ["x@newco.io"])], ["y@newco.io"], verdicts),
  null,
);
check(
  "no verdicts at all -> no reuse",
  pickSameOrgNameMatch([manuelOriginal], ["manuel@aheadgaining.com"], null),
  null,
);
check("no name matches -> no reuse", pickSameOrgNameMatch([], ["manuel@aheadgaining.com"], verdicts), null);
check(
  "only a merged-away match -> no reuse",
  pickSameOrgNameMatch([m("dupe", ["manuel@aheadgaining.com"], true)], ["manuel@aheadgaining.com"], verdicts),
  null,
);
check(
  "an answer address can supply the shared org domain",
  pickSameOrgNameMatch([manuelOriginal], ["manuel.d@gmail.com", "manuel@aheadgaining.com"], verdicts),
  { id: "orig", domain: "aheadgaining.com" },
);
check(
  "domain comparison is case-insensitive",
  pickSameOrgNameMatch([manuelOriginal], ["Manuel@AheadGaining.com"], verdicts),
  { id: "orig", domain: "aheadgaining.com" },
);

// --- Possible-duplicate flags (looser candidates + Jev) ----------------------
// Pairs from the 2026-10-21 offline check over the live Contacts.
const rec = (name, emails = [], linkedin = null, first = "", last = "") => ({ name, first, last, emails, linkedin });
const none = new Set();
const reasons = (a, b, rare = none) => flagCandidateReasons(a, b, rare);

check("Ustaz Syakir / Syakir Samsaimon: a shared rare name word is a candidate",
  reasons(rec("Ustaz Syakir", ["sykreativ@gmail.com"]), rec("Syakir Samsaimon", ["syakir@alfalah.sg"]), new Set(["syakir"])),
  ["shared-rare-token"]);
check("...but not when the word is common",
  reasons(rec("Ustaz Syakir", ["sykreativ@gmail.com"]), rec("Syakir Samsaimon", ["syakir@alfalah.sg"])),
  []);
check("Appi / Appireddy Pamulapati: same surname, shortened given name, same mailbox",
  reasons(rec("Appi Pamulapati", ["appi@knoxxfoods.com"]), rec("Appireddy Pamulapati", ["appi@knoxxinnovations.com"])),
  ["surname+compatible-first", "same-local-part"]);
check("annag579 Gibeva / Anna Gibaeva: the mailbox spells the other's name",
  reasons(rec("annag579 Gibeva", ["annagibaeva05@gmail.com"], null, "annag579", "Gibeva"),
          rec("Anna Gibaeva", ["anna.gibaeva@effem.com"])).includes("local-part-spells-name"),
  true);
check("a contact titled with its email is matched on First/Last Name",
  reasons(rec("alemga@kinnai.com", ["alemga@kinnai.com"], null, "Alex", "Marin Gasga"),
          rec("Alex Marin Gasga", ["alexmga@kiinnai.com"], "https://linkedin.com/in/alexmga")),
  ["exact-name"]);
check("Jin Keat Lai / Jin Keat Keat: the same LinkedIn profile",
  reasons(rec("Jin Keat Lai", ["keat@skiesfifty.com"], "https://linkedin.com/in/keatlai"),
          rec("Jin Keat Keat", ["keat@terrascope.com"], "http://www.linkedin.com/in/keatlai/")),
  ["same-local-part", "same-linkedin"]);
check("role mailboxes are not a signal",
  reasons(rec("Kathy Sheehy", ["hello@kittykat.world"]), rec("Des Moran", ["hello@other.world"])),
  []);
check("Mike Lim / Mike M: a two-edit name difference is only a candidate, not a flag",
  reasons(rec("Mike Lim", ["mike@insightout.com.sg"]), rec("Mike M", ["mike.mediouni@tictek.co"])),
  ["fuzzy-name"]);

const cand = (r, ...why) => ({ id: "c", record: r, reasons: why });
const gtang = rec("Grace Tang", ["grace@linkby.com"], "https://linkedin.com/in/gtang1");
check("exact name flags without Jev",
  decideFlag(rec("Nancy Chen", ["nancy.y.chen@gmail.com"]), cand(rec("Nancy Chen", ["nchen@makenotion.com"]), "exact-name"), null).flag,
  true);
check("a LinkedIn conflict never flags, even on an exact name (the two Grace Tangs)",
  decideFlag(gtang, cand(rec("Grace Tang", ["grace@leaps.sg"], "https://linkedin.com/in/tangenpinggrace"), "exact-name"), 0.99).flag,
  false);
check("non-exact: Jev 0.84 (Anna's score) flags, 0.46 (the highest different pair) does not, no score does not",
  [0.84, 0.46, null].map((p) => decideFlag(rec("A B"), cand(rec("A C"), "fuzzy-name"), p).flag),
  [true, false, false]);
check("the bar is 0.6",
  [0.59, 0.6].map((p) => decideFlag(rec("A B"), cand(rec("A C"), "fuzzy-name"), p).flag),
  [false, true]);
check("LinkedIn on one side only is no conflict",
  linkedinConflict("https://linkedin.com/in/x", null), false);

console.log(`\n${count - failures}/${count} passed`);
if (failures) process.exit(1);
