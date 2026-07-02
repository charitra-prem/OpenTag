#!/usr/bin/env bash
# opentag-ingress — the ONLY root-privileged step of `wt`: manage cloudflared
# ingress rules for OpenTag instances on the named tunnel (triage-hetzner).
#
# Install (as root):
#   install -m 0755 /home/omni/OpenTag/infra/wt/ingress-helper.sh /usr/local/bin/opentag-ingress
#   echo 'omni ALL=(root) NOPASSWD: /usr/local/bin/opentag-ingress' > /etc/sudoers.d/opentag-ingress
#   chmod 0440 /etc/sudoers.d/opentag-ingress
#
# Usage:
#   opentag-ingress add <slug> <fe_port> <be_port> <agents_port>
#   opentag-ingress remove <slug>
#
# Rules are tagged with "# opentag:<slug>" comments so remove is exact and
# other (root-managed) rules are never touched. After editing we restart the
# tunnel service AND kill any stray untracked cloudflared connector — a stale
# connector serving the old config round-robins with the new one (documented
# trap: intermittent 404s).
set -euo pipefail

CONF=/root/.cloudflared/config.yml
SERVICE=cloudflared-triage
DOMAIN="${OPENTAG_DEPLOY_DOMAIN:-local-pcci.org}"

cmd="${1:?add|remove}"; slug="${2:?slug}"
[[ "$slug" =~ ^[a-z][a-z0-9-]{1,20}$ ]] || { echo "bad slug" >&2; exit 1; }

cp "$CONF" "${CONF}.bak.opentag"

remove_rules() {
  # Each opentag rule is exactly 2 lines: the tagged hostname line + its
  # service line — so delete the match plus ONE following line. (+2 once ate
  # the next rule's hostname and corrupted the YAML.)
  sed -i "/# opentag:${slug}\$/,+1d" "$CONF"
}

case "$cmd" in
  add)
    fe="${3:?fe port}"; be="${4:?be port}"; ag="${5:?agents port}"
    remove_rules  # idempotent re-add
    # Insert before the wildcard/catch-all (first rule that has no hostname or
    # the '*.' wildcard) so specific hostnames keep matching first.
    tmp=$(mktemp)
    # A port of 0 means "no such service for this instance" (frontend-only
    # instances have no local -api/-agents) — skip that rule entirely.
    awk -v slug="$slug" -v fe="$fe" -v be="$be" -v ag="$ag" -v dom="$DOMAIN" '
      !inserted && /hostname: .\*\./ {
        print "- hostname: " slug "." dom "  # opentag:" slug
        print "  service: http://127.0.0.1:" fe
        if (be != "0") {
          print "- hostname: " slug "-api." dom "  # opentag:" slug
          print "  service: http://127.0.0.1:" be
        }
        if (ag != "0") {
          print "- hostname: " slug "-agents." dom "  # opentag:" slug
          print "  service: http://127.0.0.1:" ag
        }
        inserted=1
      }
      { print }
    ' "$CONF" > "$tmp"
    # sanity: catch-all still last, yaml still parses (cloudflared will verify on start)
    grep -q "http_status:404" "$tmp" || { echo "refusing: catch-all missing after edit" >&2; exit 1; }
    mv "$tmp" "$CONF"
    ;;
  remove)
    remove_rules
    ;;
  *) echo "unknown command $cmd" >&2; exit 1;;
esac

systemctl restart "$SERVICE"
# Kill stray connectors not owned by the service (stale-config trap).
main_pid=$(systemctl show -p MainPID --value "$SERVICE")
for pid in $(pgrep -f 'cloudflared.*tunnel run' || true); do
  [ "$pid" != "$main_pid" ] && kill "$pid" 2>/dev/null && echo "killed stale cloudflared $pid"
done
echo "ingress ${cmd} ${slug}: ok"
