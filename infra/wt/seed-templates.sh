#!/usr/bin/env bash
# seed-templates.sh — one-time (rerunnable) seeding of the golden env
# templates for `wt env` from the PROVEN live deployments on the box:
#   backend/agents ← /root/home-archive/wt/permv2-be/{backend,agents}/.env.local
#   frontend       ← /root/home-archive/wt/permv2-fe/apps/frontend/.env.local
#
# Run as root on the box:  bash /home/omni/OpenTag/infra/wt/seed-templates.sh
#
# It copies the live env files (all shared secrets come through verbatim) and
# rewrites ONLY the per-instance identity vars to {{PLACEHOLDER}} form, then
# installs them at /home/omni/.opentag/env-templates/ (owner omni, mode 0600).
# Nothing is printed except var NAMES. Update a secret? Fix it in the template
# file directly (or reseed from a newer live deployment) and run
# `wt env <slug>` per instance.
set -euo pipefail

SRC_BE=/root/home-archive/wt/permv2-be/backend/.env.local
SRC_AG=/root/home-archive/wt/permv2-be/agents/.env.local
SRC_FE=/root/home-archive/wt/permv2-fe/apps/frontend/.env.local
# The DEPLOYED-dev-backend FE config (FE runs locally, talks to
# https://api.dev.khichdi.cc via the same-origin Next proxy, matching dev Clerk
# keys) — the reference for frontend-only changes that don't need a local BE.
SRC_FE_DEV=/opt/fluso-frontend/apps/frontend/.env.local
DST=/home/omni/.opentag/env-templates
mkdir -p "$DST"

# quote_placeholders FILE — live envs carry literal `KEY=<fill me in>` stubs;
# unquoted angle brackets are a bash syntax error when the file is sourced.
quote_placeholders() {
  sed -i -E 's/^([A-Za-z_][A-Za-z0-9_]*)=(<[^>]*>)\s*$/\1="\2"/' "$1"
}

# set_kv FILE KEY VALUE — replace the value of KEY, appending if absent.
set_kv() {
  local f="$1" k="$2" v="$3"
  if grep -qE "^${k}=" "$f"; then
    sed -i "s|^${k}=.*|${k}=${v}|" "$f"
  else
    echo "${k}=${v}" >> "$f"
  fi
}

# ── backend.env.tmpl ─────────────────────────────────────────────────────────
f="$DST/backend.env.tmpl"; cp "$SRC_BE" "$f"; quote_placeholders "$f"
set_kv "$f" SERVER_REDIRECT_URI_BASE       'https://{{SLUG}}-api.{{DOMAIN}}'
set_kv "$f" SERVER_DEV_PORTAL_URL          'https://{{SLUG}}.{{DOMAIN}}'
set_kv "$f" SERVER_CORS_ALLOWED_ORIGINS    'https://{{SLUG}}.{{DOMAIN}},https://{{SLUG}}-api.{{DOMAIN}},http://localhost:{{FE_PORT}},http://127.0.0.1:{{FE_PORT}}'
set_kv "$f" SERVER_DB_HOST                 '{{DB_HOST}}'
set_kv "$f" SERVER_DB_PORT                 '{{DB_PORT}}'
set_kv "$f" SERVER_DB_NAME                 '{{DB_NAME}}'
set_kv "$f" SERVER_DB_USER                 'postgres'
set_kv "$f" SERVER_DB_PASSWORD             'postgres'
set_kv "$f" ALEMBIC_DB_HOST                '{{DB_HOST}}'
set_kv "$f" ALEMBIC_DB_PORT                '{{DB_PORT}}'
set_kv "$f" ALEMBIC_DB_NAME                '{{DB_NAME}}'
set_kv "$f" ALEMBIC_DB_USER                'postgres'
set_kv "$f" ALEMBIC_DB_PASSWORD            'postgres'
set_kv "$f" CLI_DB_HOST                    '{{DB_HOST}}'
set_kv "$f" CLI_DB_PORT                    '{{DB_PORT}}'
set_kv "$f" CLI_DB_NAME                    '{{DB_NAME}}'
set_kv "$f" CLI_SERVER_URL                 'http://127.0.0.1:{{BE_PORT}}'
set_kv "$f" AGENTS_SERVER_URL              'http://127.0.0.1:{{AG_PORT}}'
set_kv "$f" COMMON_AWS_ENDPOINT_URL        'http://127.0.0.1:{{LOCALSTACK_PORT}}'
set_kv "$f" PIPELINE_BACKEND_URL           'http://127.0.0.1:{{BE_PORT}}'
set_kv "$f" CHRONOGRAPH_URL                'http://127.0.0.1:{{CG_PORT}}'
set_kv "$f" SERVER_ENVIRONMENT             'local'

