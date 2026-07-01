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
 *     native TUI, and the session's API status doesn't track per-turn work, so
 *     /items is the authoritative source and the TUI's own "(esc to interrupt)"
 *     working line is the turn-complete signal.)
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
const REPO = () => process.env["OMNIGENT_REPO"] ?? "/home/omni/demo-repo";
const BIN = () => process.env["OMNIGENT_BIN"] ?? "omnigent";
const HOME = () => process.env["HOME"] ?? "/home/omni";
const CHILD_PATH = () =>
  `${HOME()}/.local/bin:${HOME()}/.bun/bin:${process.env["PATH"] ?? ""}`;

// Omnigent session-level statuses: idle | launching | running | waiting | failed.
// We only use `idle` (session up / ready) and `failed` (hard error) — the native
// TUI doesn't reflect per-turn work here, so turn completion is read off the TUI
// itself (see WORKING_RE) rather than this status.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Session {
  tmux: string;
  conv: string;
}
/** One native session per *stable* Slack-thread key (survives instance churn). */
const sessions = new Map<string, Session>();
/** Serialize bring-up per key so concurrent turns don't double-launch. */
const booting = new Map<string, Promise<Session>>();

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
 * Stable session key for a Slack thread. The Slack store mints a fresh AG-UI
 * threadId per turn (`slack-{channel}-{scope}-{uuid}`); we strip the trailing
 * UUID so every turn in the same thread maps to ONE native Claude session.
 */
function stableKey(threadId: string): string {
  return threadId.replace(
    /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "",
  );
}
function tmuxName(key: string): string {
  return "og_" + key.replace(/[^A-Za-z0-9]/g, "_").slice(0, 48);
}

