// @vitest-environment node
/**
 * Issue #2862 fix 1: the old vercel.app production alias 308s to
 * play.percolator.trade (path + query kept), before the waitlist gate runs.
 * Runs the REAL middleware function.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@upstash/redis", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Redis: vi.fn(function (this: any) {
    return this;
  }),
}));

type Mw = (req: NextRequest) => Promise<Response>;
let middleware: Mw;

const OLD = "percolator-playground.vercel.app";
const SLAB = "AzagguvrH6sA8WvSFbYd5vV1zGZSeXP1oKm3uPq5RzYa";

function req(host: string, p: string, method = "GET") {
  return new NextRequest(`https://${host}${p}`, {
    method,
    headers: { host, "x-forwarded-for": `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
  });
}

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.stubEnv("PLAYGROUND_ACCESS_SECRET", "s".repeat(40));
  vi.stubEnv("PLAYGROUND_GATE_ENABLED", "true");
  middleware = (await import("@/middleware")).middleware as Mw;
});
afterEach(() => vi.unstubAllEnvs());

describe("old host redirect", () => {
  it.each([OLD, `www.${OLD}`])("%s -> 308 play.percolator.trade", async (host) => {
    const r = await middleware(req(host, "/"));
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe("https://play.percolator.trade/");
  });

  it.each(["/trade/" + SLAB, "/markets", "/earn", "/locked", "/enter"])("keeps path %s", async (p) => {
    const r = await middleware(req(OLD, p));
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe(`https://play.percolator.trade${p}`);
  });

  it("keeps the query string", async () => {
    const r = await middleware(req(OLD, "/trade/" + SLAB + "?ref=share&x=1"));
    expect(r.headers.get("location")).toBe(`https://play.percolator.trade/trade/${SLAB}?ref=share&x=1`);
  });

  it("redirects before the gate: no gate cookie, no /locked hop, gate on", async () => {
    const r = await middleware(req(OLD, "/trade/x"));
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).not.toContain("/locked");
    expect(r.headers.get("set-cookie")).toBeNull();
  });

  it("browser /api routes are redirected too (not left to 401)", async () => {
    const r = await middleware(req(OLD, "/api/rpc?network=devnet", "POST"));
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe("https://play.percolator.trade/api/rpc?network=devnet");
  });
});

describe("old host exclusions (not redirected)", () => {
  it.each([
    ["GET", "/token-metadata/sim-usdc.json"],
    ["GET", "/token-metadata/sim-usdc.svg"],
    ["GET", "/.well-known/x"],
    ["GET", "/api/health"],
    ["HEAD", "/api/health"],
    ["GET", "/api/playground/registered-markets"],
    ["PATCH", "/api/markets/" + SLAB],
    ["POST", "/api/oracle-keeper/register"],
    ["POST", "/api/oracle/set-price-cap"],
  ])("%s %s is served, not redirected", async (method, p) => {
    const r = await middleware(req(OLD, p, method));
    expect(r.status).not.toBe(308);
    expect(r.headers.get("location") ?? "").not.toContain("play.percolator.trade");
  });

  it("method-mismatched server route is still redirected (exclusion is exact)", async () => {
    const r = await middleware(req(OLD, "/api/health", "POST"));
    expect(r.status).toBe(308);
  });
});

describe("other hosts untouched", () => {
  it.each([
    "percolator-playground-git-fix-x-khubair-nasirs-projects.vercel.app",
    "percolator-playground-abc123-khubair-nasirs-projects.vercel.app",
    "localhost",
    "localhost:3000",
    "play.percolator.trade",
    "evil-percolator-playground.vercel.app",
    "percolator-playground.vercel.app.evil.com",
  ])("%s is not redirected to play", async (host) => {
    const r = await middleware(req(host, "/trade/x?y=1"));
    expect(r.headers.get("location") ?? "").not.toContain("https://play.percolator.trade/trade/x?y=1");
    expect(r.status).not.toBe(308);
  });
});
