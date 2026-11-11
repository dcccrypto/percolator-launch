// @vitest-environment node
/**
 * Door hardening: (1) the team code is accepted by POST only; (2) the gate exempts an explicit
 * allowlist of exact paths, never a pattern. Secrets here are generated in the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { isExempt, gateDecision } from "@/lib/playground-gate";

const SECRET = "a".repeat(48);
const TEAM = "b".repeat(48);

describe("/enter team code is POST only", () => {
  beforeEach(() => {
    vi.stubEnv("PLAYGROUND_ACCESS_SECRET", SECRET);
    vi.stubEnv("PLAYGROUND_TEAM_BYPASS_SECRET", TEAM);
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("GET ?team=<valid> does not set the cookie", async () => {
    const { GET } = await import("@/app/enter/route");
    const res = await GET(new NextRequest(`https://x.test/enter?team=${TEAM}`));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/locked");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("POST team=<valid> sets the cookie", async () => {
    const { POST } = await import("@/app/enter/route");
    const res = await POST(
      new NextRequest("https://x.test/enter", {
        method: "POST",
        body: new URLSearchParams({ team: TEAM }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    );
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
    expect(res.headers.get("set-cookie")).toContain("pg_access=");
  });

  it("GET /enter with no code still redirects to /locked without a cookie", async () => {
    const { GET } = await import("@/app/enter/route");
    const res = await GET(new NextRequest("https://x.test/enter"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/locked");
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("gate exemptions are an exact-path allowlist", () => {
  const env = { PLAYGROUND_GATE_ENABLED: "true", PLAYGROUND_ACCESS_SECRET: SECRET };

  it.each([
    "/x.txt",
    "/trade.png",
    "/.well-known/x",
    "/_vercel/x",
    "/favicon.ico",
    "/favicon.ico/x",
    "/foo/bar.svg",
    "/chart-empty-state.svg",
    "/manifest.webmanifest",
    "/images/logo.png",
    "/icons/chart-empty.svg",
    "/audio/percolator.mp3",
    "/tv-theme/percolator.css",
    "/charting_library/x.js",
    "/token-metadata/other.json",
    "/_next/data/x.json",
    "/_next/staticx",
    "/_next/image/x",
  ])("logged-out GET %s is gated", async (p) => {
    expect(isExempt(p, "GET")).toBe(false);
    expect(await gateDecision(p, "GET", null, env)).toBe("redirect-locked");
  });

  it.each([
    "/enter",
    "/locked",
    "/_next/static/chunks/a.js",
    "/_next/image",
    "/icon.png",
    "/robots.txt",
    "/sitemap.xml",
    "/opengraph-image",
    "/twitter-image",
    "/token-metadata/sim-usdc.json",
    "/token-metadata/sim-usdc.svg",
    "/_vercel/insights/script.js",
  ])("allowlisted GET %s passes logged-out", async (p) => {
    expect(await gateDecision(p, "GET", null, env)).toBe("pass");
  });

  it("insights beacons are exact and method-specific", () => {
    expect(isExempt("/_vercel/insights/view", "POST")).toBe(true);
    expect(isExempt("/_vercel/insights/event", "POST")).toBe(true);
    expect(isExempt("/_vercel/insights/view", "GET")).toBe(false);
    expect(isExempt("/_vercel/insights/script.js", "POST")).toBe(false);
    expect(isExempt("/_vercel/insights/other", "POST")).toBe(false);
  });
});

describe("matcher sends every non-build path through the gate", () => {
  async function runs(p: string): Promise<boolean> {
    const { config } = await import("@/middleware");
    return new RegExp("^" + config.matcher[0] + "$").test(p);
  }
  it.each(["/x.txt", "/trade.png", "/.well-known/x", "/_vercel/x", "/favicon.ico", "/favicon.ico/x", "/foo/bar.svg", "/images/logo.png", "/_next/image/x", "/_next/staticx"])(
    "runs on %s",
    async (p) => expect(await runs(p)).toBe(true),
  );
  it.each(["/_next/static/chunks/a.js", "/_next/image"])("skips %s", async (p) => expect(await runs(p)).toBe(false));
});
