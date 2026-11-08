/**
 * Helpers behind POST /api/allocation/check: exact formatting, strict
 * single-wallet parsing, fail-closed server config, and IP keying.
 */
import { describe, expect, it, vi, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

import { formatCents, formatUnits } from "@/lib/allocation-vote/check-result";
import { checkEnvelope, parseCheckJson } from "@/lib/allocation-vote/check-request";
import { readAllocationConfig } from "@/lib/allocation-vote/server-config";
import { clientKey, ipv6Prefix64, rateLimitIdentity } from "@/lib/allocation-vote/client-key";

describe("exact formatting (no floats)", () => {
  it.each([
    ["0", 6, "0"],
    ["1", 6, "0.000001"],
    ["1000000", 6, "1"],
    ["1234567890123", 6, "1234567.890123"],
    ["18446744073709551615", 6, "18446744073709.551615"],
    ["120", 0, "120"],
  ])("formatUnits(%s, %d) = %s", (raw, d, out) => expect(formatUnits(raw, d)).toBe(out));

  it.each(["-1", "1.5", "", "01", "1e3"])("formatUnits rejects %j", (raw) => expect(() => formatUnits(raw, 6)).toThrow());

  it.each([
    ["0", "0.00"],
    ["5", "0.05"],
    ["12345", "123.45"],
    ["5000000", "50000.00"],
    ["9007199254740993", "90071992547409.93"],
  ])("formatCents(%s) = %s", (c, out) => expect(formatCents(c)).toBe(out));
});

describe("single-wallet parsing", () => {
  const W = "11111111111111111111111111111111";
  it("accepts exactly one wallet, trimmed", () => {
    expect(parseCheckJson(JSON.stringify({ wallet: `  ${W}\n` }))).toEqual({ ok: true, owner: W });
  });
  it.each([
    ['{"__proto__": {"wallet": "x"}}'],
    ['{"wallet": "' + W + '", "wallet2": "' + W + '"}'],
    ['["' + W + '"]'],
    ['"' + W + '"'],
    ["null"],
    ["{}"],
    ['{"wallet": {"toString": "' + W + '"}}'],
  ])("rejects %s", (body) => {
    const r = parseCheckJson(body);
    expect(r.ok).toBe(false);
  });
  it("duplicate keys collapse in JSON.parse; the last value is still validated", () => {
    expect(parseCheckJson(`{"wallet": "${W}", "wallet": "bad"}`).ok).toBe(false);
  });
  it.each([
    ["text/plain", null, 415],
    ["application/jsonx", null, 415],
    ["application/json", "1025", 413],
  ])("envelope %s / %s -> %d", (t, l, s) => expect(checkEnvelope(t, l)?.status).toBe(s));
  it("envelope accepts application/json with charset", () => {
    expect(checkEnvelope("application/json; charset=utf-8", "40")).toBeNull();
  });
});

describe("server config fails closed", () => {
  const S = "s".repeat(32);
  const env = (url: string | undefined, secret: string | undefined = S, ca?: string) =>
    ({ ALLOCATION_DATABASE_URL: url, ALLOCATION_RATE_LIMIT_SECRET: secret, ALLOCATION_DATABASE_CA_PEM: ca }) as unknown as NodeJS.ProcessEnv;

  it("local reader: no TLS", () => {
    expect(readAllocationConfig(env("postgresql://perc_alloc_reader:pw@127.0.0.1:5432/app"))).toMatchObject({ ssl: null, secret: S });
  });
  it("remote reader (Supavisor user form): always verified TLS, URL ssl params stripped", () => {
    const c = readAllocationConfig(env("postgres://perc_alloc_reader.abcdef:pw@pooler.example.com:6543/postgres?sslmode=disable&ssl=false&sslrootcert=/x"))!;
    expect(c.ssl).toEqual({ rejectUnauthorized: true });
    expect(c.connectionString).not.toMatch(/\?/);
  });
  it("optional CA is passed through for verification", () => {
    expect(readAllocationConfig(env("postgres://perc_alloc_reader:pw@db.example.com/p", S, "-----BEGIN CERTIFICATE-----x"))!.ssl).toEqual({
      rejectUnauthorized: true,
      ca: "-----BEGIN CERTIFICATE-----x",
    });
  });
  it.each([
    [undefined, S],
    ["postgresql://perc_alloc_reader:pw@127.0.0.1/app", ""],
    ["postgresql://perc_alloc_reader:pw@127.0.0.1/app", "x".repeat(31)],
    ["postgresql://postgres:pw@127.0.0.1/app", S],
    ["postgresql://perc_alloc_readerx:pw@127.0.0.1/app", S],
    ["postgresql://service_role.perc_alloc_reader:pw@127.0.0.1/app", S],
    ["mysql://perc_alloc_reader:pw@127.0.0.1/app", S],
    ["not a url", S],
    ["postgresql://perc_alloc_reader:pw@127.0.0.1/app?host=evil.example", S],
    ["postgresql://perc_alloc_reader:pw@127.0.0.1/app?hostaddr=203.0.113.9", S],
    ["postgresql://perc_alloc_reader:pw@127.0.0.1/app?port=6543", S],
    ["postgresql://perc_alloc_reader:pw@127.0.0.1/app?options=-csearch_path%3Dx", S],
    ["postgresql://perc_alloc_reader:pw@127.0.0.1/app?service=x", S],
  ])("refuses url=%j", (url, secret) => expect(readAllocationConfig(env(url, secret))).toBeNull());
});

describe("rate-limit identity", () => {
  const prod = (h: Record<string, string>) => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      return rateLimitIdentity(new Headers(h));
    } finally {
      vi.unstubAllEnvs();
    }
  };
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"],
    ["2001:db8:1:2::9", "2001:db8:1:2::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["2001:0db8:0001:0002::", "2001:db8:1:2::/64"],
  ])("ipv6Prefix64(%s) = %s", (ip, out) => expect(ipv6Prefix64(ip)).toBe(out));

  it("one IPv6 /64 is one identity", () => {
    expect(prod({ "x-real-ip": "2001:db8:1:2::aaaa" })).toBe(prod({ "x-real-ip": "2001:db8:1:2:ffff::1" }));
    expect(prod({ "x-real-ip": "2001:db8:1:2::aaaa" })).not.toBe(prod({ "x-real-ip": "2001:db8:1:3::aaaa" }));
  });
  it("IPv4-mapped IPv6 is keyed as the IPv4 address", () => {
    expect(prod({ "x-real-ip": "::ffff:203.0.113.5" })).toBe("203.0.113.5");
    expect(prod({ "x-real-ip": "::ffff:cb00:7105" })).toBe("203.0.113.5");
    expect(prod({ "x-real-ip": "::ffff:7f00:1" })).toBe("127.0.0.1");
  });
  it("in production x-forwarded-for is ignored (no spoofed rotation via XFF); no IP -> shared 'unknown'", () => {
    expect(prod({ "x-forwarded-for": "198.51.100.1" })).toBe("unknown");
    expect(prod({})).toBe("unknown");
  });
  it("client-settable cf-connecting-ip / x-forwarded-for never change the identity (origin is not behind Cloudflare)", () => {
    const real = prod({ "x-real-ip": "203.0.113.5" });
    for (let i = 0; i < 5; i++) {
      expect(prod({ "x-real-ip": "203.0.113.5", "cf-connecting-ip": `198.51.100.${i}`, "x-forwarded-for": `192.0.2.${i}` })).toBe(real);
    }
    expect(prod({ "cf-connecting-ip": "198.51.100.1" })).toBe("unknown");
    expect(real).toBe("203.0.113.5");
  });
  it("falls back to the first x-vercel-forwarded-for entry; garbage is 'unknown'", () => {
    expect(prod({ "x-vercel-forwarded-for": "203.0.113.9, 10.0.0.1" })).toBe("203.0.113.9");
    expect(prod({ "x-real-ip": "not-an-ip" })).toBe("unknown");
    expect(prod({ "x-real-ip": "203.0.113.5:443" })).toBe("203.0.113.5");
  });
  it("key is a 32-byte HMAC that depends on the secret", () => {
    const h = new Headers({ "x-real-ip": "203.0.113.5" });
    const a = clientKey(h, "a".repeat(32));
    expect(a.length).toBe(32);
    expect(a.equals(clientKey(h, "a".repeat(32)))).toBe(true);
    expect(a.equals(clientKey(h, "b".repeat(32)))).toBe(false);
  });
});
