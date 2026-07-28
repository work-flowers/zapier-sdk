#!/usr/bin/env node
// One-off backfill for the Zapier partner lead history.
// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/scripts
//
// WHY THIS EXISTS
// The partner tool holds every referral lead ever submitted (247 as at
// 2026-07-28), but only the handful registered through Notion's "Register Lead"
// button were ever mirrored into the CRM — the classic status-change Zap could
// only resolve a company through the lead Table, so everything submitted
// straight from the partner portal was invisible. The replacement workflow
// (`zapier-partner-lead-status-to-notion`) fixes that going forward, but it
// only ever sees a lead when its status *changes*. A lead sitting quietly at
// Approved won't fire again until it converts or expires.
//
// So this script replays the existing leads through that workflow.
//
// WHY IT REPLAYS RATHER THAN WRITING DIRECTLY
// Every resolution rule, status mapping and field-presence subtlety already
// lives in the durable and is verified there. Re-implementing it here would be
// a second copy to keep in step. This script only decides *which* leads to
// replay; the durable does the work, and each replay shows up in its run
// history like any other event.
//
// The durable is idempotent — it writes the lead's current state and never
// clears a field — so re-running this is safe.
//
// WHAT IT REPLAYS, AND WHY NOT EVERYTHING
// The workflow only adopts an *untracked* lead into the CRM at a status that
// says it matters — `Converted` (see ADOPTION_STATUSES in the workflow). The
// account's lead history is essentially one bulk event submission: 45 of 45
// leads sampled across it carried `source: mdfRequest-…` and 78% had no Zapier
// account at all. Replaying those would just produce "not adopted" skips.
//
// So by default this fires only the leads that can actually land:
//   * any lead whose status is in --adopt-statuses (default Converted), and
//   * any lead already tracked — one with a lead Table row, or whose company
//     already carries its `Zapier Client Id` — regardless of status.
//
// Use --all to replay everything anyway (the workflow still gates; you'll just
// pay for the skips).
//
// COST
// One durable run per lead, each doing up to a few Notion calls. Nothing is
// fired without --commit.
//
// USAGE
//   node scripts/backfill-zapier-partner-leads.mjs                  # plan only
//   node scripts/backfill-zapier-partner-leads.mjs --commit
//   node scripts/backfill-zapier-partner-leads.mjs --commit --limit 10
//   node scripts/backfill-zapier-partner-leads.mjs --commit --status Converted,Expired
//
//   --commit              actually fire the runs (default: plan and exit)
//   --limit N             only the first N candidates (newest status change first)
//   --adopt-statuses A,B  statuses that let an untracked lead through
//                         (default Converted — keep in step with the workflow's
//                         ADOPTION_STATUSES, or the plan will promise writes the
//                         workflow then refuses)
//   --all                 replay every lead regardless of status or tracking
//   --status A,B          only these lead statuses (applied after the above)
//   --include-linked      replay leads already linked in Notion too. Worth doing
//                         once: the leads the CLASSIC Zap linked carry only a
//                         status, client id and lead id — it never captured the
//                         reason, expiry, commission or payout windows, and they
//                         won't fill in until that lead's status next changes.
//                         Replaying is idempotent, so `--commit --include-linked`
//                         is the safe way to sweep everything.
//   --delay-ms N          pause between runs (default 1500)
//   --settle-ms N         how long to wait for runs to finish (default 900000)
//   --sample N            unresolved runs to poll for their skip reason (default 10)
//   --out PATH            JSONL log (default ./backfill-zapier-partner-leads.jsonl)

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, writeFileSync, existsSync } from "node:fs";
import { globSync } from "node:fs";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);

// --- Constants (mirror zapier-partner-lead-status-to-notion/zap.json) -------
const WORKFLOW_ID = "019fa7a7-8553-722c-b176-049b03cc5227";
const PARTNER_APP_KEY = "App227952CLIAPI";
const PARTNER_CONNECTION = "02a5085e-1d27-853d-89b7-115a57fc4d32";
const NOTION_CONNECTION = "02b73654-15c8-85c3-b16a-07304d2beb17";
const COMPANIES_DS = "21991b07-11ac-80b0-b787-000b3d3995f6";
const LEAD_TABLE = "01KPZFHX4RP6SER3AEK4YJ62BF";
const NOTION_VERSION = "2026-03-11";

