#!/usr/bin/env node
// Publish the durable Zaps affected by a merge, and sync current_version_id
// back into each zap.json (repo rule 4).
//
// Consumes the same detection layer as the dry run (detectChangedZaps), then,
// for each affected deployment, mirrors the workflows-modify "direct publish"
// path: fetch the DEPLOYED version's metadata, rebuild source_files from the
// repo, and republish carrying that metadata forward — dependencies, durable
// version, connections, app-versions, and the exact trigger-vs-manual start
// mode. Getting the start mode wrong silently drops a live trigger, so this
// script REFUSES (non-zero exit, nothing published) on anything ambiguous
// rather than guessing:
//   - the workflow has an open draft (a direct publish would 409 anyway),
//   - the trigger signals disagree (saved trigger vs empty live triggers[]),
//   - a deployed source file has no counterpart in the repo,
//   - required metadata can't be read back.
//
// Auth: ZAPIER_CLIENT_ID / ZAPIER_CLIENT_SECRET in the environment.
//
// Usage:
//   node scripts/publish-changed-zaps.mjs --base <sha> --head <sha>            # PLAN only (no publish)
//   node scripts/publish-changed-zaps.mjs --base <sha> --head <sha> --execute  # publish + sync back
//
// Without --execute it prints the plan and touches nothing — a deeper dry run.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { detectChangedZaps } from "./detect-changed-zaps.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

