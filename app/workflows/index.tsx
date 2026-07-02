/**
 * The issue workflow — Slack thread → plan → human approval → implementation.
 *
 * Opt-in per thread: someone replies `@bot take this` under a bug report (the
 * Linear bot has already filed FLU-nnn and two-way synced the thread, so
 * everything we post here lands on the Linear issue as a comment for free).
 *
 *   1. PLAN     — a native session (OMNIGENT_PLAN_EXECUTOR, codex once its
 *                 login works) investigates the repo clones and streams a
 *                 short structured plan into the thread.
 *   2. APPROVE  — the plan gets an Approve / Request changes / Skip card.
 *                 "Request changes" arms the thread: the next `@bot <feedback>`
 *                 mention goes back to the SAME planning session (it keeps its
 *                 context) and a revised plan is posted with a fresh card.
 *   3. IMPLEMENT— on Approve, a worktree per affected repo is cut from
 *                 origin/dev on branch athena/<issue>, and an implementation
 *                 session (OMNIGENT_IMPL_EXECUTOR, claude) executes the
 *                 approved plan, pushes, opens the PR, and comments the link
 *                 on the Linear issue.
 *
 * Phases run through OmnigentNativeAgent via one-shot turn overrides
 * (`setTurnOverride`), so streaming, tool rows, and `stop` all work unchanged.
 */
import { Message, Header, Section, Context, Actions, Button } from "@copilotkit/bot-ui";
import type { InteractionContext } from "@copilotkit/bot-ui";
import {
  setTurnOverride,
  executorLabel,
  type Executor,
} from "../../omnigent/native-agent.js";
import { OMNIGENT_ROUTE } from "../agent-router.js";
import { getWorkflow, newWorkflow, putWorkflow, type Workflow } from "./state.js";
import {
  parseWorkflowTrigger,
  parseInvestigateTrigger,
  extractIssueId,
  parsePlanMeta,
} from "./detect.js";
import { ensureWorktree, listRepos, REPOS_DIR, WORKTREES_DIR, BASE_BRANCH } from "./git.js";
import {
  planningPrompt,
  revisionPrompt,
  implementPrompt,
  investigatePrompt,
} from "./prompts.js";
import { planViewUrl, PLANS_DIR } from "./planbridge.js";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Run the `wt` instance manager (infra/wt) and wait for it. Long timeout:
 * `create` includes dependency installs. stdout/err land in the bot log.
 */
const WT_BIN = fileURLToPath(new URL("../../infra/wt/wt", import.meta.url));
function runWt(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      WT_BIN,
      args,
      { encoding: "utf8", timeout: 25 * 60 * 1000, maxBuffer: 1 << 24 },
      (err, stdout, stderr) => {
        if (stdout) console.log(`[wt ${args[0]}] ${stdout.trim()}`);
        if (err) reject(new Error(`wt ${args.join(" ")}: ${stderr?.slice(-400) || err.message}`));
        else resolve();
      },
    );
  });
}

const PLAN_EXECUTOR = (): Executor =>
  (process.env["OMNIGENT_PLAN_EXECUTOR"] as Executor) || "claude";
const IMPL_EXECUTOR = (): Executor =>
  (process.env["OMNIGENT_IMPL_EXECUTOR"] as Executor) || "claude";
// Model per phase: planning/investigation/revision reason harder (opus),
// implementation is the long, mechanical phase (sonnet). Only applied when the
// phase executor is Claude; overridable via env.
const PLAN_MODEL = (): string => process.env["OMNIGENT_PLAN_MODEL"] || "opus";
const IMPL_MODEL = (): string => process.env["OMNIGENT_IMPL_MODEL"] || "sonnet";

/** Poll budgets (×0.8 s): planning ~24 min, investigation ~40, impl ~80. */
const PLAN_POLLS = 1800;
const INVESTIGATE_POLLS = 3000;
const IMPL_POLLS = 6000;

/**
 * The slice of the bot Thread the workflow needs. The public `Thread` type
 * omits `conversationKey`; everything else is on it — one structural cast at
 * the boundary keeps the rest typed.
 */
