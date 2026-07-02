#!/usr/bin/env bun
/**
 * OpenTag watchdog — one pass per invocation (systemd timer, every 60s).
 *
 * Answers the two questions nobody could answer before:
 *   "did my session die?"  → posts into the originating Slack thread
 *   "is the stack alive?"  → posts into the ops channel
 * and does the tmux garbage collection that used to pile up 26 dead panes.
 *
 * State (what was already alerted, so each incident alerts ONCE) lives in
 * ~/.opentag/watchdog-state.json. Safe to run concurrently with the bot: it
 * only kills panes whose workflow is in a terminal state or which are
 * plain-chat panes idle past the TTL — never planning/implementing panes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const STATE_DIR = process.env["OPENTAG_STATE_DIR"] ?? join(HOME, ".opentag");
const BOT_ENV = process.env["OPENTAG_BOT_ENV"] ?? join(HOME, "OpenTag", ".env");
const WD_STATE = join(STATE_DIR, "watchdog-state.json");
const CHAT_TTL_H = Number(process.env["OPENTAG_CHAT_PANE_TTL_HOURS"] ?? 48);
const DONE_TTL_H = Number(process.env["OPENTAG_DONE_PANE_TTL_HOURS"] ?? 24);
const MIN_AVAIL_MB = Number(process.env["OPENTAG_MIN_AVAIL_MB"] ?? 700);
// Session GC is purely TIME-based (idle age), never count/recency-based — a
// count cap once reaped panes that were still in use, killing live replies
// mid-stream. This is a soft ceiling used ONLY to warn (ops channel), never to
// kill. A pane active within RECENT_ACTIVE_MIN is NEVER GC'd, whatever its age.
const MAX_CHAT_PANES = Number(process.env["OPENTAG_MAX_CHAT_PANES"] ?? 20);
const RECENT_ACTIVE_MIN = Number(process.env["OPENTAG_RECENT_ACTIVE_MIN"] ?? 30);
const INSTANCE_MAX_AGE_D = Number(process.env["OPENTAG_INSTANCE_MAX_AGE_DAYS"] ?? 3);
const OMNI = process.env["OMNIGENT_URL"] ?? "http://127.0.0.1:6767";

// ── env / slack ─────────────────────────────────────────────────────────────
function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
  } catch {}
  return out;
}
const botEnv = parseEnvFile(BOT_ENV);
const SLACK_TOKEN = botEnv["SLACK_BOT_TOKEN"] ?? "";
const OPS_CHANNEL = botEnv["OPENTAG_OPS_CHANNEL"] ?? process.env["OPENTAG_OPS_CHANNEL"] ?? "";

async function slackPost(channel: string, text: string, threadTs?: string): Promise<void> {
  if (!SLACK_TOKEN || !channel) {
    console.error(`[watchdog] (no slack) ${channel} ${threadTs ?? ""}: ${text}`);
    return;
  }
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SLACK_TOKEN}` },
      body: JSON.stringify({ channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) }),
    });
    const j = (await res.json()) as { ok: boolean; error?: string };
    if (!j.ok) console.error(`[watchdog] slack post failed: ${j.error}`);
  } catch (e) {
    console.error(`[watchdog] slack post error`, e);
  }
}

// ── alert-once state ────────────────────────────────────────────────────────
interface WdState { alerted: Record<string, string> } // key → ISO time
const wdState: WdState = (() => {
  try { return JSON.parse(readFileSync(WD_STATE, "utf8")) as WdState; } catch { return { alerted: {} }; }
})();
function alertedRecently(key: string, hours = 24): boolean {
  const t = wdState.alerted[key];
  return !!t && Date.now() - Date.parse(t) < hours * 3600_000;
}
function markAlerted(key: string): void {
  wdState.alerted[key] = new Date().toISOString();
}
function saveWdState(): void {
  // prune entries older than 7d
  for (const [k, t] of Object.entries(wdState.alerted)) {
    if (Date.now() - Date.parse(t) > 7 * 24 * 3600_000) delete wdState.alerted[k];
  }
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(WD_STATE, JSON.stringify(wdState, null, 2));
}

// ── tmux ────────────────────────────────────────────────────────────────────
interface Pane { name: string; created: number; activity: number }
function tmuxSessions(): Pane[] {
  try {
    const out = execFileSync(
      "tmux",
      ["list-sessions", "-F", "#{session_name}\t#{session_created}\t#{session_activity}"],
      { encoding: "utf8" },
    );
    return out.trim().split("\n").filter(Boolean).map((l) => {
      const [name, created, activity] = l.split("\t");
      return { name: name!, created: Number(created) * 1000, activity: Number(activity) * 1000 };
    });
  } catch {
    return [];
  }
}
function killSession(name: string): void {
  try { execFileSync("tmux", ["kill-session", "-t", name]); } catch {}
}

// ── workflows ───────────────────────────────────────────────────────────────
interface Workflow {
  issue: string; conversationKey: string; state: string; updatedAt: string;
}
const ACTIVE = new Set(["planning", "awaiting_approval", "revising", "implementing"]);
function loadWorkflows(): Workflow[] {
  try { return JSON.parse(readFileSync(join(STATE_DIR, "workflows.json"), "utf8")) as Workflow[]; } catch { return []; }
}
/** Mirror of the bot's tmux naming: og_ + key with non-alnum → _ (prefix match). */
function panePrefixFor(conversationKey: string): string {
  return ("og_slack_" + conversationKey.replace(/::/, "_")).replace(/[^A-Za-z0-9_]/g, "_");
}

