#!/usr/bin/env bash
#
# Build the vendored CopilotKit bot SDK packages (already checked out in
# vendor/copilotkit) in dependency order. Run this after a fresh clone
# (`git submodule update --init && bun install && bun run vendor:build`)
# or any time the submodule's dist/ output is missing or stale.
#
set -euo pipefail

SUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/vendor/copilotkit"

# Config packages (typescript-config, tsconfig) are JSON-only — no build step.
BUILD_ORDER=(shared core bot-ui bot runtime bot-slack bot-discord bot-telegram bot-whatsapp)

for p in "${BUILD_ORDER[@]}"; do
  echo "==> building $p"
  ( cd "$SUB/packages/$p" && bun run build >/dev/null )
done
echo "==> vendor build complete"