interface WfThread {
  conversationKey: string;
  post(ui: unknown): Promise<unknown>;
  postFile(file: {
    bytes: Uint8Array;
    filename: string;
    title?: string;
    altText?: string;
  }): Promise<{ ok: boolean; error?: string }>;
  runAgent(opts?: { context?: unknown[] }): Promise<unknown>;
  // Loosely typed on purpose: only `.text` is read here, and this keeps a real
  // rehydrated `Thread` (whose `getMessages` returns richer `ThreadMessage`s)
  // structurally assignable to `WfThread` for the plan-page feedback path.
  getMessages(): Promise<Array<{ text?: string }>>;
}
const wf = (thread: unknown): WfThread => thread as WfThread;

const stripMention = (text: string): string =>
  text.replace(/^\s*(?:<@[^>]+>|@\S+)\s*/i, "").trim();

/** Thread transcript texts, best-effort — [] on flat DMs or transient API failures. */
async function threadTexts(thread: WfThread): Promise<string[]> {
  try {
    return (await thread.getMessages()).map((m) => m.text ?? "");
  } catch {
    return [];
  }
}

/**
 * Flip an approved plan into `implementing` and kick off the long-running
 * implementation WITHOUT holding the caller (button dispatch / mention
 * handler). Refuses when the plan named no known repo — there's nothing to
 * cut a worktree from. Shared by the card's Approve button and text-form
 * approvals so both enforce the same guard.
 */
async function approvePlan(thread: WfThread, record: Workflow): Promise<boolean> {
  if (record.repos.length === 0) {
    await thread.post(
      "⚠️ The plan named no known repo (REPOS: line), so I can't cut a worktree. " +
        "Request changes and ask it to name the repo.",
    );
    return false;
  }
  record.state = "implementing";
  putWorkflow(record);
  void runImplementation(thread, record).catch((err) =>
    failImplementationSetup(thread, record, err),
  );
  return true;
}

/**
 * Workflow entry point, called from the mention handler AFTER control phrases.
 * Returns true when the mention belonged to the workflow (trigger or plan
 * feedback) and was fully handled here.
 */
export async function handleWorkflowMention(args: {
  thread: unknown;
  text: string;
}): Promise<boolean> {
  const thread = wf(args.thread);
  const ck = thread.conversationKey;
  const existing = getWorkflow(ck);
  const trigger = parseWorkflowTrigger(args.text);

  // Exploration/debugging mode — checked FIRST, even over a pending plan's
  // feedback branch: "investigate why X" while a plan awaits approval is a
  // question, not plan feedback. Read-only, no plan, no state machine — the
  // findings just stream into the thread from a separate session.
  const inv = parseInvestigateTrigger(args.text);
  if (inv) {
    await runInvestigation(thread, inv);
    return true;
  }

  // A mention while a plan is on the table = a decision or revision feedback.
  if (
    existing &&
    (existing.state === "awaiting_approval" || existing.state === "revising") &&
    !trigger
  ) {
    const t = stripMention(args.text).toLowerCase().replace(/[.!?\s]+$/, "");
    // Text-form decisions mirror the card buttons — people reply in words.
    if (/^(approve|approved|approve (the )?plan|lgtm|ship it|go ahead|yes)$/.test(t)) {
      if (existing.state !== "awaiting_approval") {
        await thread.post("No plan is awaiting approval right now.");
        return true;
      }
      if (await approvePlan(thread, existing)) {
        await thread.post(
          `✅ Plan approved — implementing *${existing.issue}* with ` +
            `*${executorLabel(IMPL_EXECUTOR())}* on \`${existing.branch}\`…`,
        );
      }
      return true;
    }
    if (/^(skip|reject|drop it|abandon)$/.test(t)) {
      existing.state = "skipped";
      putWorkflow(existing);
      await thread.post(`⏭️ Skipped *${existing.issue}*. Say \`take this\` to start over.`);
      return true;
    }
    await runRevision(thread, existing, stripMention(args.text));
    return true;
  }

  if (!trigger) return false;

  if (existing && (existing.state === "planning" || existing.state === "implementing")) {
    await thread.post(
      `⚙️ Already working on *${existing.issue}* (${existing.state.replace("_", " ")}). ` +
        "Say `stop` first if you want to restart.",
    );
    return true;
  }

  // Resolve the issue id: explicit in the trigger, else fish it out of the
  // thread (the Linear bot's "FLU-nnn … synced" reply).
  const texts = await threadTexts(thread);
  const issue = trigger.issue ?? extractIssueId(texts);
  if (!issue) {
    await thread.post(
      "I couldn't find a Linear issue in this thread. Say `@Athena take FLU-123` to name one.",
    );
    return true;
  }

  const repos = listRepos();
  if (repos.length === 0) {
    await thread.post(
      "⚠️ No repo clones found on the agent box — set OPENTAG_REPOS_DIR.",
    );
    return true;
  }

  const record = newWorkflow(ck, issue);
  await thread.post(
    `🔍 Taking *${issue}* — planning with *${executorLabel(PLAN_EXECUTOR())}* (${PLAN_MODEL()}). ` +
      "I'll post a plan here for approval before touching any code.",
  );

  const threadContext = texts.join("\n").slice(0, 4000);
  setTurnOverride(ck, {
    prompt: planningPrompt({ issue, repos, threadContext }),
    executor: PLAN_EXECUTOR(),
    model: PLAN_MODEL(),
    cwd: REPOS_DIR(),
    sessionTag: "plan",
    maxPolls: PLAN_POLLS,
    onDone: (r) => void onPlanDone(thread, ck, r),
  });
  await thread.runAgent({ context: [OMNIGENT_ROUTE] });
  return true;
}

