#!/usr/bin/env bash
#
# Refresh the vendored CopilotKit bot SDK to a chosen upstream commit and rebuild.
#
# OpenTag consumes the @copilotkit/bot* packages from the CopilotKit monorepo as a
# pinned git submodule (vendor/copilotkit), linked into a bun workspace. The npm
# releases of these packages are incomplete/internally inconsistent, so we build
# them from source. This script is the ONLY thing you run to pull upstream changes;
# it never auto-syncs — you choose when, and the new commit is recorded in OpenTag's
# history when you commit the submodule pointer.
#
# Usage:
#   scripts/sync-copilotkit.sh              # latest origin/main
#   scripts/sync-copilotkit.sh <ref>        # a specific branch, tag, or SHA
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUB="$REPO_ROOT/vendor/copilotkit"
REF="${1:-origin/main}"

# Keep this list in sync with the "workspaces" array in package.json — it's the
# closure of bot packages plus everything they reference via "workspace:".
PACKAGES=(bot bot-ui bot-slack bot-discord bot-telegram bot-whatsapp core shared runtime typescript-config tsconfig)

echo "==> Fetching CopilotKit and checking out '$REF'"
git -C "$SUB" fetch --depth 1 origin "${REF#origin/}" 2>/dev/null || git -C "$SUB" fetch origin
git -C "$SUB" checkout --detach FETCH_HEAD 2>/dev/null || git -C "$SUB" checkout "$REF"

echo "==> Re-applying sparse-checkout"
git -C "$SUB" sparse-checkout set "${PACKAGES[@]/#/packages/}"

echo "==> Installing workspace (bun)"
( cd "$REPO_ROOT" && bun install )

echo "==> Building packages"
bash "$REPO_ROOT/scripts/build-copilotkit.sh"

echo "==> Type-checking OpenTag"
( cd "$REPO_ROOT" && bun run check-types )

PINNED="$(git -C "$SUB" rev-parse HEAD)"
echo
echo "==> Done. CopilotKit pinned at $PINNED"
echo "    Commit the new pointer to record it in OpenTag's history:"
echo "      git add vendor/copilotkit && git commit -m 'chore: bump CopilotKit to ${PINNED:0:12}'"
