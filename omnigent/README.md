# Solving bugs with Omnigent (live progress in Slack)

The flow, minimally:

```
Slack @mention ("fix this bug")
   └─▶ app/index.ts onMention ─▶ solveBug(thread, text)   (omnigent/solve.ts)
          1. thread.post(...)            → one status message in the thread
          2. POST /v1/sessions + message → Omnigent starts a Codex/Claude fix
          3. read the session SSE        → thread.update(...) the SAME message
                                            live: working → testing → ✅ done
```

No custom agent, no AG-UI bridge, no separate monitor process. OpenTag stays as
it is and just calls Omnigent; Omnigent does the work and we narrate it.

## Files

| File | Role |
| --- | --- |
| `solve.ts` | `solveBug(thread, text)` — dispatch + live status edits. Self-contained. |
| `agent.yaml` | The Omnigent side: the fixer agent's prompt + which executor (Codex/Claude/Pi) and any server-side tools. |

## Setup

1. Run Omnigent with a `fixer` agent (see `agent.yaml`).
2. Env in OpenTag's `.env`:
   ```
   OMNIGENT_URL=http://localhost:6767
   OMNIGENT_API_KEY=...        # if your server requires it
   OMNIGENT_AGENT=fixer
   ```
3. Mentions now route to `solveBug` (wired in `app/index.ts`).

## The one thing to verify

`streamTask` in `solve.ts` assumes submitting a message keeps an SSE open for the
whole run (the openapi spec's `response.*` event stream). If your Omnigent
instead returns immediately and you `attach` to a separate event stream, change
ONLY that function. The Slack side (`thread.post`/`update`) is already correct.

Also confirm the two `TODO`s in `createSession` (the field names for selecting
the agent and seeding the task) against your Omnigent version.

## Add later, only if needed

- **Approvals in Slack:** today `response.elicitation_request` just flips the card
  to "needs approval — open the link." To approve from Slack, post an interactive
  message and `POST /v1/sessions/{id}/events` with the choice.
- **Survives restarts:** persist `{sessionId, channel, threadTs, lastSeq}` in the
  bot's `StateStore` and re-attach on boot. Not needed until a long run actually
  gets interrupted.
