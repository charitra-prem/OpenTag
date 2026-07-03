/**
 * OmnigentNativeAgent — an AG-UI agent backed by a *native* Claude Code terminal
 * session (the `claude-native-ui` harness) driven on your Claude subscription via
 * a real pty. No `claude -p`, no metered API.
 *
 * How it maps onto Omnigent (reusing Omnigent's own mechanisms):
 *   - Session: one persistent native Claude session per Slack thread, launched as
 *     `omnigent claude` inside a detached tmux pane (the pty the native TUI needs
 *     to stay alive). Reused across turns for context continuity.
 *   - Input: typed into the live TUI via `tmux send-keys` — the same terminal
 *     injection Omnigent's native executors use (`inject_user_message_via_tui`).
 *     (`POST /events` is queued but NOT consumed by the native TUI harness.)
 *   - Output: polled from `GET /v1/sessions/{id}/items` — assistant message text
 *     (top-level `content[].text`) plus inline markers for `function_call` items — and
 *     streamed into Slack as it grows. (The SSE stream doesn't flush text for the
 *     native TUI, so /items is the authoritative source; turn completion is judged
 *     from session status / pane activity / the TUI's working line, debounced —
 *     see the poll loop.)
 *
 * Permissions: launched with `--dangerously-skip-permissions` (allowed as the
 * non-root `omni` user) so Claude runs tools autonomously. The one-time bypass
 * warning is accepted at boot.
 *
 * Because this is a plain AG-UI `AbstractAgent`, OpenTag drives it in-process and
 * renders native Slack streaming + the "is thinking…" shimmer + tool rows for free.
 *
 * Env: OMNIGENT_URL (default http://127.0.0.1:6767), OMNIGENT_REPO (cwd),
 *      OMNIGENT_BIN (default "omnigent").
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AbstractAgent, EventType } from "@ag-ui/client";
import type {
  AgentConfig,
  BaseEvent,
  Message,
  RunAgentInput,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
} from "@ag-ui/client";
import type { AgentCapabilities } from "@ag-ui/core";
import { Observable } from "rxjs";

const OMNI = () =>
  (process.env["OMNIGENT_URL"] ?? "http://127.0.0.1:6767").replace(/\/$/, "");
/** cwd for plain-chat sessions (workflow phases override with a worktree). */
const REPO = () => process.env["OMNIGENT_REPO"] ?? `${HOME()}/repos`;
const BIN = () => process.env["OMNIGENT_BIN"] ?? "omnigent";
const HOME = () => process.env["HOME"] ?? "/home/omni";
const CHILD_PATH = () =>
  `${HOME()}/.local/bin:${HOME()}/.bun/bin:${process.env["PATH"] ?? ""}`;

// ---- Conversation keys, per platform -----------------------------------------
// Two key shapes flow through this file — the bot-side conversationKey and the
// agent-side stable thread key — and BOTH are platform-specific:
//
//   platform   bot conversationKey        agent stable key (stableKey(threadId))
//   slack      <channelId>::<scope>       slack-<channelId>-<scope>       (threadId minus per-turn uuid)
//   telegram   tg:<chatId>:<scope>        tg-thread-tg:<chatId>:<scope>   (threadId IS stable, no uuid)
//
// Telegram scopes can themselves contain colons (`topic:99`, `user:456`), so
// parse chatId as the segment between the first two colons and keep the rest.
// Every transform below goes through ONE parser pair so the bot side and the
// agent side can never disagree — a mismatch silently strands turn overrides,
// preambles, `stop`, and the share outbox for that platform.
interface ConvParts {
  platform: "slack" | "telegram";
  /** Slack channel id, or Telegram chat id. */
  channelId: string;
  scope: string;
}

/** Parse a bot-side conversationKey (either platform's shape). */
export function partsFromConversationKey(key: string): ConvParts {
  if (key.startsWith("tg:")) {
    const rest = key.slice(3);
    const i = rest.indexOf(":");
    return {
      platform: "telegram",
      channelId: i >= 0 ? rest.slice(0, i) : rest,
      scope: i >= 0 ? rest.slice(i + 1) : "",
    };
  }
  const i = key.indexOf("::");
  return {
    platform: "slack",
    channelId: i >= 0 ? key.slice(0, i) : key,
    scope: i >= 0 ? key.slice(i + 2) : "",
  };
}

/** Parse an agent-side stable thread key (either platform's shape). */
function partsFromStableKey(key: string): ConvParts {
  if (key.startsWith("tg-thread-")) {
    return partsFromConversationKey(key.slice("tg-thread-".length));
  }
  const m = key.match(/^slack-([^-]+)-(.*)$/);
  return m
    ? { platform: "slack", channelId: m[1] as string, scope: m[2] as string }
    : { platform: "slack", channelId: key, scope: "" };
}

/**
 * Canonical per-conversation key: the agent-side stable thread key the native
 * turn runs under. The bot side must pass its conversationKey through this to
 * land on the SAME string the agent derives from `stableKey(threadId)`.
 */
export const canonicalKey = (conversationKey: string): string => {
  const p = partsFromConversationKey(conversationKey);
  return p.platform === "telegram"
    ? `tg-thread-${conversationKey}`
    : `slack-${p.channelId}-${p.scope}`;
};

/** Inverse of {@link canonicalKey}: bot-side conversationKey from a stable key. */
export function conversationKeyOfStableKey(key: string): string {
  if (key.startsWith("tg-thread-")) return key.slice("tg-thread-".length);
  const p = partsFromStableKey(key);
  return `${p.channelId}::${p.scope}`;
}

/**
 * The per-conversation "outbox" directory. Any file the native agent drops here
 * is uploaded to the originating Slack thread after the turn (see the share
 * scan in app/index.ts). Exposed to the pane as `$ATHENA_SHARE_DIR`. `key` is
 * the canonical key — pass `canonicalKey(conversationKey)` from the bot side.
 */
export const shareDirFor = (key: string): string =>
  join(HOME(), ".opentag", "outbox", key.replace(/[^A-Za-z0-9_-]/g, "_"));

