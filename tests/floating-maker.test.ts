/**
 * PERC-364: Floating Market Maker Bot — Unit Tests
 *
 * Tests the core quoting logic, price calculations, and skewing behavior
 * without requiring on-chain connectivity.
 */

import { describe, it, expect } from "vitest";

// ═══════════════════════════════════════════════════════════════
// Inline the pure functions from floating-maker.ts for testing
// (avoids importing the full module which requires env/connection)
// ═══════════════════════════════════════════════════════════════

const SPREAD_BPS = 30; // 0.30%
const MAX_QUOTE_SIZE = 500_000_000n; // $500 in 6-decimal USDC
const MAX_POSITION_PCT = 10;
const SKEW_MAX_MULTIPLIER = 3.0;

function calculateQuotes(
  oraclePrice: number,
  positionSize: bigint,
  collateral: bigint,
): {
  bidPrice: number;
  askPrice: number;
  bidSize: bigint;
  askSize: bigint;
  skewFactor: number;
} {
  const spreadFrac = SPREAD_BPS / 10_000;
  const collateralUsd = Number(collateral) / 1_000_000;
  const positionUsd = Number(positionSize) / 1_000_000;

  const exposure =
    collateralUsd > 0
      ? Math.max(
          -1,
          Math.min(
            1,
            positionUsd / (collateralUsd * (MAX_POSITION_PCT / 100)),
          ),
        )
      : 0;

  const skewFactor = exposure;

  const bidSpreadMul =
    1 + Math.max(0, skewFactor) * (SKEW_MAX_MULTIPLIER - 1);
  const askSpreadMul =
    1 + Math.max(0, -skewFactor) * (SKEW_MAX_MULTIPLIER - 1);

  const bidPrice = oraclePrice * (1 - spreadFrac * bidSpreadMul);
  const askPrice = oraclePrice * (1 + spreadFrac * askSpreadMul);

  const absExposure = Math.abs(exposure);
  const sizeFactor = Math.max(0.1, 1 - absExposure * 0.8);

  let bidSize = MAX_QUOTE_SIZE;
  let askSize = MAX_QUOTE_SIZE;

  if (absExposure >= 0.95) {
    if (exposure > 0) {
      bidSize = 0n;
    } else {
      askSize = 0n;
    }
  } else {
    const scaledSize = BigInt(
      Math.floor(Number(MAX_QUOTE_SIZE) * sizeFactor),
    );
    bidSize = scaledSize;
    askSize = scaledSize;
  }

  return { bidPrice, askPrice, bidSize, askSize, skewFactor };
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe("Floating Maker — Quote Calculation", () => {
  const COLLATERAL = 10_000_000_000n; // $10,000 USDC (6 decimals)

  describe("flat position (no skew)", () => {
    it("quotes symmetrically around oracle price", () => {
      const { bidPrice, askPrice, skewFactor } = calculateQuotes(
        100.0,
        0n,
        COLLATERAL,
      );

      expect(skewFactor).toBe(0);
      // Spread = 0.30%, so bid = 99.70, ask = 100.30
      expect(bidPrice).toBeCloseTo(99.7, 2);
      expect(askPrice).toBeCloseTo(100.3, 2);
    });

    it("has equal bid/ask sizes when flat", () => {
      const { bidSize, askSize } = calculateQuotes(100.0, 0n, COLLATERAL);

      expect(bidSize).toBe(MAX_QUOTE_SIZE);
      expect(askSize).toBe(MAX_QUOTE_SIZE);
    });
  });

  describe("long position (positive skew)", () => {
    it("widens bid spread when long", () => {
      // Position = $500 = 50% of max position ($1000 = 10% of $10000)
      const { bidPrice, askPrice, skewFactor } = calculateQuotes(
        100.0,
        500_000_000n, // $500
        COLLATERAL,
      );

      expect(skewFactor).toBeCloseTo(0.5, 2);
      // Bid should be wider than ask
      const bidSpread = 100.0 - bidPrice;
      const askSpread = askPrice - 100.0;
      expect(bidSpread).toBeGreaterThan(askSpread);
    });

    it("reduces bid to zero at max long exposure", () => {
      // Position = $1000 = 100% of max position
      const { bidSize, askSize, skewFactor } = calculateQuotes(
        100.0,
        1_000_000_000n, // $1000
        COLLATERAL,
      );

      expect(skewFactor).toBeCloseTo(1.0, 2);
      expect(bidSize).toBe(0n);
      expect(askSize).toBeGreaterThan(0n);
    });

    it("scales down quote sizes with exposure", () => {
      const flat = calculateQuotes(100.0, 0n, COLLATERAL);
      const half = calculateQuotes(100.0, 500_000_000n, COLLATERAL);

      expect(half.bidSize).toBeLessThan(flat.bidSize);
      expect(half.askSize).toBeLessThan(flat.askSize);
    });
  });

  describe("short position (negative skew)", () => {
    it("widens ask spread when short", () => {
      const { bidPrice, askPrice, skewFactor } = calculateQuotes(
        100.0,
        -500_000_000n, // -$500
        COLLATERAL,
      );

      expect(skewFactor).toBeCloseTo(-0.5, 2);
      const bidSpread = 100.0 - bidPrice;
      const askSpread = askPrice - 100.0;
      expect(askSpread).toBeGreaterThan(bidSpread);
    });

    it("reduces ask to zero at max short exposure", () => {
      const { bidSize, askSize, skewFactor } = calculateQuotes(
        100.0,
        -1_000_000_000n, // -$1000
        COLLATERAL,
      );

      expect(skewFactor).toBeCloseTo(-1.0, 2);
      expect(askSize).toBe(0n);
      expect(bidSize).toBeGreaterThan(0n);
    });
  });

  describe("edge cases", () => {
    it("handles zero collateral gracefully", () => {
      const { bidPrice, askPrice, skewFactor } = calculateQuotes(
        100.0,
        500_000_000n,
        0n,
      );

      expect(skewFactor).toBe(0);
      expect(bidPrice).toBeCloseTo(99.7, 2);
      expect(askPrice).toBeCloseTo(100.3, 2);
    });

    it("caps exposure at ±1", () => {
      // Position way beyond max
      const { skewFactor } = calculateQuotes(
        100.0,
        50_000_000_000n, // $50,000 (5x collateral)
        COLLATERAL,
      );

      expect(skewFactor).toBe(1);
    });

    it("works with high-value assets (BTC ~$100k)", () => {
      const { bidPrice, askPrice } = calculateQuotes(
        100_000.0,
        0n,
        COLLATERAL,
      );

      expect(bidPrice).toBeCloseTo(99_700, 0);
      expect(askPrice).toBeCloseTo(100_300, 0);
    });

    it("works with low-value assets (BONK ~$0.00002)", () => {
      const { bidPrice, askPrice } = calculateQuotes(
        0.00002,
        0n,
        COLLATERAL,
      );

      const bidSpread = 0.00002 - bidPrice;
      const askSpread = askPrice - 0.00002;
      expect(bidSpread).toBeCloseTo(askSpread, 10);
      expect(bidPrice).toBeLessThan(0.00002);
      expect(askPrice).toBeGreaterThan(0.00002);
    });

    it("maintains minimum size of 10% even at high exposure", () => {
      // 90% of max position — should still quote small size
      const { bidSize, askSize } = calculateQuotes(
        100.0,
        900_000_000n, // $900 = 90% of max $1000
        COLLATERAL,
      );

      const minSize = BigInt(Math.floor(Number(MAX_QUOTE_SIZE) * 0.1));
      // Not at 95% cutoff yet, so both sides should still quote
      expect(bidSize).toBeGreaterThanOrEqual(minSize);
      expect(askSize).toBeGreaterThanOrEqual(minSize);
    });
  });

  describe("spread math invariants", () => {
    it("bid is always below oracle", () => {
      for (const pos of [0n, 500_000_000n, -500_000_000n]) {
        const { bidPrice } = calculateQuotes(100.0, pos, COLLATERAL);
        expect(bidPrice).toBeLessThan(100.0);
      }
    });

    it("ask is always above oracle", () => {
      for (const pos of [0n, 500_000_000n, -500_000_000n]) {
        const { askPrice } = calculateQuotes(100.0, pos, COLLATERAL);
        expect(askPrice).toBeGreaterThan(100.0);
      }
    });

    it("bid < ask always holds (no crossed quotes)", () => {
      for (const pos of [0n, 500_000_000n, -500_000_000n, 999_000_000n]) {
        const { bidPrice, askPrice } = calculateQuotes(
          100.0,
          pos,
          COLLATERAL,
        );
        expect(bidPrice).toBeLessThan(askPrice);
      }
    });

    it("spread widens monotonically with exposure", () => {
      let prevSpread = 0;
      for (const posFrac of [0, 0.2, 0.4, 0.6, 0.8]) {
        const pos = BigInt(Math.floor(posFrac * 1_000_000_000));
        const { bidPrice, askPrice } = calculateQuotes(
          100.0,
          pos,
          COLLATERAL,
        );
        const totalSpread = askPrice - bidPrice;
        expect(totalSpread).toBeGreaterThanOrEqual(prevSpread);
        prevSpread = totalSpread;
      }
    });
  });
});

describe("Floating Maker — Symbol Inference", () => {
  // Test the symbol inference logic (inline version)
  function inferFromPrice(markUsd: number): string {
    if (markUsd > 50_000) return "BTC";
    if (markUsd > 2_000) return "ETH";
    if (markUsd > 50) return "SOL";
    return "UNKNOWN";
  }

  it("identifies BTC from price > $50k", () => {
    expect(inferFromPrice(97_000)).toBe("BTC");
  });

  it("identifies ETH from price $2k-$50k", () => {
    expect(inferFromPrice(3_500)).toBe("ETH");
  });

  it("identifies SOL from price $50-$2000", () => {
    expect(inferFromPrice(150)).toBe("SOL");
  });

  it("returns UNKNOWN for low prices", () => {
    expect(inferFromPrice(0.00002)).toBe("UNKNOWN");
  });
});
