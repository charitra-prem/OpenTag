import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point persistence at a throwaway dir BEFORE the module lazily loads state.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-state-"));
  process.env["OPENTAG_STATE_DIR"] = dir;
});
afterAll(() => {
  delete process.env["OPENTAG_STATE_DIR"];
  rmSync(dir, { recursive: true, force: true });
});

const { newWorkflow, putWorkflow, findWorkflowByIssue, getWorkflow } =
  await import("../state.js");

describe("findWorkflowByIssue", () => {
  it("matches case-insensitively (plan-page slug → uppercased issue)", () => {
    newWorkflow("C1::100.1", "FLU-900");
    expect(findWorkflowByIssue("flu-900")?.conversationKey).toBe("C1::100.1");
    expect(findWorkflowByIssue("FLU-900")?.conversationKey).toBe("C1::100.1");
    expect(findWorkflowByIssue("flu-000")).toBeUndefined();
  });

  it("prefers a record with a plan on the table over a terminal one", () => {
    const done = newWorkflow("C2::100.2", "FLU-901");
    done.state = "done";
    putWorkflow(done);
    const active = newWorkflow("C3::100.3", "FLU-901");
    active.state = "awaiting_approval";
    putWorkflow(active);
    expect(findWorkflowByIssue("flu-901")?.conversationKey).toBe("C3::100.3");
    // sanity: both records still exist under their own keys
    expect(getWorkflow("C2::100.2")?.state).toBe("done");
  });
});