/**
 * Read-only exploration/debugging session — the skills do the work
 * (runtime-session-investigation, fluso-browser-testing) and the findings
 * report streams straight into the thread. No plan, no approval card, no
 * worktree; runs in its own session pane so a pending plan is untouched.
 */
async function runInvestigation(
  thread: WfThread,
  inv: { issue?: string; brief: string },
): Promise<void> {
  const texts = await threadTexts(thread);
  const issue = inv.issue ?? extractIssueId(texts);
  await thread.post(
    `🔎 Investigating${issue ? ` *${issue}*` : ""} with ` +
      `*${executorLabel(PLAN_EXECUTOR())}* — read-only, findings land here (no plan, no code changes).`,
  );
  setTurnOverride(thread.conversationKey, {
    prompt: investigatePrompt({
      brief: inv.brief,
      issue,
      repos: listRepos(),
      threadContext: texts.join("\n").slice(0, 4000),
    }),
    executor: PLAN_EXECUTOR(),
    model: PLAN_MODEL(),
    cwd: REPOS_DIR(),
    sessionTag: "inv",
    maxPolls: INVESTIGATE_POLLS,
    onDone: (r) => {
      if (!r.ok || (!r.cancelled && !r.text.trim())) {
        void thread
          .post("⚠️ The investigation session died before reporting — try again.")
          .catch(() => {});
      }
    },
  });
  await thread.runAgent({ context: [OMNIGENT_ROUTE] });
}

/**
 * Re-plan with human feedback, in the SAME planning session (keeps context).
 * Exported so plan-page feedback (see workflows/feedback.ts) can drive the exact
 * same revision loop a Slack `@Athena <feedback>` mention does.
 */
export async function runRevision(
  thread: WfThread,
  record: Workflow,
  feedback: string,
): Promise<void> {
  if (!feedback) {
    await thread.post("Tell me what to change: `@Athena <your feedback>`.");
    return;
  }
  record.state = "planning";
  record.rounds += 1;
  putWorkflow(record);
  setTurnOverride(record.conversationKey, {
    prompt: revisionPrompt(feedback),
    executor: PLAN_EXECUTOR(),
    model: PLAN_MODEL(),
    cwd: REPOS_DIR(),
    sessionTag: "plan",
    maxPolls: PLAN_POLLS,
    onDone: (r) => void onPlanDone(thread, record.conversationKey, r),
  });
  await thread.runAgent({ context: [OMNIGENT_ROUTE] });
}

