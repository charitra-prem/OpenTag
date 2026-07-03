/**
 * The in-thread issue scan is Slack-only: on Telegram the "thread" is the
 * whole rolling chat (including Athena's own status dumps), and scanning it
 * live-picked FLU-277 out of a status table. A bare `take this` there must
 * nudge for an explicit id instead of fishing one out of the history.
 */
import { describe, expect, it, vi } from "vitest";
import { handleWorkflowMention } from "../index.js";

const tgThread = (posts: unknown[]) => ({
  conversationKey: "tg:874934115:dm",
  post: vi.fn(async (ui: unknown) => void posts.push(ui)),
  postFile: vi.fn(async () => ({ ok: true })),
  runAgent: vi.fn(async () => undefined),
  // History full of issue ids — exactly what a status dump leaves behind.
  getMessages: vi.fn(async () => [
    { text: "flu-277 slot=8 issue=FLU-277 state=running" },
    { text: "FLU-192 — implementing" },
  ]),
});

describe("telegram platform gate", () => {
  it("take this → asks for an explicit issue id, never scans history", async () => {
    const posts: unknown[] = [];
    const thread = tgThread(posts);
    const handled = await handleWorkflowMention({ thread, text: "take this" });
    expect(handled).toBe(true);
    expect(String(posts[0])).toMatch(/name the issue explicitly/i);
    // The scan being skipped entirely is the point — not just its result.
    expect(thread.getMessages).not.toHaveBeenCalled();
    expect(thread.runAgent).not.toHaveBeenCalled();
  });
});
