# Omnigent native agent (native Claude Code / Codex in your chat platform)

`@mentions` (and Telegram DMs) are answered by a **native Claude Code or Codex
session** — the real TUI, driven on your own subscription through the local
[Omnigent](https://github.com/omnigent-ai/omnigent)
CLI. No `claude -p`, no metered API. The reply (prose + tool activity) streams
back into the chat thread live.

The flow, minimally:

```
Slack @mention ("explain how the frontend renders markdown attachments")
   └─▶ app/index.ts onMention ─▶ thread.runAgent({ context: [OMNIGENT_ROUTE] })
          └─▶ OmnigentNativeAgent.run()   (omnigent/native-agent.ts)
                 1. ensureSession(thread, executor)      → one persistent native
                    TUI per (thread, model), in a tmux pane
                 2. tmux send-keys → type the message into the live TUI
                 3. poll GET /v1/sessions/{id}/items      → emit AG-UI events
                    (TEXT_MESSAGE_* + TOOL_CALL_*) as the reply grows
                 4. TUI "esc to interrupt" goes quiet     → RUN_FINISHED
```

It's a plain AG-UI `AbstractAgent`, so Athena drives it in-process and renders
each platform's native streaming + the "is thinking…" shimmer + per-tool status
rows for free. No separate runtime server, no AG-UI HTTP bridge, no monitor process.

## Files

| File | Role |
| --- | --- |
| `native-agent.ts` | `OmnigentNativeAgent` — the AG-UI agent. Session lifecycle, tmux I/O, `/items` polling → AG-UI events, model routing, and the stop registry. Self-contained. |

## Model routing (Claude ⇄ Codex)

A native session is one tmux pane running one harness binary, pinned to a chat
thread — so the model is chosen per thread. Resolution order for each turn:

1. **Inline directive** — `@bot !codex <task>` (or `model: codex …`) — one message only.
2. **Per-channel default** — set with `@bot use codex` / `@bot use claude`, or the
   `/codex` · `/claude` slash commands. Persisted to `~/.opentag/channel-executors.json`
   so it survives bot restarts.
3. **Env default** — `OMNIGENT_EXECUTOR` (`claude` | `codex`), default `claude`.

Each `(thread, model)` gets its own persistent pane, so switching back and forth
never clobbers the other harness's context. Auto-approval flags differ per
harness (`--dangerously-skip-permissions` for Claude,
`--dangerously-bypass-approvals-and-sandbox` for Codex) and are overridable via
`OMNIGENT_CLAUDE_ARGS` / `OMNIGENT_CODEX_ARGS`.

## Stopping a run

`stop` interrupts the answer streaming in THIS thread; `stop all` sweeps the
whole channel. Either way it ends the stream (the partial reply stays) and sends
`Esc` to the harness so it stops working — without killing the session, so the
next turn reuses it. Slack slash commands are channel-scoped (no thread
context), so `/stop` behaves like `stop all`.

## Control phrases (work on every platform; no Slack-manifest changes needed)

Because the mention handler inspects the message text before running the agent,
these work immediately, even before the slash commands are added to the manifest:

- `@bot help` — the help card (also `/help`).
- `@bot use codex` / `@bot use claude` — set the channel default (also `/codex` `/claude`).
- `@bot stop` — interrupt (also `/stop`).

A mention that is a *real task* (e.g. "use codex to fix the null deref") is **not**
hijacked — control phrases must be the whole message.

## Setup

1. Install and run Omnigent on the host (`omnigent server`), and authenticate the
   harness you want: `omnigent claude` (Claude Code login) and/or `codex login`.
2. Env in OpenTag's `.env` (see the Omnigent block in `.env.example`):
   ```
   OMNIGENT_URL=http://127.0.0.1:6767
   OMNIGENT_REPO=/path/to/the/repo/the/agent/works/in
   OMNIGENT_EXECUTOR=claude          # or codex
   # OMNIGENT_BIN=omnigent           # if not on PATH
   ```
3. `@mention` the bot. The reply streams into the thread.

## How it maps onto Omnigent

- **Session** — one persistent native session per (thread, executor), launched as
  `omnigent <executor> <auto-approve-args>` inside a detached tmux pane (the pty
  the native TUI needs). Reused across turns for context continuity.
- **Input** — typed into the live TUI via `tmux send-keys` (the same terminal
  injection Omnigent's native executors use). `POST /events` is queued but not
  consumed by the native TUI harness.
- **Output** — polled from `GET /v1/sessions/{id}/items` (assistant message text
  plus `function_call` items) and streamed into Slack as it grows. The SSE stream
  doesn't flush text for the native TUI, so `/items` is the authoritative source;
  turn completion is judged from the session status (`running`), tmux pane
  activity, the TUI's working line, and item flow — debounced (see the poll loop).

## Notes / limitations

- The native harness runs its **own** tools inside the TUI; it does not call
  OpenTag's AG-UI/client tools. So the legacy generative-UI cards, the
  `confirm_write` HITL gate, and the Linear/Notion MCP tools are **not** on this
  path — those belong to the optional AG-UI triage backend (`runtime.ts`).
- Only the latest user message is injected per turn; the harness keeps its own
  conversation state across turns in the reused session.
