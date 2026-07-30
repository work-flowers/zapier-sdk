#!/usr/bin/env node
// Repo rule 6: a Zap with an AI step keeps its prompt in a reviewable
// `*-prompt.md` alongside the code, and the deployed source embeds a verbatim
// copy. This script proves the two still agree.
//
//   node scripts/check-prompts.mjs         # verify, non-zero exit on drift
//   node scripts/check-prompts.mjs --fix   # rewrite the embedded copy from the .md
//
// Convention it enforces, per Zap directory:
//   <something>-prompt.md   has a "## Prompt" heading; everything after it
//                           (minus a leading `---` rule) is the prompt.
//   <something>.ts          has `const <NAME>_PROMPT = ` followed by a
//                           template literal holding that same text.
// A directory with neither is ignored; one with only a .md is an error, since
// that means a prompt is documented but nothing deploys it.
//
// A Zap with MORE THAN ONE prompt (drive-invoice-to-xero runs a header
// extraction and a payment-instruction extraction as separate AI steps) must
// say which literal each markdown file owns, with a marker anywhere above the
// "## Prompt" heading:
//
//   <!-- embed: PAYMENT_PROMPT -->
//
// Without it there is no way to tell which of several literals a file means,
// and `--fix` would overwrite one literal from every markdown in turn. A
// directory with a single prompt needs no marker, which is why the three Zaps
// that predate this are untouched.

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fix = process.argv.includes("--fix");

/** The prompt text a `*-prompt.md` file publishes: everything below "## Prompt". */
function promptFromMarkdown(md) {
  const idx = md.search(/^##\s+Prompt\s*$/m);
  if (idx === -1) return null;
  const after = md.slice(idx).replace(/^##\s+Prompt\s*$/m, "");
  return after.replace(/^\s*---\s*$/m, "").trim();
}

/** Which literal a markdown file owns, from a `<!-- embed: NAME -->` marker. */
function embedTargetFromMarkdown(md) {
  const m = md.match(/<!--\s*embed:\s*([A-Z0-9_]+)\s*-->/);
  return m ? m[1] : null;
}

/**
 * Locate every `const NAME_PROMPT = ` + template literal in a .ts source.
 * Returns each literal's raw body and its span, in source order.
 */
function findEmbeddedPrompts(src) {
  const decl = /const\s+([A-Z0-9_]*PROMPT)\s*(?::\s*string\s*)?=\s*`/g;
  const out = [];
  let m;
  while ((m = decl.exec(src)) !== null) {
    const start = m.index + m[0].length;
    let i = start;
    while (i < src.length) {
      const ch = src[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") break;
      i += 1;
    }
    if (i >= src.length) break;
    out.push({ name: m[1], raw: src.slice(start, i), start, end: i });
    decl.lastIndex = i + 1;
  }
  return out;
}

/** Evaluate a template-literal body to the string it denotes. Our own repo
 *  source, and all `${` are escaped by `escapeForTemplate`, so nothing runs. */
function decodeTemplateLiteral(raw) {
  return Function(`"use strict"; return \`${raw}\`;`)();
}

function escapeForTemplate(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

const dirs = readdirSync(REPO_ROOT)
  .filter((n) => !n.startsWith(".") && n !== "scripts" && n !== "node_modules")
  .filter((n) => {
    try {
      return statSync(join(REPO_ROOT, n)).isDirectory();
    } catch {
      return false;
    }
  })
  .sort();

let checked = 0;
let fixedCount = 0;
const problems = [];

for (const dir of dirs) {
  const abs = join(REPO_ROOT, dir);
  const files = readdirSync(abs);
  const mdFiles = files.filter((f) => /-prompt\.md$/.test(f));
  if (mdFiles.length === 0) continue;

  for (const md of mdFiles) {
    const mdPath = join(abs, md);
    // Re-read the source inside this loop, never outside it: when two markdown
    // files own two literals in the SAME .ts file, `--fix` rewrites by byte
    // offset, so the second fix must see the bytes the first one wrote.
    const mdText = readFileSync(mdPath, "utf8");
    const expected = promptFromMarkdown(mdText);
    if (expected === null) {
      problems.push(`${relative(REPO_ROOT, mdPath)}: no "## Prompt" heading`);
      continue;
    }
    const target = embedTargetFromMarkdown(mdText);

    const tsFiles = files.filter((f) => f.endsWith(".ts"));
    let hits = [];
    for (const ts of tsFiles) {
      const tsPath = join(abs, ts);
      const src = readFileSync(tsPath, "utf8");
      const literals = findEmbeddedPrompts(src);
      if (literals.length === 0) continue;
      if (target) {
        for (const found of literals.filter((l) => l.name === target)) hits.push({ tsPath, src, found });
      } else {
        // Legacy single-prompt shape: the first literal in the file is the one.
        hits.push({ tsPath, src, found: literals[0] });
      }
    }

    if (!target && mdFiles.length > 1) {
      problems.push(
        `${relative(REPO_ROOT, mdPath)}: ${dir}/ has ${mdFiles.length} *-prompt.md files, so this one must ` +
          `declare which literal it owns with an "<!-- embed: NAME_PROMPT -->" marker above "## Prompt"`,
      );
      continue;
    }

    if (hits.length === 0) {
      const available = [
        ...new Set(
          tsFiles.flatMap((ts) => findEmbeddedPrompts(readFileSync(join(abs, ts), "utf8")).map((l) => l.name)),
        ),
      ];
      problems.push(
        target
          ? `${relative(REPO_ROOT, mdPath)}: no literal named ${target} in any .ts in ${dir}/` +
              (available.length ? ` (found: ${available.join(", ")})` : "")
          : `${relative(REPO_ROOT, mdPath)}: no *_PROMPT template literal found in any .ts in ${dir}/`,
      );
      continue;
    }

    for (const { tsPath, src, found } of hits) {
      checked += 1;
      let actual;
      try {
        actual = decodeTemplateLiteral(found.raw);
      } catch (err) {
        problems.push(
          `${relative(REPO_ROOT, tsPath)}: ${found.name} is not a decodable template literal (${err.message})`,
        );
        continue;
      }
      if (actual === expected) continue;

      if (fix) {
        const next =
          src.slice(0, found.start) + escapeForTemplate(expected) + src.slice(found.end);
        writeFileSync(tsPath, next);
        fixedCount += 1;
        console.log(
          `fixed  ${relative(REPO_ROOT, tsPath)} (${found.name}) <- ${relative(REPO_ROOT, mdPath)}`,
        );
      } else {
        problems.push(
          `${relative(REPO_ROOT, tsPath)}: ${found.name} has drifted from ${relative(REPO_ROOT, mdPath)}\n` +
            `    embedded: ${actual.length} chars, markdown: ${expected.length} chars\n` +
            `    run: node scripts/check-prompts.mjs --fix`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error("Prompt check failed:\n");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

if (fix) {
  console.log(fixedCount === 0 ? "All prompts already in sync." : `Synced ${fixedCount} prompt(s).`);
} else {
  console.log(`All prompts in sync (${checked} checked).`);
}
