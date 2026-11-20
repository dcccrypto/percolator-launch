/** The live trade message carries the unit of its price (trades.price_lot_exp, via lib/chart/trade-feed.ts). */
import { describe, expect, it } from "vitest";
import { parseTradeMessage } from "@/lib/tv/data/tradeStream";

const S = "HBU9iugdcxdvQ9tNFuTLTtcB1bYXFdh4d5reD8M2dpop";
describe("parseTradeMessage priceLotExp", () => {
  it("keeps a recorded unit (0 = per token)", () => {
    expect(parseTradeMessage({ type: "trade", slab: S, price: 0.3, size: 1, timestamp: 2_000_000, priceLotExp: 0 }, S)).toEqual({ price: 0.3, size: 1, tsSec: 2000, priceLotExp: 0 });
  });
  it("null, absent or garbage: unit unknown (no field)", () => {
    for (const priceLotExp of [null, undefined, "0", 1.5, -1, 99]) {
      expect(parseTradeMessage({ type: "trade", slab: S, price: 0.3, size: 1, timestamp: 2_000_000, priceLotExp }, S)).toEqual({ price: 0.3, size: 1, tsSec: 2000 });
    }
  });
});
