import { describe, expect, it } from "vitest";
import {
  parseWorkflowTrigger,
  parseInvestigateTrigger,
  workflowTriggerHint,
  extractIssueId,
  parsePlanMeta,
} from "../detect.js";

describe("parseWorkflowTrigger", () => {
  it("matches bare trigger phrases (after a mention token)", () => {
    expect(parseWorkflowTrigger("<@U123> take this")).toEqual({});
    expect(parseWorkflowTrigger("take it!")).toEqual({});
    expect(parseWorkflowTrigger("plan this issue")).toEqual({});
    expect(parseWorkflowTrigger("work on this")).toEqual({});
  });

  it("captures an explicit issue id", () => {
    expect(parseWorkflowTrigger("<@U123> take FLU-252")).toEqual({
      issue: "FLU-252",
    });
    expect(parseWorkflowTrigger("fix flu-9")).toEqual({ issue: "FLU-9" });
  });

  it("does NOT hijack ordinary requests", () => {
    expect(parseWorkflowTrigger("take this file and refactor it")).toBeNull();
    expect(parseWorkflowTrigger("can you fix this bug in sum.js")).toBeNull();
    expect(parseWorkflowTrigger("what does sum.js do")).toBeNull();
    // `fix`/`work on` never carry a brief — trailing text stays chat.
    expect(parseWorkflowTrigger("fix this, quickly please")).toBeNull();
    expect(parseWorkflowTrigger("work on FLU-9 tomorrow")).toBeNull();
  });

  it("captures a trailing brief after a separator or an issue id", () => {
    expect(parseWorkflowTrigger("<@U123> take this, fe fix only")).toEqual({
      brief: "fe fix only",
    });
    expect(parseWorkflowTrigger("plan this issue — frontend only")).toEqual({
      brief: "frontend only",
    });
    expect(parseWorkflowTrigger("take FLU-262 fe only")).toEqual({
      issue: "FLU-262",
      brief: "fe only",
    });
    expect(parseWorkflowTrigger("take flu-262, skip the backend")).toEqual({
      issue: "FLU-262",
      brief: "skip the backend",
    });
    // No separator after "this" → not a trigger (the hint covers it).
    expect(parseWorkflowTrigger("take this fe fix only")).toBeNull();
  });
});

describe("workflowTriggerHint", () => {
  it("hints on near-miss triggers instead of silent chat fallthrough", () => {
    expect(workflowTriggerHint("<@U123> take this fe fix only")).toMatch(
      /take this, fe fix only/,
    );
    expect(workflowTriggerHint("plan this migration carefully")).toBeDefined();
  });
  it("stays quiet for ordinary chat", () => {
    expect(workflowTriggerHint("can you fix this bug in sum.js")).toBeUndefined();
    expect(workflowTriggerHint("what does sum.js do")).toBeUndefined();
    expect(workflowTriggerHint("fix this typo in the header")).toBeUndefined();
  });
});

describe("extractIssueId", () => {
  it("finds the last issue id across the thread", () => {
    expect(
      extractIssueId([
        "*From:* Jai …",
        "[ FLU-247](https://linear.app/…) comments are synced",
        "some chatter",
      ]),
    ).toBe("FLU-247");
  });
  it("returns undefined when there is none", () => {
    expect(extractIssueId(["no ids here"])).toBeUndefined();
  });
});

describe("parseInvestigateTrigger", () => {
  it("matches leading investigation verbs and keeps the brief", () => {
    expect(parseInvestigateTrigger("<@U123> investigate this")).toEqual({
      issue: undefined,
      brief: "this",
    });
    expect(
      parseInvestigateTrigger("@Athena debug why the runtime is unreachable in prod"),
    ).toEqual({ issue: undefined, brief: "why the runtime is unreachable in prod" });
    expect(parseInvestigateTrigger("look into FLU-252, the stop button one")).toEqual({
      issue: "FLU-252",
      brief: "FLU-252, the stop button one",
    });
    expect(parseInvestigateTrigger("root-cause the 401s on dev")).toEqual({
      issue: undefined,
      brief: "the 401s on dev",
    });
  });
  it("does not fire for workflow triggers or plain chat", () => {
    expect(parseInvestigateTrigger("take this")).toBeNull();
    expect(parseInvestigateTrigger("fix FLU-252")).toBeNull();
    expect(parseInvestigateTrigger("what are open Fluso issues?")).toBeNull();
    expect(parseInvestigateTrigger("can you maybe investigate later")).toBeNull();
  });
});

describe("parsePlanMeta", () => {
  it("parses REPOS and TITLE leniently", () => {
    const meta = parsePlanMeta(
      "**REPOS:** fluso-frontend, premapp-backend\n*TITLE*: Fix save button placement\n## Plan\n1. …",
    );
    expect(meta.repos).toEqual(["fluso-frontend", "premapp-backend"]);
    expect(meta.title).toBe("Fix save button placement");
  });
  it("returns empty repos when the header is missing", () => {
    expect(parsePlanMeta("just prose").repos).toEqual([]);
  });
});
