/**
 * Rate-limit identity for the allocation lookup: HMAC-SHA256 of the client IP
 * under a server secret. The database only ever sees this 32-byte key, never
 * the IP. IPv6 is keyed by /64 so one host cannot rotate through its prefix.
 * Requests with no usable IP share one "unknown" bucket.
 *
 * IP source: ONLY headers the Vercel edge sets itself and overwrites
 * (x-real-ip, then the first x-vercel-forwarded-for entry). cf-connecting-ip
 * and x-forwarded-for are ignored: percolator.trade is served by Vercel
 * directly (not through the Cloudflare proxy), so those two are whatever the
 * client sent and would let one client rotate its rate-limit identity. If a
 * proxy is ever put in front, clients would share the proxy's buckets, which
 * fails towards more limiting, not less. Validation/normalisation reuses the
 * waitlist helper.
 */
import "server-only";
import { createHmac } from "node:crypto";
import { isIPv6 } from "node:net";
import { getClientIp } from "@/lib/waitlist/client-ip";

export function ipv6Prefix64(ip: string): string {
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  // An embedded IPv4 tail occupies two hextets; it never affects the first four.
  const width = (parts: string[]) => parts.reduce((n, p) => n + (p.includes(".") ? 2 : 1), 0);
  const full = ip.includes("::") ? [...h, ...Array(8 - width(h) - width(t)).fill("0"), ...t] : h;
  return full.slice(0, 4).map((x) => (x || "0").replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/** The client IP as set by the Vercel edge, or null. Never reads client-settable headers. */
export function edgeClientIp(headers: Headers): string | null {
  const v = headers.get("x-real-ip")?.trim() || headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
  if (!v) return null;
  // getClientIp only ever sees this one value (no cf-connecting-ip / x-forwarded-for).
  return getClientIp(new Headers({ "x-real-ip": v }));
}

export function rateLimitIdentity(headers: Headers): string {
  const ip = edgeClientIp(headers);
  if (!ip) return "unknown";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  // Hex form of an IPv4-mapped address (::ffff:7f00:1): key by the embedded IPv4.
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
  }
  return isIPv6(ip) ? ipv6Prefix64(ip) : ip;
}

export function clientKey(headers: Headers, secret: string): Buffer {
  return createHmac("sha256", secret).update(`perc-alloc-rl|${rateLimitIdentity(headers)}`).digest();
}
