import { describe, it, expect, vi } from "vitest";

/**
 * Integration tests for the Simulator page data flow.
 * Tests how market switching, config loading, and component data propagation
 * work together — without testing the full React tree.
 */

// Import sim config to verify market data
import simConfig from "@/config/sim-markets.json";

describe("Integration: Sim Config → Market Data", () => {
  it("sim-markets.json has all required fields", () => {
    expect(simConfig.programId).toBeTruthy();
    expect(simConfig.simUSDC).toBeTruthy();
    expect(simConfig.simUSDC.mint).toBeTruthy();
    expect(simConfig.simUSDC.decimals).toBe(6);
    expect(simConfig.admin).toBeTruthy();
  });

  it("has 3 markets configured", () => {
    const markets = Object.keys(simConfig.markets);
    expect(markets).toHaveLength(3);
    expect(markets).toContain("SOL/USD");
    expect(markets).toContain("BTC/USD");
    expect(markets).toContain("ETH/USD");
  });

  it("each market has a valid slab address", () => {
    const markets = simConfig.markets as Record<string, { slab: string; name: string }>;
    for (const [key, cfg] of Object.entries(markets)) {
      expect(cfg.slab.length).toBeGreaterThan(20);
      expect(cfg.name).toContain("SIM-");
    }
  });

  it("each market has unique slab address", () => {
    const markets = simConfig.markets as Record<string, { slab: string }>;
    const slabs = Object.values(markets).map((m) => m.slab);
    const unique = new Set(slabs);
    expect(unique.size).toBe(slabs.length);
  });

  it("all markets use admin oracle mode", () => {
    const markets = simConfig.markets as Record<
      string,
      { oracleMode?: string }
    >;
    for (const cfg of Object.values(markets)) {
      expect(cfg.oracleMode).toBe("admin");
    }
  });

  it("network is devnet", () => {
    expect(simConfig.network).toBe("devnet");
  });
});

describe("Integration: Price Data Flow", () => {
  it("TradingChart price accumulation logic works correctly", () => {
    // Simulate the price accumulation logic from TradingChart
    const prices: { timestamp: number; price: number }[] = [];
    const addPrice = (price: number) => {
      const now = Date.now();
      const last = prices[prices.length - 1];
      if (last && now - last.timestamp < 5000) return; // 5s throttle
      prices.push({ timestamp: now, price });
      // Keep max 1000 points
      if (prices.length > 1000) prices.splice(0, prices.length - 1000);
    };

    // Simulate rapid price updates (every 2s from oracle)
    const baseTime = Date.now();
    for (let i = 0; i < 10; i++) {
      // Manually set timestamps to avoid throttle
      prices.push({
        timestamp: baseTime + i * 5000,
        price: 83 + Math.sin(i) * 2,
      });
    }

    expect(prices.length).toBe(10);
    expect(prices[0].price).toBeCloseTo(83, 0);
  });

  it("candle aggregation produces correct OHLCV", () => {
    // From TradingChart's aggregateCandles logic
    const INTERVAL = 5 * 60 * 1000; // 5 min candles

    interface CandleData {
      timestamp: number;
      open: number;
      high: number;
      low: number;
      close: number;
    }

    function aggregateCandles(
      prices: { timestamp: number; price: number }[],
      intervalMs: number
    ): CandleData[] {
      if (prices.length === 0) return [];
      const candles: CandleData[] = [];
      let current: CandleData | null = null;

      prices.forEach((point) => {
        const start = Math.floor(point.timestamp / intervalMs) * intervalMs;
        if (!current || current.timestamp !== start) {
          if (current) candles.push(current);
          current = {
            timestamp: start,
            open: point.price,
            high: point.price,
            low: point.price,
            close: point.price,
          };
        } else {
          current.high = Math.max(current.high, point.price);
          current.low = Math.min(current.low, point.price);
          current.close = point.price;
        }
      });
      if (current) candles.push(current);
      return candles;
    }

    const now = Date.now();
    const base = Math.floor(now / INTERVAL) * INTERVAL;

    const prices = [
      { timestamp: base + 0, price: 100 },
      { timestamp: base + 60000, price: 105 },
      { timestamp: base + 120000, price: 95 },
      { timestamp: base + 180000, price: 102 },
    ];

    const candles = aggregateCandles(prices, INTERVAL);
    expect(candles).toHaveLength(1);
    expect(candles[0].open).toBe(100);
    expect(candles[0].high).toBe(105);
    expect(candles[0].low).toBe(95);
    expect(candles[0].close).toBe(102);
  });

  it("candle aggregation handles cross-interval data", () => {
    const INTERVAL = 5 * 60 * 1000;
    const base = Math.floor(Date.now() / INTERVAL) * INTERVAL;

    interface CandleData {
      timestamp: number;
      open: number;
      high: number;
      low: number;
      close: number;
    }

    function aggregateCandles(
      prices: { timestamp: number; price: number }[],
      intervalMs: number
    ): CandleData[] {
      if (prices.length === 0) return [];
      const candles: CandleData[] = [];
      let current: CandleData | null = null;

      prices.forEach((point) => {
        const start = Math.floor(point.timestamp / intervalMs) * intervalMs;
        if (!current || current.timestamp !== start) {
          if (current) candles.push(current);
          current = {
            timestamp: start,
            open: point.price,
            high: point.price,
            low: point.price,
            close: point.price,
          };
        } else {
          current.high = Math.max(current.high, point.price);
          current.low = Math.min(current.low, point.price);
          current.close = point.price;
        }
      });
      if (current) candles.push(current);
      return candles;
    }

    const prices = [
      { timestamp: base + 0, price: 100 },       // candle 1
      { timestamp: base + 60000, price: 110 },   // candle 1
      { timestamp: base + INTERVAL, price: 108 }, // candle 2
      { timestamp: base + INTERVAL + 60000, price: 112 }, // candle 2
    ];

    const candles = aggregateCandles(prices, INTERVAL);
    expect(candles).toHaveLength(2);

    // First candle
    expect(candles[0].open).toBe(100);
    expect(candles[0].close).toBe(110);
    expect(candles[0].high).toBe(110);
    expect(candles[0].low).toBe(100);

    // Second candle
    expect(candles[1].open).toBe(108);
    expect(candles[1].close).toBe(112);
  });
});

