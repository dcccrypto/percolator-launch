/**
 * PERC-377: Unit tests for quote calculation logic.
 *
 * Tests the position-aware skewing, spread noise, size jitter,
 * and edge-case handling in the maker bot's quoting engine.
 */

import { describe, it, expect } from "vitest";

// ── Inline the quote logic for unit testing ─────────────

interface QuoteResult {
  bidPrice: number;
  askPrice: number;
  bidSize: bigint;
  askSize: bigint;
  skewFactor: number;
  effectiveSpreadBps: number;
}

interface QuoteConfig {
  spreadBps: number;
  maxQuoteSizeUsdc: number;
  maxPositionPct: number;
  skewMaxMultiplier: number;
  spreadNoiseBps: number;
  sizeJitter: number;
}

function calculateQuotes(
  oraclePrice: number,
  positionSize: bigint,
  collateral: bigint,
  config: QuoteConfig,
  rng?: () => number,
): QuoteResult {
  const rand = rng ?? Math.random;

  let spreadBps = config.spreadBps;
  if (config.spreadNoiseBps > 0) {
    const noise = (rand() * 2 - 1) * config.spreadNoiseBps;
    spreadBps = Math.max(1, spreadBps + noise);
  }

  const spreadFrac = spreadBps / 10_000;
  const collateralUsd = Number(collateral) / 1_000_000;
  const positionUsd = Number(positionSize) / 1_000_000;
  const maxQuoteSize = BigInt(config.maxQuoteSizeUsdc) * 1_000_000n;

  const maxPosUsd = collateralUsd * (config.maxPositionPct / 100);
  const exposure = maxPosUsd > 0
    ? Math.max(-1, Math.min(1, positionUsd / maxPosUsd))
    : 0;

  const skewFactor = exposure;

  const bidSpreadMul = 1 + Math.max(0, skewFactor) * (config.skewMaxMultiplier - 1);
  const askSpreadMul = 1 + Math.max(0, -skewFactor) * (config.skewMaxMultiplier - 1);

  const bidPrice = oraclePrice * (1 - spreadFrac * bidSpreadMul);
  const askPrice = oraclePrice * (1 + spreadFrac * askSpreadMul);

  const absExposure = Math.abs(exposure);
  const sizeFactor = Math.max(0.1, 1 - absExposure * 0.8);

  let bidSize = maxQuoteSize;
  let askSize = maxQuoteSize;

  if (absExposure >= 0.95) {
    if (exposure > 0) bidSize = 0n;
    else askSize = 0n;
  } else {
    const baseSize = BigInt(Math.floor(Number(maxQuoteSize) * sizeFactor));

    if (config.sizeJitter > 0) {
      const jitterFactor = 1 + (rand() * 2 - 1) * config.sizeJitter;
      const jitteredSize = BigInt(Math.floor(Number(baseSize) * Math.max(0.1, jitterFactor)));
      bidSize = jitteredSize;
      askSize = jitteredSize;
    } else {
      bidSize = baseSize;
      askSize = baseSize;
    }
  }

  return { bidPrice, askPrice, bidSize, askSize, skewFactor, effectiveSpreadBps: spreadBps };
}

// ── Tests ───────────────────────────────────────────────

const DEFAULT_CONFIG: QuoteConfig = {
  spreadBps: 25,
  maxQuoteSizeUsdc: 500,
  maxPositionPct: 10,
  skewMaxMultiplier: 3.0,
  spreadNoiseBps: 0, // disabled for deterministic tests
  sizeJitter: 0,      // disabled for deterministic tests
};

const COLLATERAL = 10_000_000_000n; // $10,000 USDC (6 decimals)

