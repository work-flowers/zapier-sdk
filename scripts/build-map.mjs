#!/usr/bin/env node
// Builds docs/map.html's embedded graph data from the repo's zap.json /
// workflow sources merged with the curated semantics in docs/map-overlay.json.
//
//   node scripts/build-map.mjs           regenerate the data block in docs/map.html
//   node scripts/build-map.mjs --check   verify committed output matches (never writes)
//   node scripts/build-map.mjs --report  print the extracted inventory (debug)

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// Extraction: facts parsed from the repo, no curation.
// ---------------------------------------------------------------------------

const NON_ZAP_DIRS = new Set(["docs", "scripts", "node_modules"]);
// Zapier Table ids: ULID, Crockford base32, epoch prefix means they all start 01.
const ULID_RE = /\b01[0-9A-HJKMNP-TV-Z]{24}\b/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function listZapDirs() {
  return readdirSync(ROOT)
    .filter((name) => {
      if (name.startsWith(".") || NON_ZAP_DIRS.has(name)) return false;
      return statSync(join(ROOT, name)).isDirectory();
    })
    .sort();
}

// UUIDs that are Zapier plumbing rather than asset ids: collected per-zap so the
// regex sweep can subtract them and leave only Notion data-source candidates.
function plumbingIds(zap) {
  const ids = new Set();
  const take = (v) => {
    if (typeof v === "string") for (const m of v.matchAll(UUID_RE)) ids.add(m[0].toLowerCase());
  };
  // Only genuinely-Zapier fields: trigger params can carry real asset ids
  // (Notion data source ids, Drive folder ids), so never subtract those.
  const fromDeployment = (d) => {
    take(d.workflow_id);
    take(d.current_version_id);
    take(d.trigger?.authentication_id);
  };
  fromDeployment(zap);
  for (const d of zap.deployments ?? []) fromDeployment(d);
  for (const v of Object.values(zap.connections ?? {})) take(v);
  return ids;
}

function normalizeDeployments(dir, zap) {
  const list = zap.deployments ?? [zap];
  return list
    .filter((d) => d.workflow_id)
    .map((d) => ({
      name: d.name ?? zap.name ?? dir,
      workflow_id: d.workflow_id,
      current_version_id: d.current_version_id ?? null,
      enabled: d.enabled ?? false,
      description: d.description ?? null,
      trigger: d.trigger
        ? {
            selected_api: d.trigger.selected_api ?? null,
            action: d.trigger.action ?? null,
            webhook_url: d.trigger.webhook_url ?? null,
          }
        : null,
    }));
}

function sourceFiles(dirPath) {
  return readdirSync(dirPath).filter((f) => f.endsWith(".ts") || f === "zap.json");
}

function extractZap(dir) {
  const dirPath = join(ROOT, dir);
  const zapPath = join(dirPath, "zap.json");
  const hasZapJson = existsSync(zapPath);
  const zap = hasZapJson ? JSON.parse(readFileSync(zapPath, "utf8")) : {};

  const deployments = hasZapJson ? normalizeDeployments(dir, zap) : [];
  const plumbing = plumbingIds(zap);

  // Regex sweep over zap.json + every .ts file so no referenced asset escapes.
  const tableIds = new Set();
  const uuidCandidates = new Set();
  for (const file of sourceFiles(dirPath)) {
    const text = readFileSync(join(dirPath, file), "utf8");
    for (const m of text.matchAll(ULID_RE)) tableIds.add(m[0]);
    for (const m of text.matchAll(UUID_RE)) {
      const id = m[0].toLowerCase();
      if (!plumbing.has(id)) uuidCandidates.add(id);
    }
  }

  // Drive folder ids are unregexable (bare base64-ish strings), so collect them
  // only from explicit structure: drive_folders blocks and trigger folder params.
  const driveFolderIds = new Set();
  for (const f of Object.values(zap.drive_folders ?? {})) {
    driveFolderIds.add(typeof f === "string" ? f : f.id);
  }
  for (const d of zap.deployments ?? [zap]) {
    const folder = d.trigger?.params?.folder;
    if (folder) driveFolderIds.add(folder);
  }

  return {
    dir,
    has_zap_json: hasZapJson,
    description: zap.description ?? zap.deployments?.[0]?.description ?? null,
    enabled: deployments.some((d) => d.enabled),
    retired: Boolean(zap.retired),
    is_private: zap.is_private ?? null,
    cutover: zap.cutover ?? null,
    ai_model: zap.ai_model ?? null,
    has_prompt_file: readdirSync(dirPath).some((f) => f.endsWith("-prompt.md")),
    deployments,
    trigger_app: deployments[0]?.trigger?.selected_api?.split("@")[0] ?? null,
    connections: Object.keys(zap.connections ?? {}),
    drive_folder_ids: [...driveFolderIds].sort(),
    table_ids: [...tableIds].sort(),
    uuid_candidates: [...uuidCandidates].sort(),
    plumbing: [...plumbing],
  };
}

