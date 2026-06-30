/**
 * Per-run agent routing for the bot.
 *
 * The bot exposes a SINGLE agent per conversation, and every `thread.runAgent()`
 * uses it — so to send @mentions to Omnigent (native Claude) while keeping slash
 * commands and modal submissions on the triage AG-UI backend, we route per run.
 *
 *   - @mentions             → OmnigentNativeAgent (in-process, native streaming)
 *   - slash commands, modals → the triage HTTP backend (SanitizingHttpAgent → runtime.ts)
 *
 * The selector is a sentinel context entry the mention handler passes
 * (`OMNIGENT_ROUTE`). `thread.runAgent({ context })` merges into `input.context`
 * (see bot/thread.ts), which the run loop forwards to `run()`. Omnigent ignores
 * context, so the marker is inert on that path; the triage path never carries it.
 *
 * The Slack store rebuilds the agent + its message history from the thread every
 * turn, so this dispatcher holds no cross-turn state — it just forwards the
 * already-reconstructed `input` to the chosen backend.
 */
import { AbstractAgent } from "@ag-ui/client";
import type { AgentConfig, BaseEvent, RunAgentInput } from "@ag-ui/client";
import type { ContextEntry } from "@copilotkit/bot";
import type { Observable } from "rxjs";

const ROUTE_DESCRIPTION = "__opentag_route";

/** Pass in `thread.runAgent({ context: [OMNIGENT_ROUTE] })` to select Omnigent. */
export const OMNIGENT_ROUTE: ContextEntry = {
  description: ROUTE_DESCRIPTION,
  value: "omnigent",
};

function wantsOmnigent(input: RunAgentInput): boolean {
  const ctx = (input as { context?: ContextEntry[] }).context;
  return (
    Array.isArray(ctx) &&
    ctx.some(
      (c) => c?.description === ROUTE_DESCRIPTION && c?.value === "omnigent",
    )
  );
}

/**
 * Dispatches each run to `omnigent` (mentions) or `triage` (everything else).
 * Both are full `AbstractAgent`s; we hand the reconstructed `input` straight to
 * the selected one so its own `run()` does the work and streaming unchanged.
 */
export class RoutingAgent extends AbstractAgent {
  constructor(
    private readonly omnigent: AbstractAgent,
    private readonly triage: AbstractAgent,
    config?: AgentConfig,
  ) {
    super(config);
  }

  override run(input: RunAgentInput): Observable<BaseEvent> {
    return (wantsOmnigent(input) ? this.omnigent : this.triage).run(input);
  }
}
