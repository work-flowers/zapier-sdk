#!/usr/bin/env node
// Audit Notion Contacts for page icons/covers that point at expiring URLs.
// Source of truth: https://github.com/work-flowers/zapier-sdk/tree/main/scripts
//
// WHY THIS EXISTS
// `enrich-contact-records` used to set a contact's page icon and cover to
// `{ type: "external", external: { url } }` using Apollo's `person.photo_url`.
// Apollo hands back LinkedIn's CDN URL verbatim, and those are signed and
// time-limited: `…?e=<unix-expiry>&v=beta&t=<signature>`. Notion stores the
// external URL forever and simply renders nothing once the URL starts 403ing,
// so the page keeps an icon and cover that draw as empty white space.
//
// The durable now downloads the photo and uploads it to Notion
// (`type: "file_upload"`), which stores the bytes and never rots. This script
// measures the damage already on the board so the backfill can be sized.
//
// WHAT IT DOES
// Pages the Contacts data source, reads each page's `icon` and `cover`, and
// classifies every external URL as:
//
//   * expiring-expired    — carries an `e=` expiry that is now in the past
//   * expiring-live       — carries an `e=` expiry still in the future (it WILL rot)
//   * external-other      — an external URL with no expiry param (e.g. a static logo)
//   * file_upload / file  — already Notion-hosted, nothing to do
//   * emoji / none        — not an image
//
// It writes nothing. `--json` emits the full per-page classification so a
// backfill can consume the affected page ids directly.
//
// COST
// Direct Notion API reads only — no Zapier tasks.
//
// USAGE
//   node scripts/audit-contact-icon-urls.mjs
//   node scripts/audit-contact-icon-urls.mjs --verbose
//   node scripts/audit-contact-icon-urls.mjs --json > /tmp/icon-audit.json

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CONTACTS_DATA_SOURCE = "21991b07-11ac-81a6-a894-000be4a09a67";
const NOTION_VERSION = "2026-03-11";
const OP_SECRET_REF = "op://Employee/notion-worker-automations/credential";

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const AS_JSON = args.includes("--json");

async function notionToken() {
  const { stdout } = await execFileAsync("op", ["read", OP_SECRET_REF]);
  const token = stdout.trim();
  if (!token) throw new Error(`no token at ${OP_SECRET_REF}`);
  return token;
}

/** Classify one icon/cover object into a bucket plus the URL it points at. */
function classify(obj, nowSeconds) {
  if (!obj) return { bucket: "none", url: null, expiresAt: null };
  if (obj.type === "emoji" || obj.type === "custom_emoji") {
    return { bucket: "emoji", url: null, expiresAt: null };
  }
  if (obj.type === "file" || obj.type === "file_upload") {
    // `file` is Notion-hosted with a rotating signed URL that Notion itself
    // refreshes on read, so it renders indefinitely. Nothing to fix.
    return { bucket: "notion-hosted", url: obj.file?.url ?? null, expiresAt: null };
  }
  if (obj.type !== "external") {
    return { bucket: `unknown:${obj.type}`, url: null, expiresAt: null };
  }

  const url = obj.external?.url ?? null;
  if (!url) return { bucket: "external-other", url: null, expiresAt: null };

  // LinkedIn (and most signed CDNs Apollo passes through) put the expiry in `e`.
  let expiry = null;
  try {
    const e = new URL(url).searchParams.get("e");
    if (e && /^\d+$/.test(e)) expiry = Number(e);
  } catch {
    // Unparseable URL — treat as a plain external link.
  }

  if (expiry === null) return { bucket: "external-other", url, expiresAt: null };
  return {
    bucket: expiry <= nowSeconds ? "expiring-expired" : "expiring-live",
    url,
    expiresAt: new Date(expiry * 1000).toISOString(),
  };
}

function pageTitle(page) {
  for (const prop of Object.values(page.properties ?? {})) {
    if (prop?.type === "title") {
      const text = (prop.title ?? []).map((t) => t?.plain_text ?? "").join("").trim();
      if (text) return text;
    }
  }
  return "(untitled)";
}

async function* allContacts(token) {
  let cursor;
  do {
    const res = await fetch(
      `https://api.notion.com/v1/data_sources/${CONTACTS_DATA_SOURCE}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
      },
    );
    if (!res.ok) {
      throw new Error(`Notion query ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }
    const body = await res.json();
    for (const page of body.results ?? []) yield page;
    cursor = body.has_more ? body.next_cursor : undefined;
  } while (cursor);
}

async function main() {
  const token = await notionToken();
  const nowSeconds = Math.floor(Date.now() / 1000);

  const rows = [];
  for await (const page of allContacts(token)) {
    const icon = classify(page.icon, nowSeconds);
    const cover = classify(page.cover, nowSeconds);
    rows.push({
      pageId: page.id,
      url: page.url,
      title: pageTitle(page),
      archived: Boolean(page.archived || page.in_trash),
      icon,
      cover,
    });
  }

  const live = rows.filter((r) => !r.archived);
  const tally = (field) =>
    live.reduce((acc, r) => {
      acc[r[field].bucket] = (acc[r[field].bucket] ?? 0) + 1;
      return acc;
    }, {});

  const affected = live.filter(
    (r) =>
      r.icon.bucket.startsWith("expiring") || r.cover.bucket.startsWith("expiring"),
  );
  const broken = live.filter(
    (r) => r.icon.bucket === "expiring-expired" || r.cover.bucket === "expiring-expired",
  );

  if (AS_JSON) {
    console.log(JSON.stringify({ rows, affected, broken }, null, 2));
    return;
  }

  console.log(`Contacts scanned:      ${rows.length} (${live.length} live, ${rows.length - live.length} archived)`);
  console.log(`\nIcon buckets:`);
  for (const [k, v] of Object.entries(tally("icon")).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(20)} ${v}`);
  }
  console.log(`\nCover buckets:`);
  for (const [k, v] of Object.entries(tally("cover")).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(20)} ${v}`);
  }
  console.log(`\nOn an expiring URL (will rot or already has): ${affected.length}`);
  console.log(`Already broken (expiry in the past):          ${broken.length}`);

  const sample = (VERBOSE ? affected : affected.slice(0, 15));
  if (sample.length) {
    console.log(`\n${VERBOSE ? "All" : "Sample of"} affected contacts:`);
    for (const r of sample) {
      const when = r.icon.expiresAt ?? r.cover.expiresAt;
      console.log(
        `  ${r.title.padEnd(28)} icon=${r.icon.bucket.padEnd(17)} cover=${r.cover.bucket.padEnd(17)} expires=${when ?? "-"}`,
      );
    }
    if (!VERBOSE && affected.length > sample.length) {
      console.log(`  … and ${affected.length - sample.length} more (--verbose for all)`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
