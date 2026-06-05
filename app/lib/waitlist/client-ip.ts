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
import { isIP } from "node:net";

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
 *      chain. **Non-production fallback only.** In production the
 *      CF→Vercel topology guarantees one of the two headers above
 *      always carries the real client IP, so this last-resort path
 *      is dead code legitimately AND spoofable by anyone who reaches
 *      it (the leftmost entry is set by the public edge — including
 *      a direct-to-Vercel attacker who bypassed Cloudflare). We
 *      consult it ONLY in non-prod so local dev proxy setups that
 *      rely on it (e.g., ngrok, custom test rigs) keep working.
 *
 * Returns `null` when no header gives a syntactically-plausible IP.
 * The route writes NULL to `ip_address` in that case rather than
 * failing the signup — a few proxies legitimately strip the
 * forwarding headers and we shouldn't block real users for it.
 */
export function getClientIp(headers: Headers): string | null {
  const cfIp = headers.get("cf-connecting-ip")?.trim();
  const cfChecked = cfIp ? checkIp(cfIp) : null;
  if (cfChecked) return cfChecked;

  const realIp = headers.get("x-real-ip")?.trim();
  const realChecked = realIp ? checkIp(realIp) : null;
  if (realChecked) return realChecked;

  // x-forwarded-for is the only header on this chain whose leftmost
  // entry is client-injectable at the public edge. In production
  // (CF→Vercel) one of the two headers above always wins, so reaching
  // this fallback would imply a direct-to-Vercel attacker spoofing
  // the chain — refuse to trust XFF in that case. Keep the dev path
  // alive for local proxy tooling that legitimately uses it.
  if (process.env.NODE_ENV === "production") {
    return null;
  }

  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    const xffChecked = first ? checkIp(first) : null;
    if (xffChecked) return xffChecked;
  }

  return null;
}

/**
 * Normalise a header value and validate it as a real IPv4 / IPv6 address.
 * Returns the validated address string on success, `null` on anything
 * else. The validation uses Node's built-in `net.isIP()` which matches
 * the grammar Postgres `inet` accepts in practice — meaning a value
 * that passes this check will not crash the downstream `INSERT`.
 *
 * Pulled out of `getClientIp` so all three header paths share the same
 * normalise + strict-check + reject logic. Earlier code had a loose
 * `/^[\[\]0-9a-fA-F:.\-]+$/` regex that admitted strings like
 * `"1.2.3.4.5"`, `"::::::"`, and `"a:b:c:d.e"` — each of which would
 * pass our test but make Postgres throw `22P02` on insert, abort the
 * whole row, and surface as a confusing 500 to the user. `net.isIP()`
 * closes that gap.
 */
function checkIp(raw: string): string | null {
  const normalised = normaliseIp(raw);
  if (isIP(normalised) === 0) return null;
  return normalised;
}

/**
 * Minimum salt length the hash function will accept. 16 ASCII chars
 * ≈ 128 bits of entropy if the operator picks a random string, which
 * is the standard floor for salts intended to defeat offline
 * precomputation. Anything shorter is treated as "no salt" — silently
 * accepting a 1-char salt would produce a "hash" whose precompute
 * cost is just 256× the unsalted IPv4 enumeration (~seconds on
 * commodity hardware), giving no real privacy advantage over the
 * raw IP. Fail-noisily-and-store-NULL is the safer posture.
 */
const MIN_SALT_LENGTH = 16;

/**
 * Module-local "we've already warned about this" flag so a
 * misconfigured deploy emits one warning at first signup rather than
 * one per signup forever. Reset by process restart, which matches the
 * intent — operators see it again only if the bad config persists
 * across a restart.
 */
let _shortSaltWarned = false;

/**
 * SHA-256(`${ip}|${salt}`), hex-encoded. The salt is required because
 * the ~4-billion IPv4 space is brute-forceable against an unsalted
 * SHA-256 in well under a minute on commodity hardware — without the
 * salt the "hash" gives no privacy advantage over the raw value.
 *
 * Returns `null` when no salt is configured OR when the configured
 * salt is shorter than `MIN_SALT_LENGTH`. The route writes NULL to
 * `ip_hash` in that case (the column is nullable; the operator should
 * set a sufficiently long `WAITLIST_IP_SALT` in production env to
 * enable analytics).
 *
 * Stable across process restarts because the salt is configuration,
 * not memory state. Rotating the salt deliberately breaks the
 * aggregation in `/admin` spam signals — useful as a recovery action
 * after a bad-actor wave you want to stop counting against future
 * normal traffic.
 */
export function hashIp(ip: string, salt: string | undefined | null): string | null {
  if (!salt) return null;
  if (salt.length < MIN_SALT_LENGTH) {
    if (!_shortSaltWarned) {
      _shortSaltWarned = true;
      console.warn(
        `[waitlist] WAITLIST_IP_SALT is ${salt.length} chars; ` +
          `min ${MIN_SALT_LENGTH} required. Treating as unset — ip_hash will be NULL.`,
      );
    }
    return null;
  }
  return createHash("sha256").update(`${ip}|${salt}`).digest("hex");
}

/**
 * Strip the cruft proxies append to the raw IP — surrounding brackets
 * on IPv6, trailing `:port` on IPv4. IPv6 with a port is always
 * bracketed (`[::1]:443`) so we can strip the bracket pair and the
 * post-bracket port safely; bare IPv6 has no port and stays intact.
 *
 * Does NOT validate — that's `checkIp`'s job via `net.isIP()`.
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
