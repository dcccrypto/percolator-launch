/**
 * J-20261120 CANDLESPROVIDERLOTEXP (#3994 review S4): /api/candles answers PER-TOKEN prices on a lot market
 * (lib/candle-lot-scale.ts + CANDLE_AGG_SQL normalise in SQL), so the TV chart provider must not divide history by
 * 10^lot_exp again. Volume is unchanged by #3994 (raw engine size, lots) and is still put on tokens by the provider.
 *
 * Live trades on the price-WS `trades:<slab>` channel are the same units as /api/candles (raw `trades.price` from
 * the table; newer rows are per token). subscribeBars must not divide those prices by 10^k. Size is still engine Q
 * in lots, so it is still multiplied. Mark ticks come from the price store, which keeps per-LOT prices, and are
 * still divided.
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

function mk(lotExp: number, extras?: { trades?: { subscribe: ReturnType<typeof vi.fn> }; marks?: { subscribe: ReturnType<typeof vi.fn>; latest: ReturnType<typeof vi.fn> } }) {
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.startsWith("/api/markets/")) {
      return new Response(JSON.stringify({ market: { symbol: "TOK", mark_price: 0.06, ...(lotExp ? { lot_exp: lotExp } : {}) } }), { status: 200 });
    }
    return new Response(JSON.stringify(API), { status: 200 });
  });
  const trades = extras?.trades ?? { subscribe: vi.fn(() => () => {}) };
  const marks = extras?.marks ?? { subscribe: vi.fn(() => () => {}), latest: vi.fn(() => null) };
  const provider = createCandlesApiProvider({
    fetchImpl: fetchImpl as never,
    trades: trades as never,
    marks: marks as never,
  });
  return { provider, trades, marks };
}

const req = { slab: SLAB, resolution: "1", fromSec: 900, toSec: 1100, countBack: 2, firstRequest: true } as never;

describe("candlesApiProvider history on a lot market (API already per token)", () => {
  it.each([1, 3, 6])("lot_exp %i: bar prices equal the API's per-token prices (no second 10^k division)", async (k) => {
    const { provider } = mk(k);
    await provider.resolveSymbol(SLAB);
    const { bars } = await provider.getBars(req);
    expect(bars.map((b) => [b.timeSec, b.open, b.high, b.low, b.close])).toEqual(
      API.t.map((t, i) => [t, API.o[i], API.h[i], API.l[i], API.c[i]]),
    );
    // Volume: the API's raw (per-lot) size sum, put on tokens as before.
    expect(bars.map((b) => b.volume)).toEqual([2 * 10 ** k, 5 * 10 ** k]);
  });

  it("lot_exp unknown until getBars (no resolveSymbol first): same per-token prices", async () => {
    const { bars } = await mk(3).provider.getBars(req);
    expect(bars.map((b) => b.close)).toEqual(API.c);
  });

  it("control lot_exp 0: prices and volume pass through unchanged", async () => {
    const { provider } = mk(0);
    await provider.resolveSymbol(SLAB);
    const { bars } = await provider.getBars(req);
    expect(bars.map((b) => [b.timeSec, b.open, b.high, b.low, b.close, b.volume])).toEqual(
      API.t.map((t, i) => [t, API.o[i], API.h[i], API.l[i], API.c[i], Number(API.v[i])]),
    );
  });
});

describe("candlesApiProvider subscribeBars on a lot market (live trades already per token)", () => {
  it.each([1, 3, 6])("lot_exp %i: live trade prices equal the feed's per-token prices (no 10^k division); size still x10^k", async (k) => {
    const trades = { subscribe: vi.fn() };
    const { provider } = mk(k, { trades });
    await provider.resolveSymbol(SLAB);
    const bars: Array<{ close: number; volume: number }> = [];
    provider.subscribeBars(SLAB, "1", { onBar: (b: { close: number; volume: number }) => bars.push(b), onReset: () => {} } as never, null, "percolator");
    trades.subscribe.mock.calls[0][1]({ price: 0.063, size: 2, tsSec: 2000 });
    expect(bars).toHaveLength(1);
    expect(bars[0].close).toBeCloseTo(0.063, 12);
    expect(bars[0].volume).toBe(2 * 10 ** k);
  });

  it("control lot_exp 0: live trade price and size pass through", async () => {
    const trades = { subscribe: vi.fn() };
    const { provider } = mk(0, { trades });
    await provider.resolveSymbol(SLAB);
    const bars: Array<{ close: number; volume: number }> = [];
    provider.subscribeBars(SLAB, "1", { onBar: (b: { close: number; volume: number }) => bars.push(b), onReset: () => {} } as never, null, "percolator");
    trades.subscribe.mock.calls[0][1]({ price: 0.063, size: 2, tsSec: 2000 });
    expect(bars[0].close).toBeCloseTo(0.063, 12);
    expect(bars[0].volume).toBe(2);
  });

  it("lot_exp 3: mark ticks from the price store stay per-lot and are still divided", async () => {
    const marks = { subscribe: vi.fn(), latest: vi.fn(() => 63) };
    const { provider } = mk(3, { marks });
    await provider.resolveSymbol(SLAB);
    const bars: Array<{ close: number }> = [];
    provider.subscribeBars(SLAB, "1", { onBar: (b: { close: number }) => bars.push(b), onReset: () => {} } as never, null, "oracle");
    marks.subscribe.mock.calls[0][1](63, 3000);
    expect(bars).toHaveLength(1);
    expect(bars[0].close).toBeCloseTo(0.063, 12);
  });
});
