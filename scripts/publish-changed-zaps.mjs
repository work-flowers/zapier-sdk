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
//
// A NEW Zap — one whose zap.json has no workflow_id and a `deploy` block with
// `state: "pending-create"` — takes the first-publish path instead: create the
// container (account-visible unless is_private is true, which is the only
// chance to set visibility), publish v1 from the metadata DECLARED in zap.json
// (there is no live version to read it off), disable it when
// `deploy.enable_on_publish` is false, then sync workflow_id /
// current_version_id / trigger_url / enabled back. So a brand-new Zap ships
// exactly like a change to an existing one: open a PR, merge it, CI publishes.
// Every subsequent change takes the republish path above.
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

// Block for `ms` without async plumbing — this script is synchronous end to end
// (execFileSync throughout), and the only thing it ever waits on is Zapier's
// asynchronous trigger claim.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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

// ---- First publish of a brand-new Zap -----------------------------------

// Read the `deploy` block a not-yet-created Zap declares, and fail loudly on
// anything missing. Nothing here can be inferred from Zapier — there is no live
// version to read metadata off — so zap.json is the only source of truth, and a
// silent default (wrong visibility, a dropped trigger) is unrecoverable or
// invisible. Every field is therefore required to be explicit.
function readCreateSpec(dir) {
  const zap = JSON.parse(readFileSync(join(REPO_ROOT, dir, "zap.json"), "utf8"));
  const d = zap.deploy;
  if (!d || d.state !== "pending-create") {
    fail(`${dir}: expected zap.json deploy.state === "pending-create"`);
  }
  const need = (value, what) => {
    if (value === undefined || value === null || value === "") fail(`${dir}: zap.json is missing ${what}`);
    return value;
  };

  // Visibility is settable ONLY at create time (repo rule 7), so it must be
  // stated rather than defaulted.
  if (typeof zap.is_private !== "boolean") {
    fail(`${dir}: zap.json must state "is_private" (true/false) — visibility cannot be changed after create`);
  }
  // Likewise the start mode: publishing without --trigger silently unclaims a
  // trigger and the Zap never fires, so "no trigger" has to be deliberate.
  if (zap.trigger === undefined) {
    fail(`${dir}: zap.json must state "trigger" (a trigger config, or null for a manual workflow)`);
  }
  if (typeof d.enable_on_publish !== "boolean") {
    fail(`${dir}: zap.json must state deploy.enable_on_publish (true/false)`);
  }

  const trigger = zap.trigger;
  if (trigger !== null) {
    need(trigger.selected_api, "trigger.selected_api");
    need(trigger.action, "trigger.action");
    // A bare, unversioned selected_api makes the trigger claim fail SILENTLY.
    if (!String(trigger.selected_api).includes("@")) {
      fail(
        `${dir}: trigger.selected_api "${trigger.selected_api}" is not version-pinned ` +
          `(expected e.g. "NotionCLIAPI@2.39.1") — an unversioned value fails the claim silently.`,
      );
    }
  }

  // publish wants { alias: { connectionId } }; zap.json stores { alias: id }.
  const connections = {};
  for (const [alias, value] of Object.entries(zap.connections || {})) {
    if (typeof value !== "string") continue; // non-connection notes live here too
    connections[alias] = { connectionId: value };
  }

  return {
    workflowName: d.workflow_name || zap.name || dir,
    description: need(d.description, "deploy.description"),
    isPrivate: zap.is_private,
    enableOnPublish: d.enable_on_publish,
    sourceFileKeys: Array.isArray(d.source_files) && d.source_files.length ? d.source_files : ["workflow.ts"],
    dependencies: need(zap.dependencies, "dependencies"),
    durableVersion: need(zap.zapier_durable_version, "zapier_durable_version"),
    connections: Object.keys(connections).length ? connections : null,
    appVersions: zap.app_versions ?? null,
    trigger,
  };
}

