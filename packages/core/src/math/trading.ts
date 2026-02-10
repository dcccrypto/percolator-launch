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
 */
export function computeLiqPrice(
  entryPrice: bigint,
  capital: bigint,
  positionSize: bigint,
  maintenanceMarginBps: bigint,
): bigint {
  if (positionSize === 0n || entryPrice === 0n) return 0n;
  const absPos = positionSize < 0n ? -positionSize : positionSize;
  const maintBps = Number(maintenanceMarginBps);
  const capitalPerUnit = (Number(capital) * 1e6) / Number(absPos);

  if (positionSize > 0n) {
    // Long: liq when price drops. Adjust for maintenance margin requirement.
    const adjusted = (capitalPerUnit * 10000) / (10000 + maintBps);
    const liq = Number(entryPrice) - adjusted;
    return liq > 0 ? BigInt(Math.round(liq)) : 0n;
  } else {
    // Short: liq when price rises. For shorts, maintenance margin reduces the buffer.
    const denom = 10000 - maintBps;
    if (denom <= 0) return 0n; // Guard: maintBps >= 100% means no valid liq price
    const adjusted = (capitalPerUnit * 10000) / denom;
    return BigInt(Math.round(Number(entryPrice) + adjusted));
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
 */
export function computePnlPercent(
  pnlTokens: bigint,
  capital: bigint,
): number {
  if (capital === 0n) return 0;
  return (Number(pnlTokens) / Number(capital)) * 100;
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
