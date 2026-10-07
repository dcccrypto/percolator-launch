/**
 * /api/prices/:slab 24h stats come from the last 24 HOURS, not the last 24 hourly bars.
 * GeckoTerminal leaves out hours with no trades, so on a quiet pool 24 bars reached days back
 * (measured 2026-10-05: 80 h and 127 h on two live Solana pools) and the badge showed a
 * multi-day move as "24h".
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const NOW = 1_800_000_000;
const H = 3600;
type Bar = [number, number, number, number, number, number];
/** [time, open, high, low, close] at `hoursAgo`. */
const bar = (hoursAgo: number, open: number, high: number, low: number, close: number): Bar => [NOW - hoursAgo * H, open, high, low, close, 1];

let seenUrls: string[] = [];
function stubGecko(bars: Bar[]) {
  seenUrls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    seenUrls.push(String(url));
    if (String(url).includes("/api/markets/")) return Response.json({ market: { dex_pool_address: "POOL1" } });
    return Response.json({ data: { attributes: { ohlcv_list: bars } } });
  }));
}

async function statsFull(slab: string) {
  const { GET } = await import("@/app/api/prices/[slab]/route");
  const res = await GET(new NextRequest(`https://play.percolator.trade/api/prices/${slab}`), { params: Promise.resolve({ slab }) });
  return (await res.json()).stats as { change24h: number; high24h: string; low24h: string; series?: number[] } | null;
}
const stats = statsFull;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW * 1000); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

describe("/api/prices/:slab 24h window", () => {
  it("a quiet pool: change is against the price 24h ago, high/low only from the last 24h (from the price it opened at)", async () => {
    // Newest first, with gaps (no trades in the missing hours). The 100 h-old bar must not count.
    stubGecko([
      bar(0.5, 1.8, 2.0, 1.8, 2.0),
      bar(10, 1.2, 2.2, 1.4, 1.5),
      bar(30, 0.9, 1.1, 0.9, 1.0), // last price at or before now-24h
      bar(100, 0.1, 9, 0.05, 0.2),
    ]);
    const s = await stats("9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn");
    expect(s?.change24h).toBeCloseTo(100); // 1.0 -> 2.0, not 0.1 -> 2.0 (+1900%)
    expect(s?.high24h).toBe("2200000");
    expect(s?.low24h).toBe("1000000"); // it opened at 1.0; the 100 h-old 0.05 doesn't count
  });

  it("a bar exactly at now-24h is the reference, not part of the window", async () => {
    stubGecko([bar(0.5, 1.8, 2.0, 1.8, 2.0), bar(24, 0.9, 5, 0.1, 1.0)]);
    const s = await stats("5EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn");
    expect(s?.change24h).toBeCloseTo(100);
    expect(s?.high24h).toBe("2000000");
    expect(s?.low24h).toBe("1000000");
  });

  it("asks for 25 bars, so a pool with a bar every hour still reaches past now-24h", async () => {
    stubGecko([bar(0.5, 1, 1, 1, 1)]);
    await stats("8EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn");
    expect(seenUrls.find((u) => u.includes("/ohlcv/"))).toContain("limit=25");
  });

  it("a pool younger than 24h: change since its first bar's open (as before)", async () => {
    stubGecko([bar(0.5, 1.8, 2.0, 1.8, 2.0), bar(5, 0.5, 1.2, 0.4, 1.0)]);
    const s = await stats("7EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn");
    expect(s?.change24h).toBeCloseTo(300); // 0.5 -> 2.0
    expect(s?.high24h).toBe("2000000");
    expect(s?.low24h).toBe("400000");
  });

  it("no trades in the last 24h: 0% and high = low = the last price", async () => {
    stubGecko([bar(30, 0.9, 1.1, 0.9, 1.0), bar(60, 0.5, 0.6, 0.4, 0.5)]);
    const s = await stats("6EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn");
    expect(s?.change24h).toBe(0);
    expect(s?.high24h).toBe("1000000");
    expect(s?.low24h).toBe("1000000");
  });
});

// The landing rail's "Chart 24h" mini chart: same window as the stats, so a quiet pool's line
// can't reach back days and its colour (first->last) always agrees with change24h.
describe("/api/prices/:slab mini chart series", () => {
  it("a quiet pool: covers only the last 24h (the reference close + bars newer than now-24h), oldest to newest", async () => {
    // Bars reach back 5 days. Without the cutoff the series would start at 0.2 (the 100 h-old close)
    // and read as a rise while the 24h move is a fall.
    stubGecko([
      bar(0.5, 1.2, 1.3, 1.0, 1.1),   // newest
      bar(10, 1.5, 1.6, 1.4, 1.5),
      bar(30, 1.9, 2.1, 1.8, 2.0),    // price at or before now-24h: the reference
      bar(60, 0.5, 0.6, 0.4, 0.5),
      bar(120, 0.1, 0.3, 0.1, 0.2),   // 5 days old
    ]);
    const s = await statsFull("4EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn");
    expect(s?.series).toEqual([2.0, 1.5, 1.1]); // reference, then in-window closes oldest->newest
    expect(s?.change24h).toBeCloseTo(-45); // 2.0 -> 1.1
    // Direction of the line agrees with the 24h change beside it.
    const first = s!.series![0];
    const lastV = s!.series![s!.series!.length - 1];
    expect(Math.sign(lastV - first)).toBe(Math.sign(s!.change24h));
  });

  it("a pool with no bar older than 24h: every bar is in the window, oldest to newest", async () => {
    stubGecko([bar(0.5, 1.8, 2.0, 1.8, 2.0), bar(5, 0.5, 1.2, 0.4, 1.0)]);
    const s = await statsFull("3EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn");
    expect(s?.series).toEqual([1.0, 2.0]);
  });

  it("fewer than two points: no series (the row draws nothing)", async () => {
    stubGecko([bar(30, 0.9, 1.1, 0.9, 1.0), bar(60, 0.5, 0.6, 0.4, 0.5)]);
    const s = await statsFull("2EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn");
    expect(s?.series).toBeUndefined();
  });
});

