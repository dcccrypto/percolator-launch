/**
 * Unit tests for Insurance Fund Health Calculations
 * Tests insurance health metrics, ratios, and accumulation rates
 */

import { describe, test, expect } from 'vitest';

interface InsuranceHealthInput {
  insuranceBalance: bigint;
  totalRisk: bigint;
}

interface InsuranceHealth {
  healthRatio: number;
  healthStatus: 'critical' | 'low' | 'healthy' | 'excellent';
  canAcceptNewPositions: boolean;
}

interface AccumulationRateInput {
  currentBalance: bigint;
  previousBalance: bigint;
  timeDeltaSeconds: number;
}

interface AccumulationRate {
  ratePerSecond: bigint;
  ratePerHour: bigint;
  ratePerDay: bigint;
  percentageGrowth: number;
}

/**
 * Calculate insurance health ratio
 * Ratio = Insurance Balance / Total Risk
 * 
 * Higher is better:
 * - < 0.5: Critical (50% coverage)
 * - 0.5 - 1.0: Low (50-100% coverage)
 * - 1.0 - 3.0: Healthy (1-3x coverage)
 * - > 3.0: Excellent (3x+ coverage)
 */
function calculateHealthRatio(input: InsuranceHealthInput): InsuranceHealth {
  const { insuranceBalance, totalRisk } = input;

  // Handle division by zero
  if (totalRisk === 0n) {
    return {
      healthRatio: Infinity,
      healthStatus: 'excellent',
      canAcceptNewPositions: true,
    };
  }

  // Handle zero insurance
  if (insuranceBalance === 0n) {
    return {
      healthRatio: 0,
      healthStatus: 'critical',
      canAcceptNewPositions: false,
    };
  }

  // Calculate ratio using float division
  const ratio = Number(insuranceBalance) / Number(totalRisk);

  let status: 'critical' | 'low' | 'healthy' | 'excellent';
  let canAcceptNewPositions: boolean;

  if (ratio < 0.5) {
    status = 'critical';
    canAcceptNewPositions = false;
  } else if (ratio < 1.0) {
    status = 'low';
    canAcceptNewPositions = true;
  } else if (ratio < 3.0) {
    status = 'healthy';
    canAcceptNewPositions = true;
  } else {
    status = 'excellent';
    canAcceptNewPositions = true;
  }

  return {
    healthRatio: ratio,
    healthStatus: status,
    canAcceptNewPositions,
  };
}

/**
 * Calculate insurance fund accumulation rate
 * How fast the insurance fund is growing from fees
 */
function calculateAccumulationRate(input: AccumulationRateInput): AccumulationRate {
  const { currentBalance, previousBalance, timeDeltaSeconds } = input;

  if (timeDeltaSeconds === 0) {
    return {
      ratePerSecond: 0n,
      ratePerHour: 0n,
      ratePerDay: 0n,
      percentageGrowth: 0,
    };
  }

  const delta = currentBalance - previousBalance;
  const ratePerSecond = delta / BigInt(timeDeltaSeconds);
  const ratePerHour = ratePerSecond * 3600n;
  const ratePerDay = ratePerSecond * 86400n;

  const percentageGrowth = previousBalance > 0n 
    ? Number((delta * 10000n) / previousBalance) / 100
    : 0;

  return {
    ratePerSecond,
    ratePerHour,
    ratePerDay,
    percentageGrowth,
  };
}

