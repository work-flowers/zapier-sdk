---
name: zap-ai-prompts
description: Mechanics for this repo's AI-step prompt files — the `<name>-prompt.md` layout, the `scripts/check-prompts.mjs` drift checker and its `--fix` re-injection, and the `<!-- embed: NAME_PROMPT -->` marker a multi-prompt Zap needs. Use when creating, editing, or reviewing the prompt of any Zap with an AI step, or when check-prompts.mjs reports drift.
---

# AI-step prompts

Repo rule 6 (in `CLAUDE.md`) requires every Zap with an AI step to keep its prompt
in a `*-prompt.md` file. This skill is the how-to behind that rule.

## File shape

A Zap with an AI step stores its prompt in `<name>-prompt.md` in the Zap's
directory. The file carries a short header explaining which step uses it, then a
`## Prompt` heading; everything after that heading is the prompt verbatim. The
deployed source embeds a copy in a ``const <NAME>_PROMPT = `…` `` template
literal with a comment pointing back at the markdown.

Reference example: [`gmail-attachments-to-drive-by-type`](../../../gmail-attachments-to-drive-by-type/).

## The sync check

`node scripts/check-prompts.mjs` verifies every `*-prompt.md` still matches its
embedded copy and exits non-zero on drift; `--fix` re-injects from the markdown.

**Edit the markdown first, then run `--fix`** — never hand-edit the literal.

## Multi-prompt Zaps need an embed marker

**A Zap with more than one AI step needs an `<!-- embed: NAME_PROMPT -->` marker**
in each markdown, above its `## Prompt` heading, naming the literal it owns.

The checker otherwise matches only the FIRST `*_PROMPT` literal in a file, so two
prompts would both be compared against the same one and `--fix` would overwrite
it from every markdown in turn — silently. A single-prompt directory needs no
marker. `drive-invoice-to-xero` is the two-prompt reference.

## Structured output

Keep structured-output field definitions (`outputFields`) in the code, not the
markdown — the action needs them as JSON — but keep their descriptions consistent
with the prompt's wording.
