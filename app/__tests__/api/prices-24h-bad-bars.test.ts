/**
 * /api/prices/:slab 24h high/low must ignore garbage bars the same way the mini series does
 * (non-finite / <= 0), and must not depend on GeckoTerminal returning bars newest-first.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const NOW = 1_800_000_000;
const H = 3600;
type Bar = [number, number, number, number, number, number];
const bar = (hoursAgo: number, open: number, high: number, low: number, close: number): Bar => [NOW - hoursAgo * H, open, high, low, close, 1];

function stubGeckoRaw(list: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/api/markets/")) return Response.json({ market: { dex_pool_address: "POOL1" } });
    return Response.json({ data: { attributes: { ohlcv_list: list } } });
  }));
}

async function stats(slab: string) {
  const { GET } = await import("@/app/api/prices/[slab]/route");
  const res = await GET(new NextRequest(`https://play.percolator.trade/api/prices/${slab}`), { params: Promise.resolve({ slab }) });
  return (await res.json()).stats as { change24h: number; high24h: string; low24h: string; series?: number[] } | null;
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW * 1000); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

describe("/api/prices/:slab bad bars", () => {
  it("a zero low is ignored, not reported as low24h = 0", async () => {
    stubGeckoRaw([bar(0.5, 1.8, 2.0, 1.8, 2.0), bar(5, 1.0, 1.2, 0, 1.0)]);
    const s = await stats("9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn");
    expect(s?.low24h).toBe("1200000");
    expect(s?.high24h).toBe("2000000");
  });

  it("a negative low is ignored", async () => {
    stubGeckoRaw([bar(0.5, 1.8, 2.0, 1.8, 2.0), bar(5, 1.0, 1.2, -3, 1.0)]);
    const s = await stats("8EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn");
    expect(s?.low24h).toBe("1200000");
  });

  it("a null low (JSON) is ignored, not coerced to 0", async () => {
    stubGeckoRaw([bar(0.5, 1.8, 2.0, 1.8, 2.0), [NOW - 5 * H, 1, 1.2, null, 1.0, 1]]);
    const s = await stats("7EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn");
    expect(s?.low24h).toBe("1200000");
  });

  it("bars in ascending order give the same answer as newest-first", async () => {
    stubGeckoRaw([
      bar(100, 0.1, 9, 0.05, 0.2),
      bar(30, 0.9, 1.1, 0.9, 1.0),
      bar(10, 1.2, 2.2, 1.4, 1.5),
      bar(0.5, 1.8, 2.0, 1.8, 2.0),
    ]);
    const s = await stats("6EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn");
    expect(s?.change24h).toBeCloseTo(100);
    expect(s?.high24h).toBe("2200000");
    expect(s?.low24h).toBe("1000000");
    expect(s?.series).toEqual([1.0, 1.5, 2.0]);
  });

  it("shuffled bars give the same answer", async () => {
    stubGeckoRaw([
      bar(10, 1.2, 2.2, 1.4, 1.5),
      bar(100, 0.1, 9, 0.05, 0.2),
      bar(0.5, 1.8, 2.0, 1.8, 2.0),
      bar(30, 0.9, 1.1, 0.9, 1.0),
    ]);
    const s = await stats("5EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn");
    expect(s?.change24h).toBeCloseTo(100);
    expect(s?.series).toEqual([1.0, 1.5, 2.0]);
  });

  it("a single bar: change since its open, high/low from the bar", async () => {
    stubGeckoRaw([bar(0.5, 1.0, 2.0, 0.9, 1.5)]);
    const s = await stats("4EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn");
    expect(s?.change24h).toBeCloseTo(50);
    expect(s?.high24h).toBe("2000000");
    expect(s?.low24h).toBe("900000");
    expect(s?.series).toBeUndefined();
  });

  it("a huge (but finite) high does not throw", async () => {
    stubGeckoRaw([bar(0.5, 1, 1e30, 1, 1)]);
    const s = await stats("3EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn");
    expect(s?.high24h).toBe(BigInt(Math.round(1e30 * 1e6)).toString());
  });
});