// ---- Executor: which native harness answers a thread ------------------------
// Each thread's turn runs on ONE harness binary in ONE tmux pane. `claude` and
// `codex` are separate `omnigent` subcommands (separate native TUIs). The house
// default is OMNIGENT_EXECUTOR; a per-turn directive overrides it.
export type Executor = "claude" | "codex";
const EXECUTORS: readonly Executor[] = ["claude", "codex"];
const DEFAULT_EXECUTOR = (): Executor => {
  const e = (process.env["OMNIGENT_EXECUTOR"] ?? "claude").toLowerCase();
  return (EXECUTORS as readonly string[]).includes(e) ? (e as Executor) : "claude";
};

/**
 * Auto-approval args to launch each harness with — they differ: Claude Code
 * uses `--dangerously-skip-permissions`, Codex uses
 * `--dangerously-bypass-approvals-and-sandbox`. Both skip every confirmation
 * prompt so the harness runs tools autonomously (we run as the non-root `omni`
 * user). Override per executor with OMNIGENT_CLAUDE_ARGS / OMNIGENT_CODEX_ARGS.
 */
const EXECUTOR_ARGS = (executor: Executor, model?: string): string => {
  const override = process.env[`OMNIGENT_${executor.toUpperCase()}_ARGS`];
  let args =
    override !== undefined
      ? override
      : executor === "codex"
        ? "--dangerously-bypass-approvals-and-sandbox"
        : "--dangerously-skip-permissions --model sonnet";
  // A phase can pin its own model (workflow: plan=opus, impl=sonnet). Only
  // Claude Code takes `--model <alias>`; strip any baked-in `--model` from the
  // base args and append the phase model so it wins. Codex model selection is
  // separate, so we leave codex args untouched.
  if (model && executor === "claude") {
    args = args.replace(/--model[= ]\S+/g, "").replace(/\s+/g, " ").trim();
    args += ` --model ${model}`;
  }
  return args;
};

/** Human-facing label for an executor. */
export const executorLabel = (e: Executor): string =>
  e === "codex" ? "Codex" : "Claude Code";

/**
 * Pull a leading model directive off a mention and return the cleaned text.
 * Recognizes `!codex …`, `/claude …`, `model: codex …` — optionally after a
 * leading Slack mention token (`<@U…>` / `@name`). The directive is stripped so
 * the harness never sees it; with no directive the text is returned untouched.
 */
export function parseExecutor(text: string): {
  executor?: Executor;
  text: string;
} {
  const stripped = text.replace(/^\s*(?:<@[^>]+>|@\S+)\s*/, "");
  const m = stripped.match(/^(?:!|\/|model\s*[:=]\s*)(claude|codex)\b[\s:,-]*/i);
  if (!m) return { text };
  return {
    executor: m[1]!.toLowerCase() as Executor,
    text: stripped.slice(m[0].length),
  };
}

// ---- Per-channel model preference -------------------------------------------
// A channel's default harness, set via `@bot use codex` / `/codex`. Persisted
// to ~/.opentag/channel-executors.json so a bot restart doesn't silently flip
// channels back to OMNIGENT_EXECUTOR. Per-turn inline directives (`!codex`)
// still override this for a single message.
const EXECUTORS_FILE = () =>
  join(
    process.env["OPENTAG_STATE_DIR"] ?? join(homedir(), ".opentag"),
    "channel-executors.json",
  );
const channelExecutor = new Map<string, Executor>(
  (() => {
    try {
      return Object.entries(
        JSON.parse(readFileSync(EXECUTORS_FILE(), "utf8")) as Record<string, Executor>,
      );
    } catch {
      return [];
    }
  })(),
);
export const setChannelExecutor = (channelId: string, e: Executor): void => {
  channelExecutor.set(channelId, e);
  try {
    mkdirSync(dirname(EXECUTORS_FILE()), { recursive: true });
    writeFileSync(EXECUTORS_FILE(), JSON.stringify(Object.fromEntries(channelExecutor), null, 2));
  } catch (err) {
    console.error("[omni] failed to persist channel executor", err);
  }
};
export const getChannelExecutor = (channelId: string): Executor | undefined =>
  channelExecutor.get(channelId);
/** The harness a channel uses when a turn carries no inline directive. */
export const effectiveExecutor = (channelId: string): Executor =>
  channelExecutor.get(channelId) ?? DEFAULT_EXECUTOR();

// ---- Per-channel Claude MODEL preference (opus/sonnet/haiku) -----------------
// `@bot use opus` pins the Claude Code model for NEW sessions in a channel
// (the model is a launch arg, so an existing thread pane keeps its model until
// its session ends). Only applies to the claude executor; workflow phases keep
// their own pins (plan=opus, impl=sonnet) and are NOT affected. Persisted like
// the executor choice so restarts don't flip channels back.
export const CLAUDE_MODELS = ["opus", "sonnet", "haiku"] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];
const MODELS_FILE = () =>
  join(
    process.env["OPENTAG_STATE_DIR"] ?? join(homedir(), ".opentag"),
    "channel-models.json",
  );
const channelModel = new Map<string, ClaudeModel>(
  (() => {
    try {
      return Object.entries(
        JSON.parse(readFileSync(MODELS_FILE(), "utf8")) as Record<string, ClaudeModel>,
      );
    } catch {
      return [];
    }
  })(),
);
export const setChannelModel = (channelId: string, m: ClaudeModel): void => {
  channelModel.set(channelId, m);
  try {
    mkdirSync(dirname(MODELS_FILE()), { recursive: true });
    writeFileSync(MODELS_FILE(), JSON.stringify(Object.fromEntries(channelModel), null, 2));
  } catch (err) {
    console.error("[omni] failed to persist channel model", err);
  }
};
export const getChannelModel = (channelId: string): ClaudeModel | undefined =>
  channelModel.get(channelId);

// ---- Control phrases (a mention that IS a command, not a task) --------------
export type Control =
  | { kind: "switch"; executor: Executor }
  | { kind: "switch-model"; model: ClaudeModel }
  | { kind: "help" }
  | { kind: "stop" }
  | { kind: "stop-all" }
  | { kind: "status" };

/**
 * Recognize a bare control phrase in a mention — `use codex`, `switch to claude`,
 * `help`, `stop`. Anchored to the WHOLE message (after stripping a leading
 * mention token) so real tasks like "use codex to fix the bug" are NOT hijacked
 * and fall through to the agent. Returns null when the text is a normal request.
 */
