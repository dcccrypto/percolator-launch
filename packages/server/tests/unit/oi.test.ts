/**
 * Unit tests for Open Interest (OI) Calculations
 * Tests long/short breakdown, imbalance calculations, and aggregations
 */

import { describe, test, expect } from 'vitest';

interface OIInput {
  totalOI: bigint;
  netLpPos: bigint; // Net LP position (positive = LP long, negative = LP short)
}

interface OIBreakdown {
  totalOI: bigint;
  longOI: bigint;
  shortOI: bigint;
  netLpPosition: bigint;
  imbalancePercent: number;
  lpSide: 'long' | 'short' | 'neutral';
}

interface ImbalanceInput {
  longOI: bigint;
  shortOI: bigint;
}

/**
 * Calculate long/short OI from total OI and net LP position
 * 
 * Logic:
 * - Total OI = Sum of absolute position sizes
 * - Net LP Position = LP long - LP short (from LP's perspective)
 * - Trader net position = -netLpPos (traders are opposite of LPs)
 * 
 * Math:
 * - Long OI = (Total OI + Trader Net) / 2 = (Total OI - Net LP Pos) / 2
 * - Short OI = (Total OI - Trader Net) / 2 = (Total OI + Net LP Pos) / 2
 */
function calculateLongShortOI(input: OIInput): OIBreakdown {
  const { totalOI, netLpPos } = input;

  // Net trader position is opposite of LP position
  const netTraderPos = -netLpPos;

  // Calculate long and short OI
  const longOI = (totalOI + netTraderPos) / 2n;
  const shortOI = (totalOI - netTraderPos) / 2n;

  const imbalancePercent = calculateImbalance({ longOI, shortOI });

  let lpSide: 'long' | 'short' | 'neutral';
  if (netLpPos > 0n) {
    lpSide = 'long';
  } else if (netLpPos < 0n) {
    lpSide = 'short';
  } else {
    lpSide = 'neutral';
  }

  return {
    totalOI,
    longOI,
    shortOI,
    netLpPosition: netLpPos,
    imbalancePercent,
    lpSide,
  };
}

/**
 * Calculate imbalance percentage
 * Positive = more long, Negative = more short
 * 
 * Formula: ((Long - Short) / Total) * 100
 */
function calculateImbalance(input: ImbalanceInput): number {
  const { longOI, shortOI } = input;
  const total = longOI + shortOI;

  if (total === 0n) {
    return 0;
  }

  const difference = longOI - shortOI;
  const imbalance = Number((difference * 10000n) / total) / 100;

  return imbalance;
}