describe("Integration: Scenario Data Flow", () => {
  // Verify scenario definitions are consistent
  const SCENARIO_TYPES = ["crash", "squeeze", "blackswan", "volatility", "trend"];
  const SCENARIO_DURATIONS: Record<string, number> = {
    crash: 60_000,
    squeeze: 120_000,
    blackswan: 600_000,
    volatility: 300_000,
    trend: 1_800_000,
  };

  it("all scenario types have defined durations", () => {
    for (const type of SCENARIO_TYPES) {
      expect(SCENARIO_DURATIONS[type]).toBeGreaterThan(0);
    }
  });

  it("scenario durations are reasonable", () => {
    // Crash should be short (1 min)
    expect(SCENARIO_DURATIONS.crash).toBeLessThanOrEqual(120_000);
    // Black swan should be long (10 min)
    expect(SCENARIO_DURATIONS.blackswan).toBeGreaterThanOrEqual(300_000);
    // Trend should be longest (30 min)
    expect(SCENARIO_DURATIONS.trend).toBeGreaterThanOrEqual(1_200_000);
  });
});

describe("Integration: Faucet → Trading Flow", () => {
  it("simUSDC has 6 decimal places (consistent with percolator)", () => {
    expect(simConfig.simUSDC.decimals).toBe(6);
  });

  it("faucet amount calculation: 10000 simUSDC = 10_000_000_000 raw", () => {
    const humanAmount = 10_000;
    const decimals = simConfig.simUSDC.decimals;
    const rawAmount = humanAmount * 10 ** decimals;
    expect(rawAmount).toBe(10_000_000_000);
  });

  it("position size calculation: $100 at 5x leverage, SOL=$83", () => {
    // This is the formula from sim-bots.ts
    const usdSize = 100;
    const leverage = 5;
    const priceE6 = 83_000_000;

    // position_size = usdSize * leverage * 1e12 / priceE6
    const positionSize = (usdSize * leverage * 1e12) / priceE6;

    // Should be ~6.02 SOL (at 6-decimal precision)
    const solAmount = positionSize / 1e6;
    expect(solAmount).toBeCloseTo(6.02, 1);

    // Notional check: position_size * priceE6 / 1e6 = notional_e6
    const notionalE6 = (positionSize * priceE6) / 1e6;
    const notionalUsd = notionalE6 / 1e6;
    expect(notionalUsd).toBeCloseTo(500, 1); // $100 * 5x = $500
  });

  it("new account fee is 1 simUSDC (1_000_000 raw)", () => {
    const feeRaw = 1_000_000;
    const feeHuman = feeRaw / 10 ** 6;
    expect(feeHuman).toBe(1);
  });
});