// Zapier-generated ids (workflow, version, trigger-run, step) are UUIDv7;
// every Notion/asset id in this repo is not, so v7 is safe to drop wholesale.
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/;

export function extract() {
  const zaps = listZapDirs().map(extractZap);
  // Connection ids leak into comments in other zaps' sources; subtract them globally.
  const globalPlumbing = new Set(
    zaps.flatMap((z) => z.plumbing ?? []),
  );
  for (const z of zaps) {
    z.uuid_candidates = z.uuid_candidates.filter(
      (u) => !UUID_V7_RE.test(u) && !globalPlumbing.has(u),
    );
    delete z.plumbing;
  }
  const allTables = new Set(zaps.flatMap((z) => z.table_ids));
  const allUuids = new Set(zaps.flatMap((z) => z.uuid_candidates));
  return { zaps, allTables, allUuids };
}

// ---------------------------------------------------------------------------
// Overlay merge + validation: every fact must be accounted for, both ways.
// ---------------------------------------------------------------------------

const OVERLAY_PATH = join(ROOT, "docs", "map-overlay.json");
const EDGE_KINDS = new Set(["own", "write", "read", "trigger", "reference", "http"]);

export function loadOverlay() {
  return JSON.parse(readFileSync(OVERLAY_PATH, "utf8"));
}

