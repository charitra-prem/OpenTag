import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSafeSlug, planViewUrl, parsePlanFeedback } from "../planbridge.js";

const MDX = `---
title: "Move the Save button"
kind: plan
slug: flu-250
status: draft
---

### Body
`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "planbridge-"));
  process.env["OPENTAG_PLANS_DIR"] = dir;
  process.env["OPENTAG_TUNNEL_URL_FILE"] = join(dir, "no-tunnel-here");
  mkdirSync(join(dir, "flu-250"));
  writeFileSync(join(dir, "flu-250", "plan.mdx"), MDX);
});

afterEach(() => {
  delete process.env["OPENTAG_PLANS_DIR"];
  delete process.env["OPENTAG_TUNNEL_URL_FILE"];
  delete process.env["OPENTAG_PUBLIC_BRIDGE_URL"];
  rmSync(dir, { recursive: true, force: true });
});

describe("isSafeSlug", () => {
  it("accepts lowercase issue slugs", () => {
    expect(isSafeSlug("flu-250")).toBe(true);
  });
  it("rejects traversal and uppercase", () => {
    expect(isSafeSlug("../etc")).toBe(false);
    expect(isSafeSlug("FLU-250")).toBe(false);
    expect(isSafeSlug("a/b")).toBe(false);
    expect(isSafeSlug("")).toBe(false);
  });
});

describe("planViewUrl", () => {
  it("composes the auth-hop Plan app URL when a public base exists", () => {
    process.env["OPENTAG_PUBLIC_BRIDGE_URL"] = "https://x.trycloudflare.com/";
    const url = planViewUrl("flu-250")!;
    expect(url.startsWith("https://x.trycloudflare.com/plan-auth?token=")).toBe(true);
    expect(url.endsWith(`&next=${encodeURIComponent("/local-plans/flu-250")}`)).toBe(true);
  });
  it("degrades to undefined without a tunnel or plan", () => {
    expect(planViewUrl("flu-250")).toBeUndefined(); // no tunnel URL anywhere
    process.env["OPENTAG_PUBLIC_BRIDGE_URL"] = "https://x.trycloudflare.com";
    expect(planViewUrl("missing-9")).toBeUndefined(); // no plan.mdx
  });
});

describe("parsePlanFeedback", () => {
  const body = (o: unknown) => JSON.stringify(o);

  it("captures a new comment (no id) as one revision message", () => {
    expect(
      parsePlanFeedback(
        body({ slug: "flu-250", comments: [{ message: "  tighten step 3  " }] }),
      ),
    ).toEqual({ slug: "flu-250", messages: ["tighten step 3"] });
  });

  it("joins multiple new comments in one write", () => {
    expect(
      parsePlanFeedback(
        body({
          slug: "flu-250",
          comments: [{ message: "a" }, { message: "b" }],
        }),
      ),
    ).toEqual({ slug: "flu-250", messages: ["a", "b"] });
  });

  it("skips updates/resolves/deletes (comments carrying an id)", () => {
    expect(
      parsePlanFeedback(
        body({
          slug: "flu-250",
          comments: [{ id: "c1", message: "resolved", status: "resolved" }],
          deletedCommentIds: ["c2"],
        }),
      ),
    ).toBeUndefined();
  });

  it("still picks the new comment out of a mixed add+update payload", () => {
    expect(
      parsePlanFeedback(
        body({
          slug: "flu-250",
          comments: [
            { id: "c1", message: "old" },
            { message: "new note" },
          ],
        }),
      ),
    ).toEqual({ slug: "flu-250", messages: ["new note"] });
  });

  it("ignores empty/whitespace-only messages", () => {
    expect(
      parsePlanFeedback(
        body({ slug: "flu-250", comments: [{ message: "   " }] }),
      ),
    ).toBeUndefined();
  });

  it("rejects unsafe or missing slugs and malformed bodies", () => {
    expect(
      parsePlanFeedback(body({ slug: "../etc", comments: [{ message: "x" }] })),
    ).toBeUndefined();
    expect(
      parsePlanFeedback(body({ comments: [{ message: "x" }] })),
    ).toBeUndefined();
    expect(parsePlanFeedback("not json")).toBeUndefined();
  });
});
