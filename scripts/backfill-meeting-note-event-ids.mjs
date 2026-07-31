#!/usr/bin/env node
// One-off migration of `[Table] Meeting Note IDs` (01JZCVG73MBWWB0357CEPS4903)
// from series-keyed to occurrence-keyed.
// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/scripts
//
// WHY THIS EXISTS
// The table maps a Notion meeting-note page to its Google Calendar event. Its
// `Event ID` (f3) column is the lookup key that
// `gcal-event-updated-to-meeting-note` uses to find the page a calendar edit
// belongs to, and the key it matches on is the Google **occurrence** id —
// `<seriesId>_<originalStartUTC>` for a recurring instance, a bare opaque id for
// a one-off. That is the only id that is unique per meeting note.
//
// Between 2026-05 and 2026-07 the `meeting-note-db-updates` Notion Worker wrote
// the **iCalUID** into that column instead. The iCalUID is the RFC 5545 UID: it
// identifies the *series*, so it is shared by every occurrence, and for a
// one-off it is `<id>@google.com` rather than `<id>`. That broke two things:
//
//   1. The lookup never matched at all — not even for one-off events, because
//      `<id>@google.com` !== `<id>`. Every note the Worker wrote in that window
//      became unreachable, and the classic Zap silently stopped updating any of
//      them.
//   2. Recurring series collapsed to a single row. Each new occurrence's
//      find-or-create matched the same iCalUID and overwrote the row's Page ID,
//      so a year of weekly standups is one row, not 52.
//
// WHAT IT DOES
// For every row whose `Event ID` is an iCalUID (contains `@`), it reads the
// occurrence id straight off the linked Notion page's `Google Calendar Event ID`
// property — the same value the Worker wrote there, so no calendar guessing is
// involved — then:
//
//   * `iCal UID` (f9) <- the old iCalUID, so the migration loses nothing
//   * `Event ID` (f3) <- the occurrence id from Notion
//
// A row whose Notion page is gone is flagged `Archived` (f7) and keeps its f3,
// since there is nothing left to key it to.
//
// WHAT IT CANNOT RECOVER
// Where a recurring row was already overwritten, the earlier occurrences' Page
// IDs are gone from the table — only the surviving Page ID can be re-keyed.
// Those earlier notes stay unreachable; nothing here can invent them back. The
// script reports how many rows are in that state.
//
// The 219 pre-Worker rows already carry an occurrence id and are left alone;
// their `iCal UID` stays empty and is filled opportunistically by the durable's
// `refresh-mapping-row` step the next time each event is edited.
//
// COST
// Notion page reads are direct API calls (free, not Zapier tasks) and table
// writes consume no tasks either, so this migration is free to run.
//
// USAGE
//   node scripts/backfill-meeting-note-event-ids.mjs            # plan only
//   node scripts/backfill-meeting-note-event-ids.mjs --commit
//   node scripts/backfill-meeting-note-event-ids.mjs --commit --limit 5
//
//   --commit    actually write (default: plan and exit)
//   --limit N   only the first N candidate rows
//   --verbose   print every row, not just a sample

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TABLE_ID = "01JZCVG73MBWWB0357CEPS4903";
const NOTION_VERSION = "2026-03-11";
const EVENT_ID_PROPERTY = "Google Calendar Event ID";
const OP_SECRET_REF = "op://Employee/notion-worker-automations/credential";

const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const VERBOSE = args.includes("--verbose");
const LIMIT = (() => {
  const i = args.indexOf("--limit");
  if (i === -1) return Infinity;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
})();