export function validate({ zaps }, overlay) {
  const errors = [];
  const zapDirs = new Set(zaps.map((z) => z.dir));

  // Cluster totality: every zap dir in exactly one cluster.
  const clustered = new Map();
  for (const [cluster, def] of Object.entries(overlay.clusters)) {
    for (const dir of def.zaps) {
      if (!zapDirs.has(dir)) errors.push(`cluster ${cluster}: unknown zap dir ${dir}`);
      if (clustered.has(dir)) errors.push(`zap ${dir} is in both ${clustered.get(dir)} and ${cluster}`);
      clustered.set(dir, cluster);
    }
  }
  for (const dir of zapDirs) {
    if (!clustered.has(dir)) errors.push(`zap ${dir} is in no cluster`);
  }

  // Asset registry <-> extraction, both directions.
  const registryByRawId = new Map();
  for (const [key, asset] of Object.entries(overlay.assets)) {
    if (asset.id) registryByRawId.set(asset.id, key);
  }
  const ignored = new Set(overlay.ignored_ids.ids);
  const extractedIds = new Set();
  for (const z of zaps) {
    for (const id of [...z.table_ids, ...z.uuid_candidates, ...z.drive_folder_ids]) {
      extractedIds.add(id);
      if (!registryByRawId.has(id) && !ignored.has(id)) {
        errors.push(`extracted id ${id} (${z.dir}) is neither a registered asset nor ignored`);
      }
    }
  }
  for (const [rawId, key] of registryByRawId) {
    if (!extractedIds.has(rawId)) errors.push(`registered asset ${key} (${rawId}) is never extracted from the repo`);
  }
  for (const id of ignored) {
    if (!extractedIds.has(id)) errors.push(`ignored id ${id} is never extracted — stale ignore entry`);
    if (registryByRawId.has(id)) errors.push(`id ${id} is both registered and ignored`);
  }

  // Edge endpoints resolve; kinds are known.
  const nodeKeys = new Set([...zapDirs, ...Object.keys(overlay.assets)]);
  for (const e of overlay.edges) {
    if (!nodeKeys.has(e.from)) errors.push(`edge from unknown node ${e.from}`);
    if (!nodeKeys.has(e.to)) errors.push(`edge to unknown node ${e.to}`);
    if (!EDGE_KINDS.has(e.kind)) errors.push(`edge ${e.from} -> ${e.to}: unknown kind ${e.kind}`);
  }

  // Every zap that touches a registered asset id should carry at least one edge
  // to that asset (or the reverse) — catches forgotten curation.
  const edgePairs = new Set(overlay.edges.flatMap((e) => [`${e.from}|${e.to}`, `${e.to}|${e.from}`]));
  for (const z of zaps) {
    for (const id of [...z.table_ids, ...z.uuid_candidates, ...z.drive_folder_ids]) {
      const key = registryByRawId.get(id);
      if (key && !edgePairs.has(`${z.dir}|${key}`)) {
        errors.push(`zap ${z.dir} references asset ${key} (${id}) but the overlay has no edge between them`);
      }
    }
  }

  // Status overrides and blurbs must target real zap dirs.
  for (const dir of [...Object.keys(overlay.status_overrides), ...Object.keys(overlay.blurbs)]) {
    if (!zapDirs.has(dir)) errors.push(`override/blurb targets unknown zap dir ${dir}`);
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Graph assembly: extracted facts + overlay semantics -> renderable nodes/edges.
// ---------------------------------------------------------------------------

const GITHUB_BASE = "https://github.com/work-flowers/zapier-sdk/tree/main";

function zapStatus(z, override) {
  if (override?.status) return override.status;
  if (z.retired) return "retired";
  if (!z.has_zap_json) return "never-deployed";
  return z.enabled ? "enabled" : "disabled";
}

export function buildGraph({ zaps }, overlay) {
  const clusterOf = new Map();
  for (const [cluster, def] of Object.entries(overlay.clusters)) {
    for (const dir of def.zaps) clusterOf.set(dir, cluster);
  }

  const excluded = new Set(overlay.excluded_zaps?.dirs ?? []);
  const nodes = [];
  for (const z of zaps) {
    if (excluded.has(z.dir)) continue;
    const override = overlay.status_overrides[z.dir];
    nodes.push({
      id: z.dir,
      kind: override?.classic ? "classic" : "durable",
      label: z.dir,
      cluster: clusterOf.get(z.dir),
      status: zapStatus(z, override),
      status_note: override?.note ?? null,
      description: overlay.blurbs[z.dir] ?? z.description,
      trigger_app: z.trigger_app,
      ai: z.ai_model
        ? { tier: z.ai_model.model_id ?? z.ai_model.tier ?? null }
        : z.has_prompt_file
          ? { tier: null }
          : null,
      deployments: z.deployments.map((d) => ({
        name: d.name,
        workflow_id: d.workflow_id,
        enabled: d.enabled,
        description: d.description,
      })),
      github: `${GITHUB_BASE}/${z.dir}`,
    });
  }
  for (const [key, asset] of Object.entries(overlay.assets)) {
    nodes.push({
      id: key,
      kind: asset.type,
      label: asset.name,
      asset_id: asset.id ?? null,
      cluster: null,
      external_owner: asset.external_owner ?? null,
      legacy: asset.legacy ?? false,
      note: asset.note ?? null,
    });
  }

  const edges = overlay.edges
    .filter((e) => !excluded.has(e.from) && !excluded.has(e.to))
    .map((e) => ({ ...e }));
  const degree = new Map();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  for (const n of nodes) n.degree = degree.get(n.id) ?? 0;

  return { nodes, edges, clusters: overlay.clusters };
}

// ---------------------------------------------------------------------------
// Layout: cluster-anchored force simulation, deterministic (seeded PRNG),
// run once at build time. The browser never lays anything out.
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function collisionRadius(n) {
  if (n.kind === "durable" || n.kind === "classic") return 58;
  const hub = Math.sqrt(Math.max(1, n.degree));
  if (n.kind === "external_app") return 40 + 6 * hub;
  return 34 + 9 * hub; // tables / notion DS / drive folders grow with degree
}

export function layout(graph, { seed = 7, iterations = 320 } = {}) {
  const rand = mulberry32(seed);
  const { nodes, edges } = graph;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Cluster anchors on a ring, ordered so adjacent clusters share assets.
  const clusterOrder = [
    "crm-contacts",
    "newsletter-content",
    "events",
    "client-onboarding",
    "esignatures-legal",
    "finance-xero",
    "internal-ops",
  ];
  const RING = 640;
  const anchors = new Map();
  clusterOrder.forEach((c, i) => {
    const a = (i / clusterOrder.length) * 2 * Math.PI - Math.PI / 2;
    anchors.set(c, { x: RING * Math.cos(a), y: RING * Math.sin(a) });
  });

  // Asset target = centroid of its neighbours' cluster anchors.
  const neighbourClusters = new Map();
  for (const e of edges) {
    for (const [a, b] of [[e.from, e.to], [e.to, e.from]]) {
      const asset = byId.get(a);
      const other = byId.get(b);
      if (asset && !asset.cluster && other?.cluster) {
        if (!neighbourClusters.has(a)) neighbourClusters.set(a, []);
        neighbourClusters.get(a).push(other.cluster);
      }
    }
  }
  const targetOf = (n) => {
    if (n.cluster) return anchors.get(n.cluster);
    const cs = neighbourClusters.get(n.id);
    if (!cs?.length) return { x: 0, y: 0 };
    let x = 0, y = 0;
    for (const c of cs) {
      x += anchors.get(c).x;
      y += anchors.get(c).y;
    }
    return { x: x / cs.length, y: y / cs.length };
  };

  // Init near targets with deterministic jitter.
  for (const n of nodes) {
    const t = targetOf(n);
    n.x = t.x + (rand() - 0.5) * 300;
    n.y = t.y + (rand() - 0.5) * 300;
    n.vx = 0;
    n.vy = 0;
    n.r = collisionRadius(n);
  }

  const DT = 1;
  for (let iter = 0; iter < iterations; iter++) {
    const cool = 1 - iter / iterations;
    // Anchor gravity.
    for (const n of nodes) {
      const t = targetOf(n);
      const g = n.cluster ? 0.022 : 0.02; // hubs sit between clusters, zaps in them
      n.vx += (t.x - n.x) * g;
      n.vy += (t.y - n.y) * g;
    }
    // Pairwise repulsion (n ~ 110, O(n^2) is fine at build time).
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = rand() - 0.5; dy = rand() - 0.5; d2 = 1; }
        const d = Math.sqrt(d2);
        const f = (2600 / d2) * cool;
        dx /= d; dy /= d;
        a.vx += dx * f; a.vy += dy * f;
        b.vx -= dx * f; b.vy -= dy * f;
      }
    }
    // Link springs — weak for mega-hubs so they anchor rather than collapse.
    for (const e of edges) {
      const a = byId.get(e.from), b = byId.get(e.to);
      const rest = a.r + b.r + 70;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const hubDegree = Math.max(a.degree, b.degree);
      const k = 0.02 / Math.sqrt(Math.max(1, hubDegree));
      const f = k * (d - rest);
      a.vx += (dx / d) * f; a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
    }
    // Integrate with damping.
    for (const n of nodes) {
      n.vx *= 0.6; n.vy *= 0.6;
      n.x += n.vx * DT;
      n.y += n.vy * DT;
    }
    // Hard collision pass in the last half, so clusters settle first.
    if (iter > iterations * 0.5) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const min = a.r + b.r + 14;
          let dx = b.x - a.x, dy = b.y - a.y;
          let d = Math.hypot(dx, dy);
          if (d < 1) { dx = 1; dy = 0; d = 1; }
          if (d < min) {
            const push = (min - d) / 2;
            dx /= d; dy /= d;
            a.x -= dx * push; a.y -= dy * push;
            b.x += dx * push; b.y += dy * push;
          }
        }
      }
    }
  }

  for (const n of nodes) {
    n.x = Math.round(n.x);
    n.y = Math.round(n.y);
    delete n.vx;
    delete n.vy;
    n.r = Math.round(n.r);
  }

  // Cluster hulls (bounding boxes with padding) for the zoomed-out view.
  const hulls = {};
  for (const [cluster, def] of Object.entries(graph.clusters)) {
    const members = nodes.filter((n) => n.cluster === cluster);
    const minX = Math.min(...members.map((n) => n.x - n.r));
    const maxX = Math.max(...members.map((n) => n.x + n.r));
    const minY = Math.min(...members.map((n) => n.y - n.r));
    const maxY = Math.max(...members.map((n) => n.y + n.r));
    hulls[cluster] = {
      label: def.label,
      x: Math.round(minX - 30),
      y: Math.round(minY - 30),
      w: Math.round(maxX - minX + 60),
      h: Math.round(maxY - minY + 60),
    };
  }
  graph.hulls = hulls;
  return graph;
}

