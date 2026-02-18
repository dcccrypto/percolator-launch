import { describe, it, expect, vi } from "vitest";

// ─── Testable bot logic (extracted from sim-bots.ts) ────────────────────────

type BotType = "trend_follower" | "mean_reverter" | "market_maker";

interface PriceHistory {
  prices: number[];
  timestamps: number[];
}

interface TradeSignal {
  direction: "long" | "short" | null;
  leverage: number;
  sizeMultiplier: number; // 0-1, relative to base position size
  reason: string;
}

interface BotConfig {
  type: BotType;
  leverageMin: number;
  leverageMax: number;
  tradeIntervalMin: number; // seconds
  tradeIntervalMax: number; // seconds
  positionDurationMin: number; // seconds
  positionDurationMax: number; // seconds
}

const BOT_CONFIGS: Record<BotType, BotConfig> = {
  trend_follower: {
    type: "trend_follower",
    leverageMin: 3,
    leverageMax: 5,
    tradeIntervalMin: 30,
    tradeIntervalMax: 120,
    positionDurationMin: 300,
    positionDurationMax: 1800,
  },
  mean_reverter: {
    type: "mean_reverter",
    leverageMin: 2,
    leverageMax: 3,
    tradeIntervalMin: 30,
    tradeIntervalMax: 120,
    positionDurationMin: 300,
    positionDurationMax: 1800,
  },
  market_maker: {
    type: "market_maker",
    leverageMin: 2,
    leverageMax: 2,
    tradeIntervalMin: 15,
    tradeIntervalMax: 60,
    positionDurationMin: 60,
    positionDurationMax: 600,
  },
};

function calcPriceChange5Min(history: PriceHistory): number {
  if (history.prices.length < 2) return 0;
  const now = history.timestamps[history.timestamps.length - 1];
  const fiveMinAgo = now - 5 * 60 * 1000;

  // Find price closest to 5 min ago
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < history.timestamps.length; i++) {
    const diff = Math.abs(history.timestamps[i] - fiveMinAgo);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }

  const oldPrice = history.prices[bestIdx];
  const newPrice = history.prices[history.prices.length - 1];
  return ((newPrice - oldPrice) / oldPrice) * 100;
}

function calc5MinAverage(history: PriceHistory): number {
  if (history.prices.length === 0) return 0;
  const now = history.timestamps[history.timestamps.length - 1];
  const fiveMinAgo = now - 5 * 60 * 1000;
  const recentPrices = history.prices.filter((_, i) => history.timestamps[i] >= fiveMinAgo);
  if (recentPrices.length === 0) return history.prices[history.prices.length - 1];
  return recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
}

function trendFollowerSignal(
  history: PriceHistory,
  scenarioActive: boolean,
  scenarioType?: string
): TradeSignal {
  const change = calcPriceChange5Min(history);
  const config = BOT_CONFIGS.trend_follower;

  // More aggressive during squeeze/trend
  const aggression = scenarioActive && (scenarioType === "squeeze" || scenarioType === "trend") ? 1.5 : 1.0;
  const threshold = 1.0 / aggression; // Lower threshold when aggressive

  if (change >= threshold) {
    return {
      direction: "long",
      leverage: config.leverageMin + Math.random() * (config.leverageMax - config.leverageMin),
      sizeMultiplier: Math.min(1.0, Math.abs(change) / 5) * aggression,
      reason: `Price up ${change.toFixed(2)}% in 5 min`,
    };
  } else if (change <= -threshold) {
    return {
      direction: "short",
      leverage: config.leverageMin + Math.random() * (config.leverageMax - config.leverageMin),
      sizeMultiplier: Math.min(1.0, Math.abs(change) / 5) * aggression,
      reason: `Price down ${change.toFixed(2)}% in 5 min`,
    };
  }

  return { direction: null, leverage: 0, sizeMultiplier: 0, reason: "No signal" };
}

