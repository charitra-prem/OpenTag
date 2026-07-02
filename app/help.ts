/**
 * The bot's help card. Shared by the `/help` slash command and the
 * `@Athena help` mention phrase so both surfaces show identical, current info —
 * including which model this channel is set to right now.
 */
import { executorLabel } from "../omnigent/native-agent.js";
import type { Executor } from "../omnigent/native-agent.js";

/**
 * Markdown help text. `current` is the channel's active harness (undefined →
 * the env default, shown as such) so the card always reflects live state.
 */
export function helpText(current?: Executor): string {
  const model = current ? executorLabel(current) : `${executorLabel("claude")} (default)`;
  return [
    `*Hi — I'm your coding agent.* Mention me and I'll work in the repo and stream the answer back here.`,
    ``,
    `*Current model in this channel:* ${model}`,
    ``,
    `*Ask me something*`,
    `> \`@Athena explain how the frontend renders markdown attachments\``,
    ``,
    `*Switch models* (Claude Code ↔ Codex)`,
    `• \`@Athena use codex\` — set this channel's default to Codex`,
    `• \`@Athena use claude\` — set it back to Claude Code`,
    `• \`@Athena !codex <task>\` — use Codex for *just this message*`,
    `• \`/codex\` · \`/claude\` — same, as slash commands`,
    ``,
    `*Stop / resume*`,
    `• \`@Athena stop\` — interrupts what's running *in this thread* (other threads keep going)`,
    `• \`@Athena stop all\`  or  \`/stop\` — interrupts every running answer in this channel`,
    `• \`@Athena resume\` — picks an interrupted implementation back up where it stopped (worktree, branch, and plan survive a stop)`,
    `• \`@Athena resume, <what to add>\` — follow-up on a *finished* workflow: implements the new ask on top of the previous work (same branch/PR, context from Linear + the PR)`,
    ``,
    `*See what's alive*`,
    `• \`@Athena status\` — sessions, workflows, running instances (+ their URLs), box headroom`,
    ``,
    `*Issue workflow* (plan → approve → implement)`,
    `• \`@Athena take this\` — in a bug thread: I find the Linear issue, post a plan for approval, and implement it in a worktree after you approve`,
    `• \`@Athena take FLU-123\` — same, naming the issue explicitly`,
    `• Add a scoping note after a comma or the issue id: \`take this, fe fix only\` · \`take FLU-123 fe only\``,
    `• While a plan awaits approval: \`@Athena <feedback>\` revises it`,
    `• \`@Athena investigate <what>\` (or debug / look into / root-cause) — read-only exploration with the debugging skills; findings land here, no plan or code changes`,
    ``,
    `*Commands*`,
    `• \`/model\` — show the current model`,
    `• \`/help\` — show this message`,
  ].join("\n");
}