// Debug rendering: rough SVG dump so layout can be iterated by eye.
const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function debugSvg(graph) {
  const xs = graph.nodes.map((n) => n.x), ys = graph.nodes.map((n) => n.y);
  const pad = 120;
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
  const colour = {
    durable: "#2E1B88", classic: "#4B4B4B", table: "#E17A14",
    notion_ds: "#4E1B61", drive_folder: "#1479E1", external_app: "#6B6B6B",
  };
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}" font-family="sans-serif">`,
    `<rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="white"/>`,
  ];
  for (const h of Object.values(graph.hulls)) {
    parts.push(`<rect x="${h.x}" y="${h.y}" width="${h.w}" height="${h.h}" fill="none" stroke="#9CE1FC" stroke-width="2" rx="16"/><text x="${h.x + 8}" y="${h.y - 8}" font-size="22" fill="#1479E1">${xmlEscape(h.label)}</text>`);
  }
  for (const e of graph.edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    parts.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#1F1F1F" stroke-opacity="0.15"/>`);
  }
  for (const n of graph.nodes) {
    parts.push(`<circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="${colour[n.kind] ?? "#999"}" fill-opacity="0.25" stroke="${colour[n.kind] ?? "#999"}"/><text x="${n.x}" y="${n.y}" font-size="11" text-anchor="middle" fill="#1F1F1F">${xmlEscape(n.label.slice(0, 26))}</text>`);
  }
  parts.push("</svg>");
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Injection: rewrite ONLY the marker-delimited data block in docs/map.html.
// ---------------------------------------------------------------------------

