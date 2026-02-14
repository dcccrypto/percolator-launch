/**
 * Unit tests for PNL Warmup Progress Calculation
 * Tests the warmup vesting logic for gradually unlocking profits
 */

import { describe, test, expect } from 'vitest';

// Type definitions for warmup calculation
interface WarmupInput {
  warmupStartSlot: bigint;
  currentSlot: bigint;
  warmupPeriodSlots: bigint;
  totalAmount: bigint;
}

interface WarmupProgress {
  warmupActive: boolean;
  percentComplete: number;
  slotsRemaining: bigint;
  slotsElapsed: bigint;
  lockedAmount: bigint;
  unlockedAmount: bigint;
  estimatedSecondsRemaining: number;
}

/**
 * Calculate warmup progress for PNL vesting
 * 
 * Logic:
 * - If warmup not started (warmupStartSlot = 0), warmup is inactive
 * - If currentSlot < warmupStartSlot, warmup hasn't begun (edge case)
 * - If elapsed >= period, warmup is complete (100% unlocked)
 * - Otherwise, calculate percentage based on elapsed / total
 */
function calculateWarmupProgress(input: WarmupInput): WarmupProgress {
  const { warmupStartSlot, currentSlot, warmupPeriodSlots, totalAmount } = input;

  // Warmup not started
  if (warmupStartSlot === 0n) {
    return {
      warmupActive: false,
      percentComplete: 0,
      slotsRemaining: 0n,
      slotsElapsed: 0n,
      lockedAmount: totalAmount,
      unlockedAmount: 0n,
      estimatedSecondsRemaining: 0,
    };
  }

  // Edge case: current slot before start slot
  if (currentSlot < warmupStartSlot) {
    return {
      warmupActive: true,
      percentComplete: 0,
      slotsRemaining: warmupPeriodSlots,
      slotsElapsed: 0n,
      lockedAmount: totalAmount,
      unlockedAmount: 0n,
      estimatedSecondsRemaining: Number(warmupPeriodSlots) * 0.4, // ~0.4s per slot
    };
  }

  const elapsed = currentSlot - warmupStartSlot;

  // Warmup complete
  if (elapsed >= warmupPeriodSlots) {
    return {
      warmupActive: false,
      percentComplete: 100,
      slotsRemaining: 0n,
      slotsElapsed: warmupPeriodSlots,
      lockedAmount: 0n,
      unlockedAmount: totalAmount,
      estimatedSecondsRemaining: 0,
    };
  }

  // Warmup in progress
  const percentComplete = Number((elapsed * 100n) / warmupPeriodSlots);
  const remaining = warmupPeriodSlots - elapsed;
  const unlocked = (totalAmount * elapsed) / warmupPeriodSlots;
  const locked = totalAmount - unlocked;

  return {
    warmupActive: true,
    percentComplete,
    slotsRemaining: remaining,
    slotsElapsed: elapsed,
    lockedAmount: locked,
    unlockedAmount: unlocked,
    estimatedSecondsRemaining: Number(remaining) * 0.4,
  };
}

