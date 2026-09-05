#!/usr/bin/env bash
# Setup script for a Claude Code cloud environment (claude.ai -> Code ->
# environment settings -> setup script). Idempotent; safe to re-run.
#
# It does four things, in the order they can fail:
#
#   1. checks Node.js is new enough for the Zapier SDK CLI
#   2. puts `zsdk` (scripts/zsdk) on PATH and warms the npx cache
#   3. repairs the .claude/skills -> .agents/skills symlinks
#   4. proves the credentials actually reach the durables API
#
# Step 4 is the point. Without it a broken environment looks fine until the
# first real command, halfway into a session. It is the same read-only check
# .github/workflows/verify-zapier-credentials.yml runs, and it publishes
# nothing.
#
# PREREQUISITES set on the environment, not here:
#
#   Secrets   ZAPIER_CLIENT_ID / ZAPIER_CLIENT_SECRET — mint with
#             `npx zapier-sdk create-client-credentials <name> --allowed-scopes …`
#             from a machine that is already logged in. Keep them READ-scoped:
#             in this repo a merge to `main` is the deploy, and a direct
#             publish-workflow-version from a sandbox would bypass PR review and
#             the zap.json sync-back.
#
#   Egress    the sandbox restricts outbound traffic. Allow at least
#             registry.npmjs.org and *.zapier.com (API + auth + the durables
#             host code-substrate-workflows.zapier.com). Note that the durable
#             RUNTIME sandbox separately blocks hooks.zapier.com — that is
#             Zapier's own restriction and nothing here can lift it.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${ZSDK_BIN_DIR:-$HOME/.local/bin}"

step() { printf '\n=== %s\n' "$1"; }

# ── 1. Node ──────────────────────────────────────────────────────────────────
step "Node.js"
if ! command -v node >/dev/null 2>&1; then
  echo "node not found. The Zapier SDK CLI needs Node.js 20+ (CI uses 22)." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node $(node -v) is too old — the Zapier SDK CLI needs 20+ (CI uses 22)." >&2
  exit 1
fi
echo "node $(node -v) — ok"

# ── 2. zsdk on PATH ──────────────────────────────────────────────────────────
step "Installing zsdk"
mkdir -p "$BIN_DIR"
ln -sf "$REPO_ROOT/scripts/zsdk" "$BIN_DIR/zsdk"
echo "linked $BIN_DIR/zsdk -> $REPO_ROOT/scripts/zsdk"

case ":${PATH}:" in
  *":$BIN_DIR:"*) ;;
  *)
    export PATH="$BIN_DIR:$PATH"
    # The setup script's own shell dies with it, so persist for later shells.
    # ~/.bashrc is created if absent — a fresh sandbox often has no dotfiles at
    # all, and skipping a missing file is how the PATH silently fails to stick.
    touch "$HOME/.bashrc"
    for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
      [ -e "$rc" ] || continue
      grep -qF "# zapier-sdk repo: zsdk on PATH" "$rc" && continue
      printf '\n# zapier-sdk repo: zsdk on PATH\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$rc"
      echo "added $BIN_DIR to PATH in $rc"
    done
    ;;
esac

# Warm the npx cache so the first real command isn't a silent 30s download —
# and so a blocked registry.npmjs.org surfaces HERE rather than mid-session.
echo "warming the npx cache for @zapier/zapier-sdk-cli…"
npx --yes --package @zapier/zapier-sdk-cli zapier-sdk --version

# ── 3. Skill symlinks ────────────────────────────────────────────────────────
# The vendored zapier-sdk / workflows-* skills live in .agents/skills and are
# only discoverable through .claude/skills symlinks. A clone without symlink
# support materialises those as plain text files, and Skill(zapier-sdk) then
# fails with "Unknown skill" — CLAUDE.md's "load the skill first" rule degrading
# silently to working from memory. The SessionStart hook is the repair path;
# run it here too so the environment snapshot is already correct.
step "Skill links"
if [ -x "$REPO_ROOT/.claude/hooks/link-agent-skills.sh" ]; then
  "$REPO_ROOT/.claude/hooks/link-agent-skills.sh" >/dev/null
  echo "ran link-agent-skills.sh"
else
  echo "link-agent-skills.sh not found or not executable — skipping." >&2
fi

# ── 4. Auth smoke test ───────────────────────────────────────────────────────
step "Zapier credentials"
if [ "${ZSDK_SKIP_AUTH_CHECK:-}" = "1" ]; then
  echo "ZSDK_SKIP_AUTH_CHECK=1 — skipping the auth check."
  exit 0
fi

missing=""
[ -z "${ZAPIER_CLIENT_ID:-}" ]     && missing="$missing ZAPIER_CLIENT_ID"
[ -z "${ZAPIER_CLIENT_SECRET:-}" ] && missing="$missing ZAPIER_CLIENT_SECRET"
if [ -n "$missing" ]; then
  echo "Missing secret(s):$missing" >&2
  echo "Set them on the cloud environment (claude.ai -> Code -> environment settings)." >&2
  echo "Re-run with ZSDK_SKIP_AUTH_CHECK=1 to set the environment up without them." >&2
  exit 1
fi

# Read-only. Print a count, not the list, to keep workflow metadata out of the
# setup log.
"$BIN_DIR/zsdk" list-workflows --json > /tmp/zsdk-workflows.json
node -e '
  const d = JSON.parse(require("fs").readFileSync("/tmp/zsdk-workflows.json", "utf8"));
  const arr = Array.isArray(d) ? d : (d.data || d.workflows || d.results || []);
  console.log("auth ok — durable workflows visible:", Array.isArray(arr) ? arr.length : "unknown");
'
rm -f /tmp/zsdk-workflows.json

step "Done"
echo "Try: zsdk list-workflows --json"
