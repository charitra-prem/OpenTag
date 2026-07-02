# OpenTag: self-hosted Claude Code / Codex in Slack

Run a **real coding agent inside Slack**: `@mention` it and it works in your repo and
streams the answer — prose plus live tool activity — right into the thread. By default
those mentions are answered by a **native [Claude Code](https://www.anthropic.com/claude-code)
or [Codex](https://openai.com/codex) session** driven on your own subscription through the
local [Omnigent](https://github.com/omnigent-ai/omnigent) CLI — no per-token API key, no
metered inference. Switch models per channel or per message; interrupt a run at any time.
**Open-source and self-hosted**: you own the whole stack. No per-seat pricing, no lock-in.

It's built on **[`@copilotkit/bot`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot)** —
CopilotKit's open SDK for chat-platform agents (Slack first; the same code also runs on
Discord, Telegram, and WhatsApp) — with a small in-process AG-UI agent
([`omnigent/native-agent.ts`](./omnigent/native-agent.ts)) bridging the native harness to
Slack streaming.

> **Two backends, one bot.** The default path (above) is the Omnigent **native
> Claude/Codex** agent. There's also an optional **legacy AG-UI mode** — an LLM
> "triage" agent ([`runtime.ts`](./runtime.ts)) that files Linear issues, writes Notion
> pages, renders inline charts/tables (**generative UI**), and gates writes behind an
> **Approve** click (**human-in-the-loop**). It's OFF unless you set `AGENT_URL`; when on,
> `@mentions` still use Omnigent while slash commands + modal submits route to it. The
> demo below shows that legacy mode.

## See it in action (legacy AG-UI mode)

https://github.com/user-attachments/assets/a74fa1cb-add0-463e-a23c-aa09b95d5135

▶️ **[Watch the demo](https://github.com/user-attachments/assets/a74fa1cb-add0-463e-a23c-aa09b95d5135)** (~50s) — the **legacy AG-UI triage agent** working a Slack thread: it renders a breakdown, a table, and a bar chart inline (**generative UI**) and files a ticket only after an **Approve** gate (**human-in-the-loop**).

> **Two ways to run it:** **host it on your own** with the open-source SDK below — or skip the ops and **[sign up for the managed service →](https://go.copilotkit.ai/opentag-managed-gh)** coming soon from CopilotKit. The managed service will be part of our Enterprise Intelligence platform. You'll be able to use our cloud-hosting or enterprises can host it on their own infra.

## Quick start (self-hosted)

The bot SDK packages aren't fully (or consistently) published to npm yet, so this repo runs
standalone by vendoring them from the [CopilotKit monorepo](https://github.com/CopilotKit/CopilotKit)
as a **pinned git submodule** (`vendor/copilotkit`) linked into a [Bun](https://bun.sh) workspace
and built from source. OpenTag stays your repo with your own history — nothing auto-syncs; you
bump the pinned CopilotKit commit only when you choose, with `bun run vendor:sync`.

```bash
git clone --recurse-submodules <your-opentag-remote> && cd OpenTag
# (already cloned without --recurse-submodules? run: git submodule update --init)
bun install            # links the @copilotkit/* packages from the submodule
bun run vendor:build   # compiles them to dist/ (needed once per submodule checkout)
```

To pull newer CopilotKit bot code later: `bun run vendor:sync [ref]` (defaults to `origin/main`),
then commit the bumped submodule pointer. See the **Vendoring** notes at the end of this section.
The original monorepo-based workflow still works too and is described further below.

For the default (Omnigent) path you run the **bot** (the Slack connection) and point it at a
local **Omnigent server** with an authenticated Claude/Codex harness — and set two Slack
secrets. The legacy AG-UI mode adds a second process (the LLM `runtime`); see the note above.

### The packages

OpenTag is a thin layer on top of a handful of CopilotKit packages. The `bun install` + `bun run vendor:build` in the Quick start above links and builds all of them for you — this is what each one does, so you know what you're running and which ones are optional.

**Required** — every OpenTag install needs these four:

| Package | Role |
| --- | --- |
| [`@copilotkit/bot`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot) | The platform-agnostic bot engine — threading, tool calls, the human-in-the-loop gate. |
| [`@copilotkit/runtime`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/runtime) | The AG-UI agent backend for the optional legacy LLM mode (built as part of the SDK closure; only run when `AGENT_URL` is set). |
| [`@copilotkit/bot-ui`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot-ui) | Cross-platform JSX for rich messages (Block Kit on Slack, Components V2 on Discord, HTML on Telegram). |
| [`@copilotkit/bot-slack`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot-slack) | The Slack adapter — or swap it for the platform you're targeting (below). |

**Optional** — add only what you use:

| Package | When you need it |
| --- | --- |
| [`@copilotkit/bot-discord`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot-discord) · [`-telegram`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot-telegram) · [`-whatsapp`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot-whatsapp) | Running on a platform other than Slack — one adapter per platform. |
| [`@copilotkit/bot-store-redis`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot-store-redis) | Durable thread persistence across restarts (defaults to in-memory without it). _Not present in the vendored monorepo snapshot yet — the `demo:restart` script and Redis persistence are unavailable until it lands upstream._ |

**1. Create a Slack app.** At [api.slack.com/apps](https://api.slack.com/apps?new_app=1) →
*From a manifest* → paste [`slack-app-manifest.yaml`](./slack-app-manifest.yaml). Install it,
then grab the **Bot User OAuth Token** (`xoxb-…`) and an **App-Level Token** (`xapp-…`, with the
`connections:write` scope). Step-by-step in [setup.md](./setup.md#1-create-a-slack-app).

**2. Configure `.env`** (`cp .env.example .env`). For the default Omnigent path you need
the two Slack secrets plus where Omnigent lives and which harness to use — **no model API
key** (the native harness runs on your own Claude/Codex login):

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
OMNIGENT_URL=http://127.0.0.1:6767   # your local `omnigent server`
OMNIGENT_REPO=/path/to/your/repo     # the repo the agent works in
OMNIGENT_EXECUTOR=claude             # or codex
```

<details>
<summary>Legacy AG-UI mode instead? (LLM triage + Linear/Notion/generative UI)</summary>

Leave the `OMNIGENT_*` block and additionally set `AGENT_URL` + a model key
(`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) and run `bun run runtime`. See
**[setup.md](./setup.md)**.
</details>

**3. Run it.** Start a local Omnigent server with an authenticated harness
(`omnigent server`, plus `omnigent claude` / `codex login` once), then start the bot:

```bash
bun run dev        # the bot
```

<details>
<summary>Or run the bot from the CopilotKit monorepo root (the original workflow)</summary>

```bash
pnpm install
pnpm --filter slack-example dev        # the bot
```
</details>

**4. Talk to it.** @mention the bot in any channel thread:

> @OpenTag read `sum.js` and tell me what it does

It streams the reply — prose plus live tool rows — into the thread. Switch models with
`@OpenTag use codex` (or `/codex`), stop a run with `@OpenTag stop` (or `/stop`), and see
everything with `@OpenTag help`. To run the legacy triage agent (Linear, Notion, inline
charts, HITL) or run on Discord / Telegram / WhatsApp, see **[setup.md](./setup.md)**.  

### Vendoring (how the standalone build stays yours)

OpenTag is a Bun workspace. The `@copilotkit/*` bot packages live in the `vendor/copilotkit`
submodule, pinned to a single commit recorded in OpenTag's history, and are linked via
`"workspace:*"` in `package.json` — so the incomplete npm releases never enter the picture.

- **Fresh clone:** `git submodule update --init && bun install && bun run vendor:build`.
- **Update CopilotKit:** `bun run vendor:sync [ref]` (default `origin/main`) fetches, re-applies
  the sparse-checkout, reinstalls, rebuilds, and type-checks. Then commit `vendor/copilotkit` to
  record the new pin. Nothing updates unless you run this.
- **Scope:** only the bot SDK packages and their `workspace:` closure are sparse-checked-out and
  built (`scripts/build-copilotkit.sh`), not the whole monorepo.

We won't lie to you, though. Setting up hosting for chat agents is not easy. To skip all of that heartache, go [join the waitlist](https://go.copilotkit.ai/opentag-managed-gh) for the CopilotKit managed service as part of our Intelligence platform, both cloud-hosted or self-hosted.

## Make it your own

OpenTag is deliberately small and hackable:

- **Change how mentions are answered.** The default agent is
  [`omnigent/native-agent.ts`](./omnigent/native-agent.ts) — an in-process AG-UI agent that
  drives a native Claude/Codex session and streams it to Slack. Model routing, the stop
  registry, and the control phrases live there.
- **Or use the legacy LLM agent.** Set `AGENT_URL` and the agent's behavior is steered by a
  single system prompt in [`runtime.ts`](./runtime.ts) — one CopilotKit `BuiltInAgent` (an LLM
  + optional Linear/Notion MCP tools — no Python, no LangGraph), served over AG-UI. `@mentions`
  still use Omnigent; slash commands + modal submits route to `runtime.ts`.
- **Copy `app/` to start your own bot.** It's the platform-agnostic bot (tools, components, the
  human-in-the-loop gate, slash commands).
- **One platform, or all of them.** `createBot` takes an array of adapters; set the secrets for
  whichever platform(s) you want and the bot starts an adapter for each.

The full architecture, the file-by-file map, and every integration live in
**[setup.md](./setup.md)**.

## Don't want to host it yourself?

Self-hosting means you run and scale the runtime, persistence, and inspection tooling yourself.
A **managed CopilotKit service** is on its way. It's the same agent, without the ops: durable
threads, persistence, hosted inspection, and agents that improve from feedback (**Continuous
Learning from Human Feedback**). 

- **[Join the waitlist →](https://go.copilotkit.ai/opentag-managed-gh)** — be first in when the managed service opens.
- **[Talk to an engineer →](https://copilotkit.ai/talk-to-an-engineer)** — building something real on this? We'd love to help you ship it.

## Learn more

The **[CopilotKit Slack quickstart](https://docs.copilotkit.ai/slack)** is the canonical guide
to building a Slack agent — read it alongside this starter. Detailed setup and configuration
lives in **[setup.md](./setup.md)**.

## License

MIT — see [LICENSE](./LICENSE).
