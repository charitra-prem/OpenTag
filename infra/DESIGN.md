# OpenTag box infrastructure — design

Target: `root@167.233.125.122` (8 cores, 15 GiB RAM, 300 GB disk). Bot + agent sessions run
as user `omni`; legacy root-side deployments (fluso :3002, permv2 :3004/:28000/:24111,
aio/triage services) stay untouched and their ports are treated as reserved.

Everything here exists to make the Slack agent workflow deterministic: the agent *calls
tools*, it does not improvise infra. Sources of truth for the audit behind these decisions:
`/tmp/opentag-audit/{backend,frontend}-audit.md`, the `hetzner-branch-worktree` skill, and
the live permv2/fluso deployments on the box.

## 1. Instances and port blocks

An **instance** is one issue/branch running the paired stack (fluso-frontend +
premapp-backend services) in worktrees under `/home/omni/worktrees/<SLUG>/`.

Slots `3..9` are available (1 ≈ legacy mcp, 2 = permv2, both root-side). Slot `N` maps to a
deterministic port block. Slots 3–5 follow the box's historic `N*10000` prefix convention;
that overflows the port range past slot 5, so slots 6–9 use `N*1000` blocks with the same
service offsets (e.g. slot 6 BE = 14000, agents = 10111):

| Service                    | Env var(s)                             | Port (slot 3–5 / 6–9) |
|----------------------------|----------------------------------------|-----------------------|
| Frontend (next start)      | `PORT`                                 | `30N0`                |
| Backend API (uvicorn)      | `FLUSO_LOCAL_BACKEND_PORT`/`SERVER_PORT` | `N8000` / `N*1000+8000` |
| Agents gateway (bun)       | `FLUSO_LOCAL_GATEWAY_PORT`/`FLUSO_GATEWAY_PORT` | `N4111` / `N*1000+4111` |
| PCCI proxy (in gateway)    | `PCCI_PROXY_PORT`                      | `N3005` / `N*1000+3005` |
| Chronograph (opt-in)       | `FLUSO_LOCAL_CHRONOGRAPH_PORT`         | `N7668` / `N*1000+7668` |
| Postgres (shared, see §2)  | `SERVER_DB_PORT`                       | shared                |

RAM note (§2): the box has ~15 GiB and no swap. Seven slots exist so frontend-only
instances (the common case, ~1 GiB each) never queue; running seven FULL stacks
concurrently would OOM — the memory watchdog alert is the guard rail there.

Hostnames per instance (cloudflared named tunnel `triage-hetzner`, wildcard DNS exists):
`<slug>.local-pcci.org` → FE, `<slug>-api.local-pcci.org` → BE,
`<slug>-agents.local-pcci.org` → agents gateway.

Registry: `/home/omni/.opentag/instances.json` (slug, issue, slot, ports, hostnames, state,
pids/tmux names, createdAt). A generated `/home/omni/worktrees/PORTS.md` mirrors it for
humans, matching root's `/root/wt/PORTS.md` convention.

## 2. Shared vs isolated infra (RAM reality)

The box has no swap, 13/15 GiB used, and a history of OOM kills. Full per-instance
`make up` stacks (postgres+redis+localstack+caddy each) do not fit. Default topology:

- **One shared "opentag-deps" docker compose project** (postgres on `35432`, localstack on
  `34566`, redis on `36379`) owned by the golden instance.
- Per instance: **own database** in the shared postgres (`SERVER_DB_NAME=opentag_<slug>`,
  created + migrated by the manager via `ALEMBIC_DB_*`) — separate DBs, so no migration
  races and no cross-instance singleton-daemon interference (`pipeline-updater` sweeps only
  its own DB).