describe('Open Interest Calculations', () => {
  describe('Long/Short Breakdown', () => {
    test('calculates long/short from net LP position (LP net short)', () => {
      const oi = calculateLongShortOI({
        totalOI: 1000000n,
        netLpPos: -200000n, // LP net short 200k → traders net long 200k
      });

      expect(oi.longOI).toBe(600000n); // (1M + 200k) / 2
      expect(oi.shortOI).toBe(400000n); // (1M - 200k) / 2
      expect(oi.lpSide).toBe('short');
      expect(oi.netLpPosition).toBe(-200000n);
    });

    test('calculates long/short from net LP position (LP net long)', () => {
      const oi = calculateLongShortOI({
        totalOI: 1000000n,
        netLpPos: 300000n, // LP net long 300k → traders net short 300k
      });

      expect(oi.longOI).toBe(350000n); // (1M - 300k) / 2
      expect(oi.shortOI).toBe(650000n); // (1M + 300k) / 2
      expect(oi.lpSide).toBe('long');
      expect(oi.netLpPosition).toBe(300000n);
    });

    test('handles balanced market (net LP position = 0)', () => {
      const oi = calculateLongShortOI({
        totalOI: 1000000n,
        netLpPos: 0n,
      });

      expect(oi.longOI).toBe(500000n);
      expect(oi.shortOI).toBe(500000n);
      expect(oi.lpSide).toBe('neutral');
      expect(oi.imbalancePercent).toBe(0);
    });
  });

  describe('Imbalance Calculation', () => {
    test('calculates 20% long imbalance', () => {
      const imbalance = calculateImbalance({
        longOI: 600000n,
        shortOI: 400000n,
      });

      expect(imbalance).toBeCloseTo(20, 1); // 20% more long
    });

    test('calculates 50% long imbalance', () => {
      const imbalance = calculateImbalance({
        longOI: 750000n,
        shortOI: 250000n,
      });

      expect(imbalance).toBeCloseTo(50, 1);
    });

    test('calculates negative imbalance (more short)', () => {
      const imbalance = calculateImbalance({
        longOI: 300000n,
        shortOI: 700000n,
      });

      expect(imbalance).toBeCloseTo(-40, 1); // 40% more short
    });

    test('calculates zero imbalance for balanced market', () => {
      const imbalance = calculateImbalance({
        longOI: 500000n,
        shortOI: 500000n,
      });

      expect(imbalance).toBe(0);
    });

    test('handles extreme imbalance (95% long)', () => {
      const imbalance = calculateImbalance({
        longOI: 950000n,
        shortOI: 50000n,
      });

      expect(imbalance).toBeCloseTo(90, 1);
    });
  });

  describe('Edge Cases', () => {
    test('handles zero total OI', () => {
      const oi = calculateLongShortOI({
        totalOI: 0n,
        netLpPos: 0n,
      });

      expect(oi.longOI).toBe(0n);
      expect(oi.shortOI).toBe(0n);
      expect(oi.imbalancePercent).toBe(0);
    });

    test('handles net LP position equal to total OI', () => {
      const oi = calculateLongShortOI({
        totalOI: 1000000n,
        netLpPos: 1000000n, // LP fully long
      });

      // (1M - 1M) / 2 = 0 long, (1M + 1M) / 2 = 1M short
      expect(oi.longOI).toBe(0n);
      expect(oi.shortOI).toBe(1000000n);
      expect(oi.lpSide).toBe('long');
    });

    test('handles net LP position equal to negative total OI', () => {
      const oi = calculateLongShortOI({
        totalOI: 1000000n,
        netLpPos: -1000000n, // LP fully short
      });

      // (1M + 1M) / 2 = 1M long, (1M - 1M) / 2 = 0 short
      expect(oi.longOI).toBe(1000000n);
      expect(oi.shortOI).toBe(0n);
      expect(oi.lpSide).toBe('short');
    });

    test('handles odd total OI (rounding)', () => {
      const oi = calculateLongShortOI({
        totalOI: 1000001n, // Odd number
        netLpPos: 0n,
      });

      // Integer division: 1000001 / 2 = 500000
      expect(oi.longOI).toBe(500000n);
      expect(oi.shortOI).toBe(500000n);
    });
  });

  describe('Large Numbers', () => {
    test('handles very large OI values', () => {
      const oi = calculateLongShortOI({
        totalOI: 1000000000000n, // 1 trillion
        netLpPos: 100000000000n, // 100 billion
      });

      expect(oi.longOI).toBe(450000000000n);
      expect(oi.shortOI).toBe(550000000000n);
    });

    test('handles precision with large numbers', () => {
      const oi = calculateLongShortOI({
        totalOI: 123456789012n,
        netLpPos: 12345678901n,
      });

      expect(oi.longOI).toBe(55555555055n);
      expect(oi.shortOI).toBe(67901233956n);
    });
  });

  describe('Math Consistency', () => {
    test('long + short always equals total OI (even)', () => {
      const oi = calculateLongShortOI({
        totalOI: 2000000n,
        netLpPos: 400000n,
      });

      expect(oi.longOI + oi.shortOI).toBe(oi.totalOI);
    });

    test('long + short equals total OI with odd numbers', () => {
      const oi = calculateLongShortOI({
        totalOI: 1000001n,
        netLpPos: 300001n,
      });

      // Due to integer division, may be off by 1
      expect(oi.longOI + oi.shortOI).toBeLessThanOrEqual(oi.totalOI);
      expect(oi.longOI + oi.shortOI).toBeGreaterThanOrEqual(oi.totalOI - 1n);
    });

    test('imbalance matches long/short breakdown', () => {
      const oi = calculateLongShortOI({
        totalOI: 1000000n,
        netLpPos: -200000n,
      });

      const directImbalance = calculateImbalance({
        longOI: oi.longOI,
        shortOI: oi.shortOI,
      });

      expect(oi.imbalancePercent).toBe(directImbalance);
    });
  });

  describe('LP Side Detection', () => {
    test('detects LP long side correctly', () => {
      const oi = calculateLongShortOI({
        totalOI: 1000000n,
        netLpPos: 100000n,
      });

      expect(oi.lpSide).toBe('long');
    });

    test('detects LP short side correctly', () => {
      const oi = calculateLongShortOI({
        totalOI: 1000000n,
        netLpPos: -100000n,
      });

      expect(oi.lpSide).toBe('short');
    });

    test('detects neutral LP position', () => {
      const oi = calculateLongShortOI({
        totalOI: 1000000n,
        netLpPos: 0n,
      });

      expect(oi.lpSide).toBe('neutral');
    });
  });

  describe('Real-World Scenarios', () => {
    test('scenario: heavily skewed long market', () => {
      const oi = calculateLongShortOI({
        totalOI: 10000000n, // $10M total OI
        netLpPos: -3000000n, // LP short $3M (traders long $3M)
      });

      expect(oi.longOI).toBe(6500000n); // $6.5M long
      expect(oi.shortOI).toBe(3500000n); // $3.5M short
      expect(oi.imbalancePercent).toBeCloseTo(30, 1); // 30% skew
      expect(oi.lpSide).toBe('short');
    });

    test('scenario: nearly balanced market', () => {
      const oi = calculateLongShortOI({
        totalOI: 5000000n,
        netLpPos: -50000n, // Tiny imbalance
      });

      expect(oi.longOI).toBe(2525000n);
      expect(oi.shortOI).toBe(2475000n);
      expect(oi.imbalancePercent).toBeCloseTo(1, 1); // ~1% imbalance
    });

    test('scenario: LP taking large directional bet', () => {
      const oi = calculateLongShortOI({
        totalOI: 8000000n,
        netLpPos: 2000000n, // LP long $2M
      });

      expect(oi.longOI).toBe(3000000n);
      expect(oi.shortOI).toBe(5000000n);
      expect(oi.imbalancePercent).toBeCloseTo(-25, 1); // More short
      expect(oi.lpSide).toBe('long');
    });
  });

  describe('Precision and Rounding', () => {
    test('handles division precision correctly', () => {
      const oi = calculateLongShortOI({
        totalOI: 999999n,
        netLpPos: 333333n,
      });

      // (999999 - 333333) / 2 = 333333
      // (999999 + 333333) / 2 = 666666
      expect(oi.longOI).toBe(333333n);
      expect(oi.shortOI).toBe(666666n);
    });

    test('handles imbalance percentage precision', () => {
      const imbalance = calculateImbalance({
        longOI: 666666n,
        shortOI: 333333n,
      });

      // (666666 - 333333) / 999999 * 100 ≈ 33.33%
      expect(imbalance).toBeCloseTo(33.33, 1);
    });
  });
});

