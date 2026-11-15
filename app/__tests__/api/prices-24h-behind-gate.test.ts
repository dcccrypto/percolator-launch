// @vitest-environment node
/**
 * /api/prices/:slab looks the market's DEX pool up by calling /api/markets/[slab]'s handler DIRECTLY (it used to
 * fetch it over loopback HTTP, which needed the visitor's cookie forwarded past the waitlist gate: 2026-10-02
 * regression). A direct call never re-enters the gate, makes no loopback request, and still yields the 24h stats.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const h = vi.hoisted(() => ({ detail: vi.fn() }));
vi.mock("@/app/api/markets/[slab]/route", () => ({ GET: h.detail }));

const SLAB = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const bars = Array.from({ length: 24 }, (_, i) => [1_700_000_000 + i * 3600, 0.003, 0.004 + i * 0.0001, 0.002, 0.0035, 1]);

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); h.detail.mockReset(); });

function stubFetch() {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(String(url));
    return Response.json({ data: { attributes: { ohlcv_list: bars } } });
  }));
  return urls;
}
const call = async (cookie?: string) => {
  const { GET } = await import("@/app/api/prices/[slab]/route");
  const req = new NextRequest(`https://play.percolator.trade/api/prices/${SLAB}`, cookie ? { headers: { cookie } } : undefined);
  return (await GET(req, { params: Promise.resolve({ slab: SLAB }) })).json();
};

describe("/api/prices/:slab pool lookup is a direct call, not a loopback fetch", () => {
  it("calls the market-detail handler once with the slab, makes NO /api/markets HTTP request, and returns stats", async () => {
    h.detail.mockResolvedValue(Response.json({ market: { dex_pool_address: "POOL1" } }));
    const urls = stubFetch();
    const body = await call("pg_access=SESSION");
    expect(h.detail).toHaveBeenCalledTimes(1);
    const [req, ctx] = h.detail.mock.calls[0];
    expect(new URL(req.url).pathname).toBe(`/api/markets/${SLAB}`);
    expect(await ctx.params).toEqual({ slab: SLAB });
    expect(urls.some((u) => u.includes("/api/markets/"))).toBe(false);
    expect(urls.some((u) => u.includes("/pools/POOL1/ohlcv/hour"))).toBe(true);
    expect(body.stats?.high24h).toBeTruthy();
    expect(body.stats?.low24h).toBeTruthy();
  });

  it("a non-OK market response (404) gives null stats and never queries GeckoTerminal", async () => {
    h.detail.mockResolvedValue(Response.json({ error: "Market not found" }, { status: 404 }));
    const urls = stubFetch();
    expect((await call()).stats).toBeNull();
    expect(urls).toEqual([]);
  });

  it("a throwing handler degrades to null stats (still 200)", async () => {
    h.detail.mockRejectedValue(new Error("boom"));
    stubFetch();
    expect((await call()).stats).toBeNull();
  });

  it("a market without a pool address gives null stats", async () => {
    h.detail.mockResolvedValue(Response.json({ market: { dex_pool_address: null } }));
    stubFetch();
    expect((await call()).stats).toBeNull();
  });
});