/** Get or start the persistent native Claude session for a thread key. */
async function ensureSession(key: string): Promise<Session> {
  const cached = sessions.get(key);
  if (cached && isLive(await statusOf(cached.conv))) return cached;

  const inflight = booting.get(key);
  if (inflight) return inflight;

  const p = (async (): Promise<Session> => {
    const name = tmuxName(key);

    if (await tmuxHasSession(name)) {
      const conv = (await capture(name)).match(CONV_RE)?.[0];
      if (conv && isLive(await statusOf(conv))) {
        const s = { tmux: name, conv };
        sessions.set(key, s);
        return s;
      }
      await tmux("kill-session", "-t", name).catch(() => {});
    }

    await tmux("new-session", "-d", "-s", name, "-x", "220", "-y", "50");
    await tmux(
      "send-keys",
      "-t",
      name,
      "-l",
      "--",
      `export PATH=${CHILD_PATH()}; cd ${REPO()}; ${BIN()} claude --dangerously-skip-permissions`,
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
    if (!conv) throw new Error("Native Claude session did not come up in time");

    const s = { tmux: name, conv };
    sessions.set(key, s);
    return s;
  })();

  booting.set(key, p);
  try {
    return await p;
  } finally {
    booting.delete(key);
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

// Claude Code prints a working line while a turn runs ("… (esc to interrupt)");
// its absence is the turn-complete signal a human reads off the TUI. This is our
// completion signal because the native session's API status doesn't track
// per-turn work and the SSE stream doesn't flush text.
const WORKING_RE = /esc to interrupt|esc to cancel/i;

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

/**
 * Turns the growing /items list into a live AG-UI event stream: assistant
 * messages become `TEXT_MESSAGE_START → CONTENT* → END` and tool calls become
 * `TOOL_CALL_START → ARGS → END`, interleaved in chronological order. The Slack
 * renderer consumes those directly — native streaming text for prose PLUS a
 * Block Kit status card per tool ("⏳ Read" → "✅ Read · sum.js"). Tool calls are
 * routed to their own card messages (adapter `toolStatusStyle: "rows"`), so they
 * never collide with the streamed prose (Slack forbids blocks + streamed text in
 * one message).
 *
 * Call `sync(freshItems)` each poll (idempotent — only NEW deltas are emitted);
 * `finalize()` once at the end to close anything still open before RUN_FINISHED.
 */
function makeTurnStreamer(emit: (e: BaseEvent) => void) {
  const msgState = new Map<string, { mid: string; len: number; ended: boolean }>();
  const toolState = new Map<string, { ended: boolean }>();
  let openMid: string | null = null; // the one TEXT_MESSAGE currently open, if any
  let chars = 0; // total assistant text chars emitted (for logging/quiet-gate)
  let endsOnTool = false; // last meaningful item is a tool call → prose pending

  const closeText = () => {
    if (!openMid) return;
    emit({
      type: EventType.TEXT_MESSAGE_END,
      messageId: openMid,
    } as TextMessageEndEvent);
    openMid = null;
  };

  const sync = (fresh: Array<Record<string, unknown>>) => {
    // Tool call_ids that already have a result item → the call has finished.
    const doneCalls = new Set<string>();
    for (const it of fresh) {
      if (it["type"] === "function_call_output") {
        const cid = itemField(it, "call_id");
        if (cid != null) doneCalls.add(String(cid));
      }
    }
    let lastKind: "msg" | "tool" | undefined;
    fresh.forEach((it, idx) => {
      const id = String(it["id"] ?? "");
      const type = it["type"];
      const status = String(itemField(it, "status") ?? "");
      if (type === "message" && itemField(it, "role") === "assistant") {
        const txt = contentText(itemField(it, "content"));
        let st = msgState.get(id);
        if (!st) {
          st = { mid: globalThis.crypto.randomUUID(), len: 0, ended: false };
          msgState.set(id, st);
        }
        if (!st.ended) {
          if (openMid !== st.mid) {
            closeText();
            emit({
              type: EventType.TEXT_MESSAGE_START,
              role: "assistant",
              messageId: st.mid,
            } as TextMessageStartEvent);
            openMid = st.mid;
          }
          if (txt.length > st.len) {
            emit({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: st.mid,
              delta: txt.slice(st.len),
            } as TextMessageContentEvent);
            chars += txt.length - st.len;
            st.len = txt.length;
          }
          if (status === "completed") {
            closeText();
            st.ended = true;
          }
        }
        lastKind = "msg";
      } else if (type === "function_call") {
        const name = String(itemField(it, "name") ?? "tool");
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
    closeText();
  };

  return {
    sync,
    finalize,
    get chars() {
      return chars;
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
      const ac = new AbortController();
      let cancelled = false;

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
        try {
          const text = lastUserText(input.messages);
          if (!text.trim()) {
            emit(runFinished);
            subscriber.complete();
            return;
          }

          const key = stableKey(input.threadId);
          console.error(`[omni] run start thread=${key} runId=${input.runId}`);
          const { tmux: name, conv } = await ensureSession(key);
          console.error(`[omni] session ready conv=${conv}`);

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
          const baseIds = await existingItemIds(conv);
          await sendToTmux(name, text);

          // Quiet polls (TUI not "working") needed to call the turn done. Short
          // when the reply already ends in prose; longer when it currently ends
          // on a tool call, to ride the gap before the concluding message lands
          // (and still bound the rare genuine tool-final turn).
          const QUIET_DONE = 3; // ~2.4s
          const QUIET_TOOL_GRACE = 12; // ~9.6s

          let started = false; // saw the TUI enter its working state at least once
          let quiet = 0; // consecutive polls with the TUI not working
          let polls = 0;
          for (let i = 0; i < 1800 && !cancelled; i++) {
            polls = i;
            await sleep(800);

            // Emit any new text/tool events produced since the last poll.
            streamer.sync(await freshItems());

            if ((await statusOf(conv)) === "failed")
              throw new Error("Native Claude session failed");

            // Done when the TUI stops working, debounced. Gated on work having
            // begun OR some reply already landing, so a fast answer that never
            // flashes "working" still terminates instead of hanging. A turn
            // ending on a tool call waits longer for its prose to conclude.
            const working = WORKING_RE.test(await capture(name));
            if (working) started = true;
            if (!working && (started || streamer.chars > 0)) {
              quiet++;
              const need = streamer.endsOnTool ? QUIET_TOOL_GRACE : QUIET_DONE;
              if (quiet >= need) break;
            } else {
              quiet = 0;
            }
          }

          // Final reconcile in case the last items landed between polls, then
          // close any open message / tool before finishing the run.
          streamer.sync(await freshItems());
          streamer.finalize();
          console.error(
            `[omni] run done conv=${conv} chars=${streamer.chars} polls=${polls}`,
          );

          emit(runFinished);
          subscriber.complete();
        } catch (err) {
          cancelled = true;
          ac.abort();
          console.error("[omni] run error", err);
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
        ac.abort();
      };
    });
  }
}
