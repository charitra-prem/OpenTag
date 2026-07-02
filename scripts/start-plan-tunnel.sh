#!/bin/bash
# cloudflared quick tunnel in front of the bot's visual-plan bridge.
#
# Quick tunnels need no Cloudflare account but get a NEW random
# *.trycloudflare.com hostname each run — so the current URL is written to
# $URL_FILE, which the bot re-reads every time it composes a plan link.
# Links minted before a tunnel restart stop working; re-post the card (or say
# `@Athena take <issue>` again) to get a fresh one. For stable URLs, switch to
# a named tunnel and set OPENTAG_PUBLIC_BRIDGE_URL instead.
#
# Run under the bot user, e.g.:
#   tmux new-session -d -s plantunnel "/home/omni/start-plan-tunnel.sh >> /home/omni/tunnel.log 2>&1"
set -u
PORT="${OPENTAG_PLAN_BRIDGE_PORT:-8791}"
URL_FILE="${OPENTAG_TUNNEL_URL_FILE:-$HOME/.opentag/tunnel-url}"
mkdir -p "$(dirname "$URL_FILE")"
rm -f "$URL_FILE"

while true; do
  cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${PORT}" 2>&1 |
    while IFS= read -r line; do
      printf '%s\n' "$line"
      u=$(printf '%s' "$line" | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | head -1)
      if [ -n "$u" ]; then
        printf '%s\n' "$u" > "$URL_FILE"
        echo "[tunnel] public URL: $u"
      fi
    done
  rm -f "$URL_FILE"
  echo "[tunnel] cloudflared exited — restarting in 5s"
  sleep 5
done
