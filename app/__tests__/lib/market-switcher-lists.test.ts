import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/listed-markets", () => ({ isBrowsableMarketRow: (slab: string) => slab !== "HIDDEN" }));

import {
  browsableRows,
  myTradeRows,
  readSwitcherTab,
  saveSwitcherTab,
  searchRows,
  watchlistRows,
} from "@/lib/market-switcher-lists";

const stats = new Map<string, Record<string, unknown>>([
  ["SOLslab", { symbol: "SOL", name: "Solana", last_price: 100, total_open_interest: 50 }],
  ["JUPslab", { symbol: "JUP", name: "Jupiter", last_price: 0.3, total_open_interest: 1_000 }],
  ["WIFslab", { symbol: "WIF", name: "dogwifhat", last_price: 1, total_open_interest: 10 }],
  ["HIDDEN", { symbol: "HID", name: "Hidden", last_price: 5, total_open_interest: 999_999 }],
  ["NOSYM", { name: "no symbol", last_price: 1 }],
]);

describe("browsableRows", () => {
  it("ranks browsable markets by open interest x price and drops hidden or symbol-less rows", () => {
    expect(browsableRows(stats).map((r) => r.symbol)).toEqual(["SOL", "JUP", "WIF"]);
  });
});

describe("searchRows", () => {
  it("matches symbol, name, or the start of the address, across every browsable market", () => {
    const all = browsableRows(stats);
    expect(searchRows(all, "jup").map((r) => r.symbol)).toEqual(["JUP"]);
    expect(searchRows(all, "DOGWIF").map((r) => r.symbol)).toEqual(["WIF"]);
    expect(searchRows(all, "solsl").map((r) => r.symbol)).toEqual(["SOL"]);
    expect(searchRows(all, "hid")).toEqual([]); // hidden markets stay out of search too
    expect(searchRows(all, "   ")).toEqual([]);
  });
});

describe("myTradeRows", () => {
  it("one row per market with an open position, with its side; closed positions are left out", () => {
    const rows = myTradeRows(
      [
        { slabAddress: "SOLslab", symbol: "SOL", positionSize: 5n },
        { slabAddress: "SOLslab", symbol: "SOL", positionSize: 2n }, // a second row in the same market
        { slabAddress: "JUPslab", symbol: "JUP", positionSize: -3n },
        { slabAddress: "WIFslab", symbol: "WIF", positionSize: 0n },
      ],
      stats,
    );
    expect(rows.map((r) => [r.symbol, r.side])).toEqual([
      ["SOL", "long"],
      ["JUP", "short"],
    ]);
    expect(rows[0].priceUsd).toBe(100);
  });

  it("still lists a position in a market hidden from browsing (it is the user's own)", () => {
    const rows = myTradeRows([{ slabAddress: "HIDDEN", symbol: "HID", positionSize: 1n }], stats);
    expect(rows.map((r) => r.symbol)).toEqual(["HID"]);
  });

  it("falls back to the position's own symbol when the market isn't in the stats yet", () => {
    const rows = myTradeRows([{ slabAddress: "NEWslab", symbol: "NEW", positionSize: -1n }], new Map());
    expect(rows).toEqual([{ slab: "NEWslab", symbol: "NEW", name: null, priceUsd: null, oiScore: 0, side: "short" }]);
  });
});

describe("watchlistRows", () => {
  it("keeps the watchlist's own (newest-first) order and skips markets not in the stats", () => {
    const rows = watchlistRows(["WIFslab", "GONE", "SOLslab"], stats);
    expect(rows.map((r) => r.symbol)).toEqual(["WIF", "SOL"]);
  });

  it("leaves out a starred market that is hidden from browsing, like Top and search do", () => {
    expect(watchlistRows(["HIDDEN", "SOLslab"], stats).map((r) => r.symbol)).toEqual(["SOL"]);
  });

  it("an empty watchlist is an empty list", () => {
    expect(watchlistRows([], stats)).toEqual([]);
  });
});

describe("remembered tab", () => {
  it("round-trips a valid tab and falls back to top for anything else", () => {
    saveSwitcherTab("watch");
    expect(readSwitcherTab()).toBe("watch");
    window.localStorage.setItem("perc:market-switcher-tab:v1", "bogus");
    expect(readSwitcherTab()).toBe("top");
  });

  it("blocked storage reads as top and never throws", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readSwitcherTab()).toBe("top");
    expect(() => saveSwitcherTab("mine")).not.toThrow();
    get.mockRestore();
    set.mockRestore();
  });
});
