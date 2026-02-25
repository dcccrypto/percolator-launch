import { describe, it, expect } from "vitest";
import {
  isMockSlab,
  getMockSymbol,
  getMockSlabState,
  MOCK_SLAB_ADDRESSES,
  getMockMarketData,
  getMockUserAccount,
  getMockUserAccountIdle,
  getMockTrades,
  getMockPortfolioPositions,
  getMockMyMarkets,
  getMockPriceHistory,
} from "../../lib/mock-trade-data";

const KNOWN_SOL_SLAB = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const KNOWN_SOL_MINT = "So11111111111111111111111111111111111111112";
const UNKNOWN_ADDRESS = "UnknownAddress111111111111111111111111111111";

describe("isMockSlab", () => {
  it("returns true for a known mock slab address", () => {
    expect(isMockSlab(KNOWN_SOL_SLAB)).toBe(true);
  });

  it("returns false for unknown address", () => {
    expect(isMockSlab(UNKNOWN_ADDRESS)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isMockSlab("")).toBe(false);
  });
});

describe("getMockSymbol", () => {
  it("returns symbol for known slab address", () => {
    expect(getMockSymbol(KNOWN_SOL_SLAB)).toBe("SOL");
  });

  it("returns symbol for known mint address", () => {
    expect(getMockSymbol(KNOWN_SOL_MINT)).toBe("SOL");
  });

  it("returns null for unknown address", () => {
    expect(getMockSymbol(UNKNOWN_ADDRESS)).toBeNull();
  });
});

describe("MOCK_SLAB_ADDRESSES", () => {
  it("is a non-empty array of addresses", () => {
    expect(MOCK_SLAB_ADDRESSES).toBeInstanceOf(Array);
    expect(MOCK_SLAB_ADDRESSES.length).toBeGreaterThan(0);
  });

  it("contains the known SOL slab", () => {
    expect(MOCK_SLAB_ADDRESSES).toContain(KNOWN_SOL_SLAB);
  });
});

describe("getMockSlabState", () => {
  it("returns null for unknown address", () => {
    expect(getMockSlabState(UNKNOWN_ADDRESS)).toBeNull();
  });

  it("returns state object with header, config, engine, params, accounts for known slab", () => {
    const state = getMockSlabState(KNOWN_SOL_SLAB);
    expect(state).not.toBeNull();
    expect(state).toHaveProperty("header");
    expect(state).toHaveProperty("config");
    expect(state).toHaveProperty("engine");
    expect(state).toHaveProperty("params");
    expect(state).toHaveProperty("accounts");
  });

  it("returns accounts array with at least one entry", () => {
    const state = getMockSlabState(KNOWN_SOL_SLAB);
    expect(state?.accounts).toBeInstanceOf(Array);
    expect(state!.accounts.length).toBeGreaterThan(0);
  });
});

describe("getMockMarketData", () => {
  it("returns null for unknown address", () => {
    expect(getMockMarketData(UNKNOWN_ADDRESS)).toBeNull();
  });

  it("returns market data for known slab", () => {
    const data = getMockMarketData(KNOWN_SOL_SLAB);
    expect(data).not.toBeNull();
    expect(data?.symbol).toBe("SOL");
    expect(data?.priceUsd).toBeGreaterThan(0);
    expect(data?.maxLeverage).toBeGreaterThan(0);
  });
});

describe("getMockUserAccount", () => {
  it("returns null for unknown address", () => {
    expect(getMockUserAccount(UNKNOWN_ADDRESS)).toBeNull();
  });

  it("returns account with position data for known slab", () => {
    const result = getMockUserAccount(KNOWN_SOL_SLAB);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("idx");
    expect(result).toHaveProperty("account");
    expect(result!.account).toHaveProperty("kind");
  });
});

describe("getMockUserAccountIdle", () => {
  it("returns null for unknown address", () => {
    expect(getMockUserAccountIdle(UNKNOWN_ADDRESS)).toBeNull();
  });

  it("returns idle account (no open position) for known slab", () => {
    const result = getMockUserAccountIdle(KNOWN_SOL_SLAB);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("idx");
    expect(result).toHaveProperty("account");
    expect(result!.account).toHaveProperty("kind");
  });
});

describe("getMockTrades", () => {
  it("returns empty array for unknown address", () => {
    expect(getMockTrades(UNKNOWN_ADDRESS)).toEqual([]);
  });

  it("returns trade array for known slab", () => {
    const trades = getMockTrades(KNOWN_SOL_SLAB);
    expect(trades).toBeInstanceOf(Array);
    expect(trades.length).toBeGreaterThan(0);
  });

  it("trades have required fields", () => {
    const trades = getMockTrades(KNOWN_SOL_SLAB);
    if (trades.length > 0) {
      const trade = trades[0];
      expect(trade).toHaveProperty("id");
      expect(trade).toHaveProperty("side");
      expect(trade).toHaveProperty("size");
      expect(trade).toHaveProperty("price");
    }
  });
});

describe("getMockPortfolioPositions", () => {
  it("returns an array of portfolio positions", () => {
    const positions = getMockPortfolioPositions();
    expect(positions).toBeInstanceOf(Array);
    expect(positions.length).toBeGreaterThan(0);
  });

  it("positions have slabAddress and symbol", () => {
    const positions = getMockPortfolioPositions();
    const first = positions[0];
    expect(first).toHaveProperty("slabAddress");
    expect(first).toHaveProperty("symbol");
  });
});

describe("getMockMyMarkets", () => {
  it("returns an array of markets", () => {
    const markets = getMockMyMarkets();
    expect(markets).toBeInstanceOf(Array);
    expect(markets.length).toBeGreaterThan(0);
  });
});

describe("getMockPriceHistory", () => {
  it("returns empty array for unknown address", () => {
    expect(getMockPriceHistory(UNKNOWN_ADDRESS)).toEqual([]);
  });

  it("returns price history array for known slab", () => {
    const history = getMockPriceHistory(KNOWN_SOL_SLAB);
    expect(history).toBeInstanceOf(Array);
    expect(history.length).toBeGreaterThan(0);
  });

  it("price history entries have price_e6 and timestamp", () => {
    const history = getMockPriceHistory(KNOWN_SOL_SLAB);
    if (history.length > 0) {
      expect(history[0]).toHaveProperty("price_e6");
      expect(history[0]).toHaveProperty("timestamp");
      expect(typeof history[0].price_e6).toBe("number");
      expect(typeof history[0].timestamp).toBe("number");
    }
  });
});