// Returns { plan } when !execute, else { plan, workflowId, newVersionId, triggerUrl, webhookUrl }.
function createAndPublish(dir, dep, execute) {
  const spec = readCreateSpec(dir);
  const startMode = spec.trigger === null ? "manual" : "trigger";

  const plan = {
    dir,
    name: dep.name,
    workflowId: null,
    fromVersion: null,
    create: true,
    workflowName: spec.workflowName,
    isPrivate: spec.isPrivate,
    startMode,
    enabled: spec.enableOnPublish,
    sourceFileKeys: spec.sourceFileKeys,
    entryFile: dep.entryFile || "workflow.ts",
    hasDependencies: true,
    hasConnections: spec.connections != null,
    hasAppVersions: spec.appVersions != null,
  };

  // Build source_files first: a create that succeeds followed by a read failure
  // would leave an orphan container behind.
  const sourceFiles = buildSourceFiles(dir, spec.sourceFileKeys, plan.entryFile);

  if (!execute) return { plan };

  // 1. Create the container. --private is the ONLY chance to set visibility.
  const createArgs = ["create-workflow", spec.workflowName, "--description", spec.description];
  if (spec.isPrivate) createArgs.push("--private");
  const created = unwrap(sdk(createArgs));
  const workflowId = created?.id || created?.workflow?.id || null;
  if (!workflowId) {
    fail(`${dir}: create-workflow returned no id — response: ${JSON.stringify(created)}`);
  }

  // 2. Publish v1 from the declared metadata.
  const rest = ["publish-workflow-version", workflowId, JSON.stringify(sourceFiles)];
  rest.push("--dependencies", JSON.stringify(spec.dependencies));
  rest.push("--zapier-durable-version", String(spec.durableVersion));
  if (spec.connections != null) rest.push("--connections", JSON.stringify(spec.connections));
  if (spec.appVersions != null) rest.push("--app-versions", JSON.stringify(spec.appVersions));
  if (startMode === "trigger") rest.push("--trigger", JSON.stringify(spec.trigger));
  else rest.push("--manual");
  const published = unwrap(sdk(rest));
  const newVersionId = published?.version?.id || published?.id || published?.version_id || null;
  if (!newVersionId) {
    fail(
      `${dir}: CREATED workflow ${workflowId} but its first publish returned no version id — ` +
        `response: ${JSON.stringify(published)}. The container now exists with no version; ` +
        `record its id in zap.json by hand before retrying.`,
    );
  }

  // 3. A publish always enables, so an intentionally-parked Zap is disabled
  //    right after (--enabled false is ignored on publish).
  if (!spec.enableOnPublish) {
    sdk(["disable-workflow", workflowId]);
  }

  // 4. Verify the start mode survived. The trigger claim is ASYNCHRONOUS and
  //    fails silently, so it is read back rather than trusted — and polled,
  //    because a claim made moments ago may not be visible on the first read.
  //    (The republish path can read once: it carries an already-live claim.)
  let after = unwrap(sdk(["get-workflow", workflowId]));
  let afterTriggers = Array.isArray(after?.triggers) ? after.triggers : [];
  for (let attempt = 0; startMode === "trigger" && afterTriggers.length === 0 && attempt < 5; attempt++) {
    sleepSync(3000);
    after = unwrap(sdk(["get-workflow", workflowId]));
    afterTriggers = Array.isArray(after?.triggers) ? after.triggers : [];
  }
  if (startMode === "trigger" && afterTriggers.length === 0) {
    fail(
      `${dir}: CREATED and PUBLISHED but the trigger was never claimed (triggers[] still empty after ~15s) — ` +
        `the Zap will never fire. The container EXISTS: record workflow_id "${workflowId}" and ` +
        `current_version_id "${newVersionId}" in zap.json by hand (and flip deploy.state to "published") so a ` +
        `rerun does not create a second container, then fix the trigger and republish.`,
    );
  }
  if (startMode === "manual" && afterTriggers.length > 0) {
    fail(
      `${dir}: CREATED ${workflowId} (version ${newVersionId}) as manual but a trigger appeared unexpectedly — ` +
        `record both ids in zap.json by hand, then investigate.`,
    );
  }

  return {
    plan,
    workflowId,
    newVersionId,
    triggerUrl: after?.trigger_url || created?.trigger_url || null,
    // Present only for catch-hook triggers; this is the URL external services call.
    webhookUrl: afterTriggers[0]?.details?.webhook_url || null,
    enabled: typeof after?.enabled === "boolean" ? after.enabled : spec.enableOnPublish,
  };
}