describe('Global OI Aggregation', () => {
  describe('Multi-Market Aggregation', () => {
    test('sums OI across multiple markets', () => {
      const markets = [
        { totalOI: 1000000n, netLpPos: -100000n },
        { totalOI: 2000000n, netLpPos: 200000n },
        { totalOI: 500000n, netLpPos: -50000n },
      ];

      const totalOI = markets.reduce((sum, m) => sum + m.totalOI, 0n);
      const totalNetLpPos = markets.reduce((sum, m) => sum + m.netLpPos, 0n);

      expect(totalOI).toBe(3500000n);
      expect(totalNetLpPos).toBe(50000n); // -100k + 200k - 50k = 50k LP long
    });

    test('calculates aggregate long/short across markets', () => {
      const markets = [
        calculateLongShortOI({ totalOI: 1000000n, netLpPos: -200000n }),
        calculateLongShortOI({ totalOI: 2000000n, netLpPos: 100000n }),
      ];

      const totalLong = markets.reduce((sum, m) => sum + m.longOI, 0n);
      const totalShort = markets.reduce((sum, m) => sum + m.shortOI, 0n);

      // Market 1: 600k long, 400k short
      // Market 2: 950k long, 1050k short
      expect(totalLong).toBe(1550000n);
      expect(totalShort).toBe(1450000n);
    });
  });
});