function meanReverterSignal(history: PriceHistory): TradeSignal {
  const currentPrice = history.prices[history.prices.length - 1];
  const avg = calc5MinAverage(history);
  if (avg === 0) return { direction: null, leverage: 0, sizeMultiplier: 0, reason: "No avg" };

  const deviation = ((currentPrice - avg) / avg) * 100;
  const config = BOT_CONFIGS.mean_reverter;
  const threshold = 2.0;

  if (deviation >= threshold) {
    return {
      direction: "short", // Fade the move
      leverage: config.leverageMin + Math.random() * (config.leverageMax - config.leverageMin),
      sizeMultiplier: Math.min(1.0, Math.abs(deviation) / 10),
      reason: `Price ${deviation.toFixed(2)}% above 5m avg — fading`,
    };
  } else if (deviation <= -threshold) {
    return {
      direction: "long", // Fade the move
      leverage: config.leverageMin + Math.random() * (config.leverageMax - config.leverageMin),
      sizeMultiplier: Math.min(1.0, Math.abs(deviation) / 10),
      reason: `Price ${deviation.toFixed(2)}% below 5m avg — fading`,
    };
  }

  return { direction: null, leverage: 0, sizeMultiplier: 0, reason: "Within range" };
}

let marketMakerLastDirection: "long" | "short" = "short";

function marketMakerSignal(): TradeSignal {
  marketMakerLastDirection = marketMakerLastDirection === "long" ? "short" : "long";
  return {
    direction: marketMakerLastDirection,
    leverage: 2,
    sizeMultiplier: 0.3, // Small positions
    reason: `Market making — ${marketMakerLastDirection}`,
  };
}

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Bots: calcPriceChange5Min", () => {
  it("returns 0 for insufficient data", () => {
    expect(calcPriceChange5Min({ prices: [100], timestamps: [Date.now()] })).toBe(0);
    expect(calcPriceChange5Min({ prices: [], timestamps: [] })).toBe(0);
  });

  it("calculates positive change correctly", () => {
    const now = Date.now();
    const history: PriceHistory = {
      prices: [100, 105],
      timestamps: [now - 5 * 60 * 1000, now],
    };
    expect(calcPriceChange5Min(history)).toBeCloseTo(5.0, 1);
  });

  it("calculates negative change correctly", () => {
    const now = Date.now();
    const history: PriceHistory = {
      prices: [100, 95],
      timestamps: [now - 5 * 60 * 1000, now],
    };
    expect(calcPriceChange5Min(history)).toBeCloseTo(-5.0, 1);
  });

  it("finds closest price to 5 min ago", () => {
    const now = Date.now();
    const history: PriceHistory = {
      prices: [90, 95, 100, 105, 110],
      timestamps: [
        now - 10 * 60 * 1000,
        now - 7 * 60 * 1000,
        now - 5 * 60 * 1000,
        now - 2 * 60 * 1000,
        now,
      ],
    };
    // Should compare 100 (5 min ago) to 110 (now) = +10%
    expect(calcPriceChange5Min(history)).toBeCloseTo(10.0, 1);
  });
});

describe("Bots: calc5MinAverage", () => {
  it("returns 0 for empty history", () => {
    expect(calc5MinAverage({ prices: [], timestamps: [] })).toBe(0);
  });

  it("averages recent prices", () => {
    const now = Date.now();
    const history: PriceHistory = {
      prices: [100, 110, 120],
      timestamps: [now - 2 * 60 * 1000, now - 1 * 60 * 1000, now],
    };
    expect(calc5MinAverage(history)).toBeCloseTo(110, 1);
  });

  it("excludes prices older than 5 min", () => {
    const now = Date.now();
    const history: PriceHistory = {
      prices: [50, 100, 110],
      timestamps: [now - 10 * 60 * 1000, now - 1 * 60 * 1000, now],
    };
    expect(calc5MinAverage(history)).toBeCloseTo(105, 1);
  });
});

