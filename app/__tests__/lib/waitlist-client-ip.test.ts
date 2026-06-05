/**
 * Header-precedence + IP-hashing tests for the waitlist client-IP helper.
 *
 * The route trusts header values from upstream proxies. Wrong precedence
 * here would let a client inject a fake IP via `x-forwarded-for` and
 * bypass the per-IP rate limit. The tests pin:
 *
 *   1. cf-connecting-ip wins over x-real-ip wins over x-forwarded-for.
 *   2. x-forwarded-for chain handling takes the LEFTMOST entry only.
 *   3. IPv6 bracketed-with-port is normalised.
 *   4. IPv4 with trailing port is stripped.
 *   5. Garbage in any header → null returned (route writes NULL).
 *   6. Hash requires a salt; returns null without one.
 *   7. Same IP + same salt → stable hash; different salt → different hash.
 */

import { describe, it, expect, afterEach } from "vitest";
import { getClientIp, hashIp } from "../../lib/waitlist/client-ip";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
afterEach(() => {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

function headers(map: Record<string, string>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(map)) h.set(k, v);
  return h;
}

describe("getClientIp", () => {
  it("prefers cf-connecting-ip over x-real-ip and x-forwarded-for", () => {
    const h = headers({
      "cf-connecting-ip": "203.0.113.10",
      "x-real-ip": "198.51.100.1",
      "x-forwarded-for": "192.0.2.1, 10.0.0.1",
    });
    expect(getClientIp(h)).toBe("203.0.113.10");
  });

  it("falls back to x-real-ip when cf-connecting-ip absent", () => {
    const h = headers({
      "x-real-ip": "198.51.100.1",
      "x-forwarded-for": "192.0.2.1, 10.0.0.1",
    });
    expect(getClientIp(h)).toBe("198.51.100.1");
  });

  it("falls back to leftmost x-forwarded-for entry when both above absent", () => {
    const h = headers({ "x-forwarded-for": "192.0.2.1, 10.0.0.1, 172.16.0.1" });
    expect(getClientIp(h)).toBe("192.0.2.1");
  });

  it("returns null when no forwarding header is present", () => {
    expect(getClientIp(headers({}))).toBeNull();
  });

  it("returns null when the header value is malformed garbage", () => {
    const h = headers({ "cf-connecting-ip": "not-an-ip!@#$" });
    expect(getClientIp(h)).toBeNull();
  });

  it("returns null when the header value is empty after trim", () => {
    const h = headers({ "x-forwarded-for": "   ,   ,   " });
    expect(getClientIp(h)).toBeNull();
  });

  it("strips the trailing port off an IPv4 with :port", () => {
    const h = headers({ "cf-connecting-ip": "192.0.2.1:51234" });
    expect(getClientIp(h)).toBe("192.0.2.1");
  });

  it("strips the brackets off a bracketed IPv6", () => {
    const h = headers({ "cf-connecting-ip": "[2001:db8::1]:443" });
    expect(getClientIp(h)).toBe("2001:db8::1");
  });

  it("returns a bare IPv6 unmodified", () => {
    const h = headers({ "cf-connecting-ip": "2001:db8::1" });
    expect(getClientIp(h)).toBe("2001:db8::1");
  });

  it("does not treat the colon in IPv6 as a port separator", () => {
    // Same hex format, no brackets — we must not strip after the first colon.
    const h = headers({ "cf-connecting-ip": "fe80::1" });
    expect(getClientIp(h)).toBe("fe80::1");
  });

  it("rejects implausibly long header values", () => {
    const h = headers({ "cf-connecting-ip": "1.2.3.4" + "5".repeat(100) });
    expect(getClientIp(h)).toBeNull();
  });

  // In production we refuse to trust x-forwarded-for entirely — CF or
  // Vercel set cf-connecting-ip / x-real-ip for legitimate traffic, so
  // a request reaching the XFF fallback in prod implies a spoofing
  // attempt (e.g., direct-to-Vercel bypassing Cloudflare).
  it("ignores x-forwarded-for fallback when NODE_ENV === production", () => {
    process.env.NODE_ENV = "production";
    expect(
      getClientIp(headers({ "x-forwarded-for": "192.0.2.1" })),
    ).toBeNull();
  });

  it("still trusts cf-connecting-ip in production", () => {
    process.env.NODE_ENV = "production";
    expect(
      getClientIp(headers({ "cf-connecting-ip": "203.0.113.10" })),
    ).toBe("203.0.113.10");
  });

  it("still trusts x-real-ip in production", () => {
    process.env.NODE_ENV = "production";
    expect(getClientIp(headers({ "x-real-ip": "198.51.100.1" }))).toBe(
      "198.51.100.1",
    );
  });

  // Regression: an earlier loose-regex validator accepted these as
  // "plausible," let them through to Postgres `inet` cast which
  // rejected them with 22P02, and crashed the signup INSERT. The
  // current `net.isIP()`-based check rejects them at the front door.
  it.each([
    "1.2.3.4.5",
    "::::::",
    "a:b:c:d.e",
    "............",
    "------",
    "999.999.999.999",
    "1.2.3",
    "g::1",
    "2001:db8::1::2",
  ])("rejects malformed IP-looking string %s", (bad) => {
    expect(getClientIp(headers({ "cf-connecting-ip": bad }))).toBeNull();
    expect(getClientIp(headers({ "x-real-ip": bad }))).toBeNull();
    expect(getClientIp(headers({ "x-forwarded-for": bad }))).toBeNull();
  });
});

describe("hashIp", () => {
  it("returns null when no salt is configured", () => {
    expect(hashIp("203.0.113.10", undefined)).toBeNull();
    expect(hashIp("203.0.113.10", null)).toBeNull();
    expect(hashIp("203.0.113.10", "")).toBeNull();
  });

  it("returns a 64-char hex string when a salt is configured", () => {
    const h = hashIp("203.0.113.10", "0123456789abcdef");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the same hash for the same ip + salt across calls", () => {
    const a = hashIp("203.0.113.10", "stable-salt-1234");
    const b = hashIp("203.0.113.10", "stable-salt-1234");
    expect(a).toBe(b);
  });

  it("returns different hashes when the salt changes", () => {
    const a = hashIp("203.0.113.10", "first-salt-abcde");
    const b = hashIp("203.0.113.10", "second-salt-xyzw");
    expect(a).not.toBe(b);
  });

  it("returns different hashes for different IPs under the same salt", () => {
    const a = hashIp("203.0.113.10", "shared-salt-1234");
    const b = hashIp("203.0.113.11", "shared-salt-1234");
    expect(a).not.toBe(b);
  });

  // Regression: previous version accepted any truthy salt. A one-char
  // salt only multiplies precompute cost by 256, leaving the IPv4
  // space brute-forceable in seconds. Min length 16 (≈ 128 bits) is
  // the standard salt floor.
  it.each(["x", "ab", "shortsalt"])(
    "returns null when salt is below 16 chars (%s)",
    (badSalt) => {
      expect(hashIp("203.0.113.10", badSalt)).toBeNull();
    },
  );

  it("accepts the boundary salt length of exactly 16 chars", () => {
    const h = hashIp("203.0.113.10", "x".repeat(16));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
