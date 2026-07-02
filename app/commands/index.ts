/**
 * Slash commands for this bot. Each is registered with the engine via
 * `createBot({ commands })`; the Slack adapter forwards every `/command` it
 * receives and the engine routes by name (ignoring unregistered ones).
 *
 * NOTE: a slash command only fires if it's also declared in the Slack app
 * config ("Slash Commands" / manifest) with the same name — Slack won't
 * deliver an unregistered command, even over Socket Mode.
 *
 * Args arrive as free text (`ctx.text`) on Slack; `ctx.options` is for
 * surfaces with native structured args (e.g. Discord). The `options` schema
 * is optional and used there for registration/typing.
 */
import { defineBotCommand } from "@copilotkit/bot";
import type { BotCommand } from "@copilotkit/bot";
import { senderContext } from "../sender-context.js";
import { IssueCard } from "../components/index.js";
import { FileIssueModal } from "../modals/file-issue.js";
import {
  stopChannel,
  channelIdFromConversationKey,
  setChannelExecutor,
  getChannelExecutor,
  effectiveExecutor,
  executorLabel,
} from "../../omnigent/native-agent.js";
import type { Executor } from "../../omnigent/native-agent.js";
import { helpText } from "../help.js";

/** `thread.conversationKey` ("channelId::scope") isn't on the public Thread
 *  interface, but it's a real field on the concrete class — it's the only id
 *  that lines up with the channel a run registered under. */
const channelOf = (thread: unknown): string =>
  channelIdFromConversationKey(
    (thread as { conversationKey: string }).conversationKey,
  );

/** A slash command that pins this channel's default harness. */
const modelCommand = (name: Executor): BotCommand =>
  defineBotCommand({
    name,
    description: `Use ${executorLabel(name)} as this channel's default model.`,
    async handler({ thread }) {
      setChannelExecutor(channelOf(thread), name);
      await thread.post(
        `✅ This channel now uses *${executorLabel(name)}*.`,
      );
    },
  });

export const appCommands: BotCommand[] = [
  // `/agent <text>` — a mention-free entry point. (Previously hardcoded in the
  // adapter; now an ordinary, app-owned command.) Runs the agent with the
  // command text as the user prompt, since slash-command args are never
  // posted to the channel for the agent to read from history.
  defineBotCommand({
    name: "agent",
    description: "Ask the triage agent anything (no @mention needed).",
    async handler({ thread, text, user }) {
      if (!text) {
        await thread.post("Usage: `/agent <your question>`");
        return;
      }
      await thread.runAgent({
        prompt: text,
        context: senderContext(user, thread.platform),
      });
    },
  }),

  // `/stop` — interrupt the answer(s) in flight in this channel. Ends the Slack
  // stream (the partial reply stays) and sends Esc to the native harness so it
  // stops working, without killing the session (the next turn reuses it). Slack
  // slash commands are channel-scoped (no thread context), so this targets the
  // channel: it stops every run currently streaming here.
  defineBotCommand({
    name: "stop",
    description: "Stop the answer(s) currently streaming in this channel.",
    async handler({ thread }) {
      const n = stopChannel(channelOf(thread));
      await thread.post(
        n > 0
          ? `⏹️ Stopped ${n} running answer${n === 1 ? "" : "s"}.`
          : "Nothing is running in this channel.",
      );
    },
  }),

  // `/claude` and `/codex` — pin this channel's default model. Handled directly
  // (no agent run), so they work regardless of the triage backend.
  modelCommand("claude"),
  modelCommand("codex"),

  // `/model` — show which model this channel uses right now.
  defineBotCommand({
    name: "model",
    description: "Show which model this channel is using.",
    async handler({ thread }) {
      const channelId = channelOf(thread);
      const pinned = getChannelExecutor(channelId);
      const active = effectiveExecutor(channelId);
      await thread.post(
        `*Model:* ${executorLabel(active)}${pinned ? "" : " (default)"} — ` +
          "switch with `/codex` / `/claude` or `@Athena use codex`.",
      );
    },
  }),

  // `/help` — the same help card as `@Athena help`.
  defineBotCommand({
    name: "help",
    description: "Show what I can do and how to switch models.",
    async handler({ thread }) {
      await thread.post(helpText(getChannelExecutor(channelOf(thread))));
    },
  }),

  // `/triage [note]` — summarize the current channel/thread and propose Linear
  // issues to file. Demonstrates a command with its own intent.
  defineBotCommand({
    name: "triage",
    description:
      "Summarize the conversation and propose Linear issues to file.",
    async handler({ thread, text, user }) {
      const prompt = text
        ? `Triage this and propose Linear issues to file: ${text}`
        : "Triage the current conversation: summarize it and propose Linear issues to file.";
      await thread.runAgent({
        prompt,
        context: senderContext(user, thread.platform),
      });
    },
  }),

  // `/preview <title>` — ephemeral demo. Show the invoker a private draft of the
  // issue we'd file BEFORE anything is posted publicly or written to Linear.
  // `postEphemeral` is capability-gated with an explicit DM fallback: Slack shows
  // a native only-you message; Discord and Telegram have no ephemeral surface, so
  // `fallbackToDM: true` sends it as a direct message instead. We narrate which
  // path was taken so the degradation is visible, never silent.
  defineBotCommand({
    name: "preview",
    description: "Privately preview the issue I'd file (only you see it).",
    async handler({ thread, text, user, platform }) {
      if (!text) {
        await thread.post("Usage: `/preview <issue title>`");
        return;
      }
      if (!user) {
        await thread.post(
          "I couldn't tell who you are, so I can't send a private preview here.",
        );
        return;
      }
      const draft = IssueCard({
        identifier: "DRAFT",
        title: text,
        state: "Triage",
        description: "_Draft — nothing is filed until you run_ `/file-issue`.",
      });
      const res = await thread.postEphemeral(user, draft, {
        fallbackToDM: true,
      });
      // Degrade, never throw: report what actually happened.
      if (!res || !res.ok) {
        await thread.post(
          `I couldn't send a private preview on ${platform}. Run \`/file-issue\` to file it.`,
        );
        return;
      }
      if (res.usedFallback) {
        await thread.post(
          "📬 I sent you the draft as a direct message (this surface has no private messages).",
        );
      }
    },
  }),

  // `/file-issue` — modal demo. Open a structured issue form, or degrade
  // honestly where modals aren't available.
  //  - Slack   → rich modal (dropdowns + radio).
  //  - Discord → text-only modal (discord.js modals take only text inputs); the
  //              dropdowns/radio drop and defaults apply (see FileIssueModal).
  //  - Telegram→ no modal trigger at all (`ctx.openModal` is undefined), so we
  //              say so and continue the same job conversationally via the agent.
  defineBotCommand({
    name: "file-issue",
    description: "Open a form to file a Linear issue.",
    async handler({ thread, openModal, platform, user }) {
      if (!openModal) {
        await thread.post(
          "Modals aren't supported here — let's do it in chat instead. " +
            "Tell me the issue title and a short description and I'll file it.",
        );
        await thread.runAgent({
          prompt:
            "The user wants to file a Linear issue but this platform has no modal form. " +
            "Ask them for a title and description, then (after the usual confirm) file it.",
          context: senderContext(user, platform),
        });
        return;
      }
      const res = await openModal(
        FileIssueModal({ rich: platform === "slack" }),
      );
      if (!res.ok) {
        await thread.post(
          `I couldn't open the form${res.error ? `: ${res.error}` : ""}.`,
        );
      }
    },
  }),
];
