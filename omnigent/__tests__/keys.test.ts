/**
 * Key-transform consistency across platforms. The whole file hinges on ONE
 * invariant: the bot side (holding a conversationKey) and the agent side
 * (holding an AG-UI threadId) must land on the SAME stable key, or turn
 * overrides, preambles, `stop`, and the share outbox silently misroute for
 * that platform — the Slack-only hardcoding of these transforms is what kept
 * Telegram from working at all.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalKey,
  channelIdFromConversationKey,
  conversationKeyOfStableKey,
  partsFromConversationKey,
  stableKey,
} from "../native-agent";

describe("slack keys", () => {
  const conversationKey = "C0BE3B406TV::1783034360.123456";
  // The Slack store mints a fresh uuid-suffixed threadId per turn.
  const threadId =
    "slack-C0BE3B406TV-1783034360.123456-0f8b2c1a-9d3e-4f5a-8b6c-7d8e9f0a1b2c";

  it("bot side and agent side meet on the same stable key", () => {
    expect(canonicalKey(conversationKey)).toBe(stableKey(threadId));
  });

  it("stable key round-trips back to the conversationKey", () => {
    expect(conversationKeyOfStableKey(canonicalKey(conversationKey))).toBe(
      conversationKey,
    );
  });

  it("extracts the channel id", () => {
    expect(channelIdFromConversationKey(conversationKey)).toBe("C0BE3B406TV");
    expect(partsFromConversationKey(conversationKey)).toEqual({
      platform: "slack",
      channelId: "C0BE3B406TV",
      scope: "1783034360.123456",
    });
  });

  it("handles the DM scope", () => {
    expect(canonicalKey("D07AAA::dm")).toBe("slack-D07AAA-dm");
    expect(conversationKeyOfStableKey("slack-D07AAA-dm")).toBe("D07AAA::dm");
  });
});

describe("telegram keys", () => {
  // Telegram threadIds are stable (`tg-thread-<conversationKey>`, no uuid),
  // and scopes can themselves contain colons (topic:<id>, user:<id>).
  const cases = [
    { conversationKey: "tg:123456:dm", chatId: "123456", scope: "dm" },
    {
      conversationKey: "tg:-1009876:topic:42",
      chatId: "-1009876",
      scope: "topic:42",
    },
    {
      conversationKey: "tg:-1009876:user:777",
      chatId: "-1009876",
      scope: "user:777",
    },
  ];

  it.each(cases)(
    "bot side and agent side meet on the same stable key ($conversationKey)",
    ({ conversationKey }) => {
      const threadId = `tg-thread-${conversationKey}`;
      expect(canonicalKey(conversationKey)).toBe(stableKey(threadId));
    },
  );

  it.each(cases)(
    "stable key round-trips back to the conversationKey ($conversationKey)",
    ({ conversationKey }) => {
      expect(conversationKeyOfStableKey(canonicalKey(conversationKey))).toBe(
        conversationKey,
      );
    },
  );

  it.each(cases)(
    "extracts the chat id ($conversationKey)",
    ({ conversationKey, chatId, scope }) => {
      expect(channelIdFromConversationKey(conversationKey)).toBe(chatId);
      expect(partsFromConversationKey(conversationKey)).toEqual({
        platform: "telegram",
        channelId: chatId,
        scope,
      });
    },
  );
});