export function parseControl(text: string): Control | null {
  const t = text
    .replace(/^\s*(?:<@[^>]+>|@\S+)\s*/i, "")
    .trim()
    .toLowerCase()
    .replace(/[.!?\s]+$/, "");
  if (/^(help|commands|what can you do|\?)$/.test(t)) return { kind: "help" };
  if (/^(?:stop|cancel|abort)\s+(?:all|everything|everywhere)$/.test(t))
    return { kind: "stop-all" };
  if (/^(stop|cancel|abort)$/.test(t)) return { kind: "stop" };
  if (/^(status|health|what'?s running)$/.test(t)) return { kind: "status" };
  const m = t.match(
    /^(?:use|switch to|switch|set model to|model)\s+(claude(?:\s*code)?|codex)$/,
  );
  if (m) {
    return {
      kind: "switch",
      executor: m[1]!.startsWith("codex") ? "codex" : "claude",
    };
  }
  const mm = t.match(
    /^(?:use|switch to|switch|set model to|model)\s+(?:claude\s+)?(opus|sonnet|haiku)$/,
  );
  if (mm) return { kind: "switch-model", model: mm[1] as ClaudeModel };
  return null;
}

// ---- Turn overrides (workflow phases) ----------------------------------------
// The issue-workflow orchestrator (app/workflows) drives PHASES — plan, revise,
// implement — through this same agent so it inherits streaming, tool rows, and
// /stop for free. A phase is not "answer the user's text in the default repo":
// it has its own prompt, its own executor, its own working directory (a git
// worktree), and its own tmux pane. The orchestrator registers an override for
// the conversation right before calling `thread.runAgent(...)`; run() consumes
// it (one-shot) in place of the mention text.
export interface TurnOverride {
  /** Exact prompt to inject instead of the last user message. */
  prompt: string;
  /** Harness for this phase (plan may differ from implement). */
  executor?: Executor;
  /** Claude model for this phase's session (plan=opus, impl=sonnet). */
  model?: string;
  /** Working directory for the phase's session (e.g. an issue worktree). */
  cwd?: string;
  /**
   * Session namespace — phases get their OWN pane per thread (`plan`, `impl`)
   * so the planning context survives revision rounds and never mixes with the
   * thread's normal chat session.
   */
  sessionTag?: string;
  /** Poll budget for this turn (default 1800 ≈ 24 min; implement runs longer). */
  maxPolls?: number;
  /** Called once with the turn's full assistant text when the run settles. */
  onDone?: (result: { text: string; ok: boolean; cancelled: boolean }) => void;
  /**
   * RE-ATTACH to a turn already running in its pane (the bot restarted while
   * it worked): skip prompt injection, reuse the persisted item-id baseline,
   * and poll the surviving session to completion. Panes and omnigent sessions
   * outlive bot restarts — only this poll loop needs rebuilding.
   */
  reattach?: { conv: string; baseIds: string[] };
}
const turnOverrides = new Map<string, TurnOverride>();

// ---- Orphaned-turn ledger (deploys that don't kill work) ---------------------
// Every run persists {conv, baseline, launch params} to a small file for its
// lifetime. A bot restart mid-turn leaves the file behind; on boot the app
// reads them (takeOrphanedTurns) and re-attaches to the still-running panes so
// workflow phases finish, post their results, and advance their records —
// instead of freezing until someone says `stop`/`resume`.
export interface OrphanTurn {
  conversationKey: string;
  sessionTag?: string;
  conv: string;
  baseIds: string[];
  executor: Executor;
  model?: string;
  cwd?: string;
  maxPolls?: number;
  startedAt: number;
}
const ORPHANS_DIR = () =>
  join(process.env["OPENTAG_STATE_DIR"] ?? join(homedir(), ".opentag"), "active-turns");
const orphanFile = (key: string, tag?: string) =>
  join(ORPHANS_DIR(), `${key}__${tag ?? "chat"}`.replace(/[^A-Za-z0-9_.-]/g, "_") + ".json");
function writeOrphan(o: OrphanTurn, key: string): void {
  try {
    mkdirSync(ORPHANS_DIR(), { recursive: true });
    writeFileSync(orphanFile(key, o.sessionTag), JSON.stringify(o));
  } catch (err) {
    console.error("[omni] failed to persist active turn", err);
  }
}
function clearOrphan(key: string, tag?: string): void {
  try {
    rmSync(orphanFile(key, tag), { force: true });
  } catch {
    // best-effort; a stale file is re-claimed (and discarded) on next boot
  }
}
/**
 * Claim every persisted in-flight turn from a previous process: returns them
 * and DELETES the files, so a crash-looping bot can't re-attach twice.
 */
export function takeOrphanedTurns(): OrphanTurn[] {
  let names: string[];
  try {
    names = readdirSync(ORPHANS_DIR());
  } catch {
    return [];
  }
  const out: OrphanTurn[] = [];
  for (const n of names) {
    const full = join(ORPHANS_DIR(), n);
    try {
      out.push(JSON.parse(readFileSync(full, "utf8")) as OrphanTurn);
    } catch (err) {
      console.error(`[omni] unreadable active-turn file ${n}:`, err);
    }
    try {
      rmSync(full, { force: true });
    } catch {}
  }
  return out;
}
/**
 * Register a one-shot override for the NEXT run in a conversation.
 * `conversationKey` is the bot-side key; `canonicalKey` maps it 1:1 onto the
 * agent-side stable thread key the run looks the override up under.
 */
export function setTurnOverride(
  conversationKey: string,
  override: TurnOverride,
): void {
  turnOverrides.set(canonicalKey(conversationKey), override);
}

// ---- Turn preambles (per-thread context for plain chat) ----------------------
// A one-shot note the bot prepends to the NEXT plain-chat turn's injected text —
// used to pin a workflow thread's scope ("this thread is about FLU-254 …") so a
// vague follow-up like "fix ci comments" can't wander off to other issues' PRs.
// Ignored for workflow-phase overrides, whose prompts carry their own context.
const turnPreambles = new Map<string, string>();
export function setTurnPreamble(conversationKey: string, note: string): void {
  turnPreambles.set(canonicalKey(conversationKey), note);
}

// Omnigent session-level statuses: idle | launching | running | waiting | failed.
// `idle` = up/ready, `failed` = hard error, and `running` DOES track per-turn
// work on current omnigent (verified live 2026-07-02) — it's the primary
// working signal in the poll loop, with pane activity / WORKING_RE / item flow
// as fallbacks for older versions.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Session {
  tmux: string;
  conv: string;
  executor: Executor;
}
/**
 * One native session per (stable Slack-thread key, executor). Keying by executor
 * too means `claude` and `codex` each keep their OWN persistent pane + context in
 * a thread, so switching harness mid-thread never clobbers the other's history.
 */
const sessions = new Map<string, Session>();
/** Serialize bring-up per session key so concurrent turns don't double-launch. */
const booting = new Map<string, Promise<Session>>();
const sessKey = (key: string, executor: Executor, tag?: string) =>
  tag ? `${key}::${executor}::${tag}` : `${key}::${executor}`;

// ---- Active-run registry (external "stop") ----------------------------------
// `cancel()` ends our poll loop (the Slack stream finalizes with whatever
// landed) and interrupts the harness (Esc), leaving the session alive for the
// next turn. Keyed by the canonical per-thread id, but each handle also carries
// its channelId: Slack slash commands are channel- (not thread-) scoped, so
// `/stop` can only target a channel — it stops every run in that channel.
interface RunHandle {
  channelId: string;
  cancel: () => void;
}
const activeRuns = new Map<string, RunHandle>();

/** Canonical per-thread key from the agent's `input.threadId`. */
function convId(threadId: string): string {
  return stableKey(threadId);
}
/** Channel/chat id out of an AG-UI threadId (either platform's shape). */
function channelOf(threadId: string): string {
  return partsFromStableKey(stableKey(threadId)).channelId;
}
/** Channel/chat id out of a bot `thread.conversationKey` (either platform). */
export function channelIdFromConversationKey(conversationKey: string): string {
  return partsFromConversationKey(conversationKey).channelId;
}
/**
 * Interrupt every in-flight turn in a channel: closes their Slack streams and
 * sends Esc to each harness (sessions stay alive). Returns how many were stopped.
 * This is the `stop all` / slash-command scope — a plain `stop` in a thread
 * must use `stopConversation` so it never kills work in OTHER threads.
 */
export function stopChannel(channelId: string): number {
  let n = 0;
  for (const [k, h] of activeRuns) {
    if (h.channelId === channelId) {
      h.cancel();
      activeRuns.delete(k);
      n++;
    }
  }
  return n;
}

/**
 * Interrupt only the in-flight turn(s) of ONE conversation (thread/chat).
 * `activeRuns` is keyed by the agent-side stable thread key, which is exactly
 * `canonicalKey(conversationKey)` — the same string `convId` derives per run.
 */
export function stopConversation(conversationKey: string): number {
  const target = canonicalKey(conversationKey);
  const h = activeRuns.get(target);
  if (!h) return 0;
  h.cancel();
  activeRuns.delete(target);
  return 1;
}

/** Run a command, resolving stdout (rejects only on spawn ENOENT). */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { env: { ...process.env, PATH: CHILD_PATH() }, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") reject(err);
        else resolve(stdout ?? "");
      },
    );
  });
}
const tmux = (...args: string[]) => run("tmux", args);
const CONV_RE = /conv_[0-9a-f]+/;

