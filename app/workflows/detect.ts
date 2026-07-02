/**
 * Pure text parsers for the issue workflow: the opt-in trigger phrase, Linear
 * issue-id extraction from thread transcripts, and the structured header the
 * planning phase is instructed to emit (REPOS: / TITLE:).
 */

/** Linear issue key, e.g. FLU-252 / MAR-7. */
const ISSUE_RE = /\b([A-Z]{2,10}-\d{1,6})\b/;

/**
 * Recognize a workflow trigger in a mention — `take this`, `plan this`,
 * `fix this`, `work on this`, optionally naming the issue (`take FLU-252`).
 * Anchored to the WHOLE message (after stripping the leading mention token) so
 * ordinary requests that merely contain "fix this ..." fall through to chat.
 */
export function parseWorkflowTrigger(
  text: string,
): { issue?: string } | null {
  const t = text
    .replace(/^\s*(?:<@[^>]+>|@\S+)\s*/i, "")
    .trim()
    .replace(/[.!?\s]+$/, "");
  const m = t.match(
    /^(?:take|plan|fix|work on|handle)\s+(?:this(?:\s+(?:issue|bug|one))?|it|over|([A-Za-z]{2,10}-\d{1,6}))$/i,
  );
  if (!m) return null;
  const issue = m[1]?.toUpperCase();
  return issue ? { issue } : {};
}

/**
 * Recognize an INVESTIGATION trigger — `investigate this`, `debug why …`,
 * `look into the runtime errors`, `diagnose FLU-252`. Unlike the workflow
 * trigger this launches a read-only exploration session (skills-driven, no
 * plan, no approval, no code changes); everything after the verb is the brief.
 * The verb must LEAD the message so chat like "can you investigate…" still
 * reads naturally — the leading mention token is stripped first.
 */
export function parseInvestigateTrigger(
  text: string,
): { issue?: string; brief: string } | null {
  const t = text
    .replace(/^\s*(?:<@[^>]+>|@\S+)\s*/i, "")
    .trim();
  const m = t.match(
    /^(?:investigate|debug|diagnose|look into|dig into|explore|root[- ]?cause)\b[:\s]*(.*)$/is,
  );
  if (!m) return null;
  const brief = (m[1] ?? "").trim().replace(/[.!?\s]+$/, "");
  const issue = brief.match(ISSUE_RE)?.[1]?.toUpperCase();
  return { issue, brief };
}

/**
 * Find the Linear issue id in a thread transcript — typically the Linear bot's
 * "[FLU-252](…) comments are synced…" reply right under the bug report. The
 * LAST match wins: it's the most recently filed issue in the thread.
 */
export function extractIssueId(texts: string[]): string | undefined {
  let found: string | undefined;
  for (const t of texts) {
    const m = t?.match(new RegExp(ISSUE_RE, "g"));
    if (m && m.length > 0) found = m[m.length - 1];
  }
  return found;
}

/**
 * Parse the structured header out of a plan reply. The planner is told to
 * lead with `REPOS: a, b` and `TITLE: …` lines; parse leniently (bold markers,
 * bullets, any casing) since it's an LLM writing them.
 */
export function parsePlanMeta(planText: string): {
  repos: string[];
  title?: string;
} {
  const clean = (s: string) => s.replace(/[*_`]/g, "").trim();
  const repoLine = planText.match(/^\s*[-*]?\s*\**REPOS?\**\s*:\s*(.+)$/im)?.[1];
  const title = planText.match(/^\s*[-*]?\s*\**TITLE\**\s*:\s*(.+)$/im)?.[1];
  const repos = (repoLine ?? "")
    .split(/[,\s]+/)
    .map((r) => clean(r).toLowerCase())
    .filter((r) => /^[a-z0-9._-]+$/.test(r));
  return { repos, title: title ? clean(title) : undefined };
}
