/**
 * Trusted-proxy-aware client IP extractor.
 *
 * Uses `TRUSTED_PROXY_DEPTH` to determine how many hops to peel off the
 * `x-forwarded-for` chain (rightmost hop is most-trusted). Falls back to
 * `x-real-ip` if the forwarded-for header is absent, then "unknown".
 *
 * Used by API routes for trusted-proxy-aware rate limiting.
 */
import type { NextRequest } from "next/server";

export function getClientIp(req: NextRequest): string {
  const PROXY_DEPTH = Math.max(0, Number(process.env.TRUSTED_PROXY_DEPTH ?? 1));
  if (PROXY_DEPTH > 0) {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) {
      const ips = forwarded.split(",").map((s) => s.trim());
      const idx = Math.max(0, ips.length - PROXY_DEPTH);
      return ips[idx] ?? "unknown";
    }
  }
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp;
  return "unknown";
}
