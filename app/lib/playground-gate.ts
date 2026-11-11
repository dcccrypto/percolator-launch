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
 *   /_next/static/*             hashed build output (JS/CSS/fonts the door page loads)
 *   /_next/image                the image optimiser (exact path)
 *   /icon.png, /robots.txt, /sitemap.xml, /opengraph-image, /twitter-image
 *                               the page icon the door page links, and crawler / link-preview routes
 *   /token-metadata/sim-usdc.json, /token-metadata/sim-usdc.svg
 *                               on-chain metadata URI (wallets/explorers fetch it server-side)
 *   GET/HEAD /_vercel/insights/script.js, POST /_vercel/insights/view and /event
 *                               Vercel Web Analytics (opt-in); exact paths only
 *   GET/HEAD /<16 hex>/script.js   the hashed Vercel Web Analytics script (#2826); that exact shape only
 *
 * Exemptions are an explicit allowlist of exact paths (plus /_next/static/). There are NO pattern
 * exemptions (no file-extension, /.well-known/, /_vercel/ or public-folder prefixes): anything else,
 * including /x.txt, /trade.png, /favicon.ico, /.well-known/x and every public/ asset, needs a session.
 * Logged-in users get public/ assets through the normal cookie check.
 *   GET  /api/health            uptime monitoring; returns only {status,rpc,indexer,ts}
 *   GET  /api/playground/registered-markets
 *                               polled by the oracle keeper (NAT'd, cookie-less); payload is
 *                               public market config by design (see the route header)
 *   PATCH /api/markets/:slab    external keeper/ops signer; HMAC-SHA256 over KEEPER_REGISTER_SECRET
 *   POST /api/oracle-keeper/register
 *                               HMAC-SHA256 over KEEPER_REGISTER_SECRET, timestamp-bounded
 *   GET  /api/earn-share/:market and /api/earn-share/:market/image   (v2.2 flag ON only)
 *                               the metadata JSON and icon a wallet fetches for an Earn share token (the `uri` of its on-chain
 *                               Metaplex record); the caller is a wallet or explorer, never a browser holding our cookie. Public by
 *                               design, built from chain state, base58-validated. Flag off the path stays gated (and 404s anyway).
 *
 * Everything else under /api is called same-origin by the browser app, so it
 * is gated and the cookie rides along automatically.
 */
import { SESSION_COOKIE, gateEnabled, sessionGrantsAccess } from "@/lib/playground-access";
import { isDevnetV22Enabled } from "@/lib/v22/flag";

export const LOCKED_PATH = "/locked";
export const ENTER_PATH = "/enter";

export type GateDecision = "pass" | "redirect-locked" | "unauthorized";

/** Vercel Web Analytics' hashed first-party script path (#2826). Exactly one 16-hex segment. */
const VERCEL_ANALYTICS_SCRIPT_RE = /^\/[0-9a-f]{16}\/script\.js$/;

/** Exact paths any method may fetch without a session. */
const EXEMPT_EXACT = new Set([
  ENTER_PATH,
  LOCKED_PATH,
  "/icon.png",
  "/robots.txt",
  "/sitemap.xml",
  "/opengraph-image",
  "/twitter-image",
  // Next image optimiser: exact path only (its ?url= query is not part of the pathname).
  "/_next/image",
  // On-chain token metadata URI + its image (public/token-metadata); fetched by wallets/explorers.
  "/token-metadata/sim-usdc.json",
  "/token-metadata/sim-usdc.svg",
]);

/** Static build output only; the sole prefix exemption. */
const EXEMPT_PREFIXES = ["/_next/static/"];

/** Vercel Web Analytics (opt-in), exact paths by method. */
const EXEMPT_VERCEL_INSIGHTS: ReadonlyArray<{ methods: readonly string[]; path: string }> = [
  { methods: ["GET", "HEAD"], path: "/_vercel/insights/script.js" },
  { methods: ["POST"], path: "/_vercel/insights/view" },
  { methods: ["POST"], path: "/_vercel/insights/event" },
];

/** Server-to-server API routes, by method. Each authenticates itself (see header). */
const EXEMPT_API: ReadonlyArray<{ method: string; re: RegExp; v22?: true }> = [
  { method: "GET", re: /^\/api\/health\/?$/ },
  { method: "GET", re: /^\/api\/playground\/registered-markets\/?$/ },
  // base58 slab only, so PATCH /api/markets/challenge|health (no PATCH handler) stays gated
  { method: "PATCH", re: /^\/api\/markets\/[1-9A-HJ-NP-Za-km-z]{32,44}\/?$/ },
  { method: "POST", re: /^\/api\/oracle-keeper\/register\/?$/ },
  // v2.2 Earn share token metadata (wallets fetch it from the Metaplex record's uri); exempt only with the v2.2 flag on.
  { method: "GET", re: /^\/api\/earn-share\/[1-9A-HJ-NP-Za-km-z]{32,44}(?:\/image)?\/?$/, v22: true },
];

/**
 * Non-normalised path: a `.`/`..` segment, an encoded dot/slash/backslash, or a raw backslash.
 * Exemptions are prefix checks on the raw path, so `/images/../trade` would match `/images/` yet
 * be served as `/trade`. Real asset URLs never contain these, so such paths are never exempt.
 */
const NON_NORMALISED_RE = /(?:^|\/)\.{1,2}(?:\/|$)|%2e|%2f|%5c|\\/i;

export function isExempt(pathname: string, method: string): boolean {
  if (NON_NORMALISED_RE.test(pathname)) return false;
  if (EXEMPT_EXACT.has(pathname)) return true;
  // /locked/ and /enter/ (trailing slash) as well
  if (pathname === LOCKED_PATH + "/" || pathname === ENTER_PATH + "/") return true;
  if (EXEMPT_PREFIXES.some((p) => pathname.startsWith(p))) return true;
  const m = method.toUpperCase();
  if (pathname.startsWith("/api/")) {
    // HEAD rides on GET's exemption (uptime monitors often send HEAD).
    return EXEMPT_API.some((e) => (e.method === m || (m === "HEAD" && e.method === "GET")) && e.re.test(pathname) && (!e.v22 || isDevnetV22Enabled()));
  }
  // Hashed Vercel Analytics script: read-only methods, exact shape, nothing else nested.
  if ((m === "GET" || m === "HEAD") && VERCEL_ANALYTICS_SCRIPT_RE.test(pathname)) return true;
  return EXEMPT_VERCEL_INSIGHTS.some((e) => e.path === pathname && e.methods.includes(m));
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
        "the gate is refusing EVERYONE (team bypass and judge door included).",
    );
  }
  return pathname.startsWith("/api/") || pathname === "/api" ? "unauthorized" : "redirect-locked";
}

export { SESSION_COOKIE };
