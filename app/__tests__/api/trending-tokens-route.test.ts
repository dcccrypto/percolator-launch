// @vitest-environment node
/**
 * /api/trending-tokens cache policy: a healthy answer is CDN-cached 60s and memoised
 * in-process for 60s (one upstream pass per minute per instance — GeckoTerminal's
 * keyless budget is shared with the chart route); an all-sources-down answer is
 * cached only briefly and NOT memoised, so recovery shows up fast. Never a 500.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ getTrendingTokens: vi.fn() }));
vi.mock("@/lib/trending-tokens", () => ({ getTrendingTokens: h.getTrendingTokens }));

const ok = { tokens: [{ mint: "x" }], generatedAt: "t", sourceEmpty: false, sources: { geckoterminal: "ok", pumpfun: "error" } };
const down = { tokens: [], generatedAt: "t", sourceEmpty: true, sources: { geckoterminal: "error", pumpfun: "error" } };

async function load() {
  vi.resetModules();
  return (await import("@/app/api/trending-tokens/route")).GET;
}

// Call counts are cleared by the global afterEach (vi.clearAllMocks in __tests__/setup.ts).
afterEach(() => vi.useRealTimers());

describe("GET /api/trending-tokens", () => {
  it("caches a healthy answer at the CDN and memoises it for 60s", async () => {
    vi.useFakeTimers();
    const GET = await load();
    h.getTrendingTokens.mockResolvedValue(ok);
    const r1 = await GET();
    expect(r1.headers.get("cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=300");
    expect(await r1.json()).toEqual(ok);
    await GET();
    expect(h.getTrendingTokens).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(61_000);
    await GET();
    expect(h.getTrendingTokens).toHaveBeenCalledTimes(2);
  });

  it("caches 'sources unavailable' only briefly and does not memoise it", async () => {
    const GET = await load();
    h.getTrendingTokens.mockResolvedValue(down);
    const r = await GET();
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("public, s-maxage=15, stale-while-revalidate=30");
    expect((await r.json()).sourceEmpty).toBe(true);
    await GET();
    expect(h.getTrendingTokens).toHaveBeenCalledTimes(2);
  });

  it("never 500s: an unexpected throw returns sourceEmpty, no-store", async () => {
    const GET = await load();
    h.getTrendingTokens.mockImplementation(() => {
      throw new Error("boom");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await GET();
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toMatchObject({ tokens: [], sourceEmpty: true });
    warn.mockRestore();
  });
});
