/**
 * Plan bridge — the auth proxy that makes the self-hosted Plan app viewable
 * from anywhere.
 *
 * The visual-plan skill (local-files privacy mode) writes an MDX folder per
 * issue under PLANS_DIR, and the self-hosted Plan app (agent-native "plan"
 * template, PLAN_LOCAL_DIR=PLANS_DIR) renders each one at
 * /local-plans/<slug> on PLAN_APP_PORT. A cloudflared quick tunnel provides
 * the public HTTPS hostname; it points HERE (BRIDGE_PORT), not at the app,
 * because the tunnel URL is public and the plans quote private source code.
 *
 * This server does exactly two things:
 *
 *   GET /plan-auth?token=<proxy token>&next=<path>  → sets an auth cookie and
 *     redirects into the Plan app. Slack links are minted with this hop
 *     (see planViewUrl) so a click authenticates once, then every app
 *     asset/API request carries the cookie.
 *
 *   everything else → cookie-gated reverse proxy to the Plan app. Comment
 *     writes are additionally inspected so plan-page feedback can drive the
 *     Slack revision loop (dormant unless a handler is registered — see
 *     setPlanFeedbackHandler / app/workflows/feedback.ts).
 *
 * The tunnel writes its current URL to TUNNEL_URL_FILE, re-read on every link
 * composition so a tunnel restart (quick tunnels get a fresh hostname each
 * run) only invalidates links minted before it.
 */
import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where per-issue visual-plan MDX artifacts are authored (outside the clones). */
export const PLANS_DIR = () =>
  process.env["OPENTAG_PLANS_DIR"] ?? "/home/omni/plans";

const BRIDGE_PORT = () =>
  Number(process.env["OPENTAG_PLAN_BRIDGE_PORT"] ?? 8791);

/** Written by start-tunnel.sh each time cloudflared (re)connects. */
const TUNNEL_URL_FILE = () =>
  process.env["OPENTAG_TUNNEL_URL_FILE"] ??
  join(homedir(), ".opentag", "tunnel-url");

/** The self-hosted Plan app (agent-native plan template) the proxy fronts. */
const PLAN_APP_PORT = () =>
  Number(process.env["OPENTAG_PLAN_APP_PORT"] ?? 8096);

const AUTH_COOKIE = "ck_plan_auth";

/**
 * The one server action every plan-page feedback op funnels through in local
 * mode — new comment, reply, resolve, delete — all POST here (verified on-box:
 * the Plan template's `writeComments` router). We proxy it through untouched
 * (so `comments.json` is still written and the UI keeps working) and, on a
 * successful write that ADDS a comment, fire the feedback hook.
 */
const COMMENTS_ACTION_PATH = "/_agent-native/actions/update-local-plan-comments";

/** New plan-page feedback captured off a proxied comment write. */
export interface PlanFeedback {
  /** Plan slug = issue id lowercased, e.g. "flu-249". */
  slug: string;
  /** The freshly-added comment bodies (one revision request, verbatim). */
  messages: string[];
}
type PlanFeedbackHandler = (feedback: PlanFeedback) => void;
let planFeedbackHandler: PlanFeedbackHandler | undefined;

/**
 * Register the sink that turns plan-page comments into revision runs. Wired by
 * app/workflows/feedback.ts at boot; keeping it a setter (rather than importing
 * the workflow here) avoids a planbridge ↔ workflow import cycle.
 */
export function setPlanFeedbackHandler(handler: PlanFeedbackHandler): void {
  planFeedbackHandler = handler;
}

/**
 * Pull NEW comments (no `id` — updates/resolves/deletes carry ids and are
 * skipped) with non-empty text out of a comment-write body. Returns undefined
 * when the body isn't a valid comment-add for a safe slug. Pure + exported for
 * tests.
 */
export function parsePlanFeedback(bodyText: string): PlanFeedback | undefined {
  let json: { slug?: unknown; comments?: unknown };
  try {
    json = JSON.parse(bodyText) as { slug?: unknown; comments?: unknown };
  } catch {
    return undefined;
  }
  const slug = typeof json.slug === "string" ? json.slug : undefined;
  if (!slug || !isSafeSlug(slug)) return undefined;
  const comments = Array.isArray(json.comments) ? json.comments : [];
  const messages = comments
    .filter(
      (c): c is { id?: unknown; message: string } =>
        !!c &&
        typeof c === "object" &&
        !(c as { id?: unknown }).id &&
        typeof (c as { message?: unknown }).message === "string" &&
        (c as { message: string }).message.trim().length > 0,
    )
    .map((c) => c.message.trim());
  if (messages.length === 0) return undefined;
  return { slug, messages };
}

/** Fire the feedback handler for a proxied comment write. Never throws. */
function firePlanFeedback(body: Buffer): void {
  if (!planFeedbackHandler) return;
  try {
    const feedback = parsePlanFeedback(body.toString("utf8"));
    if (feedback) planFeedbackHandler(feedback);
  } catch (err) {
    console.error("[planbridge] plan feedback dispatch failed:", err);
  }
}

/** Slugs are issue ids we lowercased ourselves — keep the gate tight. */
export const isSafeSlug = (slug: string): boolean =>
  /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug);

/**
 * One global secret gating the proxied Plan app (the tunnel URL is public).
 * Links carry it once via /plan-auth, which converts it into a cookie so the
 * app's own asset/API requests pass through untouched.
 */