describe('Insurance Health Calculation', () => {
  describe('Health Ratio', () => {
    test('calculates correct health ratio for 5x coverage', () => {
      const health = calculateHealthRatio({
        insuranceBalance: 1000000n,
        totalRisk: 200000n,
      });

      expect(health.healthRatio).toBe(5.0);
      expect(health.healthStatus).toBe('excellent');
      expect(health.canAcceptNewPositions).toBe(true);
    });

    test('calculates correct health ratio for 2x coverage (healthy)', () => {
      const health = calculateHealthRatio({
        insuranceBalance: 2000000n,
        totalRisk: 1000000n,
      });

      expect(health.healthRatio).toBe(2.0);
      expect(health.healthStatus).toBe('healthy');
      expect(health.canAcceptNewPositions).toBe(true);
    });

    test('calculates correct health ratio for 1x coverage (edge of healthy)', () => {
      const health = calculateHealthRatio({
        insuranceBalance: 500000n,
        totalRisk: 500000n,
      });

      expect(health.healthRatio).toBe(1.0);
      expect(health.healthStatus).toBe('healthy');
      expect(health.canAcceptNewPositions).toBe(true);
    });

    test('calculates correct health ratio for 0.75x coverage (low)', () => {
      const health = calculateHealthRatio({
        insuranceBalance: 750000n,
        totalRisk: 1000000n,
      });

      expect(health.healthRatio).toBe(0.75);
      expect(health.healthStatus).toBe('low');
      expect(health.canAcceptNewPositions).toBe(true);
    });

    test('calculates correct health ratio for 0.3x coverage (critical)', () => {
      const health = calculateHealthRatio({
        insuranceBalance: 300000n,
        totalRisk: 1000000n,
      });

      expect(health.healthRatio).toBe(0.3);
      expect(health.healthStatus).toBe('critical');
      expect(health.canAcceptNewPositions).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    test('handles zero risk (infinite ratio)', () => {
      const health = calculateHealthRatio({
        insuranceBalance: 1000000n,
        totalRisk: 0n,
      });

      expect(health.healthRatio).toBe(Infinity);
      expect(health.healthStatus).toBe('excellent');
      expect(health.canAcceptNewPositions).toBe(true);
    });

    test('handles zero insurance (zero ratio)', () => {
      const health = calculateHealthRatio({
        insuranceBalance: 0n,
        totalRisk: 200000n,
      });

      expect(health.healthRatio).toBe(0);
      expect(health.healthStatus).toBe('critical');
      expect(health.canAcceptNewPositions).toBe(false);
    });

    test('handles both zero (no activity)', () => {
      const health = calculateHealthRatio({
        insuranceBalance: 0n,
        totalRisk: 0n,
      });

      expect(health.healthRatio).toBe(Infinity);
      expect(health.healthStatus).toBe('excellent');
      expect(health.canAcceptNewPositions).toBe(true);
    });
  });

  describe('Large Numbers', () => {
    test('handles very large insurance balances', () => {
      const health = calculateHealthRatio({
        insuranceBalance: 1000000000000n, // 1 trillion
        totalRisk: 100000000000n, // 100 billion
      });

      expect(health.healthRatio).toBe(10.0);
      expect(health.healthStatus).toBe('excellent');
    });

    test('handles precision with large numbers', () => {
      const health = calculateHealthRatio({
        insuranceBalance: 123456789012n,
        totalRisk: 98765432109n,
      });

      expect(health.healthRatio).toBeCloseTo(1.25, 2);
      expect(health.healthStatus).toBe('healthy');
    });
  });

  describe('Status Thresholds', () => {
    test('status is critical at exactly 0.5x ratio', () => {
      const health = calculateHealthRatio({
        insuranceBalance: 500000n,
        totalRisk: 1000000n,
      });

      // 0.5 should be "low" (boundary)
      expect(health.healthRatio).toBe(0.5);
      expect(health.healthStatus).toBe('low');
    });

    test('status is excellent at exactly 3x ratio', () => {
      const health = calculateHealthRatio({
        insuranceBalance: 3000000n,
        totalRisk: 1000000n,
      });

      expect(health.healthRatio).toBe(3.0);
      expect(health.healthStatus).toBe('excellent');
    });

    test('status is low just below 1x', () => {
      const health = calculateHealthRatio({
        insuranceBalance: 999999n,
        totalRisk: 1000000n,
      });

      expect(health.healthRatio).toBeCloseTo(0.999999, 4);
      expect(health.healthStatus).toBe('low');
    });
  });
});

describe('Accumulation Rate Calculation', () => {
  describe('Basic Rate Calculation', () => {
    test('calculates rate from growing balance', () => {
      const rate = calculateAccumulationRate({
        currentBalance: 1100000n,
        previousBalance: 1000000n,
        timeDeltaSeconds: 3600, // 1 hour
      });

      // 100,000 growth over 3600 seconds = 27.77 per second
      expect(rate.ratePerSecond).toBe(27n);
      expect(rate.ratePerHour).toBe(27n * 3600n);
      expect(rate.ratePerDay).toBe(27n * 86400n);
      expect(rate.percentageGrowth).toBeCloseTo(10, 1); // 10% growth
    });

    test('calculates rate for steady accumulation', () => {
      const rate = calculateAccumulationRate({
        currentBalance: 1001000n,
        previousBalance: 1000000n,
        timeDeltaSeconds: 60, // 1 minute
      });

      expect(rate.ratePerSecond).toBe(16n); // 1000 / 60 ≈ 16
      expect(rate.percentageGrowth).toBeCloseTo(0.1, 2);
    });

    test('calculates rate for fast growth', () => {
      const rate = calculateAccumulationRate({
        currentBalance: 2000000n,
        previousBalance: 1000000n,
        timeDeltaSeconds: 3600,
      });

      expect(rate.ratePerSecond).toBe(277n);
      expect(rate.percentageGrowth).toBe(100); // 100% growth
    });
  });

  describe('Edge Cases', () => {
    test('handles zero time delta', () => {
      const rate = calculateAccumulationRate({
        currentBalance: 1100000n,
        previousBalance: 1000000n,
        timeDeltaSeconds: 0,
      });

      expect(rate.ratePerSecond).toBe(0n);
      expect(rate.ratePerHour).toBe(0n);
      expect(rate.ratePerDay).toBe(0n);
      expect(rate.percentageGrowth).toBe(0);
    });

    test('handles no change in balance', () => {
      const rate = calculateAccumulationRate({
        currentBalance: 1000000n,
        previousBalance: 1000000n,
        timeDeltaSeconds: 3600,
      });

      expect(rate.ratePerSecond).toBe(0n);
      expect(rate.percentageGrowth).toBe(0);
    });

    test('handles decreasing balance (negative rate)', () => {
      const rate = calculateAccumulationRate({
        currentBalance: 900000n,
        previousBalance: 1000000n,
        timeDeltaSeconds: 3600,
      });

      expect(rate.ratePerSecond).toBeLessThan(0n);
      expect(rate.percentageGrowth).toBeCloseTo(-10, 1);
    });

    test('handles zero previous balance', () => {
      const rate = calculateAccumulationRate({
        currentBalance: 100000n,
        previousBalance: 0n,
        timeDeltaSeconds: 3600,
      });

      expect(rate.ratePerSecond).toBe(27n); // 100000 / 3600
      expect(rate.percentageGrowth).toBe(0); // Can't calculate % from 0
    });
  });

  describe('Time Scaling', () => {
    test('scales correctly from seconds to hours', () => {
      const rate = calculateAccumulationRate({
        currentBalance: 1003600n,
        previousBalance: 1000000n,
        timeDeltaSeconds: 3600,
      });

      expect(rate.ratePerSecond).toBe(1n);
      expect(rate.ratePerHour).toBe(3600n);
    });

    test('scales correctly from seconds to days', () => {
      const rate = calculateAccumulationRate({
        currentBalance: 1086400n,
        previousBalance: 1000000n,
        timeDeltaSeconds: 86400, // 1 day
      });

      expect(rate.ratePerSecond).toBe(1n);
      expect(rate.ratePerDay).toBe(86400n);
    });

    test('handles very short time periods', () => {
      const rate = calculateAccumulationRate({
        currentBalance: 1000010n,
        previousBalance: 1000000n,
        timeDeltaSeconds: 1, // 1 second
      });

      expect(rate.ratePerSecond).toBe(10n);
      expect(rate.ratePerDay).toBe(864000n);
    });
  });

  describe('Large Numbers', () => {
    test('handles very large balances', () => {
      const rate = calculateAccumulationRate({
        currentBalance: 1100000000000n, // 1.1 trillion
        previousBalance: 1000000000000n, // 1 trillion
        timeDeltaSeconds: 86400,
      });

      expect(rate.ratePerSecond).toBe(1157407n);
      expect(rate.percentageGrowth).toBeCloseTo(10, 1);
    });
  });

  describe('Percentage Growth', () => {
    test('calculates 10% growth correctly', () => {
      const rate = calculateAccumulationRate({
        currentBalance: 1100000n,
        previousBalance: 1000000n,
        timeDeltaSeconds: 3600,
      });

      expect(rate.percentageGrowth).toBeCloseTo(10, 1);
    });

    test('calculates 0.5% growth correctly', () => {
      const rate = calculateAccumulationRate({
        currentBalance: 1005000n,
        previousBalance: 1000000n,
        timeDeltaSeconds: 3600,
      });

      expect(rate.percentageGrowth).toBeCloseTo(0.5, 1);
    });

    test('calculates negative growth correctly', () => {
      const rate = calculateAccumulationRate({
        currentBalance: 950000n,
        previousBalance: 1000000n,
        timeDeltaSeconds: 3600,
      });

      expect(rate.percentageGrowth).toBeCloseTo(-5, 1);
    });
  });
});
