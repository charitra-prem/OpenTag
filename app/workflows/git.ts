/**
 * Git plumbing for the issue workflow: one worktree per (issue, repo), cut
 * from the repo's base branch (`dev` in both Fluso repos), all sharing the
 * issue's feature branch name. Worktrees keep parallel issues isolated — two
 * implementations never stomp on each other or on the main clones.
 *
 * Layout: ${OPENTAG_WORKTREES_DIR}/<ISSUE>/<repo>  (branch opentag/<issue>)
 * Clones: ${OPENTAG_REPOS_DIR}/<repo>              (never built in, only fetched)
 */
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export const REPOS_DIR = () =>
  process.env["OPENTAG_REPOS_DIR"] ?? "/home/omni/repos";
export const WORKTREES_DIR = () =>
  process.env["OPENTAG_WORKTREES_DIR"] ?? "/home/omni/worktrees";
export const BASE_BRANCH = () => process.env["OPENTAG_BASE_BRANCH"] ?? "dev";

function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { maxBuffer: 1 << 22 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]}: ${stderr || err.message}`));
        else resolve(stdout);
      },
    );
  });
}

/** The repos available to the planner = the clones present on disk. */
export function listRepos(): string[] {
  try {
    return readdirSync(REPOS_DIR(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(REPOS_DIR(), d.name, ".git")))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Ensure the worktree for (issue, repo) exists, bootstrapped, and return its
 * path. Reuses an existing worktree (revision rounds, retries) and an existing
 * branch; fresh ones are cut from up-to-date origin/<base>.
 */
export async function ensureWorktree(
  issue: string,
  repo: string,
): Promise<string> {
  const clone = join(REPOS_DIR(), repo);
  const path = join(WORKTREES_DIR(), issue, repo);
  if (existsSync(path)) return path;

  const branch = `athena/${issue.toLowerCase()}`;
  const base = BASE_BRANCH();
  await git(clone, "fetch", "origin", base);
  const existing = (await git(clone, "branch", "--list", branch)).trim();
  if (existing) {
    await git(clone, "worktree", "add", path, branch);
  } else {
    await git(clone, "worktree", "add", "-b", branch, path, `origin/${base}`);
  }
  await bootstrapWorktree(clone, path);
  return path;
}

/**
 * Make a fresh worktree RUNNABLE, not just readable:
 *
 *  1. Copy `.env*` files from the clone at the same relative paths — they're
 *     gitignored, so a worktree never gets them from git. Drop real env files
 *     into the clones ONCE and every issue worktree inherits them.
 *  2. Run the repo's own dependency install (pnpm / bun / npm by lockfile).
 *     NOT a node_modules symlink: pnpm workspaces link back to their package
 *     sources, so a symlinked node_modules would resolve imports to the
 *     CLONE's files instead of the worktree's edits. With warm pnpm/bun
 *     stores this is a fast hardlink pass, and it's always correct.
 *
 * Install failures are logged, not fatal — the implementation agent is told
 * it can rerun the install itself if the tree looks broken.
 */
async function bootstrapWorktree(clone: string, path: string): Promise<void> {
  for (const rel of findEnvFiles(clone)) {
    const dst = join(path, rel);
    try {
      if (!existsSync(dst)) {
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(join(clone, rel), dst);
      }
    } catch (err) {
      console.error(`[workflow] env copy failed for ${rel}`, err);
    }
  }

  const installer = existsSync(join(path, "pnpm-lock.yaml"))
    ? ["pnpm", "install", "--prefer-offline"]
    : existsSync(join(path, "bun.lock")) || existsSync(join(path, "bun.lockb"))
      ? ["bun", "install"]
      : existsSync(join(path, "package-lock.json"))
        ? ["npm", "install", "--prefer-offline"]
        : undefined;
  if (!installer) return;
  console.error(`[workflow] installing deps in ${path} (${installer[0]})`);
  await new Promise<void>((resolve) => {
    execFile(
      installer[0]!,
      installer.slice(1),
      {
        cwd: path,
        maxBuffer: 1 << 24,
        timeout: 15 * 60 * 1000,
        env: {
          ...process.env,
          PATH: `${process.env["HOME"]}/.local/bin:${process.env["HOME"]}/.bun/bin:${process.env["PATH"]}`,
        },
      },
      (err, _stdout, stderr) => {
        if (err) {
          console.error(
            `[workflow] deps install failed in ${path}: ${stderr?.slice(-500) || err.message}`,
          );
        }
        resolve();
      },
    );
  });
}

/** Relative paths of gitignored env files in the clone (depth ≤ 3). */
function findEnvFiles(root: string, dir = root, depth = 0): string[] {
  if (depth > 3) return [];
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...findEnvFiles(root, full, depth + 1));
    } else if (/^\.env(\..+)?$/.test(e.name) && !/example|sample|template/.test(e.name)) {
      out.push(relative(root, full));
    }
  }
  return out;
}