export function getProxyToken(): string {
  const file = join(PLANS_DIR(), ".proxy-token");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // not minted yet
  }
  const token = randomBytes(24).toString("base64url");
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

const hasAuthCookie = (cookieHeader: string | undefined): boolean => {
  if (!cookieHeader) return false;
  return cookieHeader
    .split(";")
    .some((c) => c.trim() === `${AUTH_COOKIE}=${getProxyToken()}`);
};

/** Current public base for the bridge (tunnel hostname), if one is up. */
function publicBase(): string | undefined {
  const explicit = process.env["OPENTAG_PUBLIC_BRIDGE_URL"];
  if (explicit) return explicit.replace(/\/$/, "");
  try {
    const url = readFileSync(TUNNEL_URL_FILE(), "utf8").trim();
    return /^https:\/\//.test(url) ? url.replace(/\/$/, "") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Shareable URL opening the Plan app page for a plan (self-hosted plan
 * template behind the tunnel, gated by the proxy token → cookie hop), or
 * undefined when there's nothing to link (no artifact written, or no tunnel
 * up) — callers degrade to a text-only card.
 */
export function planViewUrl(slug: string): string | undefined {
  if (!isSafeSlug(slug) || !existsSync(join(PLANS_DIR(), slug, "plan.mdx")))
    return undefined;
  const base = publicBase();
  if (!base) return undefined;
  const next = encodeURIComponent(`/local-plans/${slug}`);
  return `${base}/plan-auth?token=${getProxyToken()}&next=${next}`;
}

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
} as const;

let started = false;

/** Boot the bridge server (idempotent). Port conflicts log, never crash the bot. */
export function startPlanBridge(): void {
  if (started || process.env["OPENTAG_PLAN_BRIDGE"] === "0") return;
  started = true;
  const server = createServer((req, res) => {
    try {
      const respond = (code: number, body: object) => {
        res.writeHead(code, JSON_HEADERS);
        res.end(JSON.stringify(body));
      };
      const url = new URL(req.url ?? "/", "http://x");

      // Link entry point: turn the link's token into a cookie, then land on
      // the real Plan app route — after this hop every app asset/API request
      // carries the cookie and proxies straight through.
      if (req.method === "GET" && url.pathname === "/plan-auth") {
        const token = url.searchParams.get("token") ?? "";
        if (token !== getProxyToken())
          return respond(403, { ok: false, error: "bad-token" });
        const next = url.searchParams.get("next") ?? "/";
        res.writeHead(302, {
          "set-cookie":
            `${AUTH_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`,
          location: next.startsWith("/") ? next : "/",
          "cache-control": "no-store",
        });
        return res.end();
      }

      // Everything else proxies to the self-hosted Plan app — cookie required
      // (the tunnel hostname is public).
      if (!hasAuthCookie(req.headers.cookie)) {
        return respond(403, {
          ok: false,
          error: "auth-required",
          hint: "open the plan link from Slack (it carries the access token)",
        });
      }
      const upstreamOpts = {
        host: "127.0.0.1",
        port: PLAN_APP_PORT(),
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `127.0.0.1:${PLAN_APP_PORT()}` },
      };
      const onUpstreamError = (err: Error) => {
        console.error("[planbridge] plan app proxy failed:", err);
        if (res.headersSent) return res.destroy();
        respond(502, { ok: false, error: "plan-app-unreachable" });
      };
      // Plan-page feedback: buffer the comment-write body so we can both
      // forward it verbatim AND, once the write succeeds, drive a revision.
      // Everything else streams straight through with no buffering.
      if (
        req.method === "POST" &&
        url.pathname === COMMENTS_ACTION_PATH &&
        planFeedbackHandler
      ) {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const body = Buffer.concat(chunks);
          // Normally we only revise on a write the Plan app accepted (2xx).
          // OPENTAG_PLAN_FEEDBACK_TEST=1 fires regardless of upstream status —
          // a verification aid for driving the revision pipeline without a
          // working comment-write (the prod-build Plan app 401s comment adds).
          const fireAlways = process.env["OPENTAG_PLAN_FEEDBACK_TEST"] === "1";
          const upstream = httpRequest(upstreamOpts, (up) => {
            res.writeHead(up.statusCode ?? 502, up.headers);
            up.pipe(res);
            if (fireAlways || (up.statusCode && up.statusCode < 300))
              firePlanFeedback(body);
          });
          upstream.on("error", onUpstreamError);
          upstream.end(body);
        });
        req.on("error", onUpstreamError);
        return;
      }
      const upstream = httpRequest(upstreamOpts, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      upstream.on("error", onUpstreamError);
      req.pipe(upstream);
    } catch (err) {
      console.error("[planbridge] request handler failed:", err);
      try {
        res.writeHead(500, JSON_HEADERS);
        res.end('{"ok":false}');
      } catch {
        // headers already sent
      }
    }
  });
  server.on("error", (err) => {
    started = false;
    console.error(`[planbridge] server error (port ${BRIDGE_PORT()}):`, err);
  });
  server.listen(BRIDGE_PORT(), "127.0.0.1", () =>
    console.log(`[planbridge] proxying ${PLANS_DIR()} plans on 127.0.0.1:${BRIDGE_PORT()}`),
  );
}
