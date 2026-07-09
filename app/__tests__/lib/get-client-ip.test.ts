/**
 * GH#2218 — hardened shared client-IP extractor.
 *
 * The previous implementation trusted `x-forwarded-for` / `x-real-ip`
 * verbatim: any caller-controlled string became a rate-limit key or
 * blocklist input. The hardened version validates every candidate as a
 * real IPv4/IPv6 address and prefers proxy-set single-IP headers
 * (cf-connecting-ip, x-real-ip) over the client-influenced XFF chain,
 * mirroring the waitlist parser (lib/waitlist/client-ip.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getClientIp, isValidIp } from "@/lib/get-client-ip";

function makeReq(headers: Record<string, string>) {
  return new Request("https://example.com/api/test", { headers }) as never;
}

const ORIGINAL_DEPTH = process.env.TRUSTED_PROXY_DEPTH;

beforeEach(() => {
  delete process.env.TRUSTED_PROXY_DEPTH; // default depth = 1
});

afterEach(() => {
  if (ORIGINAL_DEPTH === undefined) delete process.env.TRUSTED_PROXY_DEPTH;
  else process.env.TRUSTED_PROXY_DEPTH = ORIGINAL_DEPTH;
});

describe("getClientIp header precedence", () => {
  it("prefers cf-connecting-ip over everything else", () => {
    const req = makeReq({
      "cf-connecting-ip": "203.0.113.7",
      "x-real-ip": "198.51.100.1",
      "x-forwarded-for": "192.0.2.1, 192.0.2.2",
    });
    expect(getClientIp(req)).toBe("203.0.113.7");
  });

  it("prefers x-real-ip over x-forwarded-for", () => {
    const req = makeReq({
      "x-real-ip": "198.51.100.1",
      "x-forwarded-for": "192.0.2.1, 192.0.2.2",
    });
    expect(getClientIp(req)).toBe("198.51.100.1");
  });

  it("uses the TRUSTED_PROXY_DEPTH hop of x-forwarded-for (rightmost at depth 1)", () => {
    const req = makeReq({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
    expect(getClientIp(req)).toBe("5.6.7.8");
  });

  it("uses the second-to-last hop at depth 2", () => {
    process.env.TRUSTED_PROXY_DEPTH = "2";
    const req = makeReq({ "x-forwarded-for": "9.9.9.9, 1.2.3.4, 5.6.7.8" });
    expect(getClientIp(req)).toBe("1.2.3.4");
  });

  it("returns unknown when no header is present", () => {
    expect(getClientIp(makeReq({}))).toBe("unknown");
  });
});

describe("getClientIp validation (GH#2218)", () => {
  it("rejects a non-IP x-real-ip instead of using it as an identity key", () => {
    const req = makeReq({ "x-real-ip": "fresh-bucket-please" });
    expect(getClientIp(req)).toBe("unknown");
  });

  it("rejects a non-IP cf-connecting-ip and falls through to x-real-ip", () => {
    const req = makeReq({
      "cf-connecting-ip": "not-an-ip",
      "x-real-ip": "198.51.100.1",
    });
    expect(getClientIp(req)).toBe("198.51.100.1");
  });

  it("returns unknown when the selected XFF hop is not an IP (no fallback to attacker-controlled hops)", () => {
    const req = makeReq({ "x-forwarded-for": "6.6.6.6, garbage" });
    expect(getClientIp(req)).toBe("unknown");
  });

  it("strips an IPv4 port suffix", () => {
    const req = makeReq({ "x-real-ip": "192.0.2.1:443" });
    expect(getClientIp(req)).toBe("192.0.2.1");
  });

  it("strips brackets and port from IPv6", () => {
    const req = makeReq({ "x-real-ip": "[2001:db8::1]:443" });
    expect(getClientIp(req)).toBe("2001:db8::1");
  });

  it("accepts a bare IPv6 address", () => {
    const req = makeReq({ "x-real-ip": "2001:db8::1" });
    expect(getClientIp(req)).toBe("2001:db8::1");
  });
});

describe("getClientIp TRUSTED_PROXY_DEPTH=0 (no trusted proxy)", () => {
  it("ignores all forwarding headers — every one is client-supplied", () => {
    process.env.TRUSTED_PROXY_DEPTH = "0";
    const req = makeReq({
      "cf-connecting-ip": "203.0.113.7",
      "x-real-ip": "198.51.100.1",
      "x-forwarded-for": "192.0.2.1",
    });
    expect(getClientIp(req)).toBe("unknown");
  });
});

describe("isValidIp", () => {
  it.each([
    "192.0.2.1",
    "0.0.0.0",
    "255.255.255.255",
    "::1",
    "::",
    "2001:db8::1",
    "2001:db8:0:0:0:0:0:1",
    "::ffff:192.0.2.1",
    "fe80::a:b:c:d",
  ])("accepts %s", (ip) => {
    expect(isValidIp(ip)).toBe(true);
  });

  it.each([
    "",
    "unknown",
    "1.2.3.4.5",
    "256.0.0.1",
    "01.2.3.4", // octal-ambiguous leading zero
    "1.2.3",
    "::::::",
    "a:b:c:d.e",
    "1::2::3",
    "1:2:3:4:5:6:7:8:9",
    "g::1",
    "192.0.2.1; DROP TABLE",
  ])("rejects %s", (ip) => {
    expect(isValidIp(ip)).toBe(false);
  });
});
