import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import { BLOCKED_SLAB_ADDRESSES } from "@/lib/blocklist";

// ── Rate limiter configuration ───────────────────────────────────────────────
// Two tiers: RPC proxy gets a higher limit since Solana web3.js generates many calls per page load.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;         // General API endpoints
const RPC_RATE_LIMIT_MAX = 600;     // /api/rpc — Solana needs many RPC calls per page

// ── Upstash Redis distributed rate limiter (GH#1213) ─────────────────────────
// Primary: Upstash Redis + @upstash/ratelimit — globally consistent across
//          Vercel serverless instances (uses REST API, Edge Runtime compatible).
// Fallback: in-memory sliding window — for local dev / CI / when Redis is unconfigured.
//
// The previous pure in-memory Map approach was per-instance: on Vercel each cold
// start resets counters independently, so an attacker distributing requests across
// instances could bypass the limit entirely. Upstash Redis solves this.
let _generalLimiter: Ratelimit | null = null;
let _rpcLimiter: Ratelimit | null = null;
let _limitersInitialized = false;

function getUpstashLimiters(): { general: Ratelimit | null; rpc: Ratelimit | null } {
  if (_limitersInitialized) return { general: _generalLimiter, rpc: _rpcLimiter };
  _limitersInitialized = true;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { general: null, rpc: null };

  try {
    const redis = new Redis({ url, token });
    _generalLimiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(RATE_LIMIT_MAX, "60 s"),
      prefix: "rl:api",
      analytics: false,
    });
    _rpcLimiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(RPC_RATE_LIMIT_MAX, "60 s"),
      prefix: "rl:rpc",
      analytics: false,
    });
  } catch {
    // Redis init error — fall through to in-memory
    _generalLimiter = null;
    _rpcLimiter = null;
  }

  return { general: _generalLimiter, rpc: _rpcLimiter };
}

// ── In-memory fallback (per-instance) ────────────────────────────────────────
// Used when Upstash is unconfigured (local dev / CI) or if Redis throws.
// NOTE: This is per-isolate only — it does NOT share state across Vercel Edge
// instances.  For reliable distributed enforcement, configure Upstash Redis
// via UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN env vars.
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const rpcRateLimitMap = new Map<string, { count: number; resetAt: number }>();

function _getInMemoryRateLimit(ip: string, isRpc: boolean): { allowed: boolean; remaining: number; reset: number } {
  const now = Date.now();
  const map = isRpc ? rpcRateLimitMap : rateLimitMap;
  const max = isRpc ? RPC_RATE_LIMIT_MAX : RATE_LIMIT_MAX;

  let entry = map.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    map.set(ip, entry);
  }
  entry.count++;

  // Probabilistic GC to avoid unbounded map growth
  if (Math.random() < 0.001) {
    for (const [key, val] of map) {
      if (now > val.resetAt) map.delete(key);
    }
  }

  // FIX(GH#1245): use strict inequality so request #max is the last ALLOWED
  // one (not the first blocked one).  Previously `remaining = max - count`
  // meant count=max → remaining=0 → `remaining <= 0` blocked that request,
  // allowing only max-1 requests through instead of max.
  const allowed = entry.count <= max;
  return {
    allowed,
    remaining: Math.max(0, max - entry.count),
    reset: Math.ceil((entry.resetAt - now) / 1000),
  };
}

async function getRateLimit(
  ip: string,
  isRpc: boolean = false,
): Promise<{ allowed: boolean; remaining: number; reset: number }> {
  const { general, rpc } = getUpstashLimiters();
  const limiter = isRpc ? rpc : general;

  if (limiter) {
    try {
      const { success, remaining, reset } = await limiter.limit(ip);
      // FIX(GH#1245): use `success` (the boolean Upstash provides) to drive
      // the allow/block decision — NOT `remaining`.  When success=true and
      // remaining=0 (the last allowed request), the old code returned
      // remaining=0 and the `remaining <= 0` guard incorrectly blocked it.
      return {
        allowed: success,
        remaining: Math.max(0, remaining),
        reset: Math.max(0, Math.ceil((reset - Date.now()) / 1000)),
      };
    } catch {
      // Redis request failed — degrade gracefully to in-memory
    }
  }

  return _getInMemoryRateLimit(ip, isRpc);
}

