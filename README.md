# OpenTag: an open-source alternative to Claude in Slack

Run your own AI agent inside Slack: it reads a thread, answers, calls your tools, and
renders rich results right in the conversation. Think of it as having Claude in your
workspace, except **open-source and self-hosted**: you own the runtime, bring your own
model, and wire it to your own tools. No per-seat pricing, no lock-in.

It's built on **[`@copilotkit/bot`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot)** —
CopilotKit's open SDK for chat-platform agents (Slack first; the same code also runs on
Discord, Telegram, and WhatsApp). Clone it, point it at your model and tools, and you own
the whole stack.

## See it in action

https://github.com/user-attachments/assets/a74fa1cb-add0-463e-a23c-aa09b95d5135

▶️ **[Watch the demo](https://github.com/user-attachments/assets/a74fa1cb-add0-463e-a23c-aa09b95d5135)** (~50s) — an OpenTag agent working a Slack thread: it renders a breakdown, a table, and a bar chart inline (**generative UI**) and files a ticket only after an **Approve** gate (**human-in-the-loop**).

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

You'll run two processes: the **agent** (the LLM backend) and the **bot** (the Slack
connection) — and set three secrets.

### The packages

OpenTag is a thin layer on top of a handful of CopilotKit packages. The `pnpm install` in step 3 installs all of them for you — this is what each one does, so you know what you're running and which ones are optional.

**Required** — every OpenTag install needs these four:

| Package | Role |
| --- | --- |
| [`@copilotkit/bot`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot) | The platform-agnostic bot engine — threading, tool calls, the human-in-the-loop gate. |
| [`@copilotkit/runtime`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/runtime) | The AG-UI agent backend that runs your LLM and tools. |
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

**2. Set three secrets** in `.env` (`cp .env.example .env`):

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
OPENAI_API_KEY=sk-...      # or ANTHROPIC_API_KEY — bring your own model
```

**3. Run it** (standalone, after the Quick-start bootstrap above):

```bash
bun run runtime   # the agent backend, on :8200
bun run dev        # the bot (separate terminal)
```

<details>
<summary>Or run it from the CopilotKit monorepo root (the original workflow)</summary>

```bash
pnpm install
pnpm --filter slack-example runtime   # the agent backend, on :8200
pnpm --filter slack-example dev        # the bot
```
</details>

**4. Talk to it.** @mention the bot in any channel thread:

> @OpenTag summarize this thread and file it as a bug

That's the whole loop. To wire up Linear, Notion, inline charts, Redis persistence, or to run
on Discord / Telegram / WhatsApp, see **[setup.md](./setup.md)**.  

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

- **Change what it does.** The agent's behavior is steered by a single system prompt in
  [`runtime.ts`](./runtime.ts) — rewrite it and you have a different agent.
- **Copy `app/` to start your own bot.** It's the platform-agnostic bot (tools, components, the
  human-in-the-loop gate). `runtime.ts` is the agent backend: one CopilotKit `BuiltInAgent` (an
  LLM + optional MCP tools — no Python, no LangGraph), served over AG-UI.
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
