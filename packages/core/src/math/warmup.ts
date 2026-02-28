/**
 * Warmup leverage cap utilities.
 *
 * During the market warmup period, capital is released linearly over
 * `warmupPeriodSlots` slots, which constrains the effective leverage
 * and maximum position size available to traders.
 */

import { computeMaxLeverage } from "./trading.js";

// =============================================================================
// Warmup leverage cap utilities
// =============================================================================

/**
 * Compute unlocked capital during the warmup period.
 *
 * Capital is released linearly over `warmupPeriodSlots` slots starting from
 * `warmupStartedAtSlot`. Before warmup starts (startSlot === 0) or if the
 * warmup period is 0, all capital is considered unlocked.
 *
 * @param totalCapital    - Total deposited capital (native units).
 * @param currentSlot     - The current on-chain slot.
 * @param warmupStartSlot - Slot at which warmup started (0 = not started).
 * @param warmupPeriodSlots - Total slots in the warmup period.
 * @returns The amount of capital currently unlocked.
 */
export function computeWarmupUnlockedCapital(
  totalCapital: bigint,
  currentSlot: bigint,
  warmupStartSlot: bigint,
  warmupPeriodSlots: bigint,
): bigint {
  // No warmup configured or not started → all capital available
  if (warmupPeriodSlots === 0n || warmupStartSlot === 0n) return totalCapital;
  if (totalCapital <= 0n) return 0n;

  const elapsed = currentSlot > warmupStartSlot
    ? currentSlot - warmupStartSlot
    : 0n;

  // Warmup complete
  if (elapsed >= warmupPeriodSlots) return totalCapital;

  // Linear unlock: totalCapital * elapsed / warmupPeriodSlots
  return (totalCapital * elapsed) / warmupPeriodSlots;
}

/**
 * Compute the effective maximum leverage during the warmup period.
 *
 * During warmup, only unlocked capital can be used as margin. The effective
 * leverage relative to *total* capital is therefore capped at:
 *
 *   effectiveMaxLeverage = maxLeverage × (unlockedCapital / totalCapital)
 *
 * This returns a floored integer value (leverage is always a whole number
 * in the UI), with a minimum of 1x if any capital is unlocked.
 *
 * @param initialMarginBps   - Initial margin requirement in basis points.
 * @param totalCapital       - Total deposited capital (native units).
 * @param currentSlot        - The current on-chain slot.
 * @param warmupStartSlot    - Slot at which warmup started (0 = not started).
 * @param warmupPeriodSlots  - Total slots in the warmup period.
 * @returns The effective maximum leverage (integer, ≥ 1).
 */
export function computeWarmupLeverageCap(
  initialMarginBps: bigint,
  totalCapital: bigint,
  currentSlot: bigint,
  warmupStartSlot: bigint,
  warmupPeriodSlots: bigint,
): number {
  const maxLev = computeMaxLeverage(initialMarginBps);

  // No warmup or warmup not started → full leverage
  if (warmupPeriodSlots === 0n || warmupStartSlot === 0n) return maxLev;
  if (totalCapital <= 0n) return 1;

  const unlocked = computeWarmupUnlockedCapital(
    totalCapital,
    currentSlot,
    warmupStartSlot,
    warmupPeriodSlots,
  );

  if (unlocked <= 0n) return 1; // At least 1x if nothing unlocked yet (slot 0 edge)

  // Effective leverage = maxLev * (unlocked / total), floored, min 1
  const effectiveLev = Number((BigInt(maxLev) * unlocked) / totalCapital);
  return Math.max(1, effectiveLev);
}

/**
 * Compute the maximum position size allowed during warmup.
 *
 * This is the unlocked capital multiplied by the base max leverage.
 * Unlike `computeWarmupLeverageCap` (which gives effective leverage
 * relative to total capital), this gives the absolute notional cap.
 *
 * @param initialMarginBps   - Initial margin requirement in basis points.
 * @param totalCapital       - Total deposited capital (native units).
 * @param currentSlot        - The current on-chain slot.
 * @param warmupStartSlot    - Slot at which warmup started (0 = not started).
 * @param warmupPeriodSlots  - Total slots in the warmup period.
 * @returns Maximum position size in native units.
 */
export function computeWarmupMaxPositionSize(
  initialMarginBps: bigint,
  totalCapital: bigint,
  currentSlot: bigint,
  warmupStartSlot: bigint,
  warmupPeriodSlots: bigint,
): bigint {
  const maxLev = computeMaxLeverage(initialMarginBps);
  const unlocked = computeWarmupUnlockedCapital(
    totalCapital,
    currentSlot,
    warmupStartSlot,
    warmupPeriodSlots,
  );
  return unlocked * BigInt(maxLev);
}
