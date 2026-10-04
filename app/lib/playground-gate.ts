/**
 * The devnet v2 waitlist lock, as middleware sees it. Edge-safe (Web Crypto only).
 *
 * When PLAYGROUND_GATE_ENABLED === "true", every request needs a valid
 * `pg_access` session cookie (minted by /enter) except the exemptions below.
 * Without one: pages → 307 to /locked; /api/* → 401 JSON.
 * Unset / anything else → the gate does nothing (kill switch).
 *
 * EXEMPTIONS — every one is either not app content, or a route whose caller
 * cannot hold a browser cookie and which authenticates itself:
 *
 *   /enter, /locked             the way in, and the door
 *   /_next/*, /_vercel/*        framework assets, Vercel analytics beacons
 *   /images/*, /icons/*, /audio/*   public/ asset folders
 *   /token-metadata/*           on-chain metadata URIs (wallets/explorers fetch these server-side)
 *   /charting_library/*, /tv-theme/*   the TradingView chart library's static files and our
 *                               theme CSS for it (loaded inside the chart iframe). Chart DATA
 *                               is /api/* and stays gated.
 *   top-level files by extension   e.g. /chart-empty-state.svg. ONLY top-level: a nested
 *                               /trade/x.png would otherwise render the [slab] page shell.
 *   favicon/icon, robots.txt, sitemap.xml, opengraph-image, twitter-image, manifest
 *   /.well-known/*
 *   GET  /api/health            uptime monitoring; returns only {status,rpc,indexer,ts}
 *   GET  /api/playground/registered-markets
 *                               polled by the oracle keeper (NAT'd, cookie-less); payload is
 *                               public market config by design (see the route header)
 *   PATCH /api/markets/:slab    external keeper/ops signer; HMAC-SHA256 over KEEPER_REGISTER_SECRET
 *   POST /api/oracle-keeper/register
 *                               HMAC-SHA256 over KEEPER_REGISTER_SECRET, timestamp-bounded
 *   POST /api/oracle/set-price-cap
 *                               operator tool; x-admin-secret vs ADMIN_API_SECRET, fails closed
 *
 * Everything else under /api is called same-origin by the browser app, so it
 * is gated and the cookie rides along automatically.
 */
import { SESSION_COOKIE, gateEnabled, sessionGrantsAccess } from "@/lib/playground-access";

export const LOCKED_PATH = "/locked";
export const ENTER_PATH = "/enter";

export type GateDecision = "pass" | "redirect-locked" | "unauthorized";

/** A single top-level segment ending in a static extension (public/ root files). */
const TOP_LEVEL_STATIC_RE =
  /^\/[^/]+\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|css|js|mjs|map|woff2?|ttf|otf|eot|mp3|ogg|wav|webm|mp4|txt|xml|webmanifest)$/i;

const EXEMPT_EXACT = new Set([
  ENTER_PATH,
  LOCKED_PATH,
  "/favicon.ico",
  "/icon.png",
  "/robots.txt",
  "/sitemap.xml",
  "/manifest.webmanifest",
  "/opengraph-image",
  "/twitter-image",
]);

const EXEMPT_PREFIXES = [
  "/_next/",
  "/_vercel/",
  "/.well-known/",
  "/token-metadata/",
  "/images/",
  "/icons/",
  "/audio/",
  // TradingView chart library (static, build-time fetched) + our theme CSS for it.
  // The chart's same-origin iframe loads these; data stays gated (/api/*).
  "/charting_library/",
  "/tv-theme/",
];

/** Server-to-server API routes, by method. Each authenticates itself (see header). */
const EXEMPT_API: ReadonlyArray<{ method: string; re: RegExp }> = [
  { method: "GET", re: /^\/api\/health\/?$/ },
  { method: "GET", re: /^\/api\/playground\/registered-markets\/?$/ },
  // base58 slab only, so PATCH /api/markets/challenge|health (no PATCH handler) stays gated
  { method: "PATCH", re: /^\/api\/markets\/[1-9A-HJ-NP-Za-km-z]{32,44}\/?$/ },
  { method: "POST", re: /^\/api\/oracle-keeper\/register\/?$/ },
  { method: "POST", re: /^\/api\/oracle\/set-price-cap\/?$/ },
];

export function isExempt(pathname: string, method: string): boolean {
  if (EXEMPT_EXACT.has(pathname)) return true;
  // /locked/ and /enter/ (trailing slash) as well
  if (pathname === LOCKED_PATH + "/" || pathname === ENTER_PATH + "/") return true;
  if (EXEMPT_PREFIXES.some((p) => pathname.startsWith(p))) return true;
  const m = method.toUpperCase();
  if (pathname.startsWith("/api/")) {
    // HEAD rides on GET's exemption (uptime monitors often send HEAD).
    return EXEMPT_API.some((e) => (e.method === m || (m === "HEAD" && e.method === "GET")) && e.re.test(pathname));
  }
  // Top-level static files only — never nested, never under /api.
  return TOP_LEVEL_STATIC_RE.test(pathname);
}

let warnedNoSecret = false;

export async function gateDecision(
  pathname: string,
  method: string,
  cookieValue: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
  nowMs = Date.now(),
): Promise<GateDecision> {
  if (!gateEnabled(env)) return "pass";
  if (isExempt(pathname, method)) return "pass";
  if (await sessionGrantsAccess(cookieValue, env, nowMs)) return "pass";
  if (!warnedNoSecret && !(env.PLAYGROUND_ACCESS_SECRET && env.PLAYGROUND_ACCESS_SECRET.length >= 32)) {
    warnedNoSecret = true;
    console.error(
      "[playground-gate] PLAYGROUND_GATE_ENABLED=true but PLAYGROUND_ACCESS_SECRET is unset or < 32 chars — " +
        "the gate is refusing EVERYONE (team bypass included).",
    );
  }
  return pathname.startsWith("/api/") || pathname === "/api" ? "unauthorized" : "redirect-locked";
}

export { SESSION_COOKIE };
