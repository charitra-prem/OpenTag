/**
 * Pure text parsers for the issue workflow: the opt-in trigger phrase, Linear
 * issue-id extraction from thread transcripts, and the structured header the
 * planning phase is instructed to emit (REPOS: / TITLE:).
 */

/** Linear issue key, e.g. FLU-252 / MAR-7. */
const ISSUE_RE = /\b([A-Z]{2,10}-\d{1,6})\b/;

const stripMention = (text: string): string =>
  text
    .replace(/^\s*(?:<@[^>]+>|@\S+)\s*/i, "")
    .trim()
    .replace(/[.!?\s]+$/, "");

/**
 * Recognize a workflow trigger in a mention — `take this`, `plan this`,
 * `fix this`, `work on this`, optionally naming the issue (`take FLU-252`).
 * Anchored to the WHOLE message (after stripping the leading mention token) so
 * ordinary requests that merely contain "fix this ..." fall through to chat.
 *
 * A trailing note becomes `brief` (a human constraint handed to the planner),
 * but only in the two shapes that can't hijack chat:
 *   - `take FLU-262 fe only`      — an explicit issue id disambiguates;
 *   - `take this, fe fix only`    — the "this" form needs a separator
 *     (comma/colon/dash), so chat like "take this file and rename it" still
 *     falls through. `fix`/`work on` never carry a brief — "fix this typo in
 *     the header" must stay ordinary chat.
 */
export function parseWorkflowTrigger(
  text: string,
): { issue?: string; brief?: string } | null {
  const t = stripMention(text);
  const exact = t.match(
    /^(?:take|plan|fix|work on|handle)\s+(?:this(?:\s+(?:issue|bug|one))?|it|over|([A-Za-z]{2,10}-\d{1,6}))$/i,
  );
  if (exact) {
    const issue = exact[1]?.toUpperCase();
    return issue ? { issue } : {};
  }
  const withIssue = t.match(
    /^(?:take|plan|handle)\s+([A-Za-z]{2,10}-\d{1,6})\b[\s,:;—–-]+(.+)$/i,
  );
  if (withIssue)
    return { issue: withIssue[1]!.toUpperCase(), brief: withIssue[2]!.trim() };
  const withThis = t.match(
    /^(?:take|plan|handle)\s+(?:this(?:\s+(?:issue|bug|one))?|it)\s*[,:;—–-]+\s*(.+)$/i,
  );
  if (withThis) return { brief: withThis[1]!.trim() };
  return null;
}

/**
 * A mention that clearly TRIED to trigger the workflow but didn't parse —
 * e.g. `take this fe fix only` (no separator before the note). Returns the
 * hint to post instead of silently falling through to chat in the default
 * repo, which is exactly how "take this, fe fix only" once became a confused
 * chat session in the wrong repo (that comma form parses now; the naked-tail
 * form and other near-misses get this nudge). Undefined = not a near-miss,
 * fall through to chat as usual.
 */
export function workflowTriggerHint(text: string): string | undefined {
  const t = stripMention(text);
  if (!/^(?:take|plan|handle)\s+(?:this\b|it\b|[A-Za-z]{2,10}-\d{1,6})/i.test(t))
    return undefined;
  return (
    "That looks like a workflow trigger, but I couldn't parse it. Say " +
    "`take this` (or `take FLU-123`), and add any scoping note after a " +
    "comma or the issue id: `take this, fe fix only` · `take FLU-123 fe only`."
  );
}

/**
 * Recognize a RESUME / FOLLOW-UP trigger — `resume`, `continue`, `resume
 * FLU-254`, `pick up where you left off`, `follow up: also handle mp3`.
 * Anchored to the whole message so chat like "continue reading the file and
 * then…" falls through. A trailing note after a separator becomes `brief`:
 * for an interrupted workflow it's extra guidance, for a FINISHED one it's
 * the follow-up instruction implemented on top of the previous work.
 */
export function parseResumeTrigger(
  text: string,
): { issue?: string; brief?: string } | null {
  const t = stripMention(text);
  const m = t.match(
    /^(?:resume|continue|pick up|follow ?up)(?:\s+(?:work(?:ing)?\s+)?(?:on\s+)?(?:where you left off|this|it|([A-Za-z]{2,10}-\d{1,6})))?\s*(?:[,:;—–-]+\s*(.+))?$/i,
  );
  if (!m) return null;
  return {
    issue: m[1]?.toUpperCase(),
    brief: m[2]?.trim() || undefined,
  };
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