describe("Bots: trendFollowerSignal", () => {
  it("goes long on +1% move", () => {
    const now = Date.now();
    const history: PriceHistory = {
      prices: [100, 101.5],
      timestamps: [now - 5 * 60 * 1000, now],
    };
    const signal = trendFollowerSignal(history, false);
    expect(signal.direction).toBe("long");
    expect(signal.leverage).toBeGreaterThanOrEqual(3);
    expect(signal.leverage).toBeLessThanOrEqual(5);
  });

  it("goes short on -1% move", () => {
    const now = Date.now();
    const history: PriceHistory = {
      prices: [100, 98],
      timestamps: [now - 5 * 60 * 1000, now],
    };
    const signal = trendFollowerSignal(history, false);
    expect(signal.direction).toBe("short");
  });

  it("no signal on flat price", () => {
    const now = Date.now();
    const history: PriceHistory = {
      prices: [100, 100.5],
      timestamps: [now - 5 * 60 * 1000, now],
    };
    const signal = trendFollowerSignal(history, false);
    expect(signal.direction).toBeNull();
  });

  it("more aggressive during squeeze", () => {
    const now = Date.now();
    const history: PriceHistory = {
      prices: [100, 100.8], // +0.8%, below normal 1% threshold
      timestamps: [now - 5 * 60 * 1000, now],
    };
    // Without scenario: no signal
    expect(trendFollowerSignal(history, false).direction).toBeNull();
    // With squeeze: should trigger (threshold lowered by 1.5x)
    expect(trendFollowerSignal(history, true, "squeeze").direction).toBe("long");
  });

  it("not aggressive during crash scenario", () => {
    const now = Date.now();
    const history: PriceHistory = {
      prices: [100, 100.8],
      timestamps: [now - 5 * 60 * 1000, now],
    };
    // Crash doesn't trigger aggression
    expect(trendFollowerSignal(history, true, "crash").direction).toBeNull();
  });
});

describe("Bots: meanReverterSignal", () => {
  it("shorts when price above 2% of average", () => {
    const now = Date.now();
    const history: PriceHistory = {
      prices: [100, 100, 100, 103],
      timestamps: [now - 3 * 60 * 1000, now - 2 * 60 * 1000, now - 60 * 1000, now],
    };
    const signal = meanReverterSignal(history);
    expect(signal.direction).toBe("short");
    expect(signal.leverage).toBeGreaterThanOrEqual(2);
    expect(signal.leverage).toBeLessThanOrEqual(3);
  });

  it("longs when price below -2% of average", () => {
    const now = Date.now();
    const history: PriceHistory = {
      prices: [100, 100, 100, 97],
      timestamps: [now - 3 * 60 * 1000, now - 2 * 60 * 1000, now - 60 * 1000, now],
    };
    const signal = meanReverterSignal(history);
    expect(signal.direction).toBe("long");
  });

  it("no signal when within range", () => {
    const now = Date.now();
    const history: PriceHistory = {
      prices: [100, 100, 100, 101],
      timestamps: [now - 3 * 60 * 1000, now - 2 * 60 * 1000, now - 60 * 1000, now],
    };
    const signal = meanReverterSignal(history);
    expect(signal.direction).toBeNull();
  });
});

describe("Bots: marketMakerSignal", () => {
  it("alternates long and short", () => {
    marketMakerLastDirection = "short";
    const s1 = marketMakerSignal();
    const s2 = marketMakerSignal();
    const s3 = marketMakerSignal();
    expect(s1.direction).toBe("long");
    expect(s2.direction).toBe("short");
    expect(s3.direction).toBe("long");
  });

  it("always uses 2x leverage", () => {
    const signal = marketMakerSignal();
    expect(signal.leverage).toBe(2);
  });

  it("uses small position size", () => {
    const signal = marketMakerSignal();
    expect(signal.sizeMultiplier).toBe(0.3);
  });
});

describe("Bots: config validation", () => {
  it("trend follower leverage range is 3-5x", () => {
    expect(BOT_CONFIGS.trend_follower.leverageMin).toBe(3);
    expect(BOT_CONFIGS.trend_follower.leverageMax).toBe(5);
  });

  it("mean reverter leverage range is 2-3x", () => {
    expect(BOT_CONFIGS.mean_reverter.leverageMin).toBe(2);
    expect(BOT_CONFIGS.mean_reverter.leverageMax).toBe(3);
  });

  it("market maker leverage is fixed 2x", () => {
    expect(BOT_CONFIGS.market_maker.leverageMin).toBe(2);
    expect(BOT_CONFIGS.market_maker.leverageMax).toBe(2);
  });

  it("market maker trades more frequently", () => {
    expect(BOT_CONFIGS.market_maker.tradeIntervalMin).toBeLessThan(BOT_CONFIGS.trend_follower.tradeIntervalMin);
  });
});
