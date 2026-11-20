/**
 * J-20261120 CANDLESPROVIDERLOTEXP (#3994 review S4): /api/candles answers PER-TOKEN prices on a lot market
 * (lib/candle-lot-scale.ts + CANDLE_AGG_SQL normalise in SQL), so the TV chart provider must not divide history by
 * 10^lot_exp again. Volume is unchanged by #3994 (raw engine size, lots) and is still put on tokens by the provider.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCandlesApiProvider } from "@/lib/tv/data/candlesApiProvider";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

beforeAll(() => { process.env.NEXT_PUBLIC_V22_INDEXER_LOT_AWARE = "1"; });
afterAll(() => { delete process.env.NEXT_PUBLIC_V22_INDEXER_LOT_AWARE; });
beforeEach(() => __setDevnetV22ForTest(true));
afterEach(() => __setDevnetV22ForTest(null));

const SLAB = "HBU9iugdcxdvQ9tNFuTLTtcB1bYXFdh4d5reD8M2dpop";
/** What /api/candles answers after #3994: per-token prices, volume as exact text in raw engine units. */
const API = { s: "ok", t: [960, 1020], o: [0.06, 0.063], h: [0.066, 0.064], l: [0.054, 0.061], c: [0.063, 0.062], v: ["2", "5"] };

function mk(lotExp: number) {
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.startsWith("/api/markets/")) {
      return new Response(JSON.stringify({ market: { symbol: "TOK", mark_price: 0.06, ...(lotExp ? { lot_exp: lotExp } : {}) } }), { status: 200 });
    }
    return new Response(JSON.stringify(API), { status: 200 });
  });
  const provider = createCandlesApiProvider({
    fetchImpl: fetchImpl as never,
    trades: { subscribe: vi.fn(() => () => {}) } as never,
    marks: { subscribe: vi.fn(() => () => {}), latest: vi.fn(() => null) } as never,
  });
  return provider;
}

const req = { slab: SLAB, resolution: "1", fromSec: 900, toSec: 1100, countBack: 2, firstRequest: true } as never;

describe("candlesApiProvider history on a lot market (API already per token)", () => {
  it.each([1, 3, 6])("lot_exp %i: bar prices equal the API's per-token prices (no second 10^k division)", async (k) => {
    const provider = mk(k);
    await provider.resolveSymbol(SLAB);
    const { bars } = await provider.getBars(req);
    expect(bars.map((b) => [b.timeSec, b.open, b.high, b.low, b.close])).toEqual(
      API.t.map((t, i) => [t, API.o[i], API.h[i], API.l[i], API.c[i]]),
    );
    // Volume: the API's raw (per-lot) size sum, put on tokens as before.
    expect(bars.map((b) => b.volume)).toEqual([2 * 10 ** k, 5 * 10 ** k]);
  });

  it("lot_exp unknown until getBars (no resolveSymbol first): same per-token prices", async () => {
    const { bars } = await mk(3).getBars(req);
    expect(bars.map((b) => b.close)).toEqual(API.c);
  });

  it("control lot_exp 0: prices and volume pass through unchanged", async () => {
    const provider = mk(0);
    await provider.resolveSymbol(SLAB);
    const { bars } = await provider.getBars(req);
    expect(bars.map((b) => [b.timeSec, b.open, b.high, b.low, b.close, b.volume])).toEqual(
      API.t.map((t, i) => [t, API.o[i], API.h[i], API.l[i], API.c[i], Number(API.v[i])]),
    );
  });
});