// ── IP Blocklist ────────────────────────────────────────────────────────────
// Parsed once at module load (Edge Runtime: module is re-evaluated per region,
// not per request, so this is effectively a startup cost).
// Configure via IP_BLOCKLIST env var: comma-separated IPs or /8|/16|/24|/32 CIDRs.
// Example (Railway): IP_BLOCKLIST=88.97.223.158,10.0.0.0/8
const _rawBlocklist = (process.env.IP_BLOCKLIST ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

interface _BlockEntry {
  type: "exact" | "cidr";
  ip?: string;
  network?: number;
  mask?: number;
}

// IPv4 only — IPv6 addresses are not supported and will pass through unblocked.
// See packages/api/src/middleware/ip-blocklist.ts for the Hono equivalent (also IPv4-only).
function _ipToInt(ip: string): number {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => isNaN(n) || n < 0 || n > 255)) return -1;
  return ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0;
}

const _blocklist: _BlockEntry[] = _rawBlocklist
  .map((entry): _BlockEntry | null => {
    if (entry.includes("/")) {
      const [addr, prefStr] = entry.split("/");
      const prefix = Number(prefStr);
      if (!addr || isNaN(prefix) || prefix < 0 || prefix > 32) return null;
      const net = _ipToInt(addr);
      if (net === -1) return null;
      const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
      return { type: "cidr", network: (net & mask) >>> 0, mask };
    }
    return { type: "exact", ip: entry };
  })
  .filter((e): e is _BlockEntry => e !== null);

function _isBlocked(clientIp: string): boolean {
  if (_blocklist.length === 0) return false;
  const clientInt = _ipToInt(clientIp);
  for (const e of _blocklist) {
    if (e.type === "exact" && clientIp === e.ip) return true;
    if (e.type === "cidr" && clientInt !== -1) {
      if ((clientInt & e.mask!) >>> 0 === e.network) return true;
    }
  }
  return false;
}

// ── Slab blocklist (GH#1363, GH#1390) ────────────────────────────────────────
// next.config.ts rewrites /api/funding/:slab, /api/open-interest/:slab, and
// /api/insurance/:slab → Railway BEFORE Next.js route handlers run, so the
// BLOCKED_SLAB_ADDRESSES check in route.ts is dead code for those paths.
// This guard lives in middleware (which runs pre-rewrite) and returns 404
// early — preventing blocked/corrupt slabs from ever reaching Railway (which
// returns 500 for them).
//
// Evaluated once at module load (Edge Runtime cold start), not per request.
// GH#1539: BLOCKED_SLAB_ADDRESSES already includes BLOCKED_MARKET_ADDRESSES entries
// (via lib/blocklist.ts unified set). No manual re-parse needed here.
const _blockedFundingSlabSet: ReadonlySet<string> = BLOCKED_SLAB_ADDRESSES;
// Matches /api/funding/<slab> and /api/funding/<slab>/history
const _fundingSlabRe = /^\/api\/funding\/([^/]+)(\/history)?$/;
// Matches /api/open-interest/<slab> (GH#1390)
const _openInterestSlabRe = /^\/api\/open-interest\/([^/]+)$/;
// Matches /api/insurance/<slab> (GH#1390)
const _insuranceSlabRe = /^\/api\/insurance\/([^/]+)$/;
// All proxied-route regexes that require slab blocklist checks (GH#1363, GH#1390)
const _slabRouteRegexes = [
  _fundingSlabRe,
  _openInterestSlabRe,
  _insuranceSlabRe,
] as const;
/** Returns the blocked slab address if `pathname` matches a guarded route and the slab is blocked. */
function _blockedSlabFromPath(pathname: string): string | null {
  for (const re of _slabRouteRegexes) {
    const m = re.exec(pathname);
    const slab = m?.[1];
    if (slab && _blockedFundingSlabSet.has(slab)) return slab;
  }
  return null;
}

// ── /markets/:slab → /trade/:slab permanent redirect (GH#1558) ───────────────
// next.config.ts redirects are processed by the Next.js router, but when an RSC
// hits BAILOUT_TO_CLIENT_SIDE_RENDERING the redirect is swallowed by the JS
// navigation layer and the HTTP response comes back as 200 (not 308).
// Middleware runs at the Edge before the Next.js router, so it is guaranteed to
// emit the correct 308 status code for all clients (curl, crawlers, JS-disabled).
// This is belt-and-suspenders alongside the next.config.ts entry (kept for dev).
const _marketsSlabRe = /^\/markets\/([^/]+)\/?$/;