/** Planning turn settled — parse the plan header and post the approval card. */
async function onPlanDone(
  thread: WfThread,
  ck: string,
  r: { text: string; ok: boolean; cancelled: boolean },
): Promise<void> {
  const record = getWorkflow(ck);
  if (!record || record.state !== "planning") return;
  try {
    if (!r.ok || r.cancelled || !r.text.trim()) {
      record.state = "failed";
      putWorkflow(record);
      await thread.post(
        `⚠️ Planning for *${record.issue}* ${r.cancelled ? "was stopped" : "failed"}. ` +
          "Say `take this` to retry.",
      );
      return;
    }
    const meta = parsePlanMeta(r.text);
    const known = new Set(listRepos());
    record.repos = meta.repos.filter((x) => known.has(x));
    record.title = meta.title;
    record.planText = r.text;
    record.state = "awaiting_approval";
    putWorkflow(record);
    // One card: summary on top, the real Plan app page a click away. No inline
    // image — the self-hosted Plan app behind the tunnel IS the detailed view.
    await thread.post(<PlanApproval record={record} />);
  } catch (err) {
    console.error("[workflow] onPlanDone failed", err);
  }
}

/** First few summary bullets from the plan's short chat reply. */
function planBullets(planText: string | undefined, max = 3): string[] {
  if (!planText) return [];
  return planText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-•*]\s+/.test(l))
    .slice(0, max)
    .map((l) => "• " + l.replace(/^[-•*]\s+/, ""));
}

/**
 * The Approve / Request changes / Skip card under a freshly posted plan.
 *
 * Exported and registered with `createBot({ components })` so its button clicks
 * survive cold-path dispatch: a card posted from a rehydrated thread (plan-page
 * feedback path) lands in a separate ActionRegistry hot-cache, so the bot's own
 * registry can only re-derive the click handler by re-rendering this component
 * from the persisted `{component:"PlanApproval", props}` snapshot — which needs
 * it registered by name AND the ActionStore shared (see app/index.ts). As a
 * bonus this also makes the buttons durable across a bot restart.
 */
export function PlanApproval({ record }: { record: Workflow }) {
  const round = record.rounds > 0 ? ` (v${record.rounds + 1})` : "";
  const repos =
    record.repos.length > 0 ? record.repos.join(", ") : "⚠️ none parsed — approve will fail";
  const view = planViewUrl(record.issue.toLowerCase());
  const bullets = planBullets(record.planText);
  return (
    <Message accent="#E2B340">
      <Header>{`📋 Plan ready — ${record.issue}${round}`}</Header>
      <Section>
        {`*${record.title ?? "Untitled fix"}*` +
          (bullets.length > 0 ? `\n${bullets.join("\n")}` : "")}
      </Section>
      <Section>
        {(view ? `<${view}|🗺️ *Open the full visual plan* ↗>\n` : "") +
          `${repos} · branch \`${record.branch}\``}
      </Section>
      <Context>
        {"Approve to start implementation, or Request changes and reply `@Athena <feedback>`."}
      </Context>
      <Actions>
        <Button
          value={{ decision: "approve" }}
          style="primary"
          onClick={async (ctx: InteractionContext) => onApprove(ctx, record.conversationKey)}
        >
          ✅ Approve plan
        </Button>
        <Button
          value={{ decision: "revise" }}
          onClick={async (ctx: InteractionContext) => onRequestChanges(ctx, record.conversationKey)}
        >
          ✏️ Request changes
        </Button>
        <Button
          value={{ decision: "skip" }}
          style="danger"
          onClick={async (ctx: InteractionContext) => onSkip(ctx, record.conversationKey)}
        >
          ⏭️ Skip
        </Button>
      </Actions>
    </Message>
  );
}

