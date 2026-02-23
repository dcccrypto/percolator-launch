import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Simple in-memory rate limiter (per-IP, resets on deploy)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;

function getRateLimit(ip: string): { remaining: number; reset: number } {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitMap.set(ip, entry);
  }

  entry.count++;

  if (Math.random() < 0.001) {
    for (const [key, val] of rateLimitMap) {
      if (now > val.resetAt) rateLimitMap.delete(key);
    }
  }

  return {
    remaining: Math.max(0, RATE_LIMIT_MAX - entry.count),
    reset: Math.ceil((entry.resetAt - now) / 1000),
  };
}

export function middleware(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const isApi = request.nextUrl.pathname.startsWith("/api/");

  if (isApi) {
    const { remaining, reset } = getRateLimit(ip);

    if (remaining <= 0) {
      return new NextResponse(
        JSON.stringify({ error: "Too many requests. Please try again later." }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Limit": String(RATE_LIMIT_MAX),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(reset),
            "Retry-After": String(reset),
          },
        }
      );
    }

    const response = NextResponse.next();
    response.headers.set("X-RateLimit-Limit", String(RATE_LIMIT_MAX));
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
  // - 'unsafe-eval': Required by Solana wallet adapters (Phantom, Solflare) which use
  //   Function() for transaction serialization. Accepted risk.
  // - 'unsafe-inline': Fallback for browsers that don't support nonces.
  //   When nonce is present, CSP2+ browsers ignore 'unsafe-inline' for scripts.
  // - style-src 'unsafe-inline': Required by Next.js for inline style injection.
  const scriptNonce = nonce ? `'nonce-${nonce}' ` : "";
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${scriptNonce}'unsafe-eval' 'unsafe-inline' https://cdn.vercel-insights.com`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https: blob:",
    "connect-src 'self' https://*.solana.com wss://*.solana.com https://*.supabase.co wss://*.supabase.co https://*.vercel-insights.com https://api.coingecko.com https://*.helius-rpc.com wss://*.helius-rpc.com https://api.dexscreener.com https://hermes.pyth.network https://*.up.railway.app wss://*.up.railway.app https://token.jup.ag https://auth.privy.io https://*.rpc.privy.systems https://explorer-api.walletconnect.com wss://relay.walletconnect.com wss://relay.walletconnect.org wss://www.walletlink.org blob:",
    "frame-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");

  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-XSS-Protection", "0");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