/** Paths blocked during mainnet beta — devnet-only faucets and internal pages */
const MAINNET_BETA_BLOCKED_PATHS = [
  "/devnet-mint", "/faucet", "/openclaw", "/pitch",
];

// ── Hostname routing (waitlist pivot 2026-05-08) ─────────────────────────────
// The Vercel project hosts three logical surfaces on the same Next.js app:
//   - mainnet.percolatorlaunch.com  : full trading frontend (existing app)
//   - percolator.trade              : waitlist landing + /pitch only
//   - percolatorlaunch.com (apex)   : 301 redirect to percolator.trade
//
// This block runs FIRST, before all other middleware logic, so non-waitlist
// hostnames continue to behave exactly as before.
const WAITLIST_HOSTS = new Set(["percolator.trade"]);
const REDIRECT_HOSTS = new Set([
  // www.percolator.trade canonicalizes to apex (SEO)
  "www.percolator.trade",
  "percolatorlaunch.com",
  "www.percolatorlaunch.com",
]);
// Paths that ARE allowed on the waitlist host (percolator.trade). Anything else
// → redirect to /waitlist. Trading-product surfaces (markets, dashboard,
// portfolio, wallet, trade, create, stake, devnet-mint, faucet) stay blocked
// here — they continue to live on mainnet.percolatorlaunch.com.
const WAITLIST_HOST_ALLOWED_PREFIXES = [
  "/waitlist",
  "/pitch",        // investor-facing deck (still accessible, just not linked from nav)
  "/guide",        // developer guide
  "/developers",
  "/join",         // community/applications
  "/report-bug",
  "/bugs",         // community-submitted bug list
  "/agents",
  "/leaderboard",
  "/openclaw",
];
function isAllowedOnWaitlistHost(pathname: string): boolean {
  if (pathname === "/") return true;
  if (pathname.startsWith("/api/")) return true;
  if (pathname.startsWith("/_next/")) return true;
  if (/\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff2?|ttf|map)$/i.test(pathname)) return true;
  for (const p of WAITLIST_HOST_ALLOWED_PREFIXES) {
    if (pathname === p || pathname.startsWith(p + "/")) return true;
  }
  return false;
}

