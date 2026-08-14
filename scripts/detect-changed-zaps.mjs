#!/usr/bin/env node
// Detect which Zap directories a set of changed files touches, and classify
// what (if anything) would need republishing to Zapier.
//
// This is the shared detection layer. Today it powers the DRY-RUN GitHub Action
// (.github/workflows/publish-zaps.yml), which only *reports*. A future
// real-publish action can import `detectChangedZaps()` so detection logic lives
// in exactly one place and stays testable off-CI.
//
// It NEVER talks to Zapier and NEVER publishes — it only reads the working tree
// and prints a report. Safe to run locally.
//
// Usage:
//   node scripts/detect-changed-zaps.mjs --base <sha> --head <sha>   # diff two commits
//   node scripts/detect-changed-zaps.mjs --files a/x.ts b/y.ts       # explicit file list
//   node scripts/detect-changed-zaps.mjs --base <sha> --head <sha> --json
//
// Env fallbacks (used by CI): BASE_SHA, HEAD_SHA. If GITHUB_STEP_SUMMARY is set,
// the Markdown report is also appended there so it shows up in the Actions run.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

// A source change to one of these means the deployed durable code changed and a
// republish would be needed. README/zap.json-only edits do not, on their own,
// change what runs on Zapier.
const SOURCE_EXT = new Set([".ts"]);
const SOURCE_FILES = new Set(["package.json", "package-lock.json"]);

function parseArgs(argv) {
  const args = { files: null, base: null, head: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--base") args.base = argv[++i];
    else if (a === "--head") args.head = argv[++i];
    else if (a === "--files") {
      args.files = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) args.files.push(argv[++i]);
    }
  }
  if (!args.base) args.base = process.env.BASE_SHA || null;
  if (!args.head) args.head = process.env.HEAD_SHA || null;
  return args;
}

