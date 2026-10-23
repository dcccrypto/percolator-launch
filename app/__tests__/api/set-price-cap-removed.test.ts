// @vitest-environment node
/**
 * #3487: /api/oracle/set-price-cap — the "circuit breaker" #1691's closing comment and the
 * CRANK_KEYPAIR leak script told operators to run — could never apply a cap on v17/v18:
 * SetOraclePriceCap (v12 tag 16) is not in v17 and the SDK's encoder always throws. It answered
 * 200 with a generic per-market failure (or 503 without CRANK_KEYPAIR). The route, its tests, its
 * playground-gate exemption and its old-host passthrough entry were removed, and with
 * /api/oracle/advance-phase (#3476) also gone nothing in app/ reads CRANK_KEYPAIR.
 *
 * The gate's "every API route is classified" test only samples routes that exist, so a stale
 * exemption for a deleted path would pass it — and would silently exempt any route later
 * recreated there. Both exemption lists are therefore checked behaviourally here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isExempt } from "@/lib/playground-gate";

vi.mock("@upstash/redis", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Redis: vi.fn(function (this: any) { return this; }),
}));

const APP = resolve(__dirname, "..", "..");
const API_DIR = join(APP, "app", "api");
const PATH = "/api/oracle/set-price-cap";

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

function dirsNamed(name: string, dir = API_DIR): string[] {
  const hits: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const full = join(dir, e.name);
    if (e.name === name) hits.push(relative(API_DIR, full));
    hits.push(...dirsNamed(name, full));
  }
  return hits;
}

describe("#3487: the dead set-price-cap circuit breaker stays removed", () => {
  it("scans the app tree", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it.each([
    ["encodeSetOraclePriceCap", /\bencodeSetOraclePriceCap\b/],
    ["ACCOUNTS_SET_ORACLE_PRICE_CAP", /\bACCOUNTS_SET_ORACLE_PRICE_CAP\b/],
    ["set-price-cap", /set-price-cap/],
    ["a CRANK_KEYPAIR read", /process\.env(\.|\[\s*["'])CRANK_KEYPAIR/],
  ])("no app source mentions %s", (_label, re) => {
    const hits = files.filter((f) => re.test(readFileSync(f, "utf8"))).map((f) => relative(APP, f));
    expect(hits).toEqual([]);
  });

  it("the walk sees the API tree (guards the directory scan)", () => {
    expect(dirsNamed("resolve")).toEqual([join("oracle", "resolve")]);
  });

  it("has no set-price-cap directory anywhere under app/api (route groups included)", () => {
    expect(dirsNamed("set-price-cap")).toEqual([]);
    expect(existsSync(join(API_DIR, "oracle", "set-price-cap"))).toBe(false);
  });

  it("the playground gate no longer exempts the path", () => {
    expect(isExempt(PATH, "POST")).toBe(false);
    expect(isExempt("/api/oracle-keeper/register", "POST")).toBe(true); // the list itself still works
  });
});

describe("#3487: the old host no longer passes the path through", () => {
  const OLD = "percolator-playground.vercel.app";
  const req = (p: string, method: string) =>
    new NextRequest(`https://${OLD}${p}`, { method, headers: { host: OLD, "x-forwarded-for": "10.1.2.3" } });

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("PLAYGROUND_ACCESS_SECRET", "s".repeat(40));
    vi.stubEnv("PLAYGROUND_GATE_ENABLED", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("POST on the old host is redirected (308) like any non-passthrough path", async () => {
    const mw = (await import("@/middleware")).middleware as unknown as (r: NextRequest) => Promise<Response>;
    expect((await mw(req(PATH, "POST"))).status).toBe(308);
    expect((await mw(req("/api/oracle-keeper/register", "POST"))).status).not.toBe(308); // control: still passed through
  });
});
