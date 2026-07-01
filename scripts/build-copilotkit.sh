#!/usr/bin/env bash
#
# Build the vendored CopilotKit bot SDK packages (already checked out in
# vendor/copilotkit) in dependency order. Run this after a fresh clone
# (`git submodule update --init && bun install && bun run vendor:build`)
# or any time the submodule's dist/ output is missing or stale.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUB="$ROOT/vendor/copilotkit"

# The submodule stays pinned to upstream CopilotKit; our local SDK changes live
# as patches/*.patch in this repo and are applied before building. `git apply
# --check` skips any patch already applied (e.g. a re-run), so this is safe to
# run repeatedly.
if [ -d "$ROOT/patches" ]; then
  for p in "$ROOT"/patches/*.patch; do
    [ -e "$p" ] || continue
    if git -C "$SUB" apply --check "$p" 2>/dev/null; then
      echo "==> applying patch $(basename "$p")"
      git -C "$SUB" apply "$p"
    else
      echo "==> patch $(basename "$p") already applied / not applicable — skipping"
    fi
  done
fi

# Config packages (typescript-config, tsconfig) are JSON-only — no build step.
BUILD_ORDER=(shared core bot-ui bot runtime bot-slack bot-discord bot-telegram bot-whatsapp)

for p in "${BUILD_ORDER[@]}"; do
  echo "==> building $p"
  ( cd "$SUB/packages/$p" && bun run build >/dev/null )
done
echo "==> vendor build complete"
