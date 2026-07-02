/**
 * Issue-workflow state — one record per Slack thread that opted into the
 * plan → approve → implement pipeline (`@bot take this` in a bug thread).
 *
 * The state machine:
 *
 *   planning ──→ awaiting_approval ──(Approve)──→ implementing ──→ done
 *                   │        ↑                          │
 *          (Request changes) │                          └──→ failed
 *                   ↓        │
 *                revising ───┘ (feedback mention → new plan round)
 *
 * Records are persisted as one JSON file (OPENTAG_STATE_DIR, default
 * ~/.opentag) so an approval clicked after a bot restart still knows its
 * issue/plan/worktree. Terminal states (done/failed/skipped) stay on disk as
 * a cheap audit trail; a new trigger in the same thread overwrites them.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type WorkflowPhase =
  | "planning"
  | "awaiting_approval"
  | "revising"
  | "implementing"
  | "done"
  | "failed"
  | "skipped";

export interface Workflow {
  /** Linear issue identifier, e.g. "FLU-252". */
  issue: string;
  /** One-line fix title, parsed from the plan's TITLE: header. */
  title?: string;
  /** Bot-side conversation key `{channelId}::{threadTs}` — the home thread. */
  conversationKey: string;
  state: WorkflowPhase;
  /** Repos the plan says must change (validated against the local clones). */
  repos: string[];
  /** Feature branch used across all worktrees, e.g. "athena/flu-252". */
  branch: string;
  /** cwd for the implementation session (single worktree or their parent). */
  worktreeCwd?: string;
  /** The latest full plan text (round N). */
  planText?: string;
  /** Plan revision rounds so far (0 = first plan). */
  rounds: number;
  createdAt: string;
  updatedAt: string;
}

const STATE_DIR = () =>
  process.env["OPENTAG_STATE_DIR"] ?? join(homedir(), ".opentag");
const STATE_FILE = () => join(STATE_DIR(), "workflows.json");

const workflows = new Map<string, Workflow>();
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(STATE_FILE(), "utf8");
    const arr = JSON.parse(raw) as Workflow[];
    for (const w of arr) workflows.set(w.conversationKey, w);
  } catch {
    // first boot / no file yet
  }
}

function save(): void {
  try {
    mkdirSync(STATE_DIR(), { recursive: true });
    writeFileSync(
      STATE_FILE(),
      JSON.stringify([...workflows.values()], null, 2),
    );
  } catch (err) {
    console.error("[workflow] state save failed", err);
  }
}

export function getWorkflow(conversationKey: string): Workflow | undefined {
  load();
  return workflows.get(conversationKey);
}

/**
 * Find the workflow for a Linear issue (case-insensitive, e.g. plan-page slug
 * `flu-249` → issue `FLU-249`). Prefers a record with a plan actually on the
 * table — `awaiting_approval`/`revising`/`planning` — over terminal ones, and
 * breaks ties by most-recently updated, so plan-page feedback lands on the live
 * thread even if the same issue was taken more than once.
 */
export function findWorkflowByIssue(issue: string): Workflow | undefined {
  load();
  const want = issue.toLowerCase();
  const active = new Set<WorkflowPhase>([
    "awaiting_approval",
    "revising",
    "planning",
  ]);
  let best: Workflow | undefined;
  for (const w of workflows.values()) {
    if (w.issue.toLowerCase() !== want) continue;
    if (!best) {
      best = w;
      continue;
    }
    const bestActive = active.has(best.state);
    const wActive = active.has(w.state);
    if (wActive !== bestActive) {
      if (wActive) best = w;
    } else if (w.updatedAt > best.updatedAt) {
      best = w;
    }
  }
  return best;
}

/** Every persisted workflow record (for `@bot status` and the watchdog). */
export function allWorkflows(): Workflow[] {
  load();
  return [...workflows.values()];
}

export function putWorkflow(w: Workflow): Workflow {
  load();
  w.updatedAt = new Date().toISOString();
  workflows.set(w.conversationKey, w);
  save();
  return w;
}

export function newWorkflow(conversationKey: string, issue: string): Workflow {
  const now = new Date().toISOString();
  return putWorkflow({
    issue,
    conversationKey,
    state: "planning",
    repos: [],
    branch: `athena/${issue.toLowerCase()}`,
    rounds: 0,
    createdAt: now,
    updatedAt: now,
  });
}
