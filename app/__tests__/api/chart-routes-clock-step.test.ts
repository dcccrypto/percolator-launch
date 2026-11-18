/**
 * A backwards wall-clock step makes `Date.now() - at` negative; the route caches must treat that as
 * expired, not fresh (otherwise stale data is pinned for the size of the step).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { Keypair } from "@solana/web3.js";

const loadHistory = vi.fn();
vi.mock("@/lib/chart/history", () => ({ loadHistory: (...a: unknown[]) => loadHistory(...a) }));
vi.mock("@/lib/chart/pg-store", () => ({ getPgCandleStore: () => ({}) }));
vi.mock("@/lib/chart/gecko-backfill", () => ({ ensureOracleBackfill: vi.fn() }));
vi.mock("@/lib/registered-pool", () => ({ registeredPoolForSlab: vi.fn(async () => null) }));

import { GET as chartGET } from "../../app/api/chart/[mint]/route";
import { GET as perpGET } from "../../app/api/perp-chart/[slab]/route";

const T0 = new Date("2026-11-18T12:00:00Z").getTime();

describe("chart routes: backwards clock step", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("/api/chart: pool choice and candles are refetched after the clock steps back", async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const pool = Keypair.generate().publicKey.toBase58();
    let topPools = 0;
    let ohlcv = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("include=top_pools")) {
          topPools++;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: { relationships: { top_pools: { data: [{ id: `solana_${pool}` }] } } },
              included: [{ id: `solana_${pool}`, attributes: { address: pool } }],
            }),
          } as unknown as Response;
        }
        ohlcv++;
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { attributes: { ohlcv_list: [[1700000000, 1, 2, 0.5, 1.5, 10]] } } }),
        } as unknown as Response;
      }),
    );
    const call = () =>
      chartGET(new NextRequest(`http://localhost/api/chart/${mint}?timeframe=hour&aggregate=1&limit=24`), {
        params: Promise.resolve({ mint }),
      });

    await call();
    expect([topPools, ohlcv]).toEqual([1, 1]);
    await call(); // same instant: cached
    expect([topPools, ohlcv]).toEqual([1, 1]);

    vi.setSystemTime(T0 - 30 * 60 * 1000); // clock steps back 30 min
    await call();
    expect(ohlcv).toBe(2); // candle cache (45s ttl) must not be pinned
    expect(topPools).toBe(2); // pool cache must not be pinned either
  });

  it("/api/perp-chart: body is reloaded after the clock steps back", async () => {
    loadHistory.mockResolvedValue({ bars: [] });
    const slab = Keypair.generate().publicKey.toBase58();
    const call = () =>
      perpGET(new NextRequest(`http://localhost/api/perp-chart/${slab}?series=mark&resolution=1&to=1700000000`), {
        params: Promise.resolve({ slab }),
      });
    await call();
    await call();
    expect(loadHistory).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 - 60 * 1000);
    await call();
    expect(loadHistory).toHaveBeenCalledTimes(2);
  });
});
