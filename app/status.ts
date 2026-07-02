/**
 * `@bot status` — one message answering "what is alive right now?":
 * native sessions (tmux panes + age), issue workflows by phase, `wt`
 * instances with their URLs, and box headroom. Every data source is
 * best-effort: a missing piece renders as a note, never an error.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { allWorkflows } from "./workflows/state.js";

const WT_BIN = fileURLToPath(new URL("../infra/wt/wt", import.meta.url));

function run(cmd: string, args: string[], timeoutMs = 15000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 1 << 22 }, (err, stdout) =>
      resolve(err && !stdout ? "" : (stdout ?? "")),
    );
  });
}

const age = (ms: number): string => {
  const h = (Date.now() - ms) / 3600_000;
  return h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
};

export async function statusText(): Promise<string> {
  const parts: string[] = [];

  // ── native sessions (tmux panes) ──
  const tmux = await run("tmux", [
    "list-sessions",
    "-F",
    "#{session_name}\t#{session_activity}",
  ]);
  const panes = tmux
    .trim()
    .split("\n")
    .filter((l) => l.startsWith("og_"))
    .map((l) => {
      const [name, act] = l.split("\t");
      return `  • \`${name}\` (active ${age(Number(act) * 1000)} ago)`;
    });
  parts.push(`*Sessions* (${panes.length})\n${panes.join("\n") || "  none"}`);

  // ── workflows ──
  const active = allWorkflows().filter((w) =>
    ["planning", "awaiting_approval", "revising", "implementing"].includes(w.state),
  );
  parts.push(
    `*Workflows* (${active.length} active)\n` +
      (active
        .map((w) => `  • ${w.issue} — *${w.state}* (updated ${age(Date.parse(w.updatedAt))} ago)`)
        .join("\n") || "  none"),
  );

  // ── wt instances ──
  const wt = (await run(WT_BIN, ["status"])).trim();
  parts.push(`*Instances*\n${wt ? "```\n" + wt + "\n```" : "  wt not available on this host"}`);

  // ── box headroom (Linux only) ──
  try {
    const mem = readFileSync("/proc/meminfo", "utf8");
    const availGb = Number(mem.match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0) / 1048576;
    const totalGb = Number(mem.match(/MemTotal:\s+(\d+)/)?.[1] ?? 0) / 1048576;
    const df = (await run("df", ["-h", "/"])).split("\n")[1]?.split(/\s+/) ?? [];
    parts.push(
      `*Box* — mem ${availGb.toFixed(1)}/${totalGb.toFixed(1)} GiB free · disk ${df[3] ?? "?"} free (${df[4] ?? "?"} used)`,
    );
  } catch {
    // not Linux (local dev) — skip
  }

  return parts.join("\n\n");
}
