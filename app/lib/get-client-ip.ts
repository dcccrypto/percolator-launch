/**
 * Trusted-proxy-aware client IP extractor.
 *
 * Uses `TRUSTED_PROXY_DEPTH` (parsed by lib/trusted-proxy-depth.ts, the same parser
 * middleware.ts uses) to determine how many hops to peel off the `x-forwarded-for` chain
 * (rightmost hop is most-trusted). Behind a proxy (depth > 0) it falls back to `x-real-ip`
 * if the forwarded-for header is absent, then "unknown". Depth 0 means no proxy, so no
 * forwarded header is trusted at all (#3483) and the result is "unknown".
 */
import { isIPv4, isIPv6 } from "net";
import type { NextRequest } from "next/server";
import { trustedProxyDepth } from "@/lib/trusted-proxy-depth";

function isValidIp(s: string): boolean {
  return isIPv4(s) || isIPv6(s);
}

export function getClientIp(req: NextRequest): string {
  const PROXY_DEPTH = trustedProxyDepth();
  // No proxy in front: every forwarded header came from the caller (#3483).
  if (PROXY_DEPTH === 0) return "unknown";

  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const ips = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
    // Peel PROXY_DEPTH trusted hops from the right (rightmost = most-trusted,
    // see file doc comment). Correct index: length - PROXY_DEPTH, clamped to 0.
    if (ips.length > 0) {
      const clientIdx = Math.max(0, ips.length - PROXY_DEPTH);
      const candidate = ips[clientIdx];
      if (candidate && isValidIp(candidate)) return candidate;
    }
  }

  const realIp = req.headers.get("x-real-ip");
  if (realIp && isValidIp(realIp)) return realIp;

  return "unknown";
}