async function cli(argv) {
  const { stdout } = await execFileAsync("npx", ["--yes", "zapier-sdk", ...argv], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function cliJson(argv) {
  const out = await cli([...argv, "--json"]);
  const start = out.indexOf("{");
  if (start === -1) throw new Error(`no JSON in CLI output: ${out.slice(0, 400)}`);
  return JSON.parse(out.slice(start));
}

async function notionToken() {
  const { stdout } = await execFileAsync("op", ["read", OP_SECRET_REF]);
  const token = stdout.trim();
  if (!token) throw new Error(`no token at ${OP_SECRET_REF}`);
  return token;
}

/** The occurrence id the Worker stamped on the page, or null. */
function readEventId(page) {
  const prop = page?.properties?.[EVENT_ID_PROPERTY];
  const parts = prop?.rich_text;
  if (!Array.isArray(parts)) return null;
  const text = parts.map((p) => p?.plain_text ?? "").join("").trim();
  return text === "" ? null : text;
}

async function fetchPage(token, pageId) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
    },
  });
  if (res.status === 404) return { gone: true, reason: "not_found" };
  if (!res.ok) {
    throw new Error(`Notion ${res.status} for ${pageId}: ${(await res.text()).slice(0, 300)}`);
  }
  const page = await res.json();
  if (page.archived || page.in_trash) return { gone: true, reason: "archived", page };
  return { gone: false, page };
}

function isICalUid(value) {
  return typeof value === "string" && value.includes("@");
}

