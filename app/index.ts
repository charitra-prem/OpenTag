/**
 * The bot _application_ — user-land code, not SDK code. The companion
 * `runtime.ts` holds the AG-UI agent backend (a CopilotKit `BuiltInAgent`
 * wired to the Linear + Notion MCP servers); this directory holds everything
 * that runs on the chat-platform side of the bot for this deployment.
 *
 * MULTI-PLATFORM: this single app drives Slack, Discord, Telegram, and/or
 * WhatsApp from one process. `@copilotkit/bot`'s `createBot` accepts an array
 * of adapters and starts them all, so we include each platform's adapter only
 * when its secrets are present. Drop in `SLACK_*` to run Slack, `DISCORD_*` for
 * Discord, `TELEGRAM_BOT_TOKEN` for Telegram, `WHATSAPP_*` for WhatsApp — or any
 * combination to run them at once. The rest of `app/` (tools, components, HITL,
 * rendering) is platform-agnostic and shared verbatim.
 *
 * Defaults are not auto-applied — you spread them explicitly. That's
 * deliberate: there's no hidden behavior, and the canonical pattern is right
 * here in the file you copy from to start a new bot.
 */
import "dotenv/config";
import { createBot, InMemoryActionStore } from "@copilotkit/bot";
import type {
  PlatformAdapter,
  BotTool,
  BotComponent,
  ContextEntry,
} from "@copilotkit/bot";
import {
  slack,
  defaultSlackTools,
  defaultSlackContext,
  SanitizingHttpAgent,
} from "@copilotkit/bot-slack";
import {
  discord,
  defaultDiscordTools,
  defaultDiscordContext,
} from "@copilotkit/bot-discord";
import {
  telegram,
  defaultTelegramTools,
  defaultTelegramContext,
} from "@copilotkit/bot-telegram";
import {
  whatsapp,
  defaultWhatsAppTools,
  defaultWhatsAppContext,
} from "@copilotkit/bot-whatsapp";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { appTools } from "./tools/index.js";
import { appContext } from "./context/app-context.js";
import { appCommands } from "./commands/index.js";
import { fileIssueSubmit, FILE_ISSUE_CALLBACK } from "./modals/file-issue.js";
import { closeBrowser } from "./render/browser.js";
import {
  OmnigentNativeAgent,
  parseControl,
  setChannelExecutor,
  getChannelExecutor,
  setChannelModel,
  getChannelModel,
  takeOrphanedTurns,
  executorLabel,
  stopChannel,
  stopConversation,
  setTurnPreamble,
  channelIdFromConversationKey,
  partsFromConversationKey,
  canonicalKey,
  shareDirFor,
} from "../omnigent/native-agent.js";
import { helpText } from "./help.js";
import { statusText } from "./status.js";
import { RoutingAgent, OMNIGENT_ROUTE } from "./agent-router.js";
import {
  handleWorkflowMention,
  releaseWorkflow,
  recoverWorkflowTurn,
  PlanApproval,
} from "./workflows/index.js";
import { getWorkflow } from "./workflows/state.js";
import { startPlanBridge } from "./workflows/planbridge.js";
import { makeThreadFactory } from "./workflows/rehydrate.js";
import { installPlanFeedback } from "./workflows/feedback.js";

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
};

/** Files we'll hand back to the thread; anything else in the outbox is ignored. */
const SHAREABLE_RE = /\.(png|jpe?g|gif|webp|bmp|svg|webm|mp4|mov|pdf|txt|log|md|csv|json|ya?ml|html?)$/i;
const MAX_SHARE_BYTES = 25 * 1024 * 1024; // Slack upload ceiling headroom
const MAX_SHARE_FILES = 10;

/**
 * Upload whatever the native agent left in its per-conversation `$ATHENA_SHARE_DIR`
 * outbox to the thread, then remove each file so it's delivered exactly once.
 * Best-effort: a missing dir, an unreadable file, or a failed upload never
 * throws into the turn handler.
 */
async function shareOutbox(
  thread: { postFile: (a: { bytes: Uint8Array; filename: string; title?: string }) => Promise<{ ok: boolean; error?: string }> },
  conversationKey: string,
): Promise<void> {
  const dir = shareDirFor(canonicalKey(conversationKey));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // no outbox for this conversation — nothing to share
  }
  const files = entries.filter((f) => SHAREABLE_RE.test(f)).sort().slice(0, MAX_SHARE_FILES);
  for (const f of files) {
    const full = join(dir, f);
    try {
      const st = statSync(full);
      if (!st.isFile() || st.size === 0 || st.size > MAX_SHARE_BYTES) continue;
      const up = await thread.postFile({
        bytes: readFileSync(full),
        filename: f,
        title: f.replace(/\.\w+$/, ""),
      });
      if (!up.ok) console.error(`[share] upload failed (${f}): ${up.error}`);
    } catch (e) {
      console.error(`[share] ${f}:`, e);
    } finally {
      try {
        rmSync(full, { force: true });
      } catch {
        /* leave it; next scan retries */
      }
    }
  }
}