describe('Warmup Progress Calculation', () => {
  describe('Basic Progress Calculation', () => {
    test('calculates correct percentage for mid-warmup (50%)', () => {
      const result = calculateWarmupProgress({
        warmupStartSlot: 1000n,
        currentSlot: 1500n,
        warmupPeriodSlots: 1000n,
        totalAmount: 1000000n,
      });

      expect(result.warmupActive).toBe(true);
      expect(result.percentComplete).toBe(50);
      expect(result.slotsRemaining).toBe(500n);
      expect(result.slotsElapsed).toBe(500n);
      expect(result.lockedAmount).toBe(500000n);
      expect(result.unlockedAmount).toBe(500000n);
    });

    test('calculates correct percentage for 25% warmup', () => {
      const result = calculateWarmupProgress({
        warmupStartSlot: 2000n,
        currentSlot: 2250n,
        warmupPeriodSlots: 1000n,
        totalAmount: 10000n,
      });

      expect(result.warmupActive).toBe(true);
      expect(result.percentComplete).toBe(25);
      expect(result.slotsRemaining).toBe(750n);
      expect(result.lockedAmount).toBe(7500n);
      expect(result.unlockedAmount).toBe(2500n);
    });

    test('calculates correct percentage for 75% warmup', () => {
      const result = calculateWarmupProgress({
        warmupStartSlot: 1000n,
        currentSlot: 1750n,
        warmupPeriodSlots: 1000n,
        totalAmount: 800000n,
      });

      expect(result.warmupActive).toBe(true);
      expect(result.percentComplete).toBe(75);
      expect(result.slotsRemaining).toBe(250n);
      expect(result.lockedAmount).toBe(200000n);
      expect(result.unlockedAmount).toBe(600000n);
    });
  });

  describe('Edge Cases', () => {
    test('returns 100% when warmup complete', () => {
      const result = calculateWarmupProgress({
        warmupStartSlot: 1000n,
        currentSlot: 2000n,
        warmupPeriodSlots: 1000n,
        totalAmount: 5000n,
      });

      expect(result.warmupActive).toBe(false);
      expect(result.percentComplete).toBe(100);
      expect(result.slotsRemaining).toBe(0n);
      expect(result.lockedAmount).toBe(0n);
      expect(result.unlockedAmount).toBe(5000n);
    });

    test('returns 100% when current slot exceeds warmup period', () => {
      const result = calculateWarmupProgress({
        warmupStartSlot: 1000n,
        currentSlot: 5000n,
        warmupPeriodSlots: 1000n,
        totalAmount: 10000n,
      });

      expect(result.warmupActive).toBe(false);
      expect(result.percentComplete).toBe(100);
      expect(result.slotsRemaining).toBe(0n);
      expect(result.unlockedAmount).toBe(10000n);
    });

    test('handles warmup not started (warmupStartSlot = 0)', () => {
      const result = calculateWarmupProgress({
        warmupStartSlot: 0n,
        currentSlot: 1500n,
        warmupPeriodSlots: 1000n,
        totalAmount: 10000n,
      });

      expect(result.warmupActive).toBe(false);
      expect(result.percentComplete).toBe(0);
      expect(result.lockedAmount).toBe(10000n);
      expect(result.unlockedAmount).toBe(0n);
    });

    test('handles edge case: current slot < start slot', () => {
      const result = calculateWarmupProgress({
        warmupStartSlot: 2000n,
        currentSlot: 1500n,
        warmupPeriodSlots: 1000n,
        totalAmount: 10000n,
      });

      expect(result.warmupActive).toBe(true);
      expect(result.percentComplete).toBe(0);
      expect(result.slotsRemaining).toBe(1000n);
      expect(result.lockedAmount).toBe(10000n);
      expect(result.unlockedAmount).toBe(0n);
    });

    test('handles zero warmup period (instant unlock)', () => {
      const result = calculateWarmupProgress({
        warmupStartSlot: 1000n,
        currentSlot: 1000n,
        warmupPeriodSlots: 0n,
        totalAmount: 10000n,
      });

      // When period is 0, any elapsed time >= period, so 100% unlocked
      expect(result.warmupActive).toBe(false);
      expect(result.percentComplete).toBe(100);
    });

    test('handles zero total amount', () => {
      const result = calculateWarmupProgress({
        warmupStartSlot: 1000n,
        currentSlot: 1500n,
        warmupPeriodSlots: 1000n,
        totalAmount: 0n,
      });

      expect(result.lockedAmount).toBe(0n);
      expect(result.unlockedAmount).toBe(0n);
      expect(result.percentComplete).toBe(50); // Still shows progress
    });
  });

  describe('Large Numbers', () => {
    test('handles large amounts without overflow', () => {
      const result = calculateWarmupProgress({
        warmupStartSlot: 100000n,
        currentSlot: 150000n,
        warmupPeriodSlots: 100000n,
        totalAmount: 1000000000000n, // 1 trillion
      });

      expect(result.percentComplete).toBe(50);
      expect(result.unlockedAmount).toBe(500000000000n);
      expect(result.lockedAmount).toBe(500000000000n);
    });

    test('handles very long warmup periods', () => {
      const result = calculateWarmupProgress({
        warmupStartSlot: 1000n,
        currentSlot: 11000n,
        warmupPeriodSlots: 100000n, // Very long warmup
        totalAmount: 1000000n,
      });

      expect(result.percentComplete).toBe(10);
      expect(result.slotsRemaining).toBe(90000n);
    });
  });

  describe('Time Estimation', () => {
    test('estimates seconds remaining correctly', () => {
      const result = calculateWarmupProgress({
        warmupStartSlot: 1000n,
        currentSlot: 1500n,
        warmupPeriodSlots: 1000n,
        totalAmount: 10000n,
      });

      // 500 slots remaining * 0.4 seconds = 200 seconds
      expect(result.estimatedSecondsRemaining).toBe(200);
    });

    test('estimates zero seconds when complete', () => {
      const result = calculateWarmupProgress({
        warmupStartSlot: 1000n,
        currentSlot: 2000n,
        warmupPeriodSlots: 1000n,
        totalAmount: 10000n,
      });

      expect(result.estimatedSecondsRemaining).toBe(0);
    });
  });

  describe('Precision', () => {
    test('handles non-round percentages correctly', () => {
      const result = calculateWarmupProgress({
        warmupStartSlot: 1000n,
        currentSlot: 1333n,
        warmupPeriodSlots: 1000n,
        totalAmount: 9000n,
      });

      expect(result.percentComplete).toBe(33); // 333/1000 = 33%
      expect(result.slotsElapsed).toBe(333n);
    });

    test('handles rounding in amount calculation', () => {
      const result = calculateWarmupProgress({
        warmupStartSlot: 1000n,
        currentSlot: 1333n,
        warmupPeriodSlots: 1000n,
        totalAmount: 10000n,
      });

      // 10000 * 333 / 1000 = 3330
      expect(result.unlockedAmount).toBe(3330n);
      expect(result.lockedAmount).toBe(6670n);
    });
  });
});
