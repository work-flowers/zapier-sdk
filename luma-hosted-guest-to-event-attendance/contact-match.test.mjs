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
const { pickSameOrgNameMatch, sharedDomainsWithSoleMatch } = mod;

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

console.log(`\n${count - failures}/${count} passed`);
if (failures) process.exit(1);
