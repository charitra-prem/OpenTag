/**
 * PICKER_RE must catch the interactive-dialog footers Claude Code renders —
 * the exact footer below is what FLU-192's implementation sat behind for
 * 900+ polls while WORKING_RE misread its "Esc to cancel" as work.
 */
import { describe, expect, it } from "vitest";
import { PICKER_RE } from "../native-agent";

describe("PICKER_RE", () => {
  it("matches the plan-mode option picker footer (live-captured)", () => {
    expect(
      PICKER_RE.test(
        "Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel",
      ),
    ).toBe(true);
  });

  it("matches confirm-style dialog footers", () => {
    expect(PICKER_RE.test("Enter to confirm · Esc to exit")).toBe(true);
  });

  it("matches the plan-approval dialog (live-captured from FLU-192)", () => {
    const dialog = [
      "Claude has written up a plan and is ready to execute. Would you like to proceed?",
      "❯ 1. Yes, and bypass permissions",
      "  2. Yes, manually approve edits",
      "  4. Tell Claude what to change",
      "     shift+tab to approve with this feedback",
    ].join("\n");
    expect(PICKER_RE.test(dialog)).toBe(true);
    // Each signature alone suffices — the capture may clip the dialog.
    expect(PICKER_RE.test("Would you like to proceed?")).toBe(true);
    expect(PICKER_RE.test("❯ 1. Yes, and bypass permissions")).toBe(true);
  });

  it("does not match the normal working line or prose", () => {
    expect(PICKER_RE.test("· Unravelling… (5m 31s · ↓ 23.9k tokens)")).toBe(
      false,
    );
    expect(PICKER_RE.test("✻ Baking… (esc to interrupt)")).toBe(false);
    expect(
      PICKER_RE.test("press Enter to continue the build when ready"),
    ).toBe(false);
  });
});