export async function middleware(request: NextRequest) {
  // ── Hostname routing ───────────────────────────────────────────────────────
  const host = (request.headers.get("host") ?? "").toLowerCase().split(":")[0];

  // Apex/www redirect: percolatorlaunch.com → percolator.trade (path-preserving 301)
  if (REDIRECT_HOSTS.has(host)) {
    const target = new URL(
      request.nextUrl.pathname + request.nextUrl.search,
      "https://percolator.trade",
    );
    return NextResponse.redirect(target, { status: 301 });
  }

  // Waitlist host: rewrite root to /waitlist, redirect everything non-allowed to /waitlist
  if (WAITLIST_HOSTS.has(host)) {
    const path = request.nextUrl.pathname;
    if (path === "/") {
      const url = request.nextUrl.clone();
      url.pathname = "/waitlist";
      return NextResponse.rewrite(url);
    }
    if (!isAllowedOnWaitlistHost(path)) {
      const url = request.nextUrl.clone();
      url.pathname = "/waitlist";
      url.search = "";
      return NextResponse.redirect(url, { status: 302 });
    }
    // Allowed path on waitlist host — fall through to existing middleware logic
  }

  // ── Mainnet beta: block pages not available yet ────────────────────────────
  const isMainnet = process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() === "mainnet";
  if (isMainnet) {
    const path = request.nextUrl.pathname;
    if (MAINNET_BETA_BLOCKED_PATHS.some((p) => path === p || path.startsWith(p + "/"))) {
      return NextResponse.redirect(new URL("/", request.url));
    }
  }

  // ── /markets/:slab → /trade/:slab (GH#1558) ─────────────────────────────
  const marketsMatch = _marketsSlabRe.exec(request.nextUrl.pathname);
  if (marketsMatch) {
    const slab = marketsMatch[1];
    const destination = new URL(`/trade/${slab}`, request.url);
    // Preserve query string if present (e.g. ?ref=share)
    destination.search = request.nextUrl.search;
    return NextResponse.redirect(destination, { status: 308 });
  }

  // ── IP Blocklist check ─────────────────────────────────────────────────────
  // Resolve client IP using the same proxy-depth logic as the rate limiter.
  if (_blocklist.length > 0) {
    const _proxyDepth = Math.max(0, Number(process.env.TRUSTED_PROXY_DEPTH ?? 1));
    let _clientIp = "unknown";
    // NOTE: depth=0 means "no proxy" — _clientIp stays "unknown" and
    // _isBlocked("unknown") returns false, effectively disabling the
    // Edge Runtime blocklist. The Hono ip-blocklist.ts middleware
    // handles depth=0 correctly for the API server path.
    if (_proxyDepth > 0) {
      const _fwd = request.headers.get("x-forwarded-for");
      if (_fwd) {
        const _ips = _fwd.split(",").map((s) => s.trim());
        _clientIp = _ips[Math.max(0, _ips.length - _proxyDepth)] ?? "unknown";
      }
    }
    if (_isBlocked(_clientIp)) {
      return new NextResponse(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // ── Slab blocklist guards (GH#1363, GH#1390) ─────────────────────────────
  // next.config.ts rewrites /api/funding/:slab, /api/open-interest/:slab, and
  // /api/insurance/:slab → Railway before route handlers run, making the
  // route.ts blocklist check unreachable for those paths.
  // Check here (pre-rewrite) and return 404 for any blocked slab.
  if (_blockedSlabFromPath(request.nextUrl.pathname)) {
    return new NextResponse(JSON.stringify({ error: "Market not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── Admin route guard (server-side session check) ──────────────────────────
  // The /admin page component does a client-side auth check, but that fires
  // after pre-render HTML is served (visible with JS disabled).  This guard
  // ensures any unauthenticated request to /admin/* is redirected before any
  // server-rendered content is produced.  Actual data is also protected by
  // Supabase RLS + admin_users table, so this is defense-in-depth (LOW risk).
  const isAdminRoute =
    request.nextUrl.pathname.startsWith("/admin") &&
    !request.nextUrl.pathname.startsWith("/admin/login");

  if (isAdminRoute) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      // Env vars missing — redirect to login rather than expose admin
      const loginUrl = new URL("/admin/login", request.url);
      return NextResponse.redirect(loginUrl);
    }

    const response = NextResponse.next();
    const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    });

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      const loginUrl = new URL("/admin/login", request.url);
      return NextResponse.redirect(loginUrl);
    }

    // User is authenticated — continue to admin route with security headers
    addSecurityHeaders(response);
    return response;
  }

  // Extract client IP respecting TRUSTED_PROXY_DEPTH env var.
  // - TRUSTED_PROXY_DEPTH=0: Ignore X-Forwarded-For (direct exposure, no proxy)
  // - TRUSTED_PROXY_DEPTH=1: One proxy layer (Vercel, Cloudflare) — use last IP
  // - TRUSTED_PROXY_DEPTH=2: Two proxy layers — use second-to-last IP
  // This prevents IP spoofing attacks via forged X-Forwarded-For headers.
  const PROXY_DEPTH = Math.max(0, Number(process.env.TRUSTED_PROXY_DEPTH ?? 1));
  let ip = "unknown";
  if (PROXY_DEPTH > 0) {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) {
      const ips = forwarded.split(",").map((s) => s.trim());
      const idx = Math.max(0, ips.length - PROXY_DEPTH);
      ip = ips[idx] ?? "unknown";
    }
  }
  const isApi = request.nextUrl.pathname.startsWith("/api/");

  if (isApi) {
    const isRpc = request.nextUrl.pathname === "/api/rpc";
    const { allowed, remaining, reset } = await getRateLimit(ip, isRpc);
    const limit = isRpc ? RPC_RATE_LIMIT_MAX : RATE_LIMIT_MAX;

    // FIX(GH#1245): gate on `allowed` (the authoritative boolean) rather than
    // `remaining <= 0`.  The old guard blocked the last *allowed* request
    // whenever remaining hit 0 — an off-by-one that manifested as "rate limit
    // fires one request too early" in single-instance envs and "never fires"
    // in distributed Edge (each isolate has its own in-memory counter at 0).
    if (!allowed) {
      // GH#1819: Log rate limit events for monitoring and alerting
      const logContext = {
        ip,
        path: request.nextUrl.pathname,
        rpcLimit: isRpc,
        limit,
        remaining,
        reset,
      };
      console.warn("[RateLimit] Request blocked:", JSON.stringify(logContext));

      return new NextResponse(
        JSON.stringify({ error: "Too many requests. Please try again later." }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Limit": String(limit),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(reset),
            "Retry-After": String(reset),
          },
        }
      );
    }

    const response = NextResponse.next();
    response.headers.set("X-RateLimit-Limit", String(limit));
    response.headers.set("X-RateLimit-Remaining", String(remaining));
    response.headers.set("X-RateLimit-Reset", String(reset));
    addSecurityHeaders(response);
    return response;
  }

  // Generate a per-request nonce for CSP using Web Crypto API (Edge Runtime compatible)
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = btoa(String.fromCharCode(...nonceBytes));

  // Forward nonce to layout.tsx via request headers
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  addSecurityHeaders(response, nonce);
  // PERC-695: Prevent CDN/edge caching of nonce-protected HTML responses.
  // A cached response would carry the old nonce in data-nonce while the middleware
  // generates a fresh nonce for the CSP header — making the nonce effectively static.
  response.headers.set("Cache-Control", "no-store, must-revalidate");
  return response;
}