// ── checks ──────────────────────────────────────────────────────────────────
const report: string[] = [];

async function checkUnits(): Promise<void> {
  for (const unit of ["opentag-bot", "opentag-omnigent", "opentag-planapp", "opentag-plantunnel"]) {
    let state = "unknown";
    try {
      state = execFileSync("systemctl", ["is-active", unit], { encoding: "utf8" }).trim();
    } catch (e) {
      // systemctl exits non-zero for any non-active state and prints it;
      // an exec failure WITHOUT output is an environment hiccup, not a down
      // unit — report only states systemd actually asserted.
      state = String((e as { stdout?: string }).stdout ?? "unknown").trim() || "unknown";
    }
    if ((state === "inactive" || state === "failed") && !alertedRecently(`unit:${unit}`, 6)) {
      markAlerted(`unit:${unit}`);
      report.push(`🔴 \`${unit}\` is *${state}* — systemd should be restarting it; check \`journalctl -u ${unit}\`.`);
    }
  }
}

async function checkMemory(): Promise<void> {
  let mem = "";
  try {
    mem = readFileSync("/proc/meminfo", "utf8");
  } catch {
    return; // not Linux
  }
  const availMb = Number(mem.match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0) / 1024;
  if (availMb > 0 && availMb < MIN_AVAIL_MB && !alertedRecently("memory", 3)) {
    markAlerted("memory");
    report.push(`🟠 Box memory low: ${availMb.toFixed(0)} MB available. Consider \`wt stop\` on an idle instance.`);
  }
}

