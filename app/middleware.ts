import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// In-memory rate limiter (per-IP, resets on deploy)
// Two tiers: RPC proxy gets a higher limit since Solana web3.js generates many calls per page load.
// RPC requests are cached/deduped server-side, so the higher limit is safe.
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const rpcRateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;         // General API endpoints
const RPC_RATE_LIMIT_MAX = 600;     // /api/rpc — Solana needs many RPC calls per page

function getRateLimit(ip: string, isRpc: boolean = false): { remaining: number; reset: number } {
  const now = Date.now();
  const map = isRpc ? rpcRateLimitMap : rateLimitMap;
  const max = isRpc ? RPC_RATE_LIMIT_MAX : RATE_LIMIT_MAX;

  let entry = map.get(ip);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    map.set(ip, entry);
  }

  entry.count++;

  if (Math.random() < 0.001) {
    for (const [key, val] of map) {
      if (now > val.resetAt) map.delete(key);
    }
  }

  return {
    remaining: Math.max(0, max - entry.count),
    reset: Math.ceil((entry.resetAt - now) / 1000),
  };
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

export async function middleware(request: NextRequest) {
  // ── IP Blocklist check ─────────────────────────────────────────────────────
  // Resolve client IP using the same proxy-depth logic as the rate limiter.
  if (_blocklist.length > 0) {
    const _proxyDepth = Math.max(0, Number(process.env.TRUSTED_PROXY_DEPTH ?? 1));
    let _clientIp = "unknown";
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
    const { remaining, reset } = getRateLimit(ip, isRpc);
    const limit = isRpc ? RPC_RATE_LIMIT_MAX : RATE_LIMIT_MAX;

    if (remaining <= 0) {
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
    "connect-src 'self' https://*.solana.com wss://*.solana.com https://*.supabase.co wss://*.supabase.co https://*.vercel-insights.com https://api.coingecko.com https://*.helius-rpc.com wss://*.helius-rpc.com https://api.dexscreener.com https://hermes.pyth.network https://*.up.railway.app wss://*.up.railway.app https://token.jup.ag https://tokens.jup.ag https://auth.privy.io https://embedded-wallets.privy.io https://*.privy.systems https://*.rpc.privy.systems https://explorer-api.walletconnect.com wss://relay.walletconnect.com wss://relay.walletconnect.org wss://www.walletlink.org blob:",
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
