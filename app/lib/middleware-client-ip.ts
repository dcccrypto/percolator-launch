import { parseIp } from "@/lib/ip-blocklist";

/** Shared fail-closed key (same as lib/get-client-ip.ts, #3853). */
export const UNKNOWN_IP = "unknown-ip";

/**
 * Resolve the client IP from X-Forwarded-For for the middleware blocklist and rate limiter.
 * Trusts the hop `depth` from the right only when the chain has at least `depth` hops: a
 * shorter chain would otherwise clamp to hop 0, which the caller wrote (rotate it = fresh
 * rate-limit bucket / framing a victim IP). Missing/short chain, depth 0 or a hop that is
 * not a valid IP -> UNKNOWN_IP. x-real-ip is never read.
 */
export function resolveClientIp(xff: string | null, depth: number): string {
  if (depth <= 0 || !xff) return UNKNOWN_IP;
  const hops = xff.split(",").map((s) => s.trim());
  if (hops.length < depth) return UNKNOWN_IP;
  const hop = hops[hops.length - depth];
  if (!hop || !parseIp(hop)) return UNKNOWN_IP;
  return hop;
}
