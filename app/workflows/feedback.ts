/**
 * Plan-page feedback → the issue-workflow revision loop.
 *
 * The plan bridge (planbridge.ts) intercepts comment writes on the self-hosted
 * Plan app and emits {slug, messages}. This module turns that into the exact
 * same revision a Slack `@Athena <feedback>` mention produces: it finds the
 * workflow for the slug, rehydrates its Slack thread, and re-drives the plan
 * session — which edits plan.mdx in place and posts a fresh approval card back
 * to the originating thread (Slack stays the source of truth). No plan content
 * leaves the box: the feedback text was already local, and the revision runs on
 * the on-box native Claude session.
 */
import { setPlanFeedbackHandler, type PlanFeedback } from "./planbridge.js";
import { findWorkflowByIssue, putWorkflow } from "./state.js";
import { runRevision } from "./index.js";
import type { ThreadFactory } from "./rehydrate.js";

/** Install the bridge → revision handler. Call once at boot. */
export function installPlanFeedback(threadFactory: ThreadFactory): void {
  setPlanFeedbackHandler((feedback) => {
    void applyPlanPageFeedback(threadFactory, feedback).catch((err) =>
      console.error("[workflow] plan-page feedback failed", err),
    );
  });
}

async function applyPlanPageFeedback(
  threadFactory: ThreadFactory,
  { slug, messages }: PlanFeedback,
): Promise<void> {
  const record = findWorkflowByIssue(slug);
  if (!record) {
    console.error(`[workflow] plan-page feedback for unknown slug ${slug}`);
    return;
  }
  // Only when a plan is actually on the table — mirrors the Slack mention path
  // (a comment on an implementing/done/skipped plan is not a re-plan trigger).
  if (record.state !== "awaiting_approval" && record.state !== "revising") {
    console.error(
      `[workflow] plan-page feedback for ${record.issue} ignored (state=${record.state})`,
    );
    return;
  }
  // Claim the round synchronously (before any await) so two comments posted in
  // quick succession can't both pass the guard and double-drive the session.
  record.state = "planning";
  putWorkflow(record);

  const feedback =
    messages.length === 1
      ? messages[0]!
      : messages.map((m) => `- ${m}`).join("\n");

  const thread = threadFactory(record.conversationKey);
  await thread.post(
    `💬 Plan-page feedback on *${record.issue}* — revising the plan…`,
  );
  await runRevision(thread, record, feedback);
}
