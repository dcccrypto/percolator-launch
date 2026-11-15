/**
 * Trusted-proxy-aware client IP extractor.
 *
 * Uses `TRUSTED_PROXY_DEPTH` (parsed by lib/trusted-proxy-depth.ts, the same parser
 * middleware.ts uses) to pick the client hop from `x-forwarded-for` (rightmost hop is
 * most-trusted). The caller writes everything left of the platform-appended hops, and the
 * whole of `x-real-ip`, so:
 *
 *  - a hop is trusted only when the chain has at least PROXY_DEPTH entries (a shorter chain
 *    is NOT clamped to a caller-written hop);
 *  - `x-real-ip` is never read;
 *  - anything else (depth 0, missing/short chain, non-IP hop) returns the single shared
 *    UNKNOWN_IP key, so a caller cannot mint a fresh rate-limit key by rotating headers.
 *
 * Same fix as percolator-indexer #291.
 */
import { isIPv4, isIPv6 } from "net";
import type { NextRequest } from "next/server";
import { trustedProxyDepth } from "@/lib/trusted-proxy-depth";

/** Shared fail-closed key. Not a valid IP, so ip-blocklist's parseIp() ignores it. */
export const UNKNOWN_IP = "unknown-ip";

function isValidIp(s: string): boolean {
  return isIPv4(s) || isIPv6(s);
}

export function getClientIp(req: NextRequest): string {
  const PROXY_DEPTH = trustedProxyDepth();
  // No proxy in front: every forwarded header came from the caller (#3483).
  if (PROXY_DEPTH === 0) return UNKNOWN_IP;

  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const ips = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
    if (ips.length >= PROXY_DEPTH) {
      const candidate = ips[ips.length - PROXY_DEPTH];
      if (candidate && isValidIp(candidate)) return candidate;
    }
  }

  return UNKNOWN_IP;
}