function changedFiles(args) {
  if (args.files) return args.files;
  if (args.base && args.head) {
    const out = execFileSync("git", ["diff", "--name-only", `${args.base}`, `${args.head}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  }
  throw new Error("Provide --files, or --base and --head (or BASE_SHA/HEAD_SHA env vars).");
}

function topLevelDir(path) {
  const idx = path.indexOf("/");
  return idx === -1 ? null : path.slice(0, idx);
}

function isSourceFile(relPath) {
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  if (SOURCE_FILES.has(name)) return true;
  const dot = name.lastIndexOf(".");
  return dot !== -1 && SOURCE_EXT.has(name.slice(dot));
}

function readJson(absPath) {
  try {
    return JSON.parse(readFileSync(absPath, "utf8"));
  } catch {
    return null;
  }
}

// Given a durable directory's zap.json and the list of files that changed inside
// it, work out which deployed workflow(s) are affected. Handles all three shapes
// this repo uses:
//   1. single deployment  -> top-level workflow_id
//   2. deployments[] with a shared source file (e.g. luma workflow.ts)
//   3. deployments[] each with its own entry_file + a shared module (sync.ts):
//      a shared-module change hits ALL deployments; an entry-file change hits
//      only that one. We take the union.
function affectedDeployments(zap, changedSourceFilesInDir) {
  const deployments = Array.isArray(zap?.deployments)
    ? zap.deployments
    : zap?.workflow_id
      ? [{ name: zap.name || null, workflow_id: zap.workflow_id, enabled: zap.enabled, entry_file: "workflow.ts" }]
      : [];

  const entryFiles = new Set(deployments.map((d) => d.entry_file).filter(Boolean));
  const changedSet = new Set(changedSourceFilesInDir);

  // Any changed source file that isn't a named per-deployment entry file is
  // treated as shared (module, package.json, or a plain workflow.ts) -> all.
  const sharedChanged = changedSourceFilesInDir.some((f) => !entryFiles.has(f));

  const affected = [];
  for (const d of deployments) {
    const hitByOwnEntry = d.entry_file && changedSet.has(d.entry_file);
    if (sharedChanged || hitByOwnEntry) affected.push(d);
  }
  return { deployments, affected };
}

export function detectChangedZaps(files) {
  // Group changed files by their top-level directory.
  const byDir = new Map();
  for (const f of files) {
    const dir = topLevelDir(f);
    if (!dir || dir.startsWith(".")) continue; // skip root files, .github, .agents, .claude
    if (dir === "scripts") continue;
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(f);
  }

  const results = [];
  for (const [dir, dirFiles] of [...byDir.entries()].sort()) {
    const abs = join(REPO_ROOT, dir);
    const hasZapJson = existsSync(join(abs, "zap.json"));
    const hasCodeStep = existsSync(join(abs, "code-step.js"));

    // Files inside this dir, made relative to the dir (e.g. "workflow.ts").
    const rel = dirFiles.map((f) => f.slice(dir.length + 1));
    const changedSource = rel.filter(isSourceFile);

    if (hasZapJson) {
      const zap = readJson(join(abs, "zap.json"));
      const { deployments, affected } = affectedDeployments(zap, changedSource);
      results.push({
        dir,
        kind: "durable",
        connections: zap?.connections || {},
        zapierDurableVersion: zap?.zapier_durable_version || null,
        totalDeployments: deployments.length,
        wouldRepublish: changedSource.length > 0,
        changedFiles: rel,
        changedSource,
        affected: affected.map((d) => ({
          name: d.name,
          workflowId: d.workflow_id,
          enabled: d.enabled,
        })),
      });
    } else if (hasCodeStep) {
      results.push({
        dir,
        kind: "classic-code-step",
        wouldRepublish: false, // classic Zaps have no durable publish command
        changedFiles: rel,
        changedSource,
      });
    } else {
      results.push({ dir, kind: "non-zap", changedFiles: rel });
    }
  }
  return results;
}

function renderMarkdown(results) {
  const durables = results.filter((r) => r.kind === "durable");
  const republish = durables.filter((r) => r.wouldRepublish);
  const metaOnly = durables.filter((r) => !r.wouldRepublish);
  const classic = results.filter((r) => r.kind === "classic-code-step");
  const other = results.filter((r) => r.kind === "non-zap");

  const lines = [];
  lines.push("## 🧪 Zap publish — dry run");
  lines.push("");
  lines.push("_Detection only. Nothing was published to Zapier._");
  lines.push("");

  if (republish.length === 0) {
    lines.push("**No Zap source changed — nothing would be republished.**");
  } else {
    const count = republish.reduce((n, r) => n + r.affected.length, 0);
    lines.push(`**Would republish ${count} deployment(s) across ${republish.length} Zap director(y/ies):**`);
    lines.push("");
    lines.push("| Zap directory | Deployment | Workflow ID | Enabled | Changed source |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const r of republish) {
      const srcList = r.changedSource.join(", ");
      if (r.affected.length === 0) {
        // Source changed but no deployment matched (e.g. deployments[] empty / not-deployed dir).
        lines.push(`| \`${r.dir}\` | _(no deployed workflow in zap.json)_ | — | — | ${srcList} |`);
      }
      for (const d of r.affected) {
        lines.push(
          `| \`${r.dir}\` | ${d.name || "—"} | \`${d.workflowId || "—"}\` | ${d.enabled === false ? "⏸️ no" : "✅ yes"} | ${srcList} |`,
        );
      }
    }
  }
  lines.push("");

  if (metaOnly.length) {
    lines.push("<details><summary>Durable dirs with metadata/README-only changes (no republish)</summary>");
    lines.push("");
    for (const r of metaOnly) lines.push(`- \`${r.dir}\` — ${r.changedFiles.join(", ")}`);
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  if (classic.length) {
    lines.push("### ⚠️ Classic Code-step Zap(s) changed — publish manually");
    lines.push("");
    lines.push("These have no durable publish command; update the Zap's code step in the Zapier UI.");
    for (const r of classic) lines.push(`- \`${r.dir}\` — ${r.changedFiles.join(", ")}`);
    lines.push("");
  }

  if (other.length) {
    lines.push("<details><summary>Other changed directories (ignored)</summary>");
    lines.push("");
    for (const r of other) lines.push(`- \`${r.dir}\``);
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  lines.push("---");
  lines.push(
    "> When this graduates from dry run to real publishing, each affected deployment is republished with " +
      "`publish-workflow-version` using the connections, dependencies, durable version, trigger, and enabled " +
      "state recorded in its `zap.json`, and the new `current_version_id` is synced back (repo rule 4).",
  );
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = changedFiles(args);
  const results = detectChangedZaps(files);

  if (args.json) {
    process.stdout.write(JSON.stringify({ changedFiles: files, results }, null, 2) + "\n");
    return;
  }

  const md = renderMarkdown(results);
  process.stdout.write(md + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  }
}

// Only run as a CLI when invoked directly, not when imported.
if (process.argv[1] && process.argv[1].endsWith("detect-changed-zaps.mjs")) {
  main();
}
