/**
 * Rate-limit identity for the allocation lookup: HMAC-SHA256 of the client IP
 * under a server secret. The database only ever sees this 32-byte key, never
 * the IP. IPv6 is keyed by /64 so one host cannot rotate through its prefix.
 * Requests with no usable IP share one "unknown" bucket.
 *
 * IP resolution reuses the waitlist helper (cf-connecting-ip, then x-real-ip;
 * x-forwarded-for is ignored in production).
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

export function rateLimitIdentity(headers: Headers): string {
  const ip = getClientIp(headers);
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