// ---- Republishing an existing deployment ---------------------------------

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

// Fill in the ids a first publish produced, and retire the `deploy` block's
// pending state. Same in-place, value-targeted replacement as above so the rest
// of the file stays byte-for-byte (a JSON round-trip would re-encode every
// escape and reformat the whole file).
function syncBackFirstPublish(dir, { workflowId, newVersionId, triggerUrl, webhookUrl, enabled }) {
  const abs = join(REPO_ROOT, dir, "zap.json");
  let raw = readFileSync(abs, "utf8");

  const setNull = (key, value, required) => {
    if (value === null || value === undefined) return;
    const re = new RegExp('("' + key + '":\\s*)null');
    if (!re.test(raw)) {
      if (required) fail(`${dir}: could not find "${key}": null in zap.json to sync back`);
      return;
    }
    raw = raw.replace(re, '$1"' + value + '"');
  };

  setNull("workflow_id", workflowId, true);
  setNull("current_version_id", newVersionId, true);
  setNull("trigger_url", triggerUrl, false);
  setNull("webhook_url", webhookUrl, false);

  // Record what Zapier actually reports, so a parked Zap reads as parked.
  // Anchored to the top-level key (two-space indent) so a nested "enabled"
  // somewhere in the metadata can never be hit instead.
  if (typeof enabled === "boolean") {
    const re = /^(  "enabled":\s*)(?:true|false)/m;
    if (!re.test(raw)) fail(`${dir}: could not find a top-level "enabled" in zap.json to sync back`);
    raw = raw.replace(re, "$1" + String(enabled));
  }

  const stateRe = /("state":\s*")pending-create(")/;
  if (!stateRe.test(raw)) fail(`${dir}: could not find deploy.state "pending-create" in zap.json`);
  raw = raw.replace(stateRe, "$1published$2");

  writeFileSync(abs, raw);
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
    log(`### \`${dir}\` → ${dep.name || dep.workflowId || "(new Zap)"}`);

    // A Zap with no container on Zapier yet: create it and publish v1.
    if (dep.pendingCreate) {
      const result = createAndPublish(dir, dep, args.execute);
      const { plan } = result;
      log(
        `- 🆕 create + publish v1 — name: \`${plan.workflowName}\`, ` +
          `${plan.isPrivate ? "private" : "account-visible"}, start mode: **${plan.startMode}**, ` +
          `enabled on publish: ${plan.enabled}, files: ${plan.sourceFileKeys.join(", ")}`,
      );
      if (args.execute) {
        syncBackFirstPublish(dir, result);
        synced.push({ dir, workflowId: result.workflowId, newVersionId: result.newVersionId, created: true });
        log(`- ✅ created \`${result.workflowId}\`, published \`${result.newVersionId}\`; zap.json updated`);
        if (!plan.enabled) log(`- ⏸️ left DISABLED as declared — enable it when you cut the classic Zap over`);
        if (result.webhookUrl) log(`- 🔗 catch URL: ${result.webhookUrl}`);
      } else {
        log(`- would create the container and publish v1 from the \`deploy\` block in zap.json`);
      }
      log("");
      continue;
    }

    const currentVersionId = loadCurrentVersionId(dir, dep.workflowId);
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
