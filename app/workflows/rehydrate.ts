/**
 * Rehydrate a Slack `Thread` from a stored `conversationKey`, OUTSIDE of an
 * incoming mention event.
 *
 * The workflow's revision loop drives a `thread` (post / runAgent / getMessages
 * / postFile). When a Slack `@Athena <feedback>` mention triggers it, that
 * thread is handed in by the bot's ingress. Plan-page feedback has no such
 * event — only the workflow record's `conversationKey` (`{channelId}::{scope}`)
 * — so we reconstruct an equivalent thread here.
 *
 * `createBot` builds threads from a closure we can't reach, but every piece is
 * individually exported, so we assemble a `Thread` the same way `makeThread`
 * does. Two things must line up with the bot for the posted approval card's
 * buttons to work when clicked in Slack (the click is dispatched by the bot's
 * OWN ActionRegistry, not this one):
 *   1. the ActionStore is SHARED with `createBot({ actionStore })`, so the
 *      bot's registry can look up the click id we minted here; and
 *   2. `PlanApproval` is registered with `createBot({ components })`, so the
 *      bot's registry can re-render it from the persisted snapshot to recover
 *      the handler (inline components can't be re-derived → ActionExpiredError).
 * See app/index.ts for where both are set up.
 */
import type { AbstractAgent } from "@ag-ui/client";
import {
  Thread,
  ActionRegistry,
  MemoryStore,
  toAgentToolDescriptors,
} from "@copilotkit/bot";
import type {
  ThreadDeps,
  BotTool,
  ContextEntry,
  ActionStore,
} from "@copilotkit/bot";
import type { PlatformAdapter } from "@copilotkit/bot";

export type ThreadFactory = (conversationKey: string) => Thread;

/**
 * Build a factory that mints a `Thread` for any `conversationKey`. The registry
 * and per-thread state store are process-lifetime singletons so interactive
 * components posted from rehydrated threads keep working across calls.
 */
export function makeThreadFactory(deps: {
  adapter: PlatformAdapter;
  agentFactory: (threadId: string) => AbstractAgent;
  tools: BotTool[];
  context: ContextEntry[];
  /** MUST be the same instance passed to `createBot({ actionStore })`. */
  actionStore: ActionStore;
}): ThreadFactory {
  const registry = new ActionRegistry({ store: deps.actionStore });
  const state = new MemoryStore();
  const toolMap = new Map(deps.tools.map((t) => [t.name, t]));
  const toolDescriptors = toAgentToolDescriptors([...toolMap.values()]);

  return (conversationKey: string): Thread => {
    const [channelId, scope] = conversationKey.split("::");
    const replyTarget =
      scope && scope !== "dm"
        ? { channel: channelId!, threadTs: scope }
        : { channel: channelId! };
    const threadDeps: ThreadDeps = {
      adapter: deps.adapter,
      replyTarget,
      conversationKey,
      registry,
      agentFactory: deps.agentFactory,
      tools: toolMap,
      toolDescriptors,
      context: deps.context,
      // Plan-page revisions don't use HITL awaitChoice / interrupts.
      registerWaiter: () => {},
      interruptHandlers: new Map(),
      state,
    };
    return new Thread(threadDeps);
  };
}
