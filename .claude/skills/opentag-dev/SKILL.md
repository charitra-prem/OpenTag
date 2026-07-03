---
name: opentag-dev
description: Working on OpenTag/Athena — architecture map, box operations, deploy discipline, conventions, and hard-won gotchas. Use when changing code in ~/work/OpenTag or operating the deployment box at 167.233.125.122.
---

# OpenTag / Athena development

OpenTag is a Slack coding-agent bot. Its Slack identity is **Athena**; to the
agents it runs, Athena is a *meta-harness* that drives native Claude Code /
Codex TUI sessions with custom skills. Never (re)introduce "OpenTag" into
anything an agent session can read (prompts, CLAUDE.md, PORTS.md, wt output) —
the product name is deliberately hidden from the agent (see Conventions).

## Topology — one rule above all

- **Mac repo `~/work/OpenTag` is the source of truth.** The box copy is a
  deploy artifact. Never `git` on the box; never edit box files without
  mirroring the change here first (or immediately backporting it).
- Box: `root@167.233.125.122`, code at `/home/omni/OpenTag`, runs as user
  `omni`. Other people's deployments share this box — behave like a guest.
- Concurrent agent sessions edit this repo. If an Edit fails with "file has
  been modified", re-read the file — someone else changed it. Merge, don't
  clobber.

## Component map

| Piece | Where | What |
|---|---|---|
| Bot app | `app/index.ts` | createBot wiring, onMention, control phrases, turn-lock override, share outbox |
| Native agent | `omnigent/native-agent.ts` | AG-UI agent driving Claude/Codex TUIs in tmux via the omnigent server (127.0.0.1:6767). Poll loop, turn streamer, stop/preamble registries |
| Issue workflow | `app/workflows/index.tsx` | take → plan → approve card → implement state machine; resume/follow-up; instance adoption |
| Trigger parsing | `app/workflows/detect.ts` | `take/plan/handle`, `resume/continue/follow up`, `investigate`, near-miss hints. Pure functions, unit-tested |
| Phase prompts | `app/workflows/prompts.ts` | planning / revision / implement / investigate / resume / follow-up prompt builders |
| Workflow state | `app/workflows/state.ts` → `/home/omni/.opentag/workflows.json` | records keyed `channel::threadTs`; states planning → awaiting_approval → (revising) → implementing → done/failed/skipped |
| Plan bridge | `app/workflows/planbridge.ts` | cookie-gated proxy (8791) fronting the self-hosted Plan app (8096) via cloudflared |
| Instance manager | `infra/wt/wt.ts` (+ `infra/wt/wt` launcher) | slot-based port blocks (slots 3–9), worktrees, env render, ingress. Registry `/home/omni/.opentag/instances.json` |
| Watchdog | `infra/watchdog/watchdog.ts` | systemd timer 60s: dead-session alerts, pane GC, debris janitor (terminal >6h, open PR always spared) |
| Agent-side briefing | `infra/context/omni-CLAUDE.md` | tracked source of the box's `/home/omni/.claude/CLAUDE.md` — **rsync does NOT install it; `cp` it on deploy** |
| Vendored SDK | `vendor/copilotkit/packages/bot*` | symlinked into node_modules. `create-bot.ts` holds the per-conversation turn lock |

Services (systemd): `opentag-bot`, `opentag-omnigent`, `opentag-planapp`,
`opentag-plantunnel`, `opentag-watchdog.timer`.
Logs: `/home/omni/bot.log`, `/home/omni/runtime.log`, `~omni/.omnigent/logs/`.

## Runtime architecture (what actually runs a turn)

1. Mention → `app/index.ts` onMention → control phrase? workflow trigger? else
   chat → `thread.runAgent` → `OmnigentNativeAgent.run()`.
2. The agent keeps **one tmux pane per (thread, executor[, phase])**:
   `og_slack_<channel>_<ts>[__claude][__plan|__impl|__inv]`. Input is typed
   with `tmux send-keys` (single line — prompts must survive newline
   flattening; never inline multi-KB blobs, reference file paths instead).
3. Output is polled from omnigent `GET /v1/sessions/{id}/items`. Turn
   completion = quiet debounce over session status / pane activity /
   WORKING_RE / item growth (`exit=quiet` in logs).
4. **The turn streamer posts ONE Slack message per turn**: interim narration
   becomes `note` tool rows inside the self-editing "⚙️ N steps" status card;
   only trailing prose after the last tool call is a real message. Workflow
   `onDone` still receives the FULL text (`streamer.text`) — plan parsing
   depends on it.
