#!/bin/bash
# CLAUDE.md says to load the `zapier-sdk` skill before writing or running any
# Zapier SDK code "if it's available" — this makes that check explicit instead
# of silently degrading when it isn't installed. Workflows-* skills are already
# tracked in skills-lock.json; zapier-sdk itself is a separate skills.sh package
# (zapier/sdk) and isn't guaranteed to be present on a fresh clone or machine.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ -d "$REPO_ROOT/.agents/skills/zapier-sdk" ] || [ -d "$HOME/.claude/skills/zapier-sdk" ]; then
  exit 0
fi

MSG="The zapier-sdk skill isn't installed (checked $REPO_ROOT/.agents/skills/zapier-sdk and ~/.claude/skills/zapier-sdk). Per this repo's CLAUDE.md, it should be loaded before writing or running any Zapier SDK code. Tell the user to run:
npx skills add zapier/sdk --skill zapier-sdk
in this repo, then load the skill before touching SDK code this session."

CONTEXT_MSG="$MSG" python3 -c "
import json, os
print(json.dumps({'hookSpecificOutput': {'hookEventName': 'SessionStart', 'additionalContext': os.environ['CONTEXT_MSG']}}))
"
