// @vitest-environment node
/**
 * /api/candles Cache-Control on the real route handler (review nit: this used to be a regex over the route's
 * source). A closed window is edge-cached as history only when its bars cannot change: not when the lot scale
 * was unread (RPC blip), and not when a legacy row's scale (no trades.price_lot_exp) was decided against
 * today's mark, in the bars or in the fill seed (review low: a moving anchor pinned in the edge cache).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  lot: { lotExp: 1, anchor: 0.01 } as { lotExp: number; anchor: number | null; unknown?: true },
  aggDependent: false,
  seedDependent: false,
}));
vi.mock("@/lib/candle-lot-scale", () => ({ readCandleLotScale: async () => h.lot }));
vi.mock("@/lib/indexer-db", async (orig) => {
  const m = await orig<typeof import("@/lib/indexer-db")>();
  return {
    ...m,
    hasIndexerDb: () => true,
    queryCandlesAggregated: async () => ({
      udf: { s: "ok", t: [600], o: [0.05], h: [0.05], l: [0.05], c: [0.05], v: ["10"] },
      truncated: false,
      anchorDependent: h.aggDependent,
    }),
    queryLastTradeSeed: async () => ({ price: 0.05, anchorDependent: h.seedDependent }),
  };
});

const { NextRequest } = await import("next/server");
const { GET } = await import("@/app/api/candles/[slab]/route");
const SLAB = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
/** A window that closed long ago (from 600 to 1200 s after the epoch). */
const get = (fill: boolean) =>
  GET(new NextRequest(`http://localhost/api/candles/${SLAB}?resolution=1&from=600&to=1200${fill ? "&fill=1" : ""}`), { params: Promise.resolve({ slab: SLAB }) });
const cache = async (fill = false) => (await get(fill)).headers.get("cache-control") ?? "";
const HISTORY = /s-maxage=3600/;
const LIVE = /s-maxage=10\b/;

describe("/api/candles: Cache-Control of a closed window", () => {
  beforeEach(() => {
    h.lot = { lotExp: 1, anchor: 0.01 };
    h.aggDependent = false;
    h.seedDependent = false;
  });

  it("known lot scale, every row's unit recorded: cached as history", async () => {
    expect(await cache()).toMatch(HISTORY);
    expect(await cache(true)).toMatch(HISTORY);
  });
  it("lot scale unread (RPC blip): not cached as history", async () => {
    h.lot = { lotExp: 0, anchor: null, unknown: true };
    expect(await cache()).toMatch(LIVE);
  });
  it("a legacy row's scale came from today's mark: not cached as history", async () => {
    h.aggDependent = true;
    expect(await cache()).toMatch(LIVE);
  });
  it("only the fill seed came from today's mark: not cached as history (fill=1), unaffected without fill", async () => {
    h.seedDependent = true;
    expect(await cache(true)).toMatch(LIVE);
    expect(await cache(false)).toMatch(HISTORY);
  });
});
