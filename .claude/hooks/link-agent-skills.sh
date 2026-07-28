#!/bin/bash
# Skills installed by skills.sh (`npx skills add …`, tracked in
# skills-lock.json) land in `.agents/skills/` — the cross-agent convention, so
# Cursor and Codex can read them too. Claude Code only discovers project skills
# under `.claude/skills/`, so without this the vendored zapier-sdk and
# workflows-* skills are present on disk but NOT invocable: `Skill(zapier-sdk)`
# fails with "Unknown skill", and CLAUDE.md's "load the zapier-sdk skill before
# writing any Zapier SDK code" silently degrades to working from memory.
#
# This links one into the other. `.claude/skills/<name>` is a relative symlink
# to `../../.agents/skills/<name>`; discovery follows it, and `references/…`
# paths inside a SKILL.md resolve through it. The links are committed, so a
# fresh clone has them in its first session — this hook is the self-healing
# path for a skill added, removed or updated after that.
#
# `.agents/skills/` stays the source of truth. Never edit through the link:
# `npx skills add` rewrites `.agents/skills/` and skills-lock.json, and would
# discard local edits.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENT_SKILLS="$REPO_ROOT/.agents/skills"
CLAUDE_SKILLS="$REPO_ROOT/.claude/skills"

linked=()
shadowed=()
pruned=()

if [ -d "$AGENT_SKILLS" ]; then
  mkdir -p "$CLAUDE_SKILLS"

  for skill_md in "$AGENT_SKILLS"/*/SKILL.md; do
    [ -e "$skill_md" ] || continue
    name="$(basename "$(dirname "$skill_md")")"
    link="$CLAUDE_SKILLS/$name"
    target="../../.agents/skills/$name"

    if [ -L "$link" ]; then
      # Already a link. Repoint it only if it aims somewhere else.
      [ "$(readlink "$link")" = "$target" ] && continue
    elif [ -d "$link" ]; then
      # A real directory someone put here deliberately, or a skills.sh install
      # that chose this path. Leave it alone — it wins — but say so, because it
      # shadows the .agents copy and the two can drift.
      shadowed+=("$name")
      continue
    fi

    # Missing, a broken link, or a plain file (a git clone without symlink
    # support writes the link target out as text). Replace it.
    rm -rf "$link"
    ln -s "$target" "$link"
    linked+=("$name")
  done
fi

# Drop links whose skill is gone from .agents/skills (uninstalled or renamed).
if [ -d "$CLAUDE_SKILLS" ]; then
  for link in "$CLAUDE_SKILLS"/*; do
    [ -L "$link" ] || continue
    case "$(readlink "$link")" in
      ../../.agents/skills/*) ;;
      *) continue ;;
    esac
    if [ ! -e "$link/SKILL.md" ]; then
      pruned+=("$(basename "$link")")
      rm -f "$link"
    fi
  done
fi

msgs=()

if [ ${#linked[@]} -gt 0 ]; then
  msgs+=("Linked ${#linked[@]} skill(s) from .agents/skills into .claude/skills so Claude Code can discover them: ${linked[*]}. If any of these do not appear in this session's skill list, they will be picked up on the next session — or ask the user to restart.")
fi

if [ ${#pruned[@]} -gt 0 ]; then
  msgs+=("Removed ${#pruned[@]} stale skill link(s) with no skill left in .agents/skills: ${pruned[*]}.")
fi

if [ ${#shadowed[@]} -gt 0 ]; then
  msgs+=("These skills exist as real directories in .claude/skills AND in .agents/skills: ${shadowed[*]}. The .claude copy wins and the two can drift; .agents/skills is meant to be the source of truth.")
fi

# The original purpose of this hook: CLAUDE.md says to load `zapier-sdk` before
# writing or running any Zapier SDK code "if it's available", so make its
# absence loud rather than letting the session quietly work from memory.
if [ ! -d "$AGENT_SKILLS/zapier-sdk" ] && [ ! -d "$HOME/.claude/skills/zapier-sdk" ]; then
  msgs+=("The zapier-sdk skill isn't installed (checked $AGENT_SKILLS/zapier-sdk and \$HOME/.claude/skills/zapier-sdk). Per this repo's CLAUDE.md it should be loaded before writing or running any Zapier SDK code. Tell the user to run 'npx skills add zapier/sdk --skill zapier-sdk' in this repo, then load the skill before touching SDK code this session.")
fi

[ ${#msgs[@]} -gt 0 ] || exit 0

CONTEXT_MSG="$(printf '%s\n' "${msgs[@]}")" python3 -c "
import json, os
print(json.dumps({'hookSpecificOutput': {'hookEventName': 'SessionStart', 'additionalContext': os.environ['CONTEXT_MSG']}}))
"