# ── agents.env.tmpl ──────────────────────────────────────────────────────────
f="$DST/agents.env.tmpl"; cp "$SRC_AG" "$f"; quote_placeholders "$f"
set_kv "$f" PORT                           '{{AG_PORT}}'
set_kv "$f" FLUSO_GATEWAY_PORT             '{{AG_PORT}}'
set_kv "$f" PCCI_PROXY_PORT                '{{PCCI_PORT}}'
set_kv "$f" FLUSO_PCCI_BASE_URL            'http://127.0.0.1:{{PCCI_PORT}}/v1'
set_kv "$f" ACI_API_URL                    'http://127.0.0.1:{{BE_PORT}}/v1'
set_kv "$f" CHRONOGRAPH_URL                'http://127.0.0.1:{{CG_PORT}}'
set_kv "$f" FLUSO_CHRONOGRAPH_URL          'http://127.0.0.1:{{CG_PORT}}'
set_kv "$f" FLUSO_DATA_DIR                 '/home/omni/worktrees/{{SLUG}}/agents-data'

# ── frontend.env.tmpl ────────────────────────────────────────────────────────
f="$DST/frontend.env.tmpl"; cp "$SRC_FE" "$f"; quote_placeholders "$f"
set_kv "$f" NEXT_PUBLIC_BACKEND_URL        'https://{{SLUG}}-api.{{DOMAIN}}/v1'
set_kv "$f" BACKEND_URL                    'https://{{SLUG}}-api.{{DOMAIN}}/v1'
set_kv "$f" BACKEND_PROXY_TARGET           'https://{{SLUG}}-api.{{DOMAIN}}'
set_kv "$f" NEXT_PUBLIC_ACI_API_URL        'https://{{SLUG}}-api.{{DOMAIN}}'
set_kv "$f" NEXT_PUBLIC_AGENT_SERVER_URL   'https://{{SLUG}}-agents.{{DOMAIN}}'
set_kv "$f" NEXT_PUBLIC_GATEWAY_URL        'https://{{SLUG}}-agents.{{DOMAIN}}'
set_kv "$f" NEXT_PUBLIC_FLUSO_URL          'https://{{SLUG}}-agents.{{DOMAIN}}'
set_kv "$f" NEXT_PUBLIC_URL                'https://{{SLUG}}.{{DOMAIN}}'
set_kv "$f" NEXT_PUBLIC_APP_URL            'https://{{SLUG}}.{{DOMAIN}}'
set_kv "$f" AGENTS_SERVER_URL              'http://127.0.0.1:{{AG_PORT}}'

# ── frontend-dev.env.tmpl (FE-only: point at the DEPLOYED dev backend) ────────
# Keeps the deployed-dev backend URLs (api.dev.khichdi.cc) + matching dev Clerk
# keys verbatim; only the FE's OWN public identity moves per-instance. No local
# backend/agents needed — the browser hits the FE's same-origin proxy which
# Next forwards server-side to the deployed backend (no CORS).
if [ -f "$SRC_FE_DEV" ]; then
  f="$DST/frontend-dev.env.tmpl"; cp "$SRC_FE_DEV" "$f"; quote_placeholders "$f"
  set_kv "$f" NEXT_PUBLIC_URL   'https://{{SLUG}}.{{DOMAIN}}'
  set_kv "$f" NEXT_PUBLIC_APP_URL 'https://{{SLUG}}.{{DOMAIN}}'
  # The deployed dev backend (api.dev.khichdi.cc) CORS-allowlists only its own
  # frontends (localhost:3000, app.khichdi.cc), NOT *.local-pcci.org — so the
  # browser must NEVER call it cross-origin. Point every browser-facing backend
  # base at THIS instance's own origin under /api/backend; next.config rewrites
  # /api/backend/:path* -> BACKEND_PROXY_TARGET server-side. Same-origin request
  # => no CORS preflight; the proxied server->server GET carries no browser
  # Origin so the backend accepts it. BACKEND_PROXY_TARGET holds the real host.
  set_kv "$f" NEXT_PUBLIC_BACKEND_URL 'https://{{SLUG}}.{{DOMAIN}}/api/backend/v1'
  set_kv "$f" BACKEND_URL             'https://{{SLUG}}.{{DOMAIN}}/api/backend/v1'
  set_kv "$f" NEXT_PUBLIC_ACI_API_URL 'https://{{SLUG}}.{{DOMAIN}}/api/backend'
  set_kv "$f" BACKEND_PROXY_TARGET    'https://api.dev.khichdi.cc'
else
  echo "WARN: $SRC_FE_DEV not found — frontend-dev template not seeded (FE-only mode unavailable)" >&2
fi

chown -R omni:omni /home/omni/.opentag
chmod 700 "$DST"; chmod 600 "$DST"/*.tmpl
echo "seeded templates:"
ls -la "$DST"
echo "(review identity vars):"
grep -hE '\{\{' "$DST"/*.tmpl | cut -d= -f1 | sort -u