function parseArgs(argv) {
  const args = { base: null, head: null, execute: false, files: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") args.execute = true;
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

// Prefer an explicit --files list (e.g. from `gh pr view --json files`, which is
// correct regardless of merge strategy). Fall back to a base..head git diff.
function changedFiles(args) {
  if (args.files) return args.files;
  if (!args.base || !args.head) fail("Provide --files, or --base and --head (or BASE_SHA/HEAD_SHA).");
  const out = execFileSync("git", ["diff", "--name-only", args.base, args.head], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

// ---- Zapier SDK CLI wrappers --------------------------------------------

const CLIENT_ID = process.env.ZAPIER_CLIENT_ID || "";
const CLIENT_SECRET = process.env.ZAPIER_CLIENT_SECRET || "";

// The CLI ships in @zapier/zapier-sdk-cli (bin: zapier-sdk); name the package
// so `npx` resolves it on a clean runner.
function sdkArgs(rest) {
  return [
    "--yes",
    "--package",
    "@zapier/zapier-sdk-cli",
    "zapier-sdk",
    "--experimental",
    ...rest,
    "--credentials-client-id",
    CLIENT_ID,
    "--credentials-client-secret",
    CLIENT_SECRET,
    "--json",
  ];
}

// Run a CLI command and parse its JSON. Throws with stderr on failure.
function sdk(rest) {
  const raw = execFileSync("npx", sdkArgs(rest), {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

// Some CLI responses wrap the payload in { data: ... }; some don't.
const unwrap = (x) => (x && typeof x === "object" && "data" in x ? x.data : x);

// ---- Publishing one deployment ------------------------------------------

function fail(msg) {
  throw new Error(msg);
}

// Build the source_files object to publish: exactly the file set that is
// currently deployed (its keys), with contents refreshed from the repo. The
// deployment's entry file fills the "workflow.ts" slot; every other deployed
// key must map 1:1 to a repo file of the same name (else we stop).
function buildSourceFiles(dir, deployedKeys, entryFile) {
  const out = {};
  for (const key of deployedKeys) {
    const repoRel = key === "workflow.ts" ? entryFile : key;
    const abs = join(REPO_ROOT, dir, repoRel);
    if (!existsSync(abs)) {
      fail(
        `Deployed source file "${key}" (repo ${dir}/${repoRel}) is missing from the repo — ` +
          `refusing to publish a different file set than what is live.`,
      );
    }
    out[key] = readFileSync(abs, "utf8");
  }
  return out;
}

// Returns { newVersionId } after publishing, or the plan object when !execute.
function publishDeployment(dir, dep, currentVersionId, execute) {
  const id = dep.workflowId;
  if (!id) fail(`${dir}: deployment "${dep.name}" has no workflow_id`);
  if (!currentVersionId) fail(`${dir}: deployment "${dep.name}" has no current_version_id in zap.json`);

  // 1. Refuse if an open draft exists — a direct publish would be rejected,
  //    and folding into a draft is a human decision (workflows-modify 6A).
  const drafts = unwrap(sdk(["list-workflow-drafts", id])) || [];
  if (Array.isArray(drafts) && drafts.length > 0) {
    fail(`${dir}: workflow ${id} has ${drafts.length} open draft(s); resolve them in the editor before CI can publish.`);
  }

  // 2. Read back the deployed version's metadata (the authoritative source of
  //    what to carry forward).
  const version = unwrap(sdk(["get-workflow-version", id, currentVersionId]));
  const wf = unwrap(sdk(["get-workflow", id]));

  const deployedSources = version?.source_files || {};
  const deployedKeys = Object.keys(deployedSources);
  if (deployedKeys.length === 0) fail(`${dir}: deployed version ${currentVersionId} reported no source_files`);

  const dependencies = version?.dependencies ?? null;
  const durableVersion = version?.zapier_durable_version ?? null;
  const connections = version?.connections ?? null;
  const appVersions = version?.app_versions ?? null;
  const triggerCfg = version?.trigger ?? null;

  // 3. Determine start mode from BOTH signals and refuse if they disagree.
  const liveTriggers = Array.isArray(wf?.triggers) ? wf.triggers : [];
  const hasSavedTrigger = triggerCfg != null;
  const hasLiveTrigger = liveTriggers.length > 0;
  let startMode;
  if (hasSavedTrigger && hasLiveTrigger) startMode = "trigger";
  else if (!hasSavedTrigger && !hasLiveTrigger) startMode = "manual";
  else {
    fail(
      `${dir}: trigger signals disagree for ${id} ` +
        `(saved trigger: ${hasSavedTrigger}, live triggers[]: ${hasLiveTrigger}). ` +
        `Refusing to publish — reconcile in the Zapier editor first.`,
    );
  }

  // 4. Enabled state to preserve.
  const enabled = typeof wf?.enabled === "boolean" ? wf.enabled : undefined;

  // 5. Rebuild source_files from the repo (fresh contents, same file set).
  const sourceFiles = buildSourceFiles(dir, deployedKeys, dep.entryFile || "workflow.ts");

  const plan = {
    dir,
    name: dep.name,
    workflowId: id,
    fromVersion: currentVersionId,
    startMode,
    enabled,
    sourceFileKeys: deployedKeys,
    entryFile: dep.entryFile || "workflow.ts",
    hasDependencies: dependencies != null,
    hasConnections: connections != null,
    hasAppVersions: appVersions != null,
  };

  if (!execute) return { plan };

  // 6. Publish, carrying every piece of metadata forward.
  const rest = ["publish-workflow-version", id, JSON.stringify(sourceFiles)];
  if (dependencies != null) rest.push("--dependencies", JSON.stringify(dependencies));
  if (durableVersion != null) rest.push("--zapier-durable-version", String(durableVersion));
  if (connections != null) rest.push("--connections", JSON.stringify(connections));
  if (appVersions != null) rest.push("--app-versions", JSON.stringify(appVersions));
  if (startMode === "trigger") rest.push("--trigger", JSON.stringify(triggerCfg));
  else rest.push("--manual");
  if (enabled === false) rest.push("--enabled", "false"); // never re-enable a disabled Zap

  const published = unwrap(sdk(rest));
  const newVersionId = published?.version?.id || published?.id || published?.version_id || null;
  if (!newVersionId) fail(`${dir}: publish of ${id} returned no new version id — response: ${JSON.stringify(published)}`);

  // 7. Verify the start mode survived.
  const after = unwrap(sdk(["get-workflow", id]));
  const afterTriggers = Array.isArray(after?.triggers) ? after.triggers : [];
  if (startMode === "trigger" && afterTriggers.length === 0) {
    fail(`${dir}: PUBLISHED but the trigger was dropped (triggers[] empty) on ${id} — needs immediate attention.`);
  }
  if (startMode === "manual" && afterTriggers.length > 0) {
    fail(`${dir}: PUBLISHED but a trigger appeared unexpectedly on ${id} — needs attention.`);
  }

  return { plan, newVersionId };
}

// ---- zap.json sync-back --------------------------------------------------

// Replace ONLY the current_version_id value in place, leaving the rest of the
// file byte-for-byte. A JSON parse→stringify round-trip would reformat the whole
// file (e.g. re-encoding \uXXXX escapes as literal characters), producing noisy
// diffs on every publish. Version ids are unique, so we target the exact old id
// where it sits as a current_version_id value — which is the right deployment's
// entry in a multi-deployment file, since each carries a distinct id.
function syncBackVersionId(dir, oldVersionId, newVersionId) {
  const abs = join(REPO_ROOT, dir, "zap.json");
  const raw = readFileSync(abs, "utf8");
  const re = new RegExp('("current_version_id":\\s*")' + oldVersionId + '(")');
  if (!re.test(raw)) {
    fail(`${dir}: could not find current_version_id "${oldVersionId}" in zap.json to sync back`);
  }
  writeFileSync(abs, raw.replace(re, `$1${newVersionId}$2`));
}

// ---- main ----------------------------------------------------------------

function loadCurrentVersionId(dir, workflowId) {
  const zap = JSON.parse(readFileSync(join(REPO_ROOT, dir, "zap.json"), "utf8"));
  if (Array.isArray(zap.deployments)) {
    const d = zap.deployments.find((x) => x.workflow_id === workflowId);
    return d?.current_version_id || null;
  }
  return zap.current_version_id || null;
}

function log(line) {
  process.stdout.write(line + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + "\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.execute && (!CLIENT_ID || !CLIENT_SECRET)) {
    fail("ZAPIER_CLIENT_ID and ZAPIER_CLIENT_SECRET must be set to --execute.");
  }

  const results = detectChangedZaps(changedFiles(args));
  const toPublish = results.filter((r) => r.kind === "durable" && r.wouldRepublish);
  const deployments = toPublish.flatMap((r) => r.affected.map((d) => ({ dir: r.dir, dep: d })));

  log(`## ${args.execute ? "🚀 Publishing" : "📋 Publish plan (dry)"} — ${deployments.length} deployment(s)`);
  log("");

  if (deployments.length === 0) {
    log("No Zap source changed — nothing to publish.");
    return;
  }

  const synced = [];
  for (const { dir, dep } of deployments) {
    const currentVersionId = loadCurrentVersionId(dir, dep.workflowId);
    log(`### \`${dir}\` → ${dep.name || dep.workflowId}`);
    const { plan, newVersionId } = publishDeployment(dir, dep, currentVersionId, args.execute);
    log(`- start mode: **${plan.startMode}**, enabled: ${plan.enabled}, files: ${plan.sourceFileKeys.join(", ")}`);
    if (args.execute) {
      syncBackVersionId(dir, currentVersionId, newVersionId);
      synced.push({ dir, workflowId: dep.workflowId, newVersionId });
      log(`- ✅ published new version \`${newVersionId}\`; zap.json updated`);
    } else {
      log(`- would republish from \`${plan.fromVersion}\` carrying deps/connections/app-versions/trigger forward`);
    }
    log("");
  }

  if (args.execute && process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `synced=${JSON.stringify(synced)}\n`);
  }
}

try {
  main();
} catch (err) {
  log("");
  log(`❌ ${err.message}`);
  process.exit(1);
}
