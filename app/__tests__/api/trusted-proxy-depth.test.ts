/**
 * #3483: TRUSTED_PROXY_DEPTH was parsed in three places as `Math.max(0, Number(raw ?? 1))`, so
 * "abc", "", "-1" and "1.5" skipped (or indexed past) the X-Forwarded-For peel, and each copy then
 * failed differently: getClientIp trusted the caller's x-real-ip, the middleware limiter put every
 * client in one "unknown" bucket, and the IP blocklist went silently off. All three now use
 * lib/trusted-proxy-depth.ts, and depth 0 ("no proxy") trusts no forwarded header in getClientIp.
 *
 * Each call site is pinned on its own with every invalid shape, and the middleware cases use a
 * two-hop X-Forwarded-For (caller-written left hop, platform-appended right hop) so a wrong depth
 * is visible: with one hop every positive depth clamps to the same entry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REAL = "203.0.113.7";      // platform-appended (rightmost) hop
const SPOOF = "198.51.100.66";   // caller-written hop / x-real-ip
const INVALID = ["abc", "", "-1", "1.5"];

function req(path: string, xff: string | null, realIp?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (xff !== null) headers["x-forwarded-for"] = xff;
  if (realIp) headers["x-real-ip"] = realIp;
  return new NextRequest(`http://localhost${path}`, { headers });
}

const ENV_KEYS = ["TRUSTED_PROXY_DEPTH", "IP_BLOCKLIST", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "PLAYGROUND_GATE_ENABLED"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  vi.resetModules();
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.restoreAllMocks();
});

describe("trustedProxyDepth()", () => {
  it.each([
    [undefined, 1], ["", 1], ["  ", 1],
    ["0", 0], ["1", 1], ["2", 2], [" 2 ", 2], ["01", 1], ["8", 8],
    ["9", 1], ["999", 1], ["99999999999999999999", 1], ["Infinity", 1],
    ["abc", 1], ["-1", 1], ["1.5", 1], ["2.0", 1], ["1e1", 1], ["0x2", 1], ["+1", 1], ["2abc", 1],
  ] as const)("%j -> %d", async (raw, want) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { trustedProxyDepth } = await import("@/lib/trusted-proxy-depth");
    expect(trustedProxyDepth(raw)).toBe(want);
  });

  it("reads the env on every call (not cached at import)", async () => {
    const { trustedProxyDepth } = await import("@/lib/trusted-proxy-depth");
    process.env.TRUSTED_PROXY_DEPTH = "2";
    expect(trustedProxyDepth()).toBe(2);
    process.env.TRUSTED_PROXY_DEPTH = "0";
    expect(trustedProxyDepth()).toBe(0);
  });

  it("logs one error per distinct bad value, none for good ones", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { trustedProxyDepth } = await import("@/lib/trusted-proxy-depth");
    for (const v of ["abc", "abc", "1.5", "1", undefined, "abc"]) trustedProxyDepth(v);
    expect(err).toHaveBeenCalledTimes(2);
  });
});

describe("getClientIp", () => {
  const ip = async (depth: string | undefined, xff: string | null, realIp?: string) => {
    if (depth !== undefined) process.env.TRUSTED_PROXY_DEPTH = depth;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { getClientIp } = await import("@/lib/get-client-ip");
    return getClientIp(req("/api/x", xff, realIp));
  };

  it("default depth -> the platform hop", async () => {
    expect(await ip(undefined, `${SPOOF}, ${REAL}`, SPOOF)).toBe(REAL);
  });

  it.each(INVALID)("TRUSTED_PROXY_DEPTH=%j -> the platform hop, not the caller's x-real-ip", async (v) => {
    expect(await ip(v, `${SPOOF}, ${REAL}`, SPOOF)).toBe(REAL);
  });

  it("an over-cap depth falls back to 1 instead of clamping to the caller's left hop", async () => {
    expect(await ip("999", `${SPOOF}, ${REAL}`, SPOOF)).toBe(REAL);
  });

  it("depth 2 peels two hops", async () => {
    expect(await ip("2", `${SPOOF}, ${REAL}, 10.0.0.9`)).toBe(REAL);
  });

  it("depth 0 (no proxy) trusts neither forwarded header", async () => {
    expect(await ip("0", `${SPOOF}, ${REAL}`, SPOOF)).toBe("unknown");
  });

  it("behind a proxy with no X-Forwarded-For, x-real-ip is still the fallback (#2194)", async () => {
    expect(await ip(undefined, null, REAL)).toBe(REAL);
  });
});

type Mw = (r: NextRequest) => Promise<Response>;
const loadMiddleware = async (): Promise<Mw> => (await import("@/middleware")).middleware as unknown as Mw;

describe("middleware rate limiter keys on the resolved client", () => {
  it.each([undefined, ...INVALID])("TRUSTED_PROXY_DEPTH=%j: client A is limited, client B is not", async (v) => {
    if (v !== undefined) process.env.TRUSTED_PROXY_DEPTH = v;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mw = await loadMiddleware();
    // Client A rotates the caller-written hop every request; only its real hop is stable.
    for (let i = 0; i < 120; i++) {
      expect((await mw(req("/api/markets", `10.9.${i >> 8}.${i & 255}, 10.0.0.1`))).status).not.toBe(429);
    }
    expect((await mw(req("/api/markets", "10.9.9.9, 10.0.0.1"))).status).toBe(429);
    expect((await mw(req("/api/markets", "10.9.9.9, 10.0.0.2"))).status).not.toBe(429);
  });
});

describe("middleware IP blocklist applies", () => {
  it.each([undefined, ...INVALID])("TRUSTED_PROXY_DEPTH=%j: the blocklisted real hop gets 403", async (v) => {
    if (v !== undefined) process.env.TRUSTED_PROXY_DEPTH = v;
    process.env.IP_BLOCKLIST = REAL;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mw = await loadMiddleware();
    expect((await mw(req("/api/markets", `1.1.1.1, ${REAL}`))).status).toBe(403);
  });

  it("warns once at load when a blocklist is set but depth is 0", async () => {
    process.env.TRUSTED_PROXY_DEPTH = "0";
    process.env.IP_BLOCKLIST = REAL;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await loadMiddleware();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("TRUSTED_PROXY_DEPTH=0"))).toHaveLength(1);
  });
});

describe("guard: only lib/trusted-proxy-depth.ts reads TRUSTED_PROXY_DEPTH", () => {
  const APP = resolve(__dirname, "..", "..");
  const HELPER = "lib/trusted-proxy-depth.ts";
  const SKIP = new Set(["node_modules", ".next", "__tests__", "e2e", "coverage", "test-results", "playwright-report"]);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.|\.spec\./.test(name)) files.push(p);
    }
  };
  walk(APP);
  const READ = /process\.env(\.|\[\s*["'])TRUSTED_PROXY_DEPTH/;

  it("scans the app tree", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("no other source reads the variable", () => {
    const hits = files.map((f) => relative(APP, f).replace(/\\/g, "/")).filter((f) => READ.test(readFileSync(join(APP, f), "utf8")));
    expect(hits).toEqual([HELPER]);
  });

  it("the helper imports nothing (middleware runs on the Edge runtime)", () => {
    expect(readFileSync(join(APP, HELPER), "utf8")).not.toMatch(/^\s*import\s/m);
  });
});