const MAP_PATH = join(ROOT, "docs", "map.html");
const START = "<!--GRAPH-DATA-START-->";
const END = "<!--GRAPH-DATA-END-->";

function renderDataBlock(graph) {
  const json = JSON.stringify({
    nodes: graph.nodes,
    edges: graph.edges,
    hulls: graph.hulls,
    meta: { generated_by: "scripts/build-map.mjs" },
  });
  // </script> inside a JSON string would end the script element early.
  const safe = json.replace(/</g, "\\u003c");
  return `${START}\n<script id="graph-data" type="application/json">${safe}</script>\n${END}`;
}

function buildAll() {
  const extracted = extract();
  const overlay = loadOverlay();
  const errors = validate(extracted, overlay);
  if (errors.length) {
    for (const e of errors) console.error(`✗ ${e}`);
    process.exit(1);
  }
  const graph = layout(buildGraph(extracted, overlay));
  // Sanity assertions: the graph the page gets must be internally coherent.
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const e of graph.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) throw new Error(`edge endpoint missing: ${e.from} -> ${e.to}`);
  }
  if (graph.nodes.length < 60 || graph.edges.length < 100) {
    throw new Error(`graph implausibly small: ${graph.nodes.length} nodes / ${graph.edges.length} edges`);
  }
  return graph;
}

