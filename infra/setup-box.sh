#!/usr/bin/env bash
# setup-box.sh — idempotent box bootstrap for the OpenTag infra layer.
# Run as ROOT on 167.233.125.122 after rsyncing the OpenTag repo:
#   bash /home/omni/OpenTag/infra/setup-box.sh
#
# Does, in order:
#   1. 16G swapfile (the box has none and a history of OOM kills)
#   2. installs the opentag-ingress sudo helper + scoped sudoers entry
#   3. installs + enables the systemd units (bot, omnigent, planapp,
#      plantunnel, watchdog timer), migrating each service out of its old
#      omni-tmux session
#   4. symlinks `wt` into omni's ~/.local/bin
#   5. git safe.directory entries so root tooling can read omni's clones
#
# It does NOT seed env templates (seed-templates.sh, reads root-owned live
# envs) and does NOT GC docker containers — run those explicitly.
set -euo pipefail
OT=/home/omni/OpenTag
[ -d "$OT/infra" ] || { echo "OpenTag repo not at $OT" >&2; exit 1; }

echo "── 1. swap"
if ! swapon --show | grep -q /swapfile; then
  if [ ! -f /swapfile ]; then
    fallocate -l 16G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10 >/dev/null
  grep -q 'vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
  echo "  swap: 16G enabled"
else
  echo "  swap: already active"
fi

echo "── 1b. omni in docker group (shared deps + agent runtimes)"
id -nG omni | grep -qw docker || usermod -aG docker omni
echo "  ok"

echo "── 1c. cloudflared config present at /root/.cloudflared"
# The tunnel config/credentials were once archived to /root/home-archive —
# a cloudflared restart without them takes down every *.local-pcci.org host.
if [ ! -f /root/.cloudflared/config.yml ] && [ -f /root/home-archive/.cloudflared/config.yml ]; then
  mkdir -p /root/.cloudflared
  cp -a /root/home-archive/.cloudflared/*.json /root/home-archive/.cloudflared/cert.pem \
        /root/home-archive/.cloudflared/config.yml /root/.cloudflared/
  echo "  restored from /root/home-archive/.cloudflared"
else
  echo "  ok"
fi

echo "── 2. ingress helper + sudoers"
install -m 0755 "$OT/infra/wt/ingress-helper.sh" /usr/local/bin/opentag-ingress
printf 'omni ALL=(root) NOPASSWD: /usr/local/bin/opentag-ingress\n' > /etc/sudoers.d/opentag-ingress
chmod 0440 /etc/sudoers.d/opentag-ingress
visudo -cf /etc/sudoers.d/opentag-ingress >/dev/null
echo "  ok"

echo "── 3. systemd units"
install -m 0644 "$OT"/infra/systemd/opentag-*.{service,timer} /etc/systemd/system/
systemctl daemon-reload

migrate() { # migrate <unit> <old-tmux-session> [<pkill-pattern>]
  local unit="$1" old="$2"
  sudo -u omni tmux kill-session -t "$old" 2>/dev/null && echo "  killed omni tmux '$old'" || true
  systemctl enable --now "$unit"
  sleep 1
  systemctl is-active --quiet "$unit" && echo "  $unit: active" || { echo "  $unit FAILED:"; journalctl -u "$unit" -n 10 --no-pager; }
}

# Bot first needs its old node procs gone (they hold the Slack socket).
if pgrep -f 'OpenTag.*app/index.ts' >/dev/null 2>&1; then
  pgrep -f 'app/index.ts' | while read -r pid; do
    # never kill our own shell / unrelated procs: check cwd is the bot dir
    if readlink "/proc/$pid/cwd" 2>/dev/null | grep -q '/home/omni/OpenTag'; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  sleep 2
fi
# The 'runtime' tmux held the legacy triage runtime (:8200); omnigent's old
# server was a detached daemon — free its port before the unit claims it.
old6767=$(ss -tlnp | grep ':6767 ' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)
if [ -n "$old6767" ] && ! systemctl is-active --quiet opentag-omnigent; then kill "$old6767" || true; sleep 2; fi
migrate opentag-omnigent runtime-none
migrate opentag-runtime runtime
migrate opentag-bot opentag
migrate opentag-planapp planapp
migrate opentag-plantunnel plantunnel
systemctl enable --now opentag-watchdog.timer
echo "  opentag-watchdog.timer: $(systemctl is-active opentag-watchdog.timer)"

echo "── 4. wt on PATH"
sudo -u omni mkdir -p /home/omni/.local/bin
sudo -u omni ln -sf "$OT/infra/wt/wt" /home/omni/.local/bin/wt
chmod +x "$OT/infra/wt/wt" "$OT/infra/wt/wt.ts" "$OT/infra/wt/seed-templates.sh" "$OT/infra/watchdog/watchdog.ts"
echo "  ok"

echo "── 5. git safe.directory"
for repo in fluso-frontend premapp-backend; do
  git config --global --get-all safe.directory 2>/dev/null | grep -qx "/home/omni/repos/$repo" \
    || git config --global --add safe.directory "/home/omni/repos/$repo"
done
echo "  ok"

echo
echo "done. next steps:"
echo "  bash $OT/infra/wt/seed-templates.sh           # golden env templates"
echo "  sudo -u omni -i wt create golden --branch dev  # golden instance"
echo "  sudo -u omni -i wt start golden"