- Chronograph is **off by default** (most UI/API issues don't need it); `wt start --with
  chronograph` gives the instance its own chronograph + redis pair (hardcoded
  `REDIS_JOB_PREFIX` makes sharing redis between chronographs unsafe).
- `wt create --isolated` escape hatch: full per-instance infra using the repo's own
  `.local/<stack>` mechanism, for issues that truly need it.

Host processes per instance (BE uvicorn ≈0.5 GiB, agents bun ≈0.3 GiB, FE `next start`
≈0.4 GiB) ≈ 1.2–1.5 GiB → 2–3 concurrent instances after the memory work in §5.
FE always `next build && next start` (turbopack dev OOMs the box); the manager serializes
builds (one at a time) and runs them with `NODE_OPTIONS=--max-old-space-size=4096`.

## 3. wt — the worktree/instance manager

`/home/omni/OpenTag/infra/wt/wt` (bun + TypeScript, no deps beyond what the bot has).
Both humans and the agent call it; the workflow prompts reference it by name.

```
wt create <slug> [--issue FLU-x] [--branch <br>] [--repos fe,be] [--isolated]
wt start  <slug> [--with chronograph]
wt stop   <slug>
wt status [<slug>]          # also: free slots, port map, tunnel state
wt url    <slug>            # prints the three public URLs
wt env    <slug>            # (re)materialize .env.locals from the golden template
wt destroy <slug>           # stop, remove ingress, git worktree remove, free slot
```

`create` = worktree(s) from `origin/dev` (or `--branch`) + slot allocation + `wt env` +
dep install (pnpm/uv/bun by lockfile) + cloudflared ingress insert + reload (kill stale
connectors first — the known trap) + registry write.

`env` renders `.env.local` files from **golden templates** at
`/home/omni/.opentag/env-templates/{backend,agents,frontend}.env.tmpl` — real values seeded
once from the proven permv2/fluso deployments, with `{{SLUG}}`, `{{PORT_*}}`, `{{DB_NAME}}`
placeholders on the ~15 identity vars (`SERVER_REDIRECT_URI_BASE`, `SERVER_DEV_PORTAL_URL`,
`SERVER_CORS_ALLOWED_ORIGINS`, `AGENTS_SERVER_URL` (BE→gateway, loopback),
`NEXT_PUBLIC_BACKEND_URL`, `BACKEND_URL`, `NEXT_PUBLIC_APP_URL`/`NEXT_PUBLIC_URL`,
`NEXT_PUBLIC_AGENT_SERVER_URL`/`NEXT_PUBLIC_GATEWAY_URL`/`NEXT_PUBLIC_FLUSO_URL`,
`FLUSO_PCCI_BASE_URL`, DB vars, ports). Secrets never pass through the LLM; template
updates are a human/vault operation (1Password `Infra` vault via `onepass` on the Mac —
the box holds only the rendered files, mode 0600).

`start` boot order: shared deps up → BE (migrate then uvicorn) → agents gateway → FE
(`HOSTNAME=<slug>.local-pcci.org` in env — not `-H`, the Clerk-redirect trap) → health
checks (`/v1/health`, `/healthz`, FE 200) → print URLs. Each process runs in a tmux session
`wt_<slug>_{be,ag,fe}` under omni with logs at `/home/omni/worktrees/<SLUG>/logs/`.

## 4. Two kinds of "branch deploy" (agent-facing definition)

- **Box instance** (this document): `wt create` + `wt start`; URLs on `*.local-pcci.org`.
  For interactive dev, issue workflows, screenshots, QA on the Hetzner box.
- **Git branch deploy** (premapp-backend/fluso-frontend `infra/branch-deploy/`): a
  per-branch Docker Compose stack built by GH Actions (`Create Branch Deploy Artifacts`,
  `workflow_dispatch` or push to `branch-deploy`), provisioned via Ansible on the AWS
  branch-deploy host; URLs `https://{api,agents,chrono}-<slug>.preview.nfraops.com`.
  The agent triggers it only on explicit request: `gh workflow run
  "Create Branch Deploy Artifacts" --ref <branch>` and reports the health URLs.
  Note: `SERVER_MCP_OAUTH_CALLBACK_BASE_URL` no longer exists — MCP OAuth callbacks derive
  from the request host.

## 5. Supervision and memory

systemd (system-level, `User=omni`) replaces the tmux-launched singletons:

- `opentag-bot.service` — the Slack bot (`bun run start`, cwd `/home/omni/OpenTag`).
- `opentag-omnigent.service` — `omnigent server` on :6767.
- `opentag-planapp.service` — plan app on 127.0.0.1:8096.
- `opentag-plantunnel.service` — the plan-bridge quick tunnel (until plan links move onto
  the named tunnel; then it's deleted).
- `opentag-watchdog.service` + `.timer` (every 60s) — see §6.

All `Restart=always`, journald logging, `MemoryHigh` caps on bot/planapp. Agent tmux panes
stay tmux (they're interactive TUIs), but get lifecycle management (§6).

Memory work: 16 GiB swapfile (`/swapfile`, swappiness 10 — safety net, not working set);
remove the 9 idle `fluso-runtime` containers + stale chromedriver/chrome processes; FE
builds serialized; `earlyoom` NOT installed (systemd restart + swap suffice).

## 6. Session lifecycle + alerts

The watchdog (a small bun script in OpenTag, run by the timer) reads
`~/.opentag/{workflows.json,instances.json}` + `tmux ls` + omnigent `/v1/sessions` and:

- **Session death**: a tmux pane backing a live workflow/chat session is gone or its
  omnigent session is `failed` → post to the originating Slack thread ("session died,
  say 'continue' to restart it") via `chat.postMessage` (bot token from OpenTag `.env`),
  and mark the record. The bot's `ensureSession` already rebuilds panes lazily on the next
  mention, so recovery is one message away.
- **Process death**: bot/omnigent/planapp unit inactive, tunnel URL file stale, or box
  memory critically low → post to the ops channel (`OPENTAG_OPS_CHANNEL`).
- **GC**: chat panes (`og_slack_*` without `__plan/__impl` tag) idle > 48h → kill;
  workflow panes for terminal-state workflows (done/failed/skipped) > 24h → kill;
  paused/awaiting panes are never GC'd. Instances stopped > 7d → `wt stop` reminder in ops.
- **Persistence**: per-channel executor defaults move from in-memory `Map` to
  `~/.opentag/channel-executors.json`.

`@bot status` (new control phrase) renders: live sessions (age, state), workflows by
phase, `wt status` summary with URLs, and box RAM/disk headroom.

## 7. Context layer

- `/home/omni/.claude/CLAUDE.md` (omni-global): who the bot is, repos + base branch `dev`,
  `wt` usage, the two branch-deploy definitions, FE-evidence rule (before/after PNGs +
  gif/webm for interactions via fluso-browser-testing → `<worktree>/screenshots/`),
  PR conventions, "never kill other instances' processes/ports", pointer to `wt status`.
- Skill `fluso-branch-deploys` (on box, in fluso-development-skills clone): the §4
  decision table + exact commands + the gotcha table from hetzner-branch-worktree
  (updated: MCP OAuth env var removed).
- `prompts.ts`: planning prompt gains "REPOS decides worktrees; instance URLs come from
  `wt url <slug>`"; implement prompt tells the agent the instance is already running,
  gives its URLs and `wt` commands, and keeps the screenshot mandate.

## 8. Golden instance

Slug `golden`, slot 3, branch `dev`, always-on. It is (a) the template donor for env
rendering, (b) the smoke-test target after box changes, (c) the reviewer's "what does dev
look like" URL: `https://golden.local-pcci.org`.