// --- CLI plumbing ----------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    commit: false,
    limit: Infinity,
    status: null,
    adoptStatuses: ["Converted"],
    all: false,
    includeLinked: false,
    delayMs: 1500,
    settleMs: 900_000,
    sample: 10,
    out: "./backfill-zapier-partner-leads.jsonl",
    workflow: WORKFLOW_ID,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--commit") opts.commit = true;
    else if (a === "--all") opts.all = true;
    else if (a === "--include-linked") opts.includeLinked = true;
    else if (a === "--adopt-statuses") opts.adoptStatuses = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--limit") opts.limit = Number(next());
    else if (a === "--status") opts.status = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--delay-ms") opts.delayMs = Number(next());
    else if (a === "--settle-ms") opts.settleMs = Number(next());
    else if (a === "--sample") opts.sample = Number(next());
    else if (a === "--out") opts.out = next();
    else if (a === "--workflow") opts.workflow = next();
    else if (a === "-h" || a === "--help") {
      console.log(
        "See the header of this file for usage. Runs a plan-only pass unless --commit is given.",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

/**
 * Resolve the Zapier SDK CLI once.
 *
 * Going through `npx` costs a second or two of startup on every call, which is
 * real money when there are a few hundred of them. Prefer the binary npx has
 * already cached, and fall back to `npx` when there isn't one.
 */
function resolveCli() {
  const cached = globSync(
    `${homedir()}/.npm/_npx/*/node_modules/.bin/zapier-sdk-experimental`,
  ).filter((p) => existsSync(p));
  if (cached.length > 0) return { cmd: cached[0], base: [] };
  return { cmd: "npx", base: ["--yes", "zapier-sdk-experimental"] };
}

const CLI = resolveCli();

async function cli(args, { maxBuffer = 64 * 1024 * 1024 } = {}) {
  const { stdout } = await execFileAsync(CLI.cmd, [...CLI.base, ...args], {
    maxBuffer,
  });
  return stdout;
}

async function cliJson(args, opts) {
  const out = await cli(args, opts);
  const parsed = JSON.parse(out);
  if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
    throw new Error(`CLI reported errors: ${JSON.stringify(parsed.errors).slice(0, 400)}`);
  }
  return parsed;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Data gathering --------------------------------------------------------

/** Every lead the partner tool currently reports, one row per lead. */
async function fetchLeads() {
  const res = await cliJson([
    "run-action", PARTNER_APP_KEY, "read", "referral_lead_status_change",
    "--connection", PARTNER_CONNECTION, "--json",
  ]);
  return res.data ?? [];
}

/**
 * Lead ids already mirrored into Notion, mapped to the company carrying them.
 *
 * `Referral Lead Id` is the marker: the workflow writes it on every successful
 * patch, so its presence means that exact lead has been through. A company with
 * only a `Zapier Client Id` (stamped at submit time, before any status change)
 * still counts as unlinked and gets replayed.
 */
async function fetchLinkedLeads() {
  const linked = new Map();
  let cursor = null;
  do {
    const body = {
      filter: { property: "Referral Lead Id", rich_text: { is_not_empty: true } },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    };
    const out = await cli([
      "curl", `https://api.notion.com/v1/data_sources/${COMPANIES_DS}/query`,
      "--connection", NOTION_CONNECTION,
      "-X", "POST",
      "-H", `Notion-Version: ${NOTION_VERSION}`,
      "--json", JSON.stringify(body),
    ]);
    const page = JSON.parse(out);
    if (page.object === "error") {
      throw new Error(`Notion query failed: ${page.code} ${page.message}`);
    }
    for (const row of page.results ?? []) {
      const props = row.properties ?? {};
      const leadId = (props["Referral Lead Id"]?.rich_text ?? [])
        .map((t) => t.plain_text ?? "").join("").trim();
      if (!leadId) continue;
      linked.set(leadId, {
        pageId: row.id,
        companyName: (props["Company Name"]?.title ?? [])
          .map((t) => t.plain_text ?? "").join("").trim(),
        status: props["Zapier Lead Status"]?.select?.name ?? null,
      });
    }
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return linked;
}

/**
 * Client ids this system already tracks — from a Notion company carrying the id,
 * or a row in the lead Table. These are exactly the leads the workflow resolves
 * without needing to adopt anything, so they are replayed at any status.
 */
async function fetchTrackedClientIds() {
  const tracked = new Set();

  let cursor = null;
  do {
    const body = {
      filter: { property: "Zapier Client Id", rich_text: { is_not_empty: true } },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    };
    const out = await cli([
      "curl", `https://api.notion.com/v1/data_sources/${COMPANIES_DS}/query`,
      "--connection", NOTION_CONNECTION,
      "-X", "POST",
      "-H", `Notion-Version: ${NOTION_VERSION}`,
      "--json", JSON.stringify(body),
    ]);
    const page = JSON.parse(out);
    if (page.object === "error") {
      throw new Error(`Notion query failed: ${page.code} ${page.message}`);
    }
    for (const row of page.results ?? []) {
      const id = (row.properties?.["Zapier Client Id"]?.rich_text ?? [])
        .map((t) => t.plain_text ?? "").join("").trim();
      if (id) tracked.add(id);
    }
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);

  const table = await cliJson([
    "list-table-records", LEAD_TABLE, "--json", "--max-items", "5000",
  ]);
  for (const row of table.data ?? []) {
    const id = String(row.data?.["Client Id"] ?? "").trim();
    if (id) tracked.add(id);
  }
  return tracked;
}

// --- Main ------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`CLI: ${CLI.cmd}${CLI.base.length ? " " + CLI.base.join(" ") : ""}\n`);

  console.log("Fetching leads from the partner tool…");
  const leads = await fetchLeads();
  console.log(`  ${leads.length} leads`);

  console.log("Reading which leads Notion already carries…");
  const linked = await fetchLinkedLeads();
  console.log(`  ${linked.size} already linked`);

  const byStatus = {};
  for (const l of leads) byStatus[l.status ?? "(none)"] = (byStatus[l.status ?? "(none)"] ?? 0) + 1;
  console.log(`  statuses: ${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(" · ")}`);

  let tracked = new Set();
  if (!opts.all) {
    console.log("Reading which client ids are already tracked…");
    tracked = await fetchTrackedClientIds();
    console.log(`  ${tracked.size} tracked client ids`);
  }

  let candidates = leads.filter((l) => l.lead_id);
  if (!opts.includeLinked) candidates = candidates.filter((l) => !linked.has(l.lead_id));

  // Mirror the workflow's adoption policy, so the plan doesn't promise writes the
  // workflow will then refuse. An untracked lead only goes through at an
  // adoption status; a tracked one goes through at any status.
  if (!opts.all) {
    const before = candidates.length;
    candidates = candidates.filter(
      (l) => tracked.has(l.client_id) || opts.adoptStatuses.includes(l.status),
    );
    const dropped = before - candidates.length;
    if (dropped > 0) {
      console.log(
        `\n  ${dropped} untracked lead(s) held back — status not in ` +
          `[${opts.adoptStatuses.join(", ")}]. The workflow would skip them as ` +
          `"not adopted"; pass --all to fire them anyway.`,
      );
    }
  }

  if (opts.status) candidates = candidates.filter((l) => opts.status.includes(l.status));
  // Newest status change first, so a partial run covers the most current leads.
  candidates.sort((a, b) =>
    String(b.lead_status_modified_on ?? "").localeCompare(String(a.lead_status_modified_on ?? "")),
  );
  if (Number.isFinite(opts.limit)) candidates = candidates.slice(0, opts.limit);

  console.log(`\n${candidates.length} lead(s) to replay through workflow ${opts.workflow}.`);
  if (candidates.length === 0) {
    console.log("Nothing to do.");
    return;
  }
  console.log("First few:");
  for (const l of candidates.slice(0, 5)) {
    console.log(`  ${l.status.padEnd(9)} ${String(l.email ?? "").padEnd(34)} ${l.name ?? ""}`);
  }

  if (!opts.commit) {
    console.log(
      `\nPlan only — nothing fired. Re-run with --commit to replay these ` +
        `${candidates.length} leads (one durable run each).`,
    );
    return;
  }

  // --- Fire ---
  writeFileSync(opts.out, "");
  const fired = [];
  console.log(`\nFiring ${candidates.length} runs, ${opts.delayMs}ms apart…`);
  for (const [i, lead] of candidates.entries()) {
    let triggerRunId = null;
    let error = null;
    try {
      const res = await cliJson([
        "trigger-workflow", opts.workflow, "--input", JSON.stringify(lead), "--json",
      ]);
      triggerRunId = res.data?.id ?? null;
    } catch (err) {
      error = String(err?.message ?? err).slice(0, 300);
    }
    const record = {
      leadId: lead.lead_id, clientId: lead.client_id, email: lead.email,
      name: lead.name, status: lead.status, triggerRunId, error,
    };
    fired.push(record);
    appendFileSync(opts.out, JSON.stringify(record) + "\n");
    const tag = error ? `FAILED TO FIRE: ${error}` : triggerRunId;
    console.log(`  [${i + 1}/${candidates.length}] ${lead.status.padEnd(9)} ${String(lead.email ?? "").padEnd(34)} ${tag}`);
    if (i < candidates.length - 1) await sleep(opts.delayMs);
  }

  const firedOk = fired.filter((f) => f.triggerRunId);
  console.log(`\n${firedOk.length}/${fired.length} fired. Waiting for them to finish…`);

  // --- Settle ---
  // Poll the run listing rather than each trigger run: one call covers them all.
  const wanted = new Set(firedOk.map((f) => f.triggerRunId));
  const deadline = Date.now() + opts.settleMs;
  const runStates = new Map();
  while (Date.now() < deadline) {
    await sleep(15_000);
    let runs = [];
    try {
      const res = await cliJson([
        "list-workflow-runs", opts.workflow, "--json", "--max-items", "1000",
      ]);
      runs = res.data ?? [];
    } catch (err) {
      console.log(`  (run listing failed, retrying: ${String(err?.message ?? err).slice(0, 120)})`);
      continue;
    }
    for (const r of runs) if (wanted.has(r.trigger_id)) runStates.set(r.trigger_id, r);
    const pending = [...wanted].filter((id) => {
      const st = runStates.get(id)?.status;
      return !st || st === "started" || st === "pending" || st === "running";
    });
    console.log(`  ${wanted.size - pending.length}/${wanted.size} finished`);
    if (pending.length === 0) break;
  }

  // --- Report ---
  const errored = [...runStates.values()].filter((r) => r.error);
  console.log("\nRe-reading Notion to see what landed…");
  const after = await fetchLinkedLeads();
  const newlyLinked = firedOk.filter((f) => after.has(f.leadId) && !linked.has(f.leadId));
  const stillUnlinked = firedOk.filter((f) => !after.has(f.leadId));

  console.log(`\n${"=".repeat(72)}`);
  console.log(`Fired            ${firedOk.length}`);
  console.log(`Newly linked     ${newlyLinked.length}`);
  console.log(`Still unlinked   ${stillUnlinked.length}`);
  console.log(`Runs errored     ${errored.length}`);
  console.log(`Notion linked    ${linked.size} -> ${after.size}`);
  console.log("=".repeat(72));

  if (errored.length > 0) {
    console.log("\nErrored runs:");
    for (const r of errored.slice(0, 20)) {
      console.log(`  ${r.input?.email ?? r.trigger_id}: ${JSON.stringify(r.error).slice(0, 200)}`);
    }
  }

  if (stillUnlinked.length > 0) {
    // These are the actionable ones: the lead exists at Zapier but nothing in
    // the CRM could be matched to it. Usually there's no contact for the email,
    // or the contact isn't linked to exactly one company.
    console.log(`\nStill unlinked — no single Notion company could be matched:`);
    for (const f of stillUnlinked) {
      console.log(`  ${String(f.status).padEnd(9)} ${String(f.email).padEnd(34)} ${f.name ?? ""}`);
    }

    const sample = stillUnlinked.slice(0, Math.max(0, opts.sample));
    if (sample.length > 0) {
      console.log(`\nSkip reasons (sample of ${sample.length}):`);
      for (const f of sample) {
        try {
          const res = await cliJson(["get-trigger-run", f.triggerRunId, "--json"]);
          const out = res.data?.output;
          console.log(`  ${f.email}: ${out?.reason ?? JSON.stringify(out ?? res.data?.error).slice(0, 200)}`);
        } catch (err) {
          console.log(`  ${f.email}: (could not read run: ${String(err?.message ?? err).slice(0, 120)})`);
        }
      }
    }
    console.log(
      `\nTo fix these: give the lead's email a Notion contact linked to exactly ` +
        `one company, then re-run this script (already-linked leads are skipped).`,
    );
  }

  console.log(`\nPer-lead log: ${opts.out}`);
}

main().catch((err) => {
  console.error(`\nFailed: ${err?.stack ?? err}`);
  process.exit(1);
});