async function main() {
  console.log(`\n[Table] Meeting Note IDs — occurrence-id migration`);
  console.log(COMMIT ? "MODE: COMMIT (will write)\n" : "MODE: plan only (no writes)\n");

  const all = await cliJson([
    "--experimental",
    "list-table-records",
    TABLE_ID,
    "--page-size",
    "1000",
    "--max-items",
    "5000",
    "--key-mode",
    "ids",
  ]);
  const rows = all.data ?? [];
  console.log(`rows in table: ${rows.length}`);

  const candidates = rows.filter((r) => isICalUid(r.data?.f3));
  const alreadyOk = rows.filter((r) => !isICalUid(r.data?.f3) && r.data?.f3);
  console.log(`already occurrence-keyed: ${alreadyOk.length}`);
  console.log(`iCalUID-keyed (candidates): ${candidates.length}`);

  const overwritten = candidates.filter(
    (r) => new Date(r.edited_at) - new Date(r.created_at) > 3 * 24 * 3600 * 1000,
  );
  console.log(
    `  of which show a >3d create->edit gap (row reused by a later occurrence; earlier Page IDs unrecoverable): ${overwritten.length}`,
  );

  const slice = candidates.slice(0, LIMIT === Infinity ? undefined : LIMIT);
  if (slice.length !== candidates.length) {
    console.log(`\n--limit ${LIMIT}: processing ${slice.length} of ${candidates.length}`);
  }

  const token = await notionToken();

  const updates = [];
  const archive = [];
  const unresolved = [];

  for (const row of slice) {
    const pageId = row.data?.f2;
    const oldF3 = row.data.f3;
    if (!pageId) {
      unresolved.push({ row, reason: "no page id on row" });
      continue;
    }
    let result;
    try {
      result = await fetchPage(token, pageId);
    } catch (error) {
      unresolved.push({ row, reason: error.message });
      continue;
    }
    if (result.gone) {
      archive.push({ row, pageId, oldF3, reason: result.reason });
      continue;
    }
    const eventId = readEventId(result.page);
    if (!eventId) {
      unresolved.push({ row, reason: `page has no "${EVENT_ID_PROPERTY}"` });
      continue;
    }
    if (eventId === oldF3) continue;
    updates.push({ recordId: row.id, pageId, oldF3, newF3: eventId, title: row.data?.f8 });
  }

  // A rewritten key must stay unique, or the durable's "first match" lookup
  // becomes ambiguous.
  //
  // Two rows can legitimately end up wanting the same key: the same meeting note
  // got a row in the occurrence-id era AND another in the iCalUID era. Where both
  // rows point at the SAME Notion page the newcomer is simply redundant — its
  // twin already carries the right key, so it is left un-keyed (an iCalUID in f3
  // never matches a lookup, so it is inert) and only its UID is preserved into
  // f9. Nothing is deleted.
  //
  // A collision between rows pointing at DIFFERENT pages is a real conflict and
  // blocks the commit, because picking a winner is a judgement call, not a
  // migration.
  const pageByKey = new Map();
  for (const r of alreadyOk) pageByKey.set(r.data.f3, r.data.f2);

  const redundant = [];
  const conflicts = [];
  const keyed = [];
  const claimed = new Map();

  for (const u of updates) {
    const twinPage = pageByKey.get(u.newF3) ?? claimed.get(u.newF3);
    if (twinPage === undefined) {
      claimed.set(u.newF3, u.pageId);
      keyed.push(u);
    } else if (twinPage === u.pageId) {
      redundant.push(u);
    } else {
      conflicts.push({ ...u, twinPage });
    }
  }

  console.log(`\nPLAN`);
  console.log(`  re-key (f3 <- occurrence id, f9 <- iCalUID): ${keyed.length}`);
  console.log(`  redundant twin (f9 only, f3 left inert):     ${redundant.length}`);
  console.log(`  flag Archived (Notion page gone):            ${archive.length}`);
  console.log(`  unresolved (left untouched):                 ${unresolved.length}`);
  if (redundant.length) {
    console.log(`\n  redundant rows (a correctly-keyed row already maps the same page):`);
    for (const u of redundant) {
      console.log(`     ${u.title ?? "(untitled)"} — record ${u.recordId}, page ${u.pageId}`);
      console.log(`       would-be key ${u.newF3} already held by its twin`);
    }
  }
  if (conflicts.length) {
    console.log(`\n  !! ${conflicts.length} real conflict(s) — same key, DIFFERENT page:`);
    for (const u of conflicts) {
      console.log(`     ${u.newF3}: record ${u.recordId} -> ${u.pageId}, twin -> ${u.twinPage}`);
    }
  }

  const sample = VERBOSE ? keyed : keyed.slice(0, 10);
  if (sample.length) {
    console.log(`\n  ${VERBOSE ? "all" : "sample of"} re-keys:`);
    for (const u of sample) {
      console.log(`     ${u.title ?? "(untitled)"}`);
      console.log(`       ${u.oldF3}`);
      console.log(`    -> ${u.newF3}`);
    }
    if (!VERBOSE && keyed.length > sample.length) {
      console.log(`     … ${keyed.length - sample.length} more (--verbose to see all)`);
    }
  }
  if (archive.length) {
    console.log(`\n  Archived flags:`);
    for (const a of archive) {
      console.log(`     ${a.row.data?.f8 ?? "(untitled)"} — page ${a.pageId} ${a.reason}`);
    }
  }
  if (unresolved.length) {
    console.log(`\n  unresolved:`);
    for (const u of unresolved) {
      console.log(`     record ${u.row.id} (${u.row.data?.f8 ?? "(untitled)"}) — ${u.reason}`);
    }
  }

  if (!COMMIT) {
    console.log(`\nplan only — re-run with --commit to write.\n`);
    return;
  }
  if (conflicts.length) {
    console.error(
      `\nrefusing to commit: ${conflicts.length} key collision(s) point at different pages. Resolve them by hand first.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const records = [
    ...keyed.map((u) => ({ id: u.recordId, data: { f3: u.newF3, f9: u.oldF3 } })),
    // Key left alone on purpose: an iCalUID in f3 never matches, so the row is
    // inert and its correctly-keyed twin serves the page.
    ...redundant.map((u) => ({ id: u.recordId, data: { f9: u.oldF3 } })),
    ...archive.map((a) => ({ id: a.row.id, data: { f7: true, f9: a.oldF3 } })),
  ];

  console.log(`\nwriting ${records.length} record(s)…`);
  for (let i = 0; i < records.length; i += 100) {
    const batch = records.slice(i, i + 100);
    await cliJson([
      "--experimental",
      "update-table-records",
      TABLE_ID,
      JSON.stringify(batch),
      "--key-mode",
      "ids",
    ]);
    console.log(`  ${Math.min(i + batch.length, records.length)}/${records.length}`);
  }
  console.log(`\ndone.\n`);
}

main().catch((error) => {
  console.error(`\nfailed: ${error.message}\n`);
  process.exitCode = 1;
});