async function checkOmnigent(): Promise<boolean> {
  try {
    const r = await fetch(`${OMNI}/v1/sessions`, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch {
    if (!alertedRecently("omnigent-api", 6)) {
      markAlerted("omnigent-api");
      report.push(`🔴 Omnigent API (${OMNI}) unreachable — native sessions can't be driven.`);
    }
    return false;
  }
}

/** Dead-session detection + pane GC in one tmux sweep. */
async function checkSessionsAndGc(): Promise<void> {
  const panes = tmuxSessions();
  const paneNames = new Set(panes.map((p) => p.name));
  const workflows = loadWorkflows();
  const now = Date.now();

  // 1) Active workflows whose expected pane vanished → in-thread alert.
  for (const w of workflows) {
    if (!ACTIVE.has(w.state)) continue;
    // Only meaningful while a phase session should be alive: planning/revising
    // (plan pane) or implementing (impl pane). awaiting_approval has no live run.
    const tag = w.state === "implementing" ? "__impl" : w.state === "awaiting_approval" ? null : "__plan";
    if (!tag) continue;
    const prefix = panePrefixFor(w.conversationKey);
    const alive = panes.some((p) => p.name.startsWith(prefix) && p.name.endsWith(tag));
    // Grace period: the bot may not have created the pane yet right after a
    // state flip. Only alert if the state is old enough to expect a pane.
    const stateAgeMin = (now - Date.parse(w.updatedAt)) / 60000;
    if (!alive && stateAgeMin > 5 && !alertedRecently(`dead:${w.conversationKey}:${w.state}`)) {
      markAlerted(`dead:${w.conversationKey}:${w.state}`);
      const [channel, ts] = w.conversationKey.split("::");
      await slackPost(
        channel!,
        `⚠️ The *${w.state}* session for ${w.issue} died (its terminal pane is gone). ` +
          `Mention me with \`stop\` to release it, then \`take ${w.issue}\` to restart.`,
        ts,
      );
    }
  }

  // 2) GC — purely TIME-based. A pane is killed ONLY when it has been idle
  // past its TTL. Recency/count never decides a kill (that once reaped live
  // sessions), and a pane active within RECENT_ACTIVE_MIN is always spared so
  // an in-flight reply is never interrupted.
  const byKeyTerminal = new Map<string, boolean>();
  for (const w of workflows) byKeyTerminal.set(panePrefixFor(w.conversationKey), !ACTIVE.has(w.state));
  let chatCount = 0;
  for (const p of panes) {
    if (!p.name.startsWith("og_")) continue;
    const idleMin = (now - p.activity) / 60_000;
    const idleH = idleMin / 60;
    if (idleMin < RECENT_ACTIVE_MIN) {
      if (!/__?(plan|impl|inv)$/.test(p.name)) chatCount++;
      continue; // recently active — never touch
    }
    const tagged = /__?(plan|impl|inv)$/.test(p.name);
    if (tagged) {
      // workflow-phase pane: kill only when its workflow is terminal + past TTL
      const prefix = [...byKeyTerminal.keys()].find((k) => p.name.startsWith(k));
      const terminal = prefix ? byKeyTerminal.get(prefix)! : false;
      if (terminal && idleH > DONE_TTL_H) {
        killSession(p.name);
        report.push(`🧹 GC'd finished workflow pane \`${p.name}\` (idle ${idleH.toFixed(0)}h).`);
      }
    } else {
      chatCount++;
      if (idleH > CHAT_TTL_H) {
        killSession(p.name);
        report.push(`🧹 GC'd idle chat pane \`${p.name}\` (idle ${idleH.toFixed(0)}h).`);
      }
    }
  }
  // Soft ceiling: WARN only (never kill) if live sessions pile up past the
  // ceiling — the operator can trim manually. Killing here would risk an
  // active session; that's the bug we removed.
  if (chatCount > MAX_CHAT_PANES && !alertedRecently("pane-ceiling", 6)) {
    markAlerted("pane-ceiling");
    report.push(
      `ℹ️ ${chatCount} chat sessions open (soft ceiling ${MAX_CHAT_PANES}). They GC by idle age (${CHAT_TTL_H}h); trim manually if the box feels heavy.`,
    );
  }
}

/** Long-running instances tie up a slot + ~1.5 GiB — nudge, don't auto-stop. */
async function checkInstances(): Promise<void> {
  let reg: { instances?: Record<string, { slug: string; state: string; updatedAt: string }> };
  try {
    reg = JSON.parse(readFileSync(join(STATE_DIR, "instances.json"), "utf8"));
  } catch {
    return;
  }
  for (const inst of Object.values(reg.instances ?? {})) {
    if (inst.slug === "golden" || inst.state !== "running") continue;
    const ageD = (Date.now() - Date.parse(inst.updatedAt)) / 86400_000;
    if (ageD > INSTANCE_MAX_AGE_D && !alertedRecently(`instance:${inst.slug}`, 24)) {
      markAlerted(`instance:${inst.slug}`);
      report.push(
        `🟡 Instance \`${inst.slug}\` has been running ${ageD.toFixed(0)}d — ` +
          `\`wt stop ${inst.slug}\` (or destroy) if it's no longer needed.`,
      );
    }
  }
}

async function checkTunnel(): Promise<void> {
  const urlFile = join(STATE_DIR, "tunnel-url");
  if (!existsSync(urlFile)) {
    if (!alertedRecently("tunnel-url", 6)) {
      markAlerted("tunnel-url");
      report.push("🟠 Plan tunnel URL file missing — plan links will 404 until opentag-plantunnel restarts.");
    }
    return;
  }
  // stale > 3d is just informational — quick tunnels rotate on restart only.
  const ageD = (Date.now() - statSync(urlFile).mtimeMs) / 86400_000;
  if (ageD > 7 && !alertedRecently("tunnel-stale", 24)) {
    markAlerted("tunnel-stale");
    report.push(`ℹ️ Plan tunnel URL is ${ageD.toFixed(0)}d old — fine, but restart opentag-plantunnel if links 404.`);
  }
}

// ── main ────────────────────────────────────────────────────────────────────
// Each check is independent; one failing must not silence the others.
for (const check of [checkUnits, checkMemory, checkOmnigent, checkSessionsAndGc, checkInstances, checkTunnel]) {
  try {
    await check();
  } catch (e) {
    console.error(`[watchdog] ${check.name} failed:`, e);
  }
}
saveWdState();

if (report.length > 0) {
  const text = `*watchdog @ ${new Date().toISOString()}*\n` + report.join("\n");
  console.log(text);
  if (OPS_CHANNEL) await slackPost(OPS_CHANNEL, text);
}