5. Workflow phases run through the same agent via one-shot `setTurnOverride`
   (prompt, executor, model, cwd, sessionTag, maxPolls, onDone).
   Plain-chat turns get a one-shot `setTurnPreamble` scope note when the
   thread has a workflow record (prevents "fix ci comments" sweeping other
   issues' PRs).
6. omnigent has a **separate long-running host daemon**
   (`omnigent.host._daemon_entry`, pid in `~omni/.omnigent/host.pid`) that is
   NOT restarted by `systemctl restart opentag-omnigent`. Runners inherit its
   cwd — see Gotchas.

## User-facing primitives (Slack)

`help` · `status` · `use codex|claude` · `!codex <task>` (one message) ·
`stop` (THIS thread) · `stop all` (channel) · `take this|FLU-x[, brief]` ·
`take this fe fix only` → near-miss hint · plan card Approve/Request/Skip
(text forms work: approve/skip/feedback) · `investigate <q>` (read-only) ·
`resume` (continue interrupted impl) · `resume, <ask>` / `follow up: <ask>`
(new work on TOP of a done workflow — same branch/PR, context from Linear +
gh pr view; merged PR → `-followup` branch).

**Telegram (chat parity):** activated by `TELEGRAM_BOT_TOKEN` in the box
`.env` (long-polling — no webhook/ingress). Control phrases, per-chat
executor/model prefs, `stop`/`stop all`, preambles, and the file outbox all
work (key transforms are platform-aware, see gotcha 13). Still Slack-only:
issue workflows' boot recovery/plan-page feedback (`makeThreadFactory`),
`/file-issue` modal, assistant pane, watchdog alerts, Linear-synced bug
threads.

## Deploy discipline

Use **`scripts/deploy.sh`** — it encodes all of this: verify (tsc + vitest),
rsync (excludes .env), chown, install omni-CLAUDE.md. Add `--restart` to also
restart `opentag-bot`.

- `infra/wt` and `infra/watchdog` go live on plain sync (re-read every
  invocation, no restart needed). `app/` and `omnigent/` changes are inert
  until a restart.
- **Restarts are safe mid-run**: every turn persists {conv, item baseline,
  launch params} to `~/.opentag/active-turns/`; on boot the bot re-attaches
  to workflow phases still running in their panes (rehydrated thread + the
  `reattach` turn override), so they stream on and their onDone still
  advances the state machine. Items produced during the restart window are
  caught up from the persisted baseline. Plain CHAT turns are not recovered
  (pane finishes on its own; the thread's frozen "Working…" card is cosmetic).
- NEVER touch box `.env` blindly (real secrets; back up before edits).
  `.env.example` documents every knob.
- Verify after restart: `systemctl is-active opentag-bot`, `tail bot.log` for
  `[bot] started on: slack` and any `[workflow] re-attached` lines.

## Testing changes for real

Unit: `npx vitest run` (parsers in `app/workflows/__tests__/`). E2E: use the
sandbox channel **#fluso-auto-solver-testing** (`C0BE3B406TV`) with the
`agent-slack` CLI (posts as Charitra; bot user is `U0B6ECCNR0A`):

```
agent-slack message send C0BE3B406TV "<@U0B6ECCNR0A> help"
agent-slack message list C0BE3B406TV --thread-ts <root-ts>   # read replies
```

Primitive matrix worth re-running after risky changes: help/status, stop in
idle thread, stop mid-turn (start a sustained multi-step task — the harness
BACKGROUNDS `sleep`-style waits and ends the turn, so use "read every file
under X and summarize"), stop all, use codex/claude, take near-miss hint,
`take TEST-1, <brief>` → plan card → `skip`, resume guards, investigate.
NEVER approve a plan from the sandbox — implementation opens real PRs.

## Conventions

- Branches: `athena/<issue-slug>` (legacy `opentag/<slug>` exists). PRs target
  `dev` in both product repos (`fluso-frontend`, `premapp-backend`).
- Worktrees: `/home/omni/worktrees/<DIR>/<repo>` where DIR is the wt slug
  uppercased — **slug drift exists** (`FLU256` vs `FLU-256`); always resolve
  via `resolveWorktreeCwd`-style candidates, never assume the dashed form.
- wt slots 3–9; 3–5 use legacy `N*10000` port blocks, 6–9 use `N*1000`.
  Ports are frozen per-instance in the registry at create time.
- Secrets: rendered into per-instance `.env.local` from templates in
  `~omni/.opentag/env-templates/` (seeded from the golden instance, mode
  0600). Agents are told they're complete; `wt env <slug>` re-renders.
- Identity: agent-visible strings say **Athena**, never OpenTag. The bot's
  own name in Slack copy is Athena.
- Config paths on box: `~/.opentag/` for state; `~/.config/` style preferred
  over macOS Library paths for anything Mac-side.
- Debris: watchdog reclaims terminal-workflow worktrees/instances/branches
  after `OPENTAG_DEBRIS_TTL_HOURS` (6) — an OPEN PR always spares them.
  Chat-driven instances with no workflow record are NEVER auto-reclaimed.

## Gotchas ledger (each cost real downtime — do not relearn)

1. **Turn lock eats overlapping mentions.** `vendor/.../create-bot.ts`
   acquires `turn:<conversationKey>` per turn; overlapping mentions DROP
   silently (60s TTL). `store.onLockConflict` in `app/index.ts` forces
   control phrases through. If a new "bot ignored me mid-turn" bug appears,
   look here first.
2. **rsync copies the Mac's permission bits.** The `infra/wt/wt` launcher
   once lost +x on every deploy because git tracked it as 100644. Commit the
   exec bit (`git ls-files -s` shows 100755) for anything executable.
3. **Never `rm -rf` a directory a running process anchors.** Deleting
   `/home/omni/demo-repo` invalidated the omnigent HOST DAEMON's cwd →
   every runner crashed at `Path.cwd()` → "Native Claude session failed to
   start" outage. Recreating the dir does NOT fix (deleted inode). Check
   `readlink /proc/*/cwd | grep <dir>` before deleting; fix by killing the
   daemon family so a fresh one spawns.
4. **Same branch can't live in two worktrees.** Re-taking a finished issue
   used to die in `wt create` ("already used by worktree"). The workflow now
   ADOPTS the existing instance (`existingInstanceSlug`) — preserve that
   behavior in any refactor.
5. **`pkill -f <pattern>` matches your own ssh command line.** Use the
   bracket trick: `pkill -f "omnigent[.]runner"`.
6. **Prompt injection is keystrokes.** Multi-KB text pasted into the TUI gets
   mangled (FLU-248 produced an empty turn). Reference plan FILES by path;
   keep injected prompts single-line-safe.
7. **`stop` leaves sessions alive** (Esc to the pane, poll loop exits).
   That's what makes `resume` cheap — don't "fix" stop to kill panes.
8. **wt pid tracking is broken** (`procs be:- ag:- fe:-` while servers run,
   `wt stop` no-ops on them). Known, unfixed — verify with `ss -tlnp` and
   kill by pid when needed. Fixing it properly lives in `infra/wt/wt.ts`
   (`startProc` tmux sessions vs status probing).
9. **The harness dodges long blocking commands** (backgrounds `sleep`, uses
   Monitor). When you need a genuinely long turn (e.g. to test stop), give it
   sustained multi-step tool work instead.
10. **`omnigent` TUIs must be launched with `--server $OMNIGENT_URL`** or
    they spawn a private server and every turn times out.
11. **Session panes are per-phase** (`__plan`, `__impl`); planning context
    survives revision rounds because revisions reuse the `plan` pane. Don't
    collapse the tags.
12. **Omnigent runners think tmux-driven sessions are idle.** A runner's
    "active work" metric only counts omnigent-API turns — Athena's
    `tmux send-keys` input is invisible to it, so every runner hits its idle
    timeout mid-work and the server marks the session `failed`
    ("Native Claude session failed" mid-turn, FLU-256 2026-07-03). Fixed via
    `runner.idle_timeout_s: 86400` in `/home/omni/.omnigent/config.yaml`
    (default is 3600 — SHORTER than the 80-min impl poll budget). New runners
    read it at spawn; already-running runners keep their old value. Worth
    reporting upstream: activity should count session events, not just turns.
13. **Conversation keys are PLATFORM-SPECIFIC — never hand-build them.**
    Slack: conversationKey `<chan>::<scope>`, threadId
    `slack-<chan>-<scope>-<uuid>` (fresh uuid per turn). Telegram:
    conversationKey `tg:<chat>:<scope>` (scope may contain colons —
    `topic:42`, `user:777`), threadId `tg-thread-tg:<chat>:<scope>`
    (STABLE, no uuid). All transforms live in ONE parser pair in
    `omnigent/native-agent.ts` (`partsFromConversationKey` /
    `partsFromStableKey`); `canonicalKey` ↔ `conversationKeyOfStableKey`
    are the only bridge. A bot-side/agent-side mismatch silently breaks
    stop, turn overrides, preambles, and the share outbox for that
    platform — `omnigent/__tests__/keys.test.ts` pins the invariant.

## State on the box (quick reference)

```
/home/omni/.opentag/workflows.json        workflow records (channel::ts keyed)
/home/omni/.opentag/instances.json        wt registry (slug → slot/ports/state)
/home/omni/.opentag/env-templates/        secret templates (0600)
/home/omni/.opentag/outbox/<conv>/        per-thread file-share outbox
/home/omni/.opentag/channel-executors.json  per-channel claude/codex choice
/home/omni/worktrees/<DIR>/               issue worktrees + screenshots/ + PORTS.md
/home/omni/plans/<issue>/plan.mdx         visual plan artifacts (local-files mode)
~omni/.omnigent/host.pid                  the long-running host daemon
```