function addSecurityHeaders(response: NextResponse, nonce?: string) {
  // CSP with nonce-based inline script protection
  // - 'unsafe-eval' REMOVED (issue #633): audited all 241 production chunks — zero eval(),
  //   new Function(), or string-arg setTimeout calls found. Wallet adapters (Phantom, Solflare)
  //   run in extension contexts not subject to page CSP.
  // - 'unsafe-inline': Fallback for browsers that don't support nonces.
  //   When nonce is present, CSP2+ browsers ignore 'unsafe-inline' for scripts.
  // - style-src 'unsafe-inline': Required by Next.js for inline style injection.
  const scriptNonce = nonce ? `'nonce-${nonce}' ` : "";
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${scriptNonce}'unsafe-inline' https://cdn.vercel-insights.com`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https: blob:",
    // GH#1283: Added https://lite.jup.ag — used by useCreateMarket to fetch token price
    // via /v6/price endpoint for HYPERP/Pump.fun oracle markets during deposit flow.
    // GH#1982: api.percolatorlaunch.com added for WebSocket price streaming (wss://)
    // and REST fallback (https://). The subdomain must resolve via DNS CNAME to
    // percolator-api-production.up.railway.app — without this CSP entry browsers
    // would block the connection even after DNS is configured.
    "connect-src 'self' https://*.solana.com wss://*.solana.com https://*.supabase.co wss://*.supabase.co https://*.vercel-insights.com https://api.coingecko.com https://api.geckoterminal.com https://*.helius-rpc.com wss://*.helius-rpc.com https://api.dexscreener.com https://hermes.pyth.network https://*.up.railway.app wss://*.up.railway.app https://api.percolatorlaunch.com wss://api.percolatorlaunch.com https://lite.jup.ag https://token.jup.ag https://tokens.jup.ag https://auth.privy.io https://embedded-wallets.privy.io https://*.privy.systems https://*.rpc.privy.systems https://explorer-api.walletconnect.com wss://relay.walletconnect.com wss://relay.walletconnect.org wss://www.walletlink.org blob:",
    // Removed https://*.vercel.app wildcard (issue #635) — no legitimate use case for embedding
    // arbitrary Vercel-hosted content in iframes. frame-src controls outbound iframe embedding.
    "frame-src 'self' https://auth.privy.io https://embedded-wallets.privy.io https://*.privy.systems https://phantom.app https://solflare.com https://verify.walletconnect.com https://verify.walletconnect.org",
    // Removed https://*.vercel.app wildcard (issue #632) — any Vercel project could embed the app,
    // creating a clickjacking surface over wallet/sign flows. Keep only the specific preview URL.
    "frame-ancestors 'self' https://percolatorlaunch.com https://*.percolatorlaunch.com https://percolator-launch.vercel.app",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");

  response.headers.set("Content-Security-Policy", csp);
  // HSTS: enforce HTTPS for 2 years, include subdomains, allow preload list submission.
  // Vercel may add this at the edge, but explicit is defense-in-depth.
  response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  response.headers.set("X-Content-Type-Options", "nosniff");
  // SAMEORIGIN allows Privy's embedded wallet iframes to work.
  // frame-ancestors CSP directive provides more granular control.
  response.headers.set("X-Frame-Options", "SAMEORIGIN");
  response.headers.set("X-XSS-Protection", "0");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
