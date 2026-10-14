// Replays jev-cases.json through the real corroborate / contactSummary /
// jevVerdict code and JEV_QUESTIONS in workflow.ts, against the live Jev API.
// READ-ONLY: Notion pages are read, nothing is written. Each Jev call goes
// through the `typesafe` connection and costs a Zapier task.
//
//   node replay-jev.mjs [cases.json] [questions.json]
//
// Needs a logged-in Zapier SDK CLI (`npx zapier-sdk-experimental login`).
// Requests go out through the CLI's `fetch` command rather than the SDK
// in-process, which hangs locally. A case is either {source, target} page ids
// (read live, so a deleted page reads as empty) or literal {a, b} summaries.
import { readFileSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = dirname(fileURLToPath(import.meta.url));
const zap = JSON.parse(readFileSync(join(dir, "zap.json"), "utf8"));
const [casesPath = join(dir, "jev-cases.json"), questionsPath] = process.argv.slice(2);

const shim = `const sdk = { fetch: async (url: string, init: any = {}) => {
  const args = ["zapier-sdk-experimental", "fetch", url, "--json", "--connection", init.connection];
  if (init.method) args.push("--method", init.method);
  if (init.headers) args.push("--headers", JSON.stringify(init.headers));
  if (init.body) args.push("--body", init.body);
  const r = JSON.parse(execFileSync("npx", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 26 }));
  const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
  return { status: r.statusCode, ok: r.statusCode < 300, text: async () => text, json: async () => JSON.parse(text) };
} };`;

let src = readFileSync(join(dir, "workflow.ts"), "utf8")
  .replace('import { defineDurable } from "@zapier/zapier-durable";',
    "const defineDurable = (name: string, fn: unknown) => ({ name, fn });")
  .replace('import { createZapierSdk } from "@zapier/zapier-sdk";', 'import { execFileSync } from "node:child_process";')
  .replace("const sdk = createZapierSdk();", shim)
  .replace('const NOTION_CONNECTION = "notion_wf";', `const NOTION_CONNECTION = "${zap.connections.notion_wf}";`)
  .replace('const JEV_CONNECTION = "typesafe";', `const JEV_CONNECTION = "${zap.connections.typesafe}";`);
if (src.includes("@zapier/") || src.includes("createZapierSdk")) throw new Error("unreplaced SDK import left in source");
src += "\nexport const __h = { sdk, readPage, corroborate, contactSummary, jevVerdict, JEV_QUESTIONS, JEV_URL, JEV_CONNECTION, JEV_MODEL };\n";

const tmpTs = join(dir, ".replay-under-test.ts");
const outDir = join(dir, ".replay-under-test-out");
writeFileSync(tmpTs, src);
let h;
try {
  execFileSync("npx", ["tsc", tmpTs, "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler",
    "--skipLibCheck", "--noCheck", "--outDir", outDir], { cwd: dir, stdio: "inherit" });
  ({ __h: h } = await import(pathToFileURL(join(outDir, ".replay-under-test.js"))));
} finally {
  unlinkSync(tmpTs);
}

const cases = JSON.parse(readFileSync(casesPath, "utf8"));
const questions = questionsPath ? JSON.parse(readFileSync(questionsPath, "utf8")) : h.JEV_QUESTIONS;
let wrong = 0;
try {
  for (const c of cases) {
    let a = c.a, b = c.b, rules = "";
    if (c.source) {
      const s = await h.readPage(c.source), t = await h.readPage(c.target);
      const v = h.corroborate(s, t);
      if (!v.jevEligible) rules = v.merge ? " (rules merge, Jev not asked)" : " (rules hard decline, Jev not asked)";
      a = h.contactSummary(s); b = h.contactSummary(t);
    }
    const res = await h.sdk.fetch(h.JEV_URL, { connection: h.JEV_CONNECTION, method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: h.JEV_MODEL, state: { record_a: a, record_b: b }, questions }) });
    const v = h.jevVerdict(await res.json());
    const ok = v.merge === (c.truth === "same");
    if (!ok) wrong++;
    console.log(`${ok ? "ok  " : "WRONG"} ${c.label} [${c.truth}]${rules} -> ${v.merge ? "merge" : "decline"}: ${v.reason}`);
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
console.log(`\n${cases.length - wrong}/${cases.length} as expected`);
process.exitCode = wrong ? 1 : 0;
