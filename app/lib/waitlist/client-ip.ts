/**
 * Client-IP extraction + hashing for the waitlist signup route.
 *
 * Pulled into a tiny module so the parser logic is unit-testable in
 * isolation from the route handler. The route then writes both the raw
 * IP (column `ip_address`, type inet) and the salted hash (column
 * `ip_hash`, text) — see `supabase-waitlist-schema.sql` for the column
 * rationale.
 */

import { createHash } from "node:crypto";

/**
 * Extract the originating client IP from request headers, taking the
 * proxy chain into account.
 *
 * Header precedence (most-trustworthy first):
 *
 *   1. `cf-connecting-ip` — Cloudflare's single-IP header. Set by
 *      Cloudflare itself and not propagated from the client. Trusted
 *      when the request flowed through CF, which is our production
 *      topology (Vercel sits behind Cloudflare for percolator.trade).
 *   2. `x-real-ip` — Set by Vercel (and most reverse proxies) to the
 *      direct peer. Single IP, not a chain. Client-injectable in
 *      theory but Vercel overwrites whatever the client sent.
 *   3. `x-forwarded-for` — Comma-separated `client, proxy1, proxy2`
 *      chain. Used only as a last resort because the chain is built
 *      up across hops and the leftmost entry can be client-injected
 *      at the public edge. When we fall through to this header we
 *      take the LEFTMOST entry — that's the originating client per
 *      RFC 7239 / de-facto convention.
 *
 * Returns `null` when no header gives a syntactically-plausible IP.
 * The route writes NULL to `ip_address` in that case rather than
 * failing the signup — a few proxies legitimately strip the
 * forwarding headers and we shouldn't block real users for it.
 */
export function getClientIp(headers: Headers): string | null {
  const cfIp = headers.get("cf-connecting-ip")?.trim();
  if (cfIp && isPlausibleIp(cfIp)) return normaliseIp(cfIp);

  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp && isPlausibleIp(realIp)) return normaliseIp(realIp);

  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first && isPlausibleIp(first)) return normaliseIp(first);
  }

  return null;
}

/**
 * SHA-256(`${ip}|${salt}`), hex-encoded. The salt is required because
 * the ~4-billion IPv4 space is brute-forceable against an unsalted
 * SHA-256 in well under a minute on commodity hardware — without the
 * salt the "hash" gives no privacy advantage over the raw value.
 *
 * Returns `null` when no salt is configured. The route writes NULL to
 * `ip_hash` in that case (the column is nullable; the operator should
 * set `WAITLIST_IP_SALT` in production env to enable analytics).
 *
 * Stable across process restarts because the salt is configuration,
 * not memory state. Rotating the salt deliberately breaks the
 * aggregation in `/admin` spam signals — useful as a recovery action
 * after a bad-actor wave you want to stop counting against future
 * normal traffic.
 */
export function hashIp(ip: string, salt: string | undefined | null): string | null {
  if (!salt) return null;
  return createHash("sha256").update(`${ip}|${salt}`).digest("hex");
}

/**
 * Light syntactic check — rejects obviously malformed strings without
 * trying to fully validate IPv4 / IPv6 grammar (postgres re-validates
 * on insert via the `inet` column type). The aim is to drop garbage
 * before it reaches the DB, not to be a parser.
 */
function isPlausibleIp(s: string): boolean {
  if (s.length < 3 || s.length > 64) return false;
  // IPv4: digits + dots. IPv6: hex + colons + optional dots (mapped form).
  // Allow brackets around IPv6 and a trailing :port that we strip in
  // normaliseIp; permit them through the loose pattern here.
  return /^[\[\]0-9a-fA-F:.\-]+$/.test(s);
}

/**
 * Strip the cruft proxies append to the raw IP — surrounding brackets
 * on IPv6, trailing `:port` on IPv4. IPv6 with a port is always
 * bracketed (`[::1]:443`) so we can strip the bracket pair and the
 * post-bracket port safely; bare IPv6 has no port and stays intact.
 */
function normaliseIp(raw: string): string {
  let s = raw;
  // Bracketed IPv6: `[2001:db8::1]:443` → `2001:db8::1`
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end > 0) return s.slice(1, end);
  }
  // IPv4 with port: `192.0.2.1:443` → `192.0.2.1`. Detect by exactly
  // one colon AND a dot before that colon (IPv4 has dots, IPv6 has
  // multiple colons).
  const firstColon = s.indexOf(":");
  if (firstColon !== -1 && s.lastIndexOf(":") === firstColon && s.indexOf(".") !== -1) {
    return s.slice(0, firstColon);
  }
  return s;
}