async function onApprove(ctx: InteractionContext, ck: string): Promise<void> {
  const record = getWorkflow(ck);
  if (!record || record.state !== "awaiting_approval") return;
  if (!(await approvePlan(wf(ctx.thread), record))) return;
  await ctx.thread.update(
    ctx.message.ref,
    <Message accent="#27AE60">
      <Header>{`✅ Plan approved — ${record.issue}`}</Header>
      <Context>{`Implementing with ${executorLabel(IMPL_EXECUTOR())} on \`${record.branch}\`…`}</Context>
    </Message>,
  );
}

async function failImplementationSetup(
  thread: WfThread,
  record: Workflow,
  err: unknown,
): Promise<void> {
  console.error("[workflow] implementation setup failed", err);
  record.state = "failed";
  putWorkflow(record);
  await thread
    .post(`⚠️ Implementation setup for *${record.issue}* failed: ${String(err)}`)
    .catch(() => {});
}

async function runImplementation(thread: WfThread, record: Workflow): Promise<void> {
  // Provision the issue's instance now that the plan is approved: worktrees +
  // port block + rendered env + deps + branch-deploy hostnames, all through
  // `wt` (infra/wt) so it matches what humans get on the box. Falls back to
  // the bare worktree plumbing if wt can't run (e.g. no free slot) — the
  // implementation can still proceed, just without a runnable instance.
  const slug = record.issue.toLowerCase();
  // A frontend-only change (the plan's REPOS names just fluso-frontend) doesn't
  // need a local backend — run the FE against the DEPLOYED dev backend so we
  // don't spin up uvicorn/agents/postgres for a UI tweak.
  const feOnly = record.repos.length === 1 && record.repos[0] === "fluso-frontend";
  let instance:
    | { slug: string; feUrl: string; apiUrl: string; agentsUrl: string; feOnly: boolean }
    | undefined;
  try {
    await runWt(
      feOnly
        ? ["create", slug, "--issue", record.issue, "--branch", record.branch, "--fe-only"]
        : ["create", slug, "--issue", record.issue, "--branch", record.branch, "--repos", record.repos.join(",")],
    );
    const domain = process.env["OPENTAG_DEPLOY_DOMAIN"] ?? "local-pcci.org";
    instance = {
      slug,
      feUrl: `https://${slug}.${domain}`,
      apiUrl: `https://${slug}-api.${domain}`,
      agentsUrl: `https://${slug}-agents.${domain}`,
      feOnly,
    };
  } catch (err) {
    console.error(`[workflow] wt create failed for ${slug} — bare worktrees fallback`, err);
    for (const repo of record.repos) {
      await ensureWorktree(record.issue, repo);
    }
  }
  const multiRepo = record.repos.length > 1;
  record.worktreeCwd = multiRepo
    ? join(WORKTREES_DIR(), record.issue)
    : join(WORKTREES_DIR(), record.issue, record.repos[0]!);
  putWorkflow(record);

  // The approved plan the implementer follows: prefer the visual-plan MDX
  // artifact (the document the human actually reviewed), referenced by PATH —
  // inlining it once broke prompt injection (multi-KB keystroke paste). The
  // short chat summary is only the fallback when no artifact was written.
  let planPath: string | undefined = join(
    PLANS_DIR(),
    record.issue.toLowerCase(),
    "plan.mdx",
  );
  try {
    readFileSync(planPath, "utf8");
  } catch {
    planPath = undefined;
  }

  // Visual evidence for FE changes lands here (sibling of the worktrees, so
  // it can never end up in a commit); onImplementDone uploads what it finds.
  const screenshotsDir = join(WORKTREES_DIR(), record.issue, "screenshots");
  try {
    mkdirSync(screenshotsDir, { recursive: true });
  } catch {
    // the impl agent can create it itself if this races
  }

  setTurnOverride(record.conversationKey, {
    prompt: implementPrompt({
      issue: record.issue,
      title: record.title,
      branch: record.branch,
      repos: record.repos,
      multiRepo,
      planPath,
      plan: record.planText ?? "",
      screenshotsDir,
      instance,
    }),
    executor: IMPL_EXECUTOR(),
    model: IMPL_MODEL(),
    cwd: record.worktreeCwd,
    sessionTag: "impl",
    maxPolls: IMPL_POLLS,
    onDone: (r) => void onImplementDone(thread, record.conversationKey, r),
  });
  await thread.runAgent({ context: [OMNIGENT_ROUTE] });
}

