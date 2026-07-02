# OpenTag — setup & configuration

Everything beyond the [quick start](./README.md#quick-start): the full Slack app walkthrough,
the complete environment reference, running standalone vs. from the monorepo, wiring up Linear /
Notion / inline charts / Redis, the other chat platforms, slash commands, tests, and how the
pieces fit together.

- [How it fits together](#how-it-fits-together)
- [Running it](#running-it) — monorepo today, standalone soon
- [1. Create a Slack app](#1-create-a-slack-app)
- [2. Environment variables](#2-environment-variables)
- [3. Integrations](#3-integrations) — Linear, Notion, charts, Redis
- [Other platforms](#other-platforms) — Discord, Telegram, WhatsApp
- [Slash commands](#slash-commands)
- [Files → charts, diagrams & tables](#files--charts-diagrams--tables)
- [Tests](#tests)

## How it fits together

There are **two agent backends**, selected per run by [`app/agent-router.ts`](./app/agent-router.ts):

```
                                            ┌── @mention ──▶ OmnigentNativeAgent (omnigent/native-agent.ts)
Slack / Discord / Telegram / WhatsApp ──▶ bot (app/)         └─▶ native Claude Code / Codex TUI (via local Omnigent, tmux)
                                            │
                                            └── /slash + modals ──▶ (optional) runtime.ts  ──AG-UI──▶ BuiltInAgent (LLM)
                                                  only if AGENT_URL set               ├── Linear MCP (hosted)
                                                                                      └── Notion MCP (sidecar)
```

- **Default (Omnigent).** `@mentions` run a **native Claude Code / Codex session** per Slack
  thread on your own subscription — driven in-process by `OmnigentNativeAgent`, no separate
  server. This is the recommended path. See [`omnigent/README.md`](./omnigent/README.md) for
  model routing (`/codex` `/claude`, `!codex`), stopping (`/stop`), and control phrases.
- **Legacy AG-UI mode (optional).** Set `AGENT_URL` to ALSO run the LLM triage agent
  (`runtime.ts`): `@mentions` still use Omnigent, but slash commands + modal submits route to
  one CopilotKit `BuiltInAgent` (an LLM plus optional Linear/Notion MCP — no Python, no
  LangGraph) over [AG-UI](https://docs.ag-ui.com). This is what powers the Linear/Notion,
  generative-UI, and human-in-the-loop features below.

> **Note.** The native harness runs its own tools inside the TUI — it does **not** call the
> bot's AG-UI tools/components. So the generative-UI cards, the `confirm_write` HITL gate, and
> the Linear/Notion MCP tools apply only to the legacy AG-UI mode, not to `@mention` replies.

| Concept                                                              | Where                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `createBot({ adapters, agent, tools, context, commands })`           | [`app/index.ts`](./app/index.ts)                                   |
| **Native Claude/Codex agent** (default mention backend)              | [`omnigent/native-agent.ts`](./omnigent/native-agent.ts), [`omnigent/README.md`](./omnigent/README.md) |
| Per-run routing (Omnigent vs. legacy triage backend)                 | [`app/agent-router.ts`](./app/agent-router.ts)                     |
| Model switch / stop / help (mention phrases + `/model` `/stop` `/help`) | [`omnigent/native-agent.ts`](./omnigent/native-agent.ts), [`app/index.ts`](./app/index.ts), [`app/commands/index.ts`](./app/commands/index.ts) |
| Multi-adapter wiring (Slack/Discord/Telegram/WhatsApp, secret-gated) | [`app/index.ts`](./app/index.ts)                                   |
| `read_thread` — grounds the agent in the real conversation           | [`app/tools/read-thread.ts`](./app/tools/read-thread.ts)           |
| Render-tools + JSX components (issue card/list, Notion pages)        | [`app/tools/render-tools.tsx`](./app/tools/render-tools.tsx), [`app/components/`](./app/components/) |
| Chart / diagram / table rendering (Playwright → PNG)                 | [`app/tools/render-chart.tsx`](./app/tools/render-chart.tsx), `render-diagram.tsx`, `render-table.tsx`, [`app/render/`](./app/render/) |
| Status / incident / links showcase cards                             | [`app/tools/showcase-tools.tsx`](./app/tools/showcase-tools.tsx), [`app/components/_status.ts`](./app/components/_status.ts) |
| Blocking **human-in-the-loop** gate (`confirm_write`)                | [`app/human-in-the-loop/confirm-write.tsx`](./app/human-in-the-loop/confirm-write.tsx) |
| Slash commands — model controls (`/claude` `/codex` `/model` `/stop` `/help`) + _legacy_ (`/agent` `/triage` `/preview` `/file-issue`) | [`app/commands/index.ts`](./app/commands/index.ts) |
| A Block Kit **modal** (`/file-issue`, legacy)                        | [`app/modals/file-issue.tsx`](./app/modals/file-issue.tsx)         |
| _Legacy_ agent backend — one `BuiltInAgent` (LLM + Linear/Notion MCP)| [`runtime.ts`](./runtime.ts)                                       |

- **`app/`** is the platform-agnostic bot. **This is the directory you copy to start your own bot.**
- **`omnigent/native-agent.ts`** is the default agent — native Claude/Codex, driven in-process.
- **`runtime.ts`** is the optional legacy AG-UI agent backend (only when `AGENT_URL` is set).
- **`e2e/`** holds live test harnesses (the Slack harness is being migrated to the new
  `createBot` API; the Telegram harness is a working manual-trigger smoke test — see
  [`e2e/TELEGRAM-README.md`](./e2e/TELEGRAM-README.md)).

It's built on:

- **[`@copilotkit/bot`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot)** — the platform-agnostic bot engine.
- **[`@copilotkit/bot-slack`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot-slack)** / **[`-discord`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot-discord)** / **[`-telegram`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot-telegram)** / **[`-whatsapp`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot-whatsapp)** — the platform adapters.
- **[`@copilotkit/bot-ui`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot-ui)** — a cross-platform JSX vocabulary for rich messages (Block Kit on Slack, Components V2 on Discord, HTML on Telegram).
- **[`@copilotkit/runtime`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/runtime)** — the AG-UI agent backend.

## Running it

### Default (Omnigent) — one process

After the Quick-start bootstrap (`bun install && bun run vendor:build`), you only run the
**bot**. It talks to a local **Omnigent server** with an authenticated native harness:

```bash
# one-time, on the host: start Omnigent and log the harness in
omnigent server            # the local server on :6767 (OMNIGENT_URL)
omnigent claude            # authenticate Claude Code   (and/or `codex login` for Codex)

bun run dev                # the bot (tsx watch app/index.ts)
```

That's it — `@mention` the bot and it streams a native Claude/Codex reply into the thread.

### Legacy AG-UI mode — add the runtime

To ALSO enable the LLM triage agent (Linear/Notion, generative UI, HITL), set `AGENT_URL`
(+ a model key) and run `runtime.ts` alongside the bot:

```bash
bun run notion-mcp     # terminal 1 — only if using Notion → http://127.0.0.1:3001/mcp
bun run runtime        # terminal 2 — the AG-UI agent backend on :8200
bun run dev            # terminal 3 — the bot
```

The chart/diagram renderers need a Chromium binary: `npx playwright install chromium`.

<details>
<summary>Or run the bot from the CopilotKit monorepo root (the original workflow)</summary>

```bash
pnpm install                              # repo root
pnpm --filter slack-example dev           # the bot (tsx watch app/index.ts)
```
</details>

> **Standalone npm caveat.** `@copilotkit/bot-telegram`, `-whatsapp`, and `-store-redis` aren't
> on npm yet, so this repo vendors the SDK from a pinned submodule (see the README's Quick
> start / Vendoring). Use `bun install && bun run vendor:build`, not a bare `npm install`.

## 1. Create a Slack app

1. Go to <https://api.slack.com/apps?new_app=1> → **From a manifest** → paste
   [`slack-app-manifest.yaml`](./slack-app-manifest.yaml). The manifest declares all four slash
   commands, the assistant pane, the `users:read.email` scope, and **Socket Mode** (so the bot
   connects outbound — no public URL needed).
2. **OAuth & Permissions** → **Install to Workspace** → copy the `xoxb-` **Bot User OAuth
   Token** → this is your `SLACK_BOT_TOKEN`.
3. **Basic Information → App-Level Tokens** → generate one with the `connections:write` scope →
   copy the `xapp-` token → this is your `SLACK_APP_TOKEN`.

(Discord, Telegram, and WhatsApp setup is documented inline in [`.env.example`](./.env.example)
and summarized under [Other platforms](#other-platforms).)

## 2. Environment variables

Copy the template and fill in the platform(s) and integrations you want — the bot starts an
adapter for each platform whose secrets are present, and the agent wires up whichever data
sources have credentials.

```bash
cp .env.example .env
```

| Variable | What it's for |
| --- | --- |
| `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` | Run on Slack (see [step 1](#1-create-a-slack-app)). |
| `OMNIGENT_URL` | Local Omnigent server (default `http://127.0.0.1:6767`). |
| `OMNIGENT_REPO` | The repo/working directory the native agent operates in. |
| `OMNIGENT_EXECUTOR` | Default harness: `claude` or `codex` (default `claude`). Overridden per-channel by `/codex` `/claude` and per-message by `!codex`. |
| `OMNIGENT_BIN` | The `omnigent` CLI binary (default `omnigent`). |
| `OMNIGENT_CLAUDE_ARGS` / `OMNIGENT_CODEX_ARGS` | Override the auto-approval launch args per harness. |
| `DISCORD_BOT_TOKEN` / `DISCORD_APP_ID` | Run on Discord. |
| `TELEGRAM_BOT_TOKEN` | Run on Telegram. |
| `WHATSAPP_ACCESS_TOKEN` (+ siblings) | Run on WhatsApp Cloud API. |
| _legacy_ `AGENT_URL` | Set to ALSO run the AG-UI triage backend (`runtime.ts`) for slash commands + modals. **Unset = Omnigent-only.** |
| _legacy_ `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `AGENT_MODEL` | The triage LLM + `provider/model` (default `openai/gpt-5.5`). Only used in AG-UI mode. |
| _legacy_ `LINEAR_API_KEY` / `LINEAR_TEAM_KEY` | Wire up Linear (AG-UI mode). |
| _legacy_ `NOTION_TOKEN` / `NOTION_MCP_AUTH_TOKEN` | Wire up Notion (AG-UI mode). |
| _legacy_ `REDIS_URL` | Optional durable store (see [Redis](#redis-persistence)). |

Every integration is independent — set only what you need. The full annotated list, including the
WhatsApp webhook details, is in [`.env.example`](./.env.example).

## 3. Integrations

### Linear

The hosted Linear MCP accepts a raw API key as a bearer token (no OAuth dance). Create one at
**linear.app → Settings → API → Personal API keys**, set `LINEAR_API_KEY`, and optionally
`LINEAR_TEAM_KEY` (the default team to file/query against). Leave `LINEAR_API_KEY` blank to run
without Linear. With it set, the agent can:

- **Query Linear** — _"what's open in CPK this cycle?"_ → renders the issues as a rich card.
- **File a Linear issue** — _"file this thread as a bug"_ → drafts it, asks you to **confirm**, then creates it.

### Notion

Notion runs as a small **Streamable-HTTP sidecar** wrapping the official
[`@notionhq/notion-mcp-server`](https://www.npmjs.com/package/@notionhq/notion-mcp-server). Start
it with `pnpm notion-mcp` (or `npm run notion-mcp`).

- `NOTION_TOKEN` — the Notion integration secret the sidecar uses to call the Notion API
  (notion.so → Settings → Connections → develop integrations).
- `NOTION_MCP_AUTH_TOKEN` — a bearer the sidecar requires on its HTTP transport; pick any strong
  string and set the same value here and when starting the sidecar. Leave it blank to run without
  Notion.

With it set, the agent can **find pages** (_"find the runbook for the auth outage"_) and
**write a postmortem** (_"write this thread up as a Notion doc"_ → reads, summarizes,
**confirms**, then creates the page).

### The human-in-the-loop write gate

Every write — Linear or Notion — goes through a blocking **`confirm_write`** gate: the agent must
call that tool and wait for a **Create / Cancel** click before it performs the write. See
[`app/human-in-the-loop/confirm-write.tsx`](./app/human-in-the-loop/confirm-write.tsx).

### Charts, diagrams & tables

The chart/diagram libraries load from a CDN into a **local** headless browser (override
`CHART_JS_URL` / `MERMAID_URL`) — your data is rendered locally and never sent to a rendering
service. Requires a Chromium binary: `npx playwright install chromium`.

### Redis persistence

By default, interactive state is in-memory. Pass a
[`@copilotkit/bot-store-redis`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot-store-redis)
store to `createBot` (set `REDIS_URL`; `docker compose up -d` starts a local Redis) so an
Approve/Cancel click still resolves **after a restart** — see
[`app/demo-restart.tsx`](./app/demo-restart.tsx) and the `demo:restart` script.

## Other platforms

The same `app/` code runs on every platform — `createBot` takes an array of adapters, and
`app/index.ts` starts one for each platform whose secrets are present. Everything else (tools,
components, the HITL gate, rendering) is shared verbatim.

- **Discord** — set `DISCORD_BOT_TOKEN` + `DISCORD_APP_ID` (and optionally `DISCORD_GUILD_ID` for
  instant slash-command registration in dev). Enable the **Message Content** and **Server
  Members** privileged intents.
- **Telegram** — message [@BotFather](https://t.me/BotFather) → `/newbot` → set `TELEGRAM_BOT_TOKEN`.
  Long-polling is the default ingress (no public URL needed).
- **WhatsApp** — set `WHATSAPP_ACCESS_TOKEN` + siblings from your Meta App → WhatsApp → API Setup.
  The server listens on `$PORT` for the webhook.

Per-platform details are documented inline in [`.env.example`](./.env.example).

## Slash commands

App-owned commands, registered via `createBot({ commands })`
([`app/commands/index.ts`](./app/commands/index.ts)). On Slack every command must ALSO be
declared under **Slash Commands** in the app manifest — the bundled
[`slack-app-manifest.yaml`](./slack-app-manifest.yaml) declares all of them.

**Model controls** (Omnigent path — handled in-process, no agent backend needed):

- **`/claude`** · **`/codex`** — set this channel's default model.
- **`/model`** — show the current model.
- **`/stop`** — interrupt the answer(s) streaming in this channel.
- **`/help`** — what the bot can do and how to switch models.

> These also work as **mention phrases** with no manifest change: `@bot use codex`,
> `@bot use claude`, `@bot stop`, `@bot help`. And `@bot !codex <task>` picks Codex for a
> single message. See [`omnigent/README.md`](./omnigent/README.md).

**Legacy AG-UI mode** (only functional when `AGENT_URL` points at a running `runtime.ts`;
`/agent`, `/triage`, `/file-issue` route to that backend, so they no-op/err without it):

- **`/agent <text>`** — a mention-free entry point; runs the triage agent with the command text.
- **`/triage [note]`** — summarizes the conversation and proposes issues to file.
- **`/preview <title>`** — privately previews the issue the bot would file (pure UI; works
  without a backend); degrades to a DM where ephemerals aren't supported.
- **`/file-issue`** — opens a structured issue **modal**; degrades to a conversational flow on
  platforms without modals (e.g. Telegram).

## Files → charts, diagrams & tables

Upload a file and the bot analyzes it: images and **PDFs** go straight to the model; CSV/JSON/text
are decoded and handed over as text. Then ask it to visualize:

> chart revenue by month · diagram this incident flow · show it as a table

> **PDFs and images need a vision/document-capable model.** The default `openai/gpt-5.5` reads
> both natively, as do recent Claude and Gemini models.

## Tests

```bash
npm test               # unit: read_thread, render tools, components, confirm_write, modals, commands
npm run check-types    # tsc --noEmit
```

The live-Slack e2e harness (`npm run e2e`) is being migrated to the new `createBot` API and
doesn't run against this code as-is. The Telegram harness (`npm run e2e:telegram`) is a working
manual-trigger smoke test — see [`e2e/TELEGRAM-README.md`](./e2e/TELEGRAM-README.md).