function injectedHtml(graph) {
  const html = readFileSync(MAP_PATH, "utf8");
  const start = html.indexOf(START);
  const end = html.indexOf(END);
  if (start === -1 || end === -1) throw new Error("docs/map.html is missing the GRAPH-DATA markers");
  return html.slice(0, start) + renderDataBlock(graph) + html.slice(end + END.length);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const mode = process.argv[2] ?? "";
if (mode === "" || mode === "--check") {
  const graph = buildAll();
  const next = injectedHtml(graph);
  const current = readFileSync(MAP_PATH, "utf8");
  if (mode === "--check") {
    if (next !== current) {
      console.error("✗ docs/map.html data block is stale — run: node scripts/build-map.mjs");
      process.exit(1);
    }
    console.log("map ✓ docs/map.html matches the repo");
  } else {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(MAP_PATH, next);
    console.log(`map: injected ${graph.nodes.length} nodes / ${graph.edges.length} edges into docs/map.html`);
  }
} else if (mode === "--debug-svg") {
  const extracted = extract();
  const overlay = loadOverlay();
  const errors = validate(extracted, overlay);
  if (errors.length) {
    for (const e of errors) console.error(`✗ ${e}`);
    process.exit(1);
  }
  const graph = layout(buildGraph(extracted, overlay));
  const out = process.argv[3];
  const { writeFileSync } = await import("node:fs");
  writeFileSync(out, debugSvg(graph));
  console.log(`debug svg -> ${out} (${graph.nodes.length} nodes, ${graph.edges.length} edges)`);
} else if (mode === "--validate") {
  const errors = validate(extract(), loadOverlay());
  for (const e of errors) console.error(`✗ ${e}`);
  console.log(errors.length ? `${errors.length} validation error(s)` : "overlay ✓ consistent with the repo");
  process.exit(errors.length ? 1 : 0);
} else if (mode === "--report") {
  const { zaps, allTables, allUuids } = extract();
  const deployed = zaps.flatMap((z) => z.deployments);
  console.log(`zap dirs:        ${zaps.length}`);
  console.log(`  no zap.json:   ${zaps.filter((z) => !z.has_zap_json).map((z) => z.dir).join(", ")}`);
  console.log(`workflow ids:    ${deployed.length}`);
  console.log(`  enabled:       ${deployed.filter((d) => d.enabled).length}`);
  console.log(`table ULIDs:     ${allTables.size}`);
  for (const t of [...allTables].sort()) {
    const users = zaps.filter((z) => z.table_ids.includes(t)).map((z) => z.dir);
    console.log(`  ${t}  ${users.length} zap(s): ${users.join(", ")}`);
  }
  console.log(`uuid candidates: ${allUuids.size}`);
  for (const u of [...allUuids].sort()) {
    const users = zaps.filter((z) => z.uuid_candidates.includes(u)).map((z) => z.dir);
    console.log(`  ${u}  ${users.length} zap(s): ${users.join(", ")}`);
  }
} else {
  console.error(`build-map: unknown mode ${mode} (use --check, --validate, --report, --debug-svg <out>)`);
  process.exit(2);
}
