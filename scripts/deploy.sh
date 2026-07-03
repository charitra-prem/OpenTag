#!/usr/bin/env bash
# Deploy OpenTag from the Mac repo (source of truth) to the box.
#
#   scripts/deploy.sh            # verify + sync code. NO restart — infra/wt and
#                                # infra/watchdog go live immediately (re-read per
#                                # invocation); app/omnigent changes wait on disk.
#   scripts/deploy.sh --restart  # …then restart opentag-bot. Safe at any time:
#                                # boot recovery re-attaches to workflow phases
#                                # that were mid-turn (panes + omnigent sessions
#                                # survive; only the bot's poll loops rebuild).
#
# What restart does NOT preserve: plain chat turns mid-stream (their pane
# finishes on its own; the thread's next mention has full context) and Slack
# "Working…" cards of chat turns (they freeze; harmless).
set -euo pipefail
cd "$(dirname "$0")/.."

BOX=root@167.233.125.122
DEST=/home/omni/OpenTag

echo "== verify"
npx tsc --noEmit
npx vitest run --reporter=dot 2>&1 | tail -2

echo "== sync"
rsync -az --delete \
  --exclude .git --exclude node_modules --exclude vendor --exclude .env \
  ./ "$BOX:$DEST/"
ssh "$BOX" "chown -R omni:omni $DEST && cp $DEST/infra/context/omni-CLAUDE.md /home/omni/.claude/CLAUDE.md && chown omni:omni /home/omni/.claude/CLAUDE.md"

if [[ "${1:-}" == "--restart" ]]; then
  echo "== restart (workflow turns re-attach on boot)"
  ssh "$BOX" "systemctl restart opentag-bot && sleep 5 && systemctl is-active opentag-bot && tail -3 /home/omni/bot.log"
else
  echo "== synced, bot NOT restarted — app/omnigent changes are inert until:"
  echo "   scripts/deploy.sh --restart   (safe even mid-run: workflows re-attach)"
fi
