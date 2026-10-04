/**
 * What a missing liquidation price actually means.
 *
 * `computeLiqPrice` returns `0n` for a long whenever
 * `capital/|size| * 10000/(10000+mm) >= entry` — that is, whenever the
 * collateral backing the position exceeds roughly its notional. Percolator is
 * cross-margin: `capital` is everything deposited into THAT market's portfolio
 * (the scan is keyed `programId|slab|wallet`), not the margin implied by the
 * order's leverage dial. So a "2x" long opened against a well-funded portfolio
 * genuinely has no price at which it liquidates — the loss is absorbed by
 * capital long before the health test trips. Verified against the engine:
 * `liquidation_projected_health_deficit_from_parts` compares portfolio equity
 * to the portfolio's total maintenance requirement, and
 * `liquidation_uncovered_loss_after_principal` is `|pnl| - capital`.
 *
 * That `0n` is truthful. The problem is that it is indistinguishable from the
 * OTHER reasons a liq price is unavailable — no entry resolved, no mark price
 * yet — and everything downstream treated all of them as one thing:
 *
 *   computeLiquidationDistancePct(...)  -> 100  ("100% away from liquidation")
 *   getLiquidationSeverity(100)         -> "safe"
 *
 * So a position with no mark price renders as maximally safe. That is exactly
 * the failure #2412 was fixed to prevent — its comment reads "an absent risk
 * signal is not evidence of safety" and fails NaN to "danger" — but the
 * fallback returns a finite 100, which walks straight past the `isFinite`
 * guard without ever being NaN.
 *
 * Three outcomes, three answers:
 *   - "liquidatable"   a real distance; rank it normally
 *   - "unliquidatable" collateral covers the position at any price; genuinely
 *                      safe, and worth SAYING rather than showing a dash
 *   - "unknown"        we could not compute it; not evidence of anything, and
 *                      must never read as safe
 */

export type LiquidationState =
  /** A real liquidation price exists; `distancePct` is meaningful. */
  | { kind: "liquidatable"; distancePct: number }
  /** No price liquidates this position at its current collateral. */
  | { kind: "unliquidatable" }
  /** Not computable — missing mark, missing entry, or no position. */
  | { kind: "unknown"; reason: "no-position" | "no-mark" | "no-entry" };

/**
 * Classify a position's liquidation risk from the same inputs the display
 * already has.
 *
 * `hasResolvedEntry` is what separates "unliquidatable" from "unknown": both
 * arrive here as `liquidationPriceE6 === 0n`, and only a resolved entry price
 * makes the zero a real statement about the position rather than a gap in the
 * data. It is the same condition the three position components already use to
 * decide whether to render the unliquidatable symbol.
 */
export function classifyLiquidation(
  positionSize: bigint,
  markPriceE6: bigint,
  liquidationPriceE6: bigint,
  hasResolvedEntry: boolean,
): LiquidationState {
  if (positionSize === 0n) return { kind: "unknown", reason: "no-position" };
  if (markPriceE6 <= 0n) return { kind: "unknown", reason: "no-mark" };

  if (liquidationPriceE6 <= 0n) {
    // Zero means two different things. Only a resolved entry makes it a claim.
    return hasResolvedEntry
      ? { kind: "unliquidatable" }
      : { kind: "unknown", reason: "no-entry" };
  }

  const isLong = positionSize > 0n;
  const crossed = isLong
    ? markPriceE6 <= liquidationPriceE6
    : markPriceE6 >= liquidationPriceE6;
  if (crossed) return { kind: "liquidatable", distancePct: 0 };

  const distanceE6 = isLong
    ? markPriceE6 - liquidationPriceE6
    : liquidationPriceE6 - markPriceE6;
  // Same canonical denominators the existing helper uses:
  //   long  => (mark - liq) / mark
  //   short => (liq - mark) / liq
  const denominatorE6 = isLong ? markPriceE6 : liquidationPriceE6;
  const hundredths = (distanceE6 * 10_000n) / denominatorE6;
  return { kind: "liquidatable", distancePct: Number(hundredths) / 100 };
}

/**
 * The collateral at which a LONG stops having a liquidation price, so the UI
 * can explain the relationship instead of just withholding a number: at the
 * notional (at entry), capital covers the position at any price — the engine's
 * maintenance check never fires once equity >= notional (lib/liquidation-risk.ts).
 * The SDK's old formula put it at `notional * (1 + mm)` (#2987). The maintenance
 * margin argument is kept for callers.
 */
export function unliquidatableCollateralThreshold(
  positionSize: bigint,
  entryPriceE6: bigint,
  _maintenanceMarginBps: bigint,
): bigint {
  if (positionSize <= 0n || entryPriceE6 <= 0n) return 0n;
  // Rounded up: one atom below this still leaves a liquidation price.
  return (positionSize * entryPriceE6 + 999_999n) / 1_000_000n;
}
