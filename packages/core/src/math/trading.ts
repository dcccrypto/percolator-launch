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
 * Dynamic fee tier configuration.
 */
export interface FeeTierConfig {
  /** Base trading fee (Tier 1) in bps */
  baseBps: bigint;
  /** Tier 2 fee in bps (0 = disabled) */
  tier2Bps: bigint;
  /** Tier 3 fee in bps (0 = disabled) */
  tier3Bps: bigint;
  /** Notional threshold to enter Tier 2 (0 = tiered fees disabled) */
  tier2Threshold: bigint;
  /** Notional threshold to enter Tier 3 */
  tier3Threshold: bigint;
}

/**
 * Compute the effective fee rate in bps using the tiered fee schedule.
 *
 * Mirrors on-chain `compute_dynamic_fee_bps` logic:
 * - notional < tier2Threshold → baseBps (Tier 1)
 * - notional < tier3Threshold → tier2Bps (Tier 2)
 * - notional >= tier3Threshold → tier3Bps (Tier 3)
 *
 * If tier2Threshold == 0, tiered fees are disabled (flat baseBps).
 */
export function computeDynamicFeeBps(
  notional: bigint,
  config: FeeTierConfig,
): bigint {
  if (config.tier2Threshold === 0n) return config.baseBps;
  if (config.tier3Threshold > 0n && notional >= config.tier3Threshold) return config.tier3Bps;
  if (notional >= config.tier2Threshold) return config.tier2Bps;
  return config.baseBps;
}

/**
 * Compute the dynamic trading fee for a given notional and tier config.
 *
 * Uses ceiling division to match on-chain behavior (prevents fee evasion
 * via micro-trades).
 */
export function computeDynamicTradingFee(
  notional: bigint,
  config: FeeTierConfig,
): bigint {
  const feeBps = computeDynamicFeeBps(notional, config);
  if (notional <= 0n || feeBps <= 0n) return 0n;
  return (notional * feeBps + 9999n) / 10000n;
}

/**
 * Fee split configuration.
 */
export interface FeeSplitConfig {
  /** LP vault share in bps (0–10_000) */
  lpBps: bigint;
  /** Protocol treasury share in bps */
  protocolBps: bigint;
  /** Market creator share in bps */
  creatorBps: bigint;
}

/**
 * Compute fee split for a total fee amount.
 *
 * Returns [lpShare, protocolShare, creatorShare].
 * If all split params are 0, 100% goes to LP (legacy behavior).
 * Creator gets the rounding remainder to ensure total is preserved.
 */
export function computeFeeSplit(
  totalFee: bigint,
  config: FeeSplitConfig,
): [bigint, bigint, bigint] {
  if (config.lpBps === 0n && config.protocolBps === 0n && config.creatorBps === 0n) {
    return [totalFee, 0n, 0n];
  }
  const lp = (totalFee * config.lpBps) / 10000n;
  const protocol = (totalFee * config.protocolBps) / 10000n;
  const creator = totalFee - lp - protocol;
  return [lp, protocol, creator];
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
