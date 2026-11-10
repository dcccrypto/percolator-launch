// @vitest-environment node
/**
 * Council r4 N11 + R3-12 — hardening of the existing tester gate.
 *  N11: the judge code must never ride in a URL (history/logs/Referer): GET /enter?judge= is refused.
 *  R3-12: `/images/../trade` (non-normalised) must not slip past the matcher's static-prefix skip or
 *         the gate's prefix exemptions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { isExempt } from "@/lib/playground-gate";

const SECRET = "s".repeat(40);
const JUDGE = "j".repeat(32);

describe("N11 /enter judge door is POST-only", () => {
  beforeEach(() => {
    vi.stubEnv("PLAYGROUND_ACCESS_SECRET", SECRET);
    vi.stubEnv("PLAYGROUND_JUDGE_ACCESS_CODE", JUDGE);
    vi.stubEnv("PLAYGROUND_TEAM_BYPASS_SECRET", "t".repeat(40));
  });
  afterEach(() => vi.unstubAllEnvs());

  it("GET ?judge=<correct code> -> /locked, no cookie", async () => {
    const { GET } = await import("@/app/enter/route");
    const res = await GET(new NextRequest(`https://x.test/enter?judge=${JUDGE}`));
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/locked");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("GET ?judge= is refused outright: it does not fall through to another door (pins the refusal branch)", async () => {
    const { GET } = await import("@/app/enter/route");
    // A valid team door alongside ?judge= would mint a cookie if the GET-refusal branch were removed.
    const ok = await GET(new NextRequest(`https://x.test/enter?team=${"t".repeat(40)}`));
    expect(ok.headers.get("set-cookie")).toContain("pg_access=");
    const res = await GET(new NextRequest(`https://x.test/enter?team=${"t".repeat(40)}&judge=anything`));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/locked");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("POST judge=<correct code> still mints the session", async () => {
    const { POST } = await import("@/app/enter/route");
    const body = new URLSearchParams({ judge: JUDGE });
    const res = await POST(
      new NextRequest("https://x.test/enter", {
        method: "POST",
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    );
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
    expect(res.headers.get("set-cookie")).toContain("pg_access=");
  });
});

describe("R3-12 dot-segment paths are gated", () => {
  const bad = [
    "/images/../trade",
    "/icons/../trade",
    "/audio/../trade",
    "/_next/../trade",
    "/_next/static/../../trade",
    "/token-metadata/../trade",
    "/charting_library/../trade",
    "/images/%2e%2e/trade",
    "/images/%2E%2E/trade",
    "/images/..%2ftrade",
    "/images/..\\trade",
    "/images/./../trade",
  ];
  it.each(bad)("isExempt(%s) is false", (p) => {
    expect(isExempt(p, "GET")).toBe(false);
  });
  it("normal asset paths stay exempt", () => {
    expect(isExempt("/images/logo.png", "GET")).toBe(true);
    expect(isExempt("/_next/static/chunks/a.js", "GET")).toBe(true);
  });

  it("matcher does not skip the proxy for dot-segment paths, but still skips real assets", async () => {
    const { config } = await import("@/middleware");
    const re = new RegExp("^" + config.matcher[0] + "$");
    for (const p of bad) expect(re.test(p), p).toBe(true);
    for (const p of ["/images/logo.png", "/icons/a.svg", "/_next/static/x.js", "/charting_library/a/b.js", "/favicon.ico"]) {
      expect(re.test(p), p).toBe(false);
    }
  });

  it("proxy 307s an unauthenticated /trade-bound request to /locked", async () => {
    vi.stubEnv("PLAYGROUND_GATE_ENABLED", "true");
    vi.stubEnv("PLAYGROUND_ACCESS_SECRET", SECRET);
    const { middleware } = await import("@/middleware");
    const res = await middleware(new NextRequest("https://x.test/images/../trade"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/locked");
    vi.unstubAllEnvs();
  });
});
