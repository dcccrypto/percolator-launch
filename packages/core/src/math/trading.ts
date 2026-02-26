/**
 * Coin-margined perpetual trade math utilities.
 *
 * On-chain PnL formula:
 *   mark_pnl = (oracle - entry) * abs_pos / oracle   (longs)
 *   mark_pnl = (entry - oracle) * abs_pos / oracle   (shorts)
 *
 * All prices are in e6 format (1 USD = 1_000_000).
 * All token amounts are in native units (e.g. lamports).
 */

/**
 * Compute mark-to-market PnL for an open position.
 */
export function computeMarkPnl(
  positionSize: bigint,
  entryPrice: bigint,
  oraclePrice: bigint,
): bigint {
  if (positionSize === 0n || oraclePrice === 0n) return 0n;
  const absPos = positionSize < 0n ? -positionSize : positionSize;
  const diff =
    positionSize > 0n
      ? oraclePrice - entryPrice
      : entryPrice - oraclePrice;
  return (diff * absPos) / oraclePrice;
}

/**
 * Compute liquidation price given entry, capital, position and maintenance margin.
 * Uses pure BigInt arithmetic for precision (no Number() truncation).
 */
export function computeLiqPrice(
  entryPrice: bigint,
  capital: bigint,
  positionSize: bigint,
  maintenanceMarginBps: bigint,
): bigint {
  if (positionSize === 0n || entryPrice === 0n) return 0n;
  const absPos = positionSize < 0n ? -positionSize : positionSize;
  // capitalPerUnit scaled by 1e6 for precision
  const capitalPerUnitE6 = (capital * 1_000_000n) / absPos;

  if (positionSize > 0n) {
    const adjusted = (capitalPerUnitE6 * 10000n) / (10000n + maintenanceMarginBps);
    const liq = entryPrice - adjusted;
    return liq > 0n ? liq : 0n;
  } else {
    // Guard: short positions liquidate when price rises above liq price.
    // With >= 100% maintenance margin the denominator (10000 - maint) would be <= 0,
    // meaning the position can never be liquidated. Return max u64 to signal this.
    if (maintenanceMarginBps >= 10000n) return 18446744073709551615n; // max u64 — unliquidatable
    const adjusted = (capitalPerUnitE6 * 10000n) / (10000n - maintenanceMarginBps);
    return entryPrice + adjusted;
  }
}

/**
 * Compute estimated liquidation price BEFORE opening a trade.
 * Accounts for trading fees reducing effective capital.
 */
export function computePreTradeLiqPrice(
  oracleE6: bigint,
  margin: bigint,
  posSize: bigint,
  maintBps: bigint,
  feeBps: bigint,
  direction: "long" | "short",
): bigint {
  if (oracleE6 === 0n || margin === 0n || posSize === 0n) return 0n;
  const absPos = posSize < 0n ? -posSize : posSize;
  const fee = (absPos * feeBps) / 10000n;
  const effectiveCapital = margin > fee ? margin - fee : 0n;
  const signedPos = direction === "long" ? absPos : -absPos;
  return computeLiqPrice(oracleE6, effectiveCapital, signedPos, maintBps);
}

/**
 * Compute trading fee from notional value and fee rate in bps.
 */
export function computeTradingFee(
  notional: bigint,
  tradingFeeBps: bigint,
): bigint {
  return (notional * tradingFeeBps) / 10000n;
}

/**
 * Compute PnL as a percentage of capital.
 *
 * Uses BigInt scaling to avoid precision loss from Number(bigint) conversion.
 * Number(bigint) silently truncates values above 2^53, which can produce
 * incorrect percentages for large positions (e.g., tokens with 9 decimals
 * where capital > ~9M tokens in native units exceeds MAX_SAFE_INTEGER).
 */
export function computePnlPercent(
  pnlTokens: bigint,
  capital: bigint,
): number {
  if (capital === 0n) return 0;
  // Scale by 10000 in BigInt-land (2 extra decimal places), then convert once
  const scaledPct = (pnlTokens * 10_000n) / capital;
  return Number(scaledPct) / 100;
}

/**
 * Estimate entry price including fee impact (slippage approximation).
 */
export function computeEstimatedEntryPrice(
  oracleE6: bigint,
  tradingFeeBps: bigint,
  direction: "long" | "short",
): bigint {
  if (oracleE6 === 0n) return 0n;
  const feeImpact = (oracleE6 * tradingFeeBps) / 10000n;
  return direction === "long" ? oracleE6 + feeImpact : oracleE6 - feeImpact;
}

/**
 * Convert per-slot funding rate (bps) to annualized percentage.
 */
export function computeFundingRateAnnualized(
  fundingRateBpsPerSlot: bigint,
): number {
  const bpsPerSlot = Number(fundingRateBpsPerSlot);
  const slotsPerYear = 2.5 * 60 * 60 * 24 * 365; // ~400ms slots
  return (bpsPerSlot * slotsPerYear) / 100;
}

/**
 * Compute margin required for a given notional and initial margin bps.
 */
export function computeRequiredMargin(
  notional: bigint,
  initialMarginBps: bigint,
): bigint {
  return (notional * initialMarginBps) / 10000n;
}

/**
 * Compute maximum leverage from initial margin bps.
 */
export function computeMaxLeverage(initialMarginBps: bigint): number {
  if (initialMarginBps === 0n) return 1;
  return Number(10000n / initialMarginBps);
}

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
