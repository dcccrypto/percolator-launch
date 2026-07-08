/**
 * Trusted-proxy-aware client IP extractor (Edge Runtime compatible).
 *
 * Header precedence mirrors the hardened waitlist parser
 * (`lib/waitlist/client-ip.ts`), which is the local security standard
 * (GH#2218). Most-trustworthy first:
 *
 *   1. `cf-connecting-ip` — Cloudflare's single-IP header. Set by
 *      Cloudflare itself and not propagated from the client in the
 *      production CF→Vercel topology.
 *   2. `x-real-ip` — set by Vercel (and most reverse proxies) to the
 *      direct peer. Vercel overwrites whatever the client sent.
 *   3. `x-forwarded-for` — comma-separated `client, proxy1, …` chain.
 *      Only the entry appended by the innermost trusted proxy is
 *      consulted, controlled by `TRUSTED_PROXY_DEPTH` (rightmost hop
 *      is most-trusted). If that entry is not a syntactically valid
 *      IP the function returns "unknown" rather than falling back to
 *      an attacker-controlled entry further left.
 *
 * Every candidate is validated as a real IPv4/IPv6 address before use —
 * a caller-controlled garbage string must never become a rate-limit key
 * or blocklist input. This module runs in the Edge Runtime (middleware),
 * so validation is implemented locally instead of via `node:net.isIP`.
 *
 * `TRUSTED_PROXY_DEPTH=0` means "no trusted proxy in front" — in that
 * topology every forwarding header is client-supplied, so none of them
 * are trusted and the function returns "unknown".
 */
import type { NextRequest } from "next/server";

export function getClientIp(req: NextRequest): string {
  const PROXY_DEPTH = Math.max(0, Number(process.env.TRUSTED_PROXY_DEPTH ?? 1));
  if (PROXY_DEPTH === 0) return "unknown";

  const cfIp = checkIp(req.headers.get("cf-connecting-ip"));
  if (cfIp) return cfIp;

  const realIp = checkIp(req.headers.get("x-real-ip"));
  if (realIp) return realIp;

  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const ips = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
    if (ips.length > 0) {
      // Each proxy appends the peer it received the connection from, so
      // with N trusted proxies the client is the Nth entry from the right.
      const idx = Math.max(0, ips.length - PROXY_DEPTH);
      const picked = checkIp(ips[idx] ?? null);
      if (picked) return picked;
    }
  }

  return "unknown";
}

/**
 * Normalise a raw header value and validate it as a real IPv4/IPv6
 * address. Returns the validated address on success, `null` otherwise.
 */
function checkIp(raw: string | null): string | null {
  if (!raw) return null;
  const normalised = normaliseIp(raw.trim());
  return isValidIp(normalised) ? normalised : null;
}

/**
 * Strip the cruft proxies append to the raw IP — surrounding brackets
 * on IPv6 (`[::1]:443` → `::1`), trailing `:port` on IPv4
 * (`192.0.2.1:443` → `192.0.2.1`). Does NOT validate.
 */
function normaliseIp(raw: string): string {
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end > 0) return raw.slice(1, end);
  }
  // IPv4 with port: exactly one colon AND a dot present (IPv6 has
  // multiple colons; bare IPv4 has none).
  const firstColon = raw.indexOf(":");
  if (firstColon !== -1 && raw.lastIndexOf(":") === firstColon && raw.includes(".")) {
    return raw.slice(0, firstColon);
  }
  return raw;
}

/**
 * Strict IPv4/IPv6 syntax check, Edge Runtime compatible (no `node:net`).
 * Exported for unit tests.
 */
export function isValidIp(s: string): boolean {
  return isIPv4(s) || isIPv6(s);
}

function isIPv4(s: string): boolean {
  const parts = s.split(".");
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    if (n > 255) return false;
    // Reject leading zeros ("01") — some parsers read them as octal,
    // so "010.0.0.1" can alias a different address downstream.
    if (p.length > 1 && p.startsWith("0")) return false;
  }
  return true;
}

function isIPv6(s: string): boolean {
  if (!s.includes(":")) return false;
  // At most one "::" (zero-compression marker).
  const doubleColonCount = s.split("::").length - 1;
  if (doubleColonCount > 1) return false;

  const hasCompression = doubleColonCount === 1;
  const [left, right = ""] = hasCompression ? s.split("::") : [s];

  const parseGroups = (part: string): string[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    // Empty group inside a side means stray ":" (e.g. ":::" or "a::b:")
    if (groups.some((g) => g === "")) return null;
    return groups;
  };

  const leftGroups = parseGroups(left ?? "");
  const rightGroups = parseGroups(right);
  if (leftGroups === null || rightGroups === null) return false;

  let groupCount = 0;
  const all = [...leftGroups, ...rightGroups];
  for (let i = 0; i < all.length; i++) {
    const g = all[i]!;
    const isLast = i === all.length - 1;
    if (isLast && g.includes(".")) {
      // Embedded IPv4 tail (e.g. "::ffff:192.0.2.1") counts as two groups.
      if (!isIPv4(g)) return false;
      groupCount += 2;
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return false;
    groupCount += 1;
  }

  if (hasCompression) {
    // "::" must stand for at least one zero group.
    return groupCount <= 7;
  }
  return groupCount === 8;
}
