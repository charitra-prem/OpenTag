/**
 * Prompt builders for the workflow phases. These are typed into a native
 * harness TUI (single line — the agent flattens newlines on injection), so
 * they're written to survive that: short labeled sections, no dependence on
 * layout.
 */
import { BASE_BRANCH, REPOS_DIR } from "./git.js";
import { PLANS_DIR } from "./planbridge.js";

export function planningPrompt(opts: {
  issue: string;
  repos: string[];
  threadContext?: string;
  /** Human constraint given with the trigger ("take this, fe fix only"). */
  brief?: string;
}): string {
  const { issue, repos, threadContext, brief } = opts;
  return [
    `You are the PLANNING phase of an automated issue workflow for Linear issue ${issue}.`,
    `Do NOT implement anything in this phase: no code edits in the repos, no commits — investigate and plan only.`,
    `If you have a Linear tool available, fetch ${issue} for the full description and comments.`,
    brief
      ? `The human gave a constraint when taking the issue: <<< ${brief} >>> — treat it as a HARD constraint on the plan's scope and approach (it also informs which repos your REPOS: line should name).`
      : "",
    threadContext
      ? `The Slack thread that reported it says: <<< ${threadContext} >>>`
      : "",
    `Candidate repositories (local clones under ${REPOS_DIR()}): ${repos.join(", ")}.`,
    `Read the relevant code so every step names real files.`,
    `Author the plan with your visual-plan skill in LOCAL-FILES privacy mode ` +
      `(AGENT_NATIVE_PLANS_MODE=local-files is set): write the MDX plan folder to ` +
      `${PLANS_DIR()}/${issue.toLowerCase()}/ — never into the repo clones. ` +
      `If the visual-plan skill is unavailable, skip the artifact and continue.`,
    `Then your final CHAT reply (posted to Slack next to the rendered visual plan, so do NOT repeat the full plan) must be EXACTLY —`,
    `first line: REPOS: <comma-separated subset of [${repos.join(", ")}] that must change>` +
      ` (list ONLY the repos that actually need edits — if it's a pure UI/display change, put just fluso-frontend, ` +
      `since a frontend-only issue runs against the deployed dev backend with no local backend spun up);`,
    `second line: TITLE: <one-line fix title>;`,
    `then 3-5 bullet lines summarizing the fix and the main risk;`,
    `last line: PLAN-FILE: <path to the plan.mdx you wrote, or "none">.`,
    `Keep the chat reply under 120 words.`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function investigatePrompt(opts: {
  brief: string;
  issue?: string;
  repos: string[];
  threadContext?: string;
}): string {
  const { brief, issue, repos, threadContext } = opts;
  return [
    `You are a READ-ONLY INVESTIGATION session — explore and debug, report findings.`,
    `Do NOT write a plan or plan artifact, do NOT modify the repos, no commits, no branches, no PRs.`,
    `The human asked you to investigate: <<< ${brief || "the problem described in this thread"} >>>`,
    issue
      ? `Related Linear issue: ${issue} — fetch it (and its comments) with your Linear tool if available.`
      : `If the thread names a Linear issue, fetch it with your Linear tool for context.`,
    threadContext ? `Thread context: <<< ${threadContext} >>>` : "",
    `Local repo clones (read them freely): ${repos.map((r) => `${REPOS_DIR()}/${r}`).join(", ")}.`,
    `USE YOUR SKILLS: runtime-session-investigation for hosted runtime/session/ECS/CloudWatch ` +
      `forensics (stay read-only per that skill); fluso-browser-testing to run the frontend ` +
      `locally and reproduce UI issues (screenshots welcome — save any to a /tmp path and ` +
      `mention them).`,
    `Your final reply is a findings report, structured as: WHAT'S HAPPENING (symptom, one line); ` +
      `EVIDENCE (files/log lines/commands, with paths); ROOT CAUSE (or ranked hypotheses if not ` +
      `conclusive); SUGGESTED NEXT STEP (a fix sketch or what data is still needed — remind the ` +
      `human they can say "take <issue>" to start the fix workflow). Keep it under 400 words.`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function revisionPrompt(feedback: string): string {
  return (
    `The human reviewed your plan and wants changes before approving: ` +
    `<<< ${feedback} >>> ` +
    `Revise the visual-plan MDX artifact in place (same local-files folder), then ` +
    `produce the REVISED chat reply in the SAME short format (REPOS: line, TITLE: line, ` +
    `3-5 summary bullets, PLAN-FILE: line, under 120 words — the rendered visual plan ` +
    `carries the detail). Still no implementation.`
  );
}

export function implementPrompt(opts: {
  issue: string;
  title?: string;
  branch: string;
  repos: string[];
  multiRepo: boolean;
  /**
   * Path to the human-approved plan.mdx on disk — referenced, NOT inlined:
   * the prompt is injected into a TUI as keystrokes, and a multi-KB MDX blob
   * doesn't survive that (FLU-248 got an empty turn exactly this way).
   */
  planPath?: string;
  /** Short chat-summary fallback when no plan artifact was written. */
  plan: string;
  /** Where before/after screenshots + recordings go (outside the repos). */
  screenshotsDir: string;
  /** Provisioned runnable instance (worktrees + ports + env + hostnames). */
  instance?: { slug: string; feUrl: string; apiUrl: string; agentsUrl: string; feOnly?: boolean };
}): string {
  const { issue, title, branch, repos, multiRepo, planPath, plan, screenshotsDir, instance } = opts;
  const base = BASE_BRANCH();
  const where = multiRepo
    ? `Your working directory contains one git worktree per repo (${repos.join(", ")}), each on branch ${branch} (based on origin/${base}).`
    : `You are in a git worktree of ${repos[0]} on branch ${branch} (based on origin/${base}).`;
  return [
    `You are the IMPLEMENTATION phase of an automated issue workflow for Linear issue ${issue}.`,
    `The plan below was approved by a human — implement it faithfully and stay within its scope.`,
    where,
    `Dependencies were installed and per-instance .env.local files were rendered during worktree setup; if the tree looks broken, rerun the repo's own install (pnpm/uv/bun) yourself — but NEVER edit ports or URLs in the env files, they are managed.`,
    instance && instance.feOnly
      ? `This is a FRONTEND-ONLY change, so NO local backend is needed — the instance ` +
        `runs the frontend against the DEPLOYED dev backend (its .env.local already points ` +
        `NEXT_PUBLIC_BACKEND_URL/BACKEND_URL at https://api.dev.khichdi.cc with matching dev ` +
        `Clerk keys). Do NOT start uvicorn/agents/postgres. Just \`wt start ${instance.slug}\` ` +
        `(builds + serves the frontend) → ${instance.feUrl}. Log in with the dev Clerk instance ` +
        `and screenshot there. \`wt status\` shows all instances; NEVER touch other instances' ` +
        `processes/ports or the legacy root deployments.`
      : instance
        ? `A runnable INSTANCE of the full stack is provisioned for this issue (slug "${instance.slug}"): ` +
          `bring it up with \`wt start ${instance.slug}\` (first start builds the frontend — a few minutes), ` +
          `then it serves ${instance.feUrl} (app), ${instance.apiUrl} (API), ${instance.agentsUrl} (agents). ` +
          `Use those URLs for browser testing and screenshots. \`wt status\` shows all instances; ` +
          `NEVER kill processes or reuse ports belonging to other instances or the legacy root deployments.`
        : `No runnable instance could be provisioned (no free slot) — you can still typecheck/build/test; do not start servers on arbitrary ports.`,
    `Verify your change compiles (typecheck/lint/build the touched package) before opening the PR.`,
    `If the change is FRONTEND/UI (anything a user can see), visual evidence is MANDATORY: ` +
      `use your fluso-browser-testing skill to run the app locally and capture clean BEFORE and ` +
      `AFTER screenshots of the affected UI (follow the skill's badge-suppression and screenshot ` +
      `workflow). Save them as PNGs named before-*.png / after-*.png in the SCREENSHOTS directory ` +
      `${screenshotsDir} (NOT inside the repo — never commit them); they get attached to the Slack thread ` +
      `automatically. Record a short screen capture (gif/webm, same directory) when the change ` +
      `involves interaction or motion a still image can't show. Mention in the PR body that ` +
      `before/after visuals are in the linked Slack thread and Linear issue. ` +
      `Use the runtime-session-investigation skill if you need to investigate live runtime behavior.`,
    `When the code is done: commit with clear messages referencing ${issue};`,
    `push with git push -u origin ${branch};`,
    `open a pull request with gh pr create --base ${base} --title "${issue}: ${title ?? "fix"}" and a body that summarizes the change and says it addresses ${issue}` +
      (multiRepo ? " (one PR per changed repo);" : ";"),
    `if you have a Linear tool available, comment the PR link on ${issue}.`,
    `Your FINAL message MUST include the PR URL(s).`,
    planPath
      ? `THE APPROVED PLAN is the visual-plan document at ${planPath} — READ IT FIRST and follow it faithfully.`
      : `APPROVED PLAN: <<< ${plan} >>>`,
  ].join(" ");
}