async function onImplementDone(
  thread: WfThread,
  ck: string,
  r: { text: string; ok: boolean; cancelled: boolean },
): Promise<void> {
  const record = getWorkflow(ck);
  if (!record || record.state !== "implementing") return;
  try {
    const prUrls = [
      ...new Set(r.text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g) ?? []),
    ];
    if (!r.ok || r.cancelled || !r.text.trim()) {
      // Empty text = the turn never actually ran (e.g. prompt injection was
      // swallowed) — that's a failure, not a quiet success.
      record.state = "failed";
      putWorkflow(record);
      await thread.post(
        `⚠️ Implementation of *${record.issue}* ${r.cancelled ? "was stopped" : "failed"}` +
          `${!r.text.trim() && r.ok && !r.cancelled ? " (the session produced no output)" : ""}. ` +
          "The worktree is preserved — say `take this` to retry.",
      );
      return;
    }
    record.state = "done";
    putWorkflow(record);
    // Attach the before/after captures the implementer saved (FE mandate).
    try {
      const dir = join(WORKTREES_DIR(), record.issue, "screenshots");
      const shots = readdirSync(dir)
        .filter((f) => /\.(png|jpe?g|gif|webm|mp4)$/i.test(f))
        .sort()
        .slice(0, 8);
      for (const f of shots) {
        const up = await thread.postFile({
          bytes: readFileSync(join(dir, f)),
          filename: f,
          title: `${record.issue} · ${f.replace(/\.\w+$/, "")}`,
        });
        if (!up.ok) console.error(`[workflow] capture upload failed (${f}): ${up.error}`);
      }
    } catch {
      // no screenshots directory — non-FE change
    }
    // A no-PR finish is a WARNING only if a change was expected. When the
    // implementer legitimately found nothing to do (issue already shipped, no
    // diff vs base), that's a clean outcome — not a failure to surface as ⚠️.
    const noChangeNeeded =
      /\b(already (shipped|merged|implemented|done|resolved|fixed)|no (diff|delta|changes?|code changes?|action needed)|nothing to (commit|do|implement)|zero diff|duplicate pr)\b/i.test(
        r.text,
      );
    await thread.post(
      prUrls.length > 0
        ? `🎉 *${record.issue}* implemented — PR: ${prUrls.join(" · ")}`
        : noChangeNeeded
          ? `✅ *${record.issue}* — no code change needed (already resolved on \`${BASE_BRANCH()}\`). ` +
            `See the explanation above; nothing to open a PR for.`
          : `🏁 *${record.issue}* implementation finished, but I didn't spot a PR link in the ` +
            `reply — check the transcript above (branch \`${record.branch}\`).`,
    );
  } catch (err) {
    console.error("[workflow] onImplementDone failed", err);
  }
}

async function onRequestChanges(ctx: InteractionContext, ck: string): Promise<void> {
  const record = getWorkflow(ck);
  if (!record || record.state !== "awaiting_approval") return;
  record.state = "revising";
  putWorkflow(record);
  await ctx.thread.update(
    ctx.message.ref,
    <Message accent="#E2B340">
      <Header>{`✏️ Changes requested — ${record.issue}`}</Header>
      <Context>{"Reply `@Athena <what to change>` and I'll revise the plan."}</Context>
    </Message>,
  );
}

async function onSkip(ctx: InteractionContext, ck: string): Promise<void> {
  const record = getWorkflow(ck);
  if (!record) return;
  record.state = "skipped";
  putWorkflow(record);
  await ctx.thread.update(
    ctx.message.ref,
    <Message accent="#EB5757">
      <Header>{`⏭️ Skipped — ${record.issue}`}</Header>
      <Context>{"No changes were made. Say `take this` to start over."}</Context>
    </Message>,
  );
}