/** True only when every named env var is set and non-empty. */
const have = (...names: string[]): boolean =>
  names.every((n) => Boolean(process.env[n]));

async function main() {
  // Omnigent-only by default: the bot needs no separate agent backend. Set
  // AGENT_URL to ALSO run the triage AG-UI backend (runtime.ts) — when present,
  // @mentions still use Omnigent while slash commands + modal submissions route
  // to triage (see the agent factory below). Without it, everything is Omnigent.
  const agentUrl = process.env.AGENT_URL;
  const agentHeaders = process.env.AGENT_AUTH_HEADER
    ? { Authorization: process.env.AGENT_AUTH_HEADER }
    : undefined;

  // Build the platform list from whichever secrets are present. Each adapter
  // contributes its own built-in tools (e.g. `lookup_slack_user` /
  // `lookup_discord_user` / `lookup_telegram_user`) and context (tagging +
  // formatting guidance), added only when that platform is active so the model
  // isn't handed a different platform's conventions.
  const adapters: PlatformAdapter[] = [];
  const tools: BotTool[] = [...appTools];
  const context: ContextEntry[] = [...appContext];
  // Captured so plan-page feedback can rehydrate a Slack thread outside a
  // mention event and drive the same revision loop (see installPlanFeedback).
  let slackAdapter: PlatformAdapter | undefined;

  if (have("SLACK_BOT_TOKEN", "SLACK_APP_TOKEN")) {
    slackAdapter = slack({
        botToken: required("SLACK_BOT_TOKEN"),
        appToken: required("SLACK_APP_TOKEN"),
        // Tool progress renders as ONE collapsible message per turn: collapsed
        // to `⚙️ N steps · <running summary>` (summary from a small model via
        // ANTHROPIC_API_KEY/CK_TOOL_LOG_MODEL; latest-step fallback without a
        // key) with a Show/Hide-steps toggle expanding to the full history.
        // OmnigentNativeAgent emits real AG-UI TOOL_CALL_START/ARGS/END events
        // to drive it.
        showToolStatus: true,
        toolStatusStyle: "collapsible",
        // The bot keeps DMs conversational and responds to explicit app
        // mentions in channels/threads. Plain channel thread replies stay
        // quiet unless they mention it again.
        respondTo: {
          directMessages: true,
          appMentions: { reply: "thread" },
          threadReplies: "mentionsOnly",
        },
        // Assistant-pane behavior is ON by default; this just customizes it.
        // The greeting + chips show when a user opens the pane (matching the
        // app manifest's `assistant_view`); native streaming + status need no
        // config. Pass `assistant: false` / `streaming: "legacy"` to opt out.
        assistant: {
          greeting:
            "Hi! I'm a coding agent — @mention me to read, explain, or change your repo. Try `use codex` to switch models, `stop` to interrupt, or `help`.",
          suggestedPrompts: [
            {
              title: "Explore the repos",
              message: "List the repos you can see and summarize what each one does",
            },
            {
              title: "Switch model",
              message: "use codex",
            },
          ],
        },
      });
    adapters.push(slackAdapter);
    tools.push(...defaultSlackTools);
    context.push(...defaultSlackContext);
  }

  if (have("DISCORD_BOT_TOKEN", "DISCORD_APP_ID")) {
    adapters.push(
      discord({
        botToken: required("DISCORD_BOT_TOKEN"),
        appId: required("DISCORD_APP_ID"),
        // Optional: register slash commands to one guild instantly during dev
        // (global commands can take up to ~1h to propagate). Omit in prod.
        guildId: process.env.DISCORD_GUILD_ID,
      }),
    );
    tools.push(...defaultDiscordTools);
    context.push(...defaultDiscordContext);
  }

  if (have("TELEGRAM_BOT_TOKEN")) {
    // Telegram long-polls by default (no public URL / webhook setup needed).
    // No greeting/suggestedPrompts: Telegram has no assistant-pane surface.
    adapters.push(telegram({ token: required("TELEGRAM_BOT_TOKEN") }));
    tools.push(...defaultTelegramTools);
    context.push(...defaultTelegramContext);
  }

  if (
    have(
      "WHATSAPP_ACCESS_TOKEN",
      "WHATSAPP_PHONE_NUMBER_ID",
      "WHATSAPP_APP_SECRET",
      "WHATSAPP_VERIFY_TOKEN",
    )
  ) {
    // Unlike Slack/Discord (outbound), WhatsApp adds an INBOUND webhook HTTP
    // server. It listens on Railway's injected `$PORT` (the public domain
    // routes there); locally it defaults to 3000. Fail loud on a malformed
    // PORT rather than letting `Number("abc")` → NaN reach `server.listen()`.
    const port = process.env.PORT ? Number(process.env.PORT) : 3000;
    if (!Number.isInteger(port) || port < 0) {
      console.error(
        `Invalid PORT: "${process.env.PORT}" is not a valid port number`,
      );
      process.exit(1);
    }
    adapters.push(
      whatsapp({
        accessToken: required("WHATSAPP_ACCESS_TOKEN"),
        phoneNumberId: required("WHATSAPP_PHONE_NUMBER_ID"),
        appSecret: required("WHATSAPP_APP_SECRET"),
        verifyToken: required("WHATSAPP_VERIFY_TOKEN"),
        port,
        path: process.env.WHATSAPP_PATH ?? "/webhook",
      }),
    );
    tools.push(...defaultWhatsAppTools);
    context.push(...defaultWhatsAppContext);
  }

  if (adapters.length === 0) {
    console.error(
      "No platform secrets found. Set SLACK_BOT_TOKEN + SLACK_APP_TOKEN, " +
        "DISCORD_BOT_TOKEN + DISCORD_APP_ID, TELEGRAM_BOT_TOKEN, " +
        "and/or the WHATSAPP_* vars (see README).",
    );
    process.exit(1);
  }

  // One AG-UI agent per conversation, driven IN-PROCESS by `OmnigentNativeAgent`
  // (native Claude on your subscription) — so the bot's native loading shimmer +
  // token streaming work with no separate runtime server. If AGENT_URL is set,
  // we wrap it in `RoutingAgent` (see agent-router.ts): @mentions still use
  // Omnigent while slash commands + modal submissions route to the triage HTTP
  // backend. Omnigent-only otherwise. Hoisted so the plan-page feedback path can
  // build threads with the SAME agent factory (see installPlanFeedback).
  const agentFactory = (threadId: string) => {
    const omnigent = new OmnigentNativeAgent({ threadId });
    if (!agentUrl) return omnigent;
    const triage = new SanitizingHttpAgent({
      url: agentUrl,
      headers: agentHeaders,
    });
    triage.threadId = threadId;
    return new RoutingAgent(omnigent, triage, { threadId });
  };

  // Shared action store: interactive buttons on plan approval cards are posted
  // from a rehydrated thread (plan-page feedback) but their clicks are
  // dispatched by the bot's own registry. Sharing ONE ActionStore + registering
  // PlanApproval as a named component lets that registry recover the click
  // handler from the persisted snapshot (also makes buttons restart-durable).
  const actionStore = new InMemoryActionStore();

  const bot = createBot({
    adapters,
    agent: agentFactory,
    actionStore,
    components: [PlanApproval as unknown as BotComponent],
    // The per-conversation turn lock silently DROPS a mention that arrives
    // while a turn is still streaming in that thread — which used to eat
    // `stop` for the first 60s (the lock TTL) of any run: exactly when you
    // most want it. Control phrases are lock-safe (they don't stream a turn
    // of their own), so force them through; everything else keeps the
    // drop-overlapping-turns behavior.
    store: {
      onLockConflict: (_conversationKey: string, message: { text?: string }) =>
        parseControl(message.text ?? "") ? ("force" as const) : ("drop" as const),
    },
    // `appTools` adds this bot's tools (read_thread, render_*, issue/page
    // cards); the per-platform `default*Tools` add `lookup_*_user`. All are
    // plain `BotTool`s — the active adapter supplies `thread`/`message`/`user`
    // per call. `default*Context` ships tagging/formatting/thread-model
    // guidance; `appContext` adds identity + triage policy.
    tools,
    context,
    // Slash commands (`/agent`, `/triage`, `/preview`, `/file-issue`). For Slack
    // each must ALSO be declared in the app config (or paste the manifest); Discord
    // and Telegram register them up front. The engine routes by name; adapters that
    // can't take commands ignore them.
    commands: appCommands,
  });

  // The turn handler. Each adapter pre-filters ingress to the turns this bot
  // should answer — DMs, explicit mentions, and every WhatsApp message.
  // createBot is mention-preferred: a single handler covers them across every
  // active platform. Additional feature demos below add their own handlers for
  // modal submissions and assistant-pane thread starts. Wrap the turn so a
  // failed run (agent backend down, network/auth error) is logged and surfaced
  // to the user instead of crashing the process or vanishing silently.
  bot.onMention(async ({ thread, message }) => {
    try {
      // A mention that IS a control phrase (`use codex`, `help`, `stop`) is
      // handled here and does NOT run the agent — so switching models, showing
      // help, and stopping all work with no Slack-manifest changes. Anything
      // else (a real request) falls through to the agent below.
      const control = parseControl(message.text ?? "");
      if (control) {
        const channelId = channelIdFromConversationKey(
          (thread as unknown as { conversationKey: string }).conversationKey,
        );
        if (control.kind === "help") {
          await thread.post(
            helpText(getChannelExecutor(channelId), getChannelModel(channelId)),
          );
          return;
        }
        if (control.kind === "switch-model") {
          setChannelModel(channelId, control.model);
          await thread.post(
            `✅ New *Claude Code* sessions in this channel now use *${control.model}*. ` +
              "Threads with a session already open keep their current model until it ends; " +
              "issue workflows keep their own pins (plan=opus, impl=sonnet).",
          );
          return;
        }
        if (control.kind === "status") {
          await thread.post(await statusText());
          return;
        }
        if (control.kind === "stop" || control.kind === "stop-all") {
          const conversationKey = (thread as unknown as { conversationKey: string })
            .conversationKey;
          // Plain `stop` is THREAD-scoped: it must never kill runs in other
          // threads of the channel (that once tore down a live test elsewhere).
          // `stop all` keeps the channel-wide sweep for when it's wanted.
          const n =
            control.kind === "stop-all"
              ? stopChannel(channelId)
              : stopConversation(conversationKey);
          // Also release this thread's workflow record if one is mid-flight:
          // a live run's onDone marks it failed anyway, but a DEAD session
          // (bot restart, GC'd pane) has no onDone — without this, `take this`
          // refuses with "already working" forever.
          const released = releaseWorkflow(conversationKey);
          const restartHint = released
            ? ` Say \`resume\` to pick up *${released.issue}* where it left off, or \`take ${released.issue}\` to start over.`
            : "";
          await thread.post(
            n > 0
              ? `⏹️ Stopped ${n} running answer${n === 1 ? "" : "s"}` +
                  `${control.kind === "stop-all" ? " across this channel" : " in this thread"}.` +
                  restartHint
              : released
                ? `⏹️ Reset the stuck *${released.issue}* workflow —${restartHint}`
                : control.kind === "stop-all"
                  ? "Nothing is running in this channel."
                  : "Nothing is running in this thread. (`stop all` sweeps the whole channel.)",
          );
          return;
        }
        // switch
        setChannelExecutor(channelId, control.executor);
        await thread.post(
          `✅ This channel now uses *${executorLabel(control.executor)}*. ` +
            "Mention me to start, or `@Athena help` for options.",
        );
        return;
      }

      // Issue workflow: `take this` under a Linear-filed bug thread starts the
      // plan → approve → implement pipeline; while a plan awaits approval, a
      // plain mention in that thread is treated as revision feedback. Returns
      // false for ordinary mentions, which fall through to normal chat below.
      if (await handleWorkflowMention({ thread, text: message.text ?? "" })) {
        return;
      }

      // Tag this run for Omnigent (the router sends it to OmnigentNativeAgent;
      // untagged runs — slash commands, modal submits — go to triage). The
      // mention text is already in the reconstructed thread history, so no
      // explicit prompt is needed; the bot streams the reply with its native
      // loading shimmer + token streaming.
      //
      // In a thread that ran (or is running) an issue workflow, pin the chat
      // turn's scope to THAT issue: a vague follow-up like "fix ci comments"
      // once sent the agent sweeping every open PR on the box instead of this
      // thread's own (FLU-254's thread got FLU-256/262's PRs "fixed").
      const conversationKey = (thread as unknown as { conversationKey: string })
        .conversationKey;
      const record = getWorkflow(conversationKey);
      if (record) {
        setTurnPreamble(
          conversationKey,
          `This chat thread is the workflow thread for Linear issue ${record.issue}` +
            `${record.title ? ` ("${record.title}")` : ""} on branch ${record.branch}` +
            ` (workflow state: ${record.state}). Scope any request in this thread to` +
            ` ${record.issue} and its branch/PR unless the user EXPLICITLY names a` +
            ` different issue, PR, or repo — never go looking across other issues'` +
            ` PRs, worktrees, or instances from here.`,
        );
      }
      await thread.runAgent({ context: [OMNIGENT_ROUTE] });
      // Deliver anything the agent dropped in its `$ATHENA_SHARE_DIR` outbox
      // (screenshots, logs, artifacts) to this thread. Chat turns otherwise
      // have no file channel — the agent can produce a PNG but not hand it over.
      await shareOutbox(
        thread,
        (thread as unknown as { conversationKey: string }).conversationKey,
      ).catch((e) => console.error("[share] outbox scan failed", e));
    } catch (err) {
      console.error("[bot] agent run failed", err);
      await thread
        .post("Sorry — I hit an error handling that. Please try again.")
        .catch(() => {});
    }
  });

  // Modal demo (cont.) — handle the /file-issue submission. The handler lives in
  // `modals/file-issue.tsx` (extracted + unit-tested): it validates, then
  // fire-and-forgets the agent run so the submission can be ack'd within Slack's
  // ~3s view_submission deadline (awaiting the run blows it → Slack double-files).
  bot.onModalSubmit(FILE_ISSUE_CALLBACK, fileIssueSubmit);

  await bot.start();
  console.log(
    `[bot] started on: ${adapters.map((a) => a.platform).join(", ")}`,
  );
  // Auth proxy fronting the self-hosted Plan app (through the cloudflared tunnel).
  startPlanBridge();

  // One rehydrated-thread factory serves both boot recovery (below) and the
  // optional plan-page feedback loop.
  const threadFactory = slackAdapter
    ? makeThreadFactory({ adapter: slackAdapter, agentFactory, tools, context, actionStore })
    : undefined;

  // DEPLOYS MUST NOT KILL WORK: panes and omnigent sessions survive a bot
  // restart — only our poll loops die. Re-attach to every workflow phase that
  // was mid-turn when the previous process stopped, so it streams on, posts
  // its result, and advances its record. Chat-turn orphans are let go (short,
  // no state machine; the pane finishes on its own and context is preserved
  // for the thread's next mention).
  if (threadFactory) {
    for (const orphan of takeOrphanedTurns()) {
      const record = getWorkflow(orphan.conversationKey);
      if (!record || (record.state !== "planning" && record.state !== "implementing")) {
        continue;
      }
      // The rehydrated-thread factory is built on the SLACK adapter; feeding
      // it a Telegram conversationKey would post the recovered stream into a
      // garbage Slack channel. Let those orphans go like chat turns: the pane
      // finishes on its own, and `resume` in the Telegram chat picks it up.
      if (partsFromConversationKey(orphan.conversationKey).platform !== "slack") {
        console.error(
          `[bot] skipping re-attach for ${record.issue} (${orphan.conversationKey}): ` +
            "only Slack threads rehydrate; say `resume` in that chat",
        );
        continue;
      }
      void recoverWorkflowTurn(threadFactory(orphan.conversationKey), record, orphan).catch(
        (err) => console.error(`[bot] re-attach failed for ${record.issue}`, err),
      );
    }
  }

  // Plan-page feedback → Slack revision loop is OFF by default: the plan page
  // is a self-contained local editor (edits/comments autosave locally, "Done"
  // closes), so comments must not trigger Slack revisions. Without a handler
  // registered the bridge's comment interception is inert (plain proxy). Set
  // OPENTAG_PLAN_PAGE_FEEDBACK=1 to opt in: each new plan-page comment then
  // drives the same revision a Slack `@Athena <feedback>` mention does.
  if (process.env["OPENTAG_PLAN_PAGE_FEEDBACK"] === "1" && threadFactory) {
    installPlanFeedback(threadFactory);
  }

  const shutdown = async (signal: string) => {
    console.log(`\n[bot] received ${signal}, stopping…`);
    await bot.stop();
    // Tear down the shared headless browser used for chart/diagram rendering.
    await closeBrowser();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Fail loud, not silent: surface any stray async error (e.g. a throw deep in an
// interaction/callback path) instead of letting it kill the process with no
// log. Log and keep running — one bad turn shouldn't take the bot down.
process.on("unhandledRejection", (reason) => {
  console.error("[bot] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[bot] uncaughtException:", err);
});

main().catch((err) => {
  console.error("[bot] fatal", err);
  process.exit(1);
});