describe("calculateQuotes", () => {
  describe("flat position (no exposure)", () => {
    it("produces symmetric spread around oracle price", () => {
      const q = calculateQuotes(100.0, 0n, COLLATERAL, DEFAULT_CONFIG);

      expect(q.bidPrice).toBeCloseTo(100 * (1 - 25 / 10_000), 4);
      expect(q.askPrice).toBeCloseTo(100 * (1 + 25 / 10_000), 4);
      expect(q.skewFactor).toBe(0);
      expect(q.bidSize).toBe(500_000_000n);
      expect(q.askSize).toBe(500_000_000n);
    });

    it("works with BTC-level prices", () => {
      const q = calculateQuotes(95_000, 0n, COLLATERAL, DEFAULT_CONFIG);

      expect(q.bidPrice).toBeCloseTo(95_000 * 0.9975, 0);
      expect(q.askPrice).toBeCloseTo(95_000 * 1.0025, 0);
    });

    it("works with sub-dollar prices", () => {
      const q = calculateQuotes(0.00001, 0n, COLLATERAL, DEFAULT_CONFIG);

      expect(q.bidPrice).toBeLessThan(0.00001);
      expect(q.askPrice).toBeGreaterThan(0.00001);
      expect(q.bidPrice).toBeGreaterThan(0);
    });
  });

  describe("long position (positive exposure)", () => {
    it("widens bid (less buying) and keeps ask tight (wants to sell)", () => {
      const longPos = 500_000_000n; // $500 long (50% of max)
      const q = calculateQuotes(100.0, longPos, COLLATERAL, DEFAULT_CONFIG);

      expect(q.skewFactor).toBe(0.5);

      // Bid should be further from oracle than symmetric
      const symmetricBid = 100 * (1 - 25 / 10_000);
      expect(q.bidPrice).toBeLessThan(symmetricBid);

      // Ask should be at normal distance
      const symmetricAsk = 100 * (1 + 25 / 10_000);
      expect(q.askPrice).toBeCloseTo(symmetricAsk, 4);
    });

    it("reduces bid size at max exposure", () => {
      const maxLong = 1_000_000_000n; // $1000 = 100% of max (10% of $10k)
      const q = calculateQuotes(100.0, maxLong, COLLATERAL, DEFAULT_CONFIG);

      expect(q.skewFactor).toBe(1);
      expect(q.bidSize).toBe(0n); // No more buying allowed
      expect(q.askSize).toBeGreaterThan(0n); // Still willing to sell
    });
  });

  describe("short position (negative exposure)", () => {
    it("widens ask (less selling) and keeps bid tight (wants to buy)", () => {
      const shortPos = -500_000_000n; // $500 short
      const q = calculateQuotes(100.0, shortPos, COLLATERAL, DEFAULT_CONFIG);

      expect(q.skewFactor).toBe(-0.5);

      // Ask should be further from oracle
      const symmetricAsk = 100 * (1 + 25 / 10_000);
      expect(q.askPrice).toBeGreaterThan(symmetricAsk);

      // Bid should be at normal distance
      const symmetricBid = 100 * (1 - 25 / 10_000);
      expect(q.bidPrice).toBeCloseTo(symmetricBid, 4);
    });

    it("reduces ask size at max short exposure", () => {
      const maxShort = -1_000_000_000n; // -$1000
      const q = calculateQuotes(100.0, maxShort, COLLATERAL, DEFAULT_CONFIG);

      expect(q.skewFactor).toBe(-1);
      expect(q.askSize).toBe(0n); // No more selling
      expect(q.bidSize).toBeGreaterThan(0n); // Still willing to buy
    });
  });

  describe("exposure clamping", () => {
    it("clamps exposure to [-1, 1] for extreme positions", () => {
      const hugePos = 999_999_000_000n; // Way over limit
      const q = calculateQuotes(100.0, hugePos, COLLATERAL, DEFAULT_CONFIG);

      expect(q.skewFactor).toBe(1);
    });

    it("handles zero collateral without division by zero", () => {
      const q = calculateQuotes(100.0, 500_000_000n, 0n, DEFAULT_CONFIG);

      expect(q.skewFactor).toBe(0);
      expect(Number.isFinite(q.bidPrice)).toBe(true);
      expect(Number.isFinite(q.askPrice)).toBe(true);
    });
  });

  describe("spread noise", () => {
    it("adds random noise to spread when enabled", () => {
      const config = { ...DEFAULT_CONFIG, spreadNoiseBps: 4 };

      // With rng returning 0 → noise = -4 bps
      const q1 = calculateQuotes(100.0, 0n, COLLATERAL, config, () => 0);
      expect(q1.effectiveSpreadBps).toBeCloseTo(21, 0);

      // With rng returning 1 → noise = +4 bps
      const q2 = calculateQuotes(100.0, 0n, COLLATERAL, config, () => 1);
      expect(q2.effectiveSpreadBps).toBeCloseTo(29, 0);
    });

    it("never reduces spread below 1 bps", () => {
      const config = { ...DEFAULT_CONFIG, spreadBps: 2, spreadNoiseBps: 10 };
      const q = calculateQuotes(100.0, 0n, COLLATERAL, config, () => 0);

      expect(q.effectiveSpreadBps).toBeGreaterThanOrEqual(1);
    });
  });

  describe("size jitter", () => {
    it("applies jitter factor to base size", () => {
      const config = { ...DEFAULT_CONFIG, sizeJitter: 0.25 };

      // rng = 0.5 → jitterFactor = 1 + 0 * 0.25 = 1 (neutral)
      const q1 = calculateQuotes(100.0, 0n, COLLATERAL, config, () => 0.5);
      expect(q1.bidSize).toBe(500_000_000n);

      // rng = 0 → jitterFactor = 1 - 0.25 = 0.75
      const q2 = calculateQuotes(100.0, 0n, COLLATERAL, config, () => 0);
      expect(q2.bidSize).toBe(375_000_000n);

      // rng = 1 → jitterFactor = 1 + 0.25 = 1.25
      const q3 = calculateQuotes(100.0, 0n, COLLATERAL, config, () => 1);
      expect(q3.bidSize).toBe(625_000_000n);
    });
  });

  describe("size reduction with exposure", () => {
    it("gradually reduces sizes as exposure grows", () => {
      const halfExposure = 500_000_000n; // 50% exposure

      const flatQ = calculateQuotes(100.0, 0n, COLLATERAL, DEFAULT_CONFIG);
      const halfQ = calculateQuotes(100.0, halfExposure, COLLATERAL, DEFAULT_CONFIG);

      // At 50% exposure, sizeFactor = 1 - 0.5 * 0.8 = 0.6
      expect(halfQ.askSize).toBeLessThan(flatQ.askSize);
    });

    it("maintains minimum 10% size even near max exposure", () => {
      const nearMax = 940_000_000n; // 94% exposure (just under 95%)
      const q = calculateQuotes(100.0, nearMax, COLLATERAL, DEFAULT_CONFIG);

      // Both sides should still have some size
      expect(q.bidSize).toBeGreaterThan(0n);
      expect(q.askSize).toBeGreaterThan(0n);
    });
  });

  describe("spread math correctness", () => {
    it("bid < oracle < ask always holds", () => {
      const oracles = [0.001, 1, 100, 95_000, 1_000_000];
      const positions = [0n, 500_000_000n, -500_000_000n];

      for (const oracle of oracles) {
        for (const pos of positions) {
          const q = calculateQuotes(oracle, pos, COLLATERAL, DEFAULT_CONFIG);
          expect(q.bidPrice).toBeLessThan(oracle);
          expect(q.askPrice).toBeGreaterThan(oracle);
        }
      }
    });

    it("effective spread in basis points matches config", () => {
      const q = calculateQuotes(100.0, 0n, COLLATERAL, DEFAULT_CONFIG);
      expect(q.effectiveSpreadBps).toBe(25);
    });
  });
});