async function tmuxHasSession(name: string): Promise<boolean> {
  const list = await tmux("list-sessions", "-F", "#{session_name}").catch(
    () => "",
  );
  return list.split("\n").some((l) => l.trim() === name);
}
async function capture(name: string): Promise<string> {
  return tmux("capture-pane", "-t", name, "-p", "-S", "-200").catch(() => "");
}
async function statusOf(conv: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${OMNI()}/v1/sessions/${conv}`);
    if (!res.ok) return undefined;
    return ((await res.json()) as { status?: string }).status;
  } catch {
    return undefined;
  }
}

/**
 * A session is reusable only while it's alive. `statusOf` returns the session
 * enum (idle | launching | running | waiting | failed) or undefined when the
 * session API can't be reached. A hard-`failed` session — or one that's gone —
 * must NOT be reused: its tmux pane is dead, so the next turn would inject into
 * a corpse and hang. (The original guard reused on any truthy status, and
 * "failed" is truthy.)
 */
const isLive = (st: string | undefined): boolean =>
  st !== undefined && st !== "failed";

/**
 * Stable session key for a thread. The Slack store mints a fresh AG-UI
 * threadId per turn (`slack-{channel}-{scope}-{uuid}`); we strip the trailing
 * UUID so every turn in the same thread maps to ONE native Claude session.
 * Telegram threadIds (`tg-thread-tg:{chat}:{scope}`) are already stable and
 * carry no UUID, so they pass through unchanged.
 * (Exported for the key-consistency tests — bot side and agent side meeting on
 * the same string is exactly what stop/overrides/outbox depend on.)
 */
export function stableKey(threadId: string): string {
  return threadId.replace(
    /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "",
  );
}
function tmuxName(key: string): string {
  const safe = "og_" + key.replace(/[^A-Za-z0-9]/g, "_");
  if (safe.length <= 60) return safe;
  // Too long to keep verbatim: a blind slice used to drop the trailing session
  // tag (`::plan` / `::impl`), which would alias different sessions onto ONE
  // pane. Keep a readable prefix and disambiguate with a hash of the full key.
  let h = 0;
  for (let i = 0; i < safe.length; i++) h = (h * 31 + safe.charCodeAt(i)) >>> 0;
  return `${safe.slice(0, 52)}_${h.toString(36)}`;
}

/** Get or start the persistent native session for a (thread, executor[, tag]). */
async function ensureSession(
  key: string,
  executor: Executor,
  opts?: { cwd?: string; tag?: string; model?: string },
): Promise<Session> {
  const sk = sessKey(key, executor, opts?.tag);
  const cached = sessions.get(sk);
  if (cached && isLive(await statusOf(cached.conv))) return cached;

  const inflight = booting.get(sk);
  if (inflight) return inflight;

  const p = (async (): Promise<Session> => {
    const name = tmuxName(sk);

    if (await tmuxHasSession(name)) {
      const conv = (await capture(name)).match(CONV_RE)?.[0];
      if (conv && isLive(await statusOf(conv))) {
        const s = { tmux: name, conv, executor };
        sessions.set(sk, s);
        return s;
      }
      await tmux("kill-session", "-t", name).catch(() => {});
    }

    // Per-conversation outbox the pane can drop files into (`$ATHENA_SHARE_DIR`);
    // the bot uploads whatever lands there to the thread after the turn.
    const shareDir = shareDirFor(key);
    try {
      mkdirSync(shareDir, { recursive: true });
    } catch {
      // best-effort; the bot's post-turn scan also tolerates a missing dir
    }

    await tmux("new-session", "-d", "-s", name, "-x", "220", "-y", "50");
    await tmux(
      "send-keys",
      "-t",
      name,
      "-l",
      "--",
      // AGENT_NATIVE_PLANS_MODE keeps the visual-plan/visual-recap skills in
      // local-files privacy mode: plan MDX stays on this box, nothing is
      // published to the hosted Plan service. Only those skills read it.
      // `--server ${OMNI()}` pins this TUI to the shared Omnigent server the
      // bot polls. Without it, `omnigent claude/codex` auto-spawns its OWN
      // ephemeral server on a random port, so its conversation never appears
      // at OMNIGENT_URL and every turn times out with "session did not come up
      // in time". (Regressed when the server moved under systemd and the old
      // pidfile auto-discovery broke.)
      `export PATH=${CHILD_PATH()} AGENT_NATIVE_PLANS_MODE=local-files ATHENA_SHARE_DIR=${shareDir}; cd ${opts?.cwd ?? REPO()}; ${BIN()} ${executor} --server ${OMNI()} ${EXECUTOR_ARGS(executor, opts?.model)}`,
    );
    await tmux("send-keys", "-t", name, "Enter");

    let conv: string | undefined;
    let acceptedBypass = false;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      const pane = await capture(name);
      // One-time gates: trust-this-folder, then the bypass-permissions warning.
      if (/do you trust the files|trust this folder/i.test(pane)) {
        await tmux("send-keys", "-t", name, "Enter");
        continue;
      }
      if (/Yes, I accept/i.test(pane)) {
        // Highlight "Yes, I accept" once (Down from the default "No"), then
        // confirm with Enter. We re-Enter on EVERY poll the warning is still
        // up: a single dropped keystroke used to leave the session stuck on the
        // warning forever (it booted to `failed`). Selection stays on "Yes" so
        // repeated Enter is safe — the prompt clears the moment one lands.
        if (!acceptedBypass) {
          await tmux("send-keys", "-t", name, "Down");
          acceptedBypass = true;
        }
        await sleep(300);
        await tmux("send-keys", "-t", name, "Enter");
        continue;
      }
      conv = conv ?? pane.match(CONV_RE)?.[0];
      if (conv && !/Yes, I accept/i.test(pane)) {
        const st = await statusOf(conv);
        if (st === "idle") break; // session up and ready for input
        if (st === "failed")
          throw new Error("Native Claude session failed to start");
      }
    }
    if (!conv) throw new Error("Native session did not come up in time");

    const s = { tmux: name, conv, executor };
    sessions.set(sk, s);
    return s;
  })();

  booting.set(sk, p);
  try {
    return await p;
  } finally {
    booting.delete(sk);
  }
}

/** Type a user message into the live Claude TUI and submit it. */
async function sendToTmux(name: string, text: string): Promise<void> {
  const oneLine = text.replace(/\r?\n+/g, " ").trim();
  await tmux("send-keys", "-t", name, "-l", "--", oneLine);
  await sleep(500);
  await tmux("send-keys", "-t", name, "Enter");
}

/** Latest user message text from the AG-UI run input. */
function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const c = m.content as unknown;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c
        .map((p) =>
          p && typeof p === "object"
            ? String((p as Record<string, unknown>)["text"] ?? "")
            : "",
        )
        .join("");
    }
  }
  return "";
}

// The TUI prints a working line while a turn runs; its absence is the
// turn-complete signal a human reads off the screen. The wording varies by
// harness AND version — older Claude Code: "✻ Baking… (esc to interrupt)";
// newer: "* Channeling… (15s · ↓ 523 tokens)" (no "esc to" at all!); codex:
// "Working (3s · esc to interrupt)". Match the stable shapes: the "esc to"
// hint when present, else a spinner verb with an elapsed-seconds counter.
const WORKING_RE = /esc to interrupt|esc to cancel|\w+…\s*\(\d+s\b/i;

/** Fetch the session's items (newest first); [] on any error. */
async function fetchItems(conv: string): Promise<Array<Record<string, unknown>>> {
  try {
    // Fetch the most-recent 80 (order=desc → newest first), then reverse to
    // CHRONOLOGICAL order. Items carry no usable `created_at` (it's null), so the
    // API's ordering is the only reliable sequence — reversing desc gives us the
    // oldest-first order the renderer needs, while still bounding to recent items
    // for long-lived (reused) sessions.
    const res = await fetch(
      `${OMNI()}/v1/sessions/${conv}/items?limit=80&order=desc`,
    );
    if (!res.ok) return [];
    const data =
      ((await res.json()) as { data?: Array<Record<string, unknown>> }).data ??
      [];
    return data.reverse();
  } catch {
    return [];
  }
}

/** The set of item ids present right now — baseline so we only stream THIS turn. */
async function existingItemIds(conv: string): Promise<Set<string>> {
  return new Set((await fetchItems(conv)).map((it) => String(it["id"] ?? "")));
}

/** Join the `.text` of an item's heterogeneous content blocks. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((x) =>
      x && typeof x === "object"
        ? String((x as Record<string, unknown>)["text"] ?? "")
        : "",
    )
    .join("");
}

/** Field of an item, reading the flat top-level shape with a `data` fallback. */
function itemField(it: Record<string, unknown>, key: string): unknown {
  const data = (it["data"] ?? {}) as Record<string, unknown>;
  return it[key] ?? data[key];
}

// Internal harness mechanics that are noise to a Slack observer — never rendered
// as tool-status rows. Claude Code's `ToolSearch` is its own deferred-tool
// lookup; surfacing "Used `ToolSearch`" just clutters the thread.
const NOISE_TOOLS = new Set(["toolsearch"]);
const isNoiseTool = (name: string): boolean =>
  NOISE_TOOLS.has(name.toLowerCase().replace(/[^a-z0-9]/g, ""));

/**
 * Turns the growing /items list into a live AG-UI event stream — shaped for a
 * CHAT platform, not a terminal transcript. A native harness turn produces a
 * run of interim narration blocks ("Let me read X…", "Confirmed, now Y…")
 * between tool calls, and posting each one as its own Slack message buried
 * real messages under a notification storm. So:
 *
 *   - Tool calls stream as `TOOL_CALL_START → ARGS → END` (unchanged) — the
 *     adapter folds them into ONE collapsible status message that edits in
 *     place ("⚙️ N steps · …").
 *   - Interim narration (an assistant message with a LATER tool call after it)
 *     is emitted as a synthetic `note` tool row, so it lands inside that same
 *     self-editing status card instead of a new message.
 *   - The turn's REAL reply — the trailing prose after the last tool call — is
 *     the only TEXT_MESSAGE emitted, at `finalize()`. One notification per
 *     turn, carrying the thing the human actually needs to read (answer,
 *     question, plan).
 *
 * `text` still accumulates EVERY assistant character (workflow onDone parsing
 * and the poll loop's activity gate depend on it). Call `sync(freshItems)`
 * each poll (idempotent); `finalize()` once before RUN_FINISHED.
 */
function makeTurnStreamer(emit: (e: BaseEvent) => void) {
  const msgState = new Map<string, { len: number; noted: boolean }>();
  const toolState = new Map<string, { ended: boolean }>();
  let lastFresh: Array<Record<string, unknown>> = []; // latest full window
  let chars = 0; // total assistant text chars seen (activity gate)
  let fullText = ""; // the turn's full assistant prose (for workflow onDone)
  let endsOnTool = false; // last meaningful item is a tool call → prose pending

  /** Emit one interim narration block as a `note` row in the status card. */
  const emitNote = (id: string, txt: string) => {
    const tcId = `note_${id}`;
    emit({
      type: EventType.TOOL_CALL_START,
      toolCallId: tcId,
      toolCallName: "note",
    } as ToolCallStartEvent);
    emit({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: tcId,
      delta: JSON.stringify({ text: txt }),
    } as ToolCallArgsEvent);
    emit({ type: EventType.TOOL_CALL_END, toolCallId: tcId } as ToolCallEndEvent);
  };

  const sync = (fresh: Array<Record<string, unknown>>) => {
    lastFresh = fresh;
    // Tool call_ids that already have a result item → the call has finished.
    const doneCalls = new Set<string>();
    for (const it of fresh) {
      if (it["type"] === "function_call_output") {
        const cid = itemField(it, "call_id");
        if (cid != null) doneCalls.add(String(cid));
      }
    }
    // Anything before this index is settled interim work; assistant prose at
    // or after it might still be the turn's final reply, so it stays buffered
    // until the next tool call proves it interim — or finalize() ships it.
    const lastToolIdx = fresh.reduce(
      (acc, it, idx) => (it["type"] === "function_call" ? idx : acc),
      -1,
    );
    let lastKind: "msg" | "tool" | undefined;
    fresh.forEach((it, idx) => {
      const id = String(it["id"] ?? "");
      const type = it["type"];
      const status = String(itemField(it, "status") ?? "");
      if (type === "message" && itemField(it, "role") === "assistant") {
        const txt = contentText(itemField(it, "content"));
        let st = msgState.get(id);
        if (!st) {
          st = { len: 0, noted: false };
          msgState.set(id, st);
          if (fullText) fullText += "\n\n"; // message boundary in the transcript
        }
        if (txt.length > st.len) {
          fullText += txt.slice(st.len);
          chars += txt.length - st.len;
          st.len = txt.length;
        }
        if (!st.noted && idx < lastToolIdx) {
          // A later tool call exists → this block is interim narration.
          emitNote(id, txt);
          st.noted = true;
        }
        lastKind = "msg";
      } else if (type === "function_call") {
        const name = String(itemField(it, "name") ?? "tool");
        // Skip internal harness mechanics (e.g. ToolSearch) — not a real tool
        // call the user cares about, and rendering it as a row looks broken.
        if (isNoiseTool(name)) return;
        const cid = String(itemField(it, "call_id") ?? id);
        let st = toolState.get(id);
        if (!st) {
          st = { ended: false };
          toolState.set(id, st);
          emit({
            type: EventType.TOOL_CALL_START,
            toolCallId: id,
            toolCallName: name,
          } as ToolCallStartEvent);
          const args = itemField(it, "arguments");
          const argStr =
            typeof args === "string"
              ? args
              : args != null
                ? JSON.stringify(args)
                : "";
          if (argStr)
            emit({
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: id,
              delta: argStr,
            } as ToolCallArgsEvent);
        }
        const isLast = idx === fresh.length - 1;
        if (!st.ended && (status === "completed" || doneCalls.has(cid) || !isLast)) {
          emit({
            type: EventType.TOOL_CALL_END,
            toolCallId: id,
          } as ToolCallEndEvent);
          st.ended = true;
        }
        lastKind = "tool";
      }
      // resource_event / function_call_output / user messages: not rendered.
    });
    endsOnTool = lastKind === "tool";
  };

  const finalize = () => {
    for (const [id, st] of toolState) {
      if (!st.ended) {
        emit({
          type: EventType.TOOL_CALL_END,
          toolCallId: id,
        } as ToolCallEndEvent);
        st.ended = true;
      }
    }
    // The turn's one real message: every assistant block after the last tool
    // call, joined. A turn that ended ON a tool call (no trailing prose) falls
    // back to its last narration block so the thread never ends on silence.
    const lastToolIdx = lastFresh.reduce(
      (acc, it, idx) => (it["type"] === "function_call" ? idx : acc),
      -1,
    );
    const msgs = lastFresh
      .map((it, idx) => ({ it, idx }))
      .filter(
        ({ it }) =>
          it["type"] === "message" && itemField(it, "role") === "assistant",
      );
    const tail = msgs
      .filter(({ idx }) => idx > lastToolIdx)
      .map(({ it }) => contentText(itemField(it, "content")).trim())
      .filter(Boolean);
    const finalText =
      tail.length > 0
        ? tail.join("\n\n")
        : (msgs
            .map(({ it }) => contentText(itemField(it, "content")).trim())
            .filter(Boolean)
            .pop() ?? "");
    if (finalText) {
      const mid = globalThis.crypto.randomUUID();
      emit({
        type: EventType.TEXT_MESSAGE_START,
        role: "assistant",
        messageId: mid,
      } as TextMessageStartEvent);
      emit({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: mid,
        delta: finalText,
      } as TextMessageContentEvent);
      emit({
        type: EventType.TEXT_MESSAGE_END,
        messageId: mid,
      } as TextMessageEndEvent);
    }
  };

  return {
    sync,
    finalize,
    get chars() {
      return chars;
    },
    get text() {
      return fullText;
    },
    get endsOnTool() {
      return endsOnTool;
    },
  };
}

export class OmnigentNativeAgent extends AbstractAgent {
  constructor(config?: AgentConfig) {
    super(config);
  }

  override async getCapabilities(): Promise<AgentCapabilities> {
    return {
      tools: { supported: true, clientProvided: false },
      transport: { streaming: true },
      humanInTheLoop: { interrupts: false },
    };
  }

  override run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      let cancelled = false;
      let paneName: string | undefined; // set once the session's pane is known

      // Register this turn so an external `/stop` can end it: drop out of the
      // poll loop AND interrupt the harness (Esc) without killing the session.
      const cKey = convId(input.threadId);
      const channelId = channelOf(input.threadId);
      const handle: RunHandle = {
        channelId,
        cancel: () => {
          cancelled = true;
          if (paneName)
            void tmux("send-keys", "-t", paneName, "Escape").catch(() => {});
        },
      };
      activeRuns.set(cKey, handle);
      const unregister = () => {
        if (activeRuns.get(cKey) === handle) activeRuns.delete(cKey);
      };

      const emit = (e: BaseEvent) => subscriber.next(e);
      const runStarted: RunStartedEvent = {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      };
      const runFinished: RunFinishedEvent = {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      };

      (async () => {
        emit(runStarted);
        const key = stableKey(input.threadId);
        // A workflow phase override is one-shot: claim it up front so a failed
        // phase never leaks its prompt into the thread's next normal mention.
        const override = turnOverrides.get(key);
        if (override) turnOverrides.delete(key);
        try {
          // Split off any leading model directive (`!codex …`) from the prose.
          // Inline directive wins; else the channel's default; else the env.
          // A workflow override trumps everything: its phase prompt + executor.
          const parsed = parseExecutor(lastUserText(input.messages));
          const text = override ? override.prompt : parsed.text;
          // The file-share outbox path can't reach the agent via env (omnigent
          // scrubs the child env to a fixed allowlist), so hand it over inside
          // the turn text. This is invisible in Slack — the injected user
          // message is filtered out of the reply stream. Only for plain chat;
          // workflow override prompts carry their own screenshot mechanism.
          const preamble = turnPreambles.get(key);
          if (preamble) turnPreambles.delete(key);
          const submitText = override
            ? text
            : `[Athena] To hand a file to the user (screenshot, log, artifact), save it into ${shareDirFor(key)} — everything left there is auto-uploaded to this chat thread when your turn ends; a path pasted in prose is NOT delivered. ${preamble ? `${preamble} ` : ""}The user's message: ${text}`;
          const executor =
            override?.executor ??
            parsed.executor ??
            effectiveExecutor(channelId);
          if (!text.trim() && !override?.reattach) {
            unregister();
            emit(runFinished);
            subscriber.complete();
            return;
          }

          console.error(
            `[omni] run start thread=${key} exec=${executor}` +
              `${override?.sessionTag ? ` phase=${override.sessionTag}` : ""} runId=${input.runId}`,
          );
          // Model precedence: workflow phase pin > channel preference (claude
          // only — codex model selection is separate) > the launch-arg default.
          const model =
            override?.model ??
            (executor === "claude" ? getChannelModel(channelId) : undefined);
          const { tmux: name, conv } = await ensureSession(key, executor, {
            cwd: override?.cwd,
            tag: override?.sessionTag,
            model,
          });
          paneName = name; // now `/stop` can interrupt the live pane
          console.error(`[omni] session ready conv=${conv} exec=${executor}`);

          // Reconstruct the turn as interleaved AG-UI text + tool-call events.
          const streamer = makeTurnStreamer(emit);
          const freshItems = async () =>
            (await fetchItems(conv)).filter(
              (it) => !baseIds.has(String(it["id"] ?? "")),
            );

          // Baseline the items already present, then submit the turn. We poll
          // /items for the growing reply (the native TUI doesn't stream text over
          // SSE) and watch the TUI's "working" indicator for completion (its
          // session status doesn't track per-turn work).
          //
          // RE-ATTACH: the turn was already submitted by a previous process —
          // reuse ITS persisted baseline (a fresh one would swallow everything
          // the turn produced before the restart) and don't type anything.
          const reattach = override?.reattach;
          const baseIds = reattach
            ? new Set(reattach.baseIds)
            : await existingItemIds(conv);
          if (!reattach) await sendToTmux(name, submitText);
          // Persist this turn for the lifetime of the run: if the bot restarts
          // before completion, boot recovery re-attaches to the pane from this
          // file instead of leaving the thread frozen. Cleared on completion.
          writeOrphan(
            {
              conversationKey: conversationKeyOfStableKey(key),
              sessionTag: override?.sessionTag,
              conv,
              baseIds: [...baseIds],
              executor,
              model,
              cwd: override?.cwd,
              maxPolls: override?.maxPolls,
              startedAt: Date.now(),
            },
            key,
          );
          // Seed the pane-activity baseline AFTER injecting, so our own
          // keystroke repaint doesn't read as the harness working — a dropped
          // injection must still look dead to the re-injection logic below.
          const seedActivity = (
            await tmux("display", "-p", "-t", name, "#{window_activity}")
          )
            .trim();

          // Quiet polls (no activity on ANY signal) needed to call the turn
          // done. Debounced past the brief idle→running flap the session status
          // shows right after a reply (suggestion generation); much longer when
          // the turn currently ends on a tool call — a long build/test can hold
          // the turn with no new output for a while.
          const QUIET_DONE = 5; // ~4s
          const QUIET_TOOL_GRACE = 38; // ~30s

          // Re-attached turns are presumed mid-work (started), and must never
          // re-inject: their submit text belongs to the previous process.
          let started = Boolean(reattach); // saw the TUI working, or items flowing
          let quiet = 0; // consecutive polls with no sign of activity
          let polls = 0;
          let lastItemCount = 0; // item-flow activity (belt to WORKING_RE's braces:
          let lastChars = 0; //     a TUI wording change must not end turns early)
          let lastActivity = seedActivity; // tmux #{window_activity} — frozen ⇔ pane quiet
          let exitReason = "budget"; // why the poll loop ended (for diagnosis)
          const MAX_INJECTS = 3;
          let injects = reattach ? MAX_INJECTS : 1; // sendToTmux already fired once above
          const NEVER_STARTED_GIVEUP = 45; // ~36s of total silence → bail
          const budget = override?.maxPolls ?? 1800;
          for (let i = 0; i < budget && !cancelled; i++) {
            polls = i;
            await sleep(800);

            // Emit any new text/tool events produced since the last poll.
            const fresh = await freshItems();
            streamer.sync(fresh);

            const sessionStatus = await statusOf(conv);
            if (sessionStatus === "failed")
              throw new Error("Native Claude session failed");

            // Activity = TUI shows its working line, OR AGENT items/text landed
            // since the last poll (tool calls, results, assistant prose). Item
            // flow is the belt to WORKING_RE's braces — a TUI wording change
            // must not end turns early. Count only agent-produced items: our own
            // injected user message also shows up in /items, and treating it as
            // activity once declared a turn started-and-done before the model
            // typed a single character.
            const agentItems = fresh.filter(
              (it) =>
                it["type"] !== "message" ||
                itemField(it, "role") === "assistant",
            ).length;
            const grew =
              agentItems > lastItemCount || streamer.chars > lastChars;
            lastItemCount = agentItems;
            lastChars = streamer.chars;

            // Primary working signals, most reliable first:
            //  1. session status "running" — omnigent DOES track per-turn work
            //     (verified live; an older comment here claimed otherwise).
            //  2. tmux #{window_activity} — ticks on every pane repaint (the
            //     spinner animates ~1/s while the harness works), frozen when
            //     idle. Immune to spinner wording AND to capture-pane racing a
            //     mid-repaint blank frame, which WORKING_RE is not.
            //  3. WORKING_RE on the pane text, 4. item/text growth — belt and
            //     braces for old omnigent versions where 1-2 might not hold.
            const activity = (
              await tmux("display", "-p", "-t", name, "#{window_activity}")
            ).trim();
            const activityTicked = activity !== "" && activity !== lastActivity;
            if (activity !== "") lastActivity = activity;
            const pane = await capture(name);
            const tuiWorking = WORKING_RE.test(pane);
            const working =
              sessionStatus === "running" || activityTicked || tuiWorking || grew;
            if (working) started = true;
            if (i < 30 || i % 25 === 0) {
              console.error(
                `[omni] poll ${i} conv=${conv} st=${sessionStatus} act=${activityTicked} tui=${tuiWorking} grew=${grew} ` +
                  `items=${fresh.length}/${agentItems} chars=${streamer.chars} ` +
                  `quiet=${quiet} started=${started}`,
              );
            }

            // No sign the turn ever began — the initial keystrokes were likely
            // dropped (TUI not ready when we typed, e.g. a slow MCP boot). Re-
            // inject a couple times, and give up cleanly rather than hang for the
            // full poll budget if it truly never starts.
            const noSign =
              !started && !working && streamer.chars === 0 && fresh.length === 0;
            if (noSign) {
              if ((i === 8 || i === 18) && injects < MAX_INJECTS) {
                console.error(`[omni] re-injecting (poll ${i}) conv=${conv}`);
                await sendToTmux(name, submitText);
                injects++;
              }
              if (i >= NEVER_STARTED_GIVEUP) {
                console.error(`[omni] turn never started conv=${conv}`);
                exitReason = "never-started";
                break;
              }
              continue; // don't run the completion gate before anything starts
            }

            // Done when the TUI stops working, debounced. Gated on work having
            // begun OR some reply already landing, so a fast answer that never
            // flashes "working" still terminates instead of hanging. A turn
            // ending on a tool call waits longer for its prose to conclude.
            if (!working && (started || streamer.chars > 0)) {
              quiet++;
              const need = streamer.endsOnTool ? QUIET_TOOL_GRACE : QUIET_DONE;
              if (quiet >= need) {
                exitReason = "quiet";
                break;
              }
            } else {
              quiet = 0;
            }
          }
          if (cancelled && exitReason === "budget") exitReason = "cancelled";

          // Final reconcile in case the last items landed between polls, then
          // close any open message / tool before finishing the run.
          streamer.sync(await freshItems());
          streamer.finalize();
          console.error(
            `[omni] run done conv=${conv} chars=${streamer.chars} polls=${polls} exit=${exitReason} cancelled=${cancelled}`,
          );

          // Snapshot BEFORE complete(): completing the observable runs the
          // teardown, which sets `cancelled = true` — reading it afterwards
          // made every successful run report "cancelled" to its onDone.
          const result = { text: streamer.text, ok: true, cancelled };
          clearOrphan(key, override?.sessionTag); // turn settled — nothing to recover
          unregister();
          emit(runFinished);
          subscriber.complete();
          override?.onDone?.(result);
        } catch (err) {
          cancelled = true;
          clearOrphan(key, override?.sessionTag); // settled (failed) — don't re-attach
          unregister();
          console.error("[omni] run error", err);
          override?.onDone?.({ text: "", ok: false, cancelled: true });
          const errorEvent: RunErrorEvent = {
            type: EventType.RUN_ERROR,
            message: err instanceof Error ? err.message : String(err),
            threadId: input.threadId,
            runId: input.runId,
          } as RunErrorEvent;
          emit(errorEvent);
          subscriber.complete();
        }
      })();

      return () => {
        cancelled = true;
        unregister();
      };
    });
  }
}
