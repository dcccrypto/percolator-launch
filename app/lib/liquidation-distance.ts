/**
 * Computes the directional percentage distance from the current mark price
 * to the position's liquidation price.
 *
 * Long positions are liquidated as the mark moves down to the liquidation
 * price. Short positions are liquidated as the mark moves up to it.
 *
 * Returns fallbackDistancePct when the position or prices are unavailable.
 */
export function computeLiquidationDistancePct(
  positionSize: bigint,
  markPriceE6: bigint,
  liquidationPriceE6: bigint,
  fallbackDistancePct = 100,
): number {
  if (positionSize === 0n || markPriceE6 <= 0n || liquidationPriceE6 <= 0n) {
    return fallbackDistancePct;
  }

  const isLong = positionSize > 0n;

  const crossedLiquidationBoundary = isLong
    ? markPriceE6 <= liquidationPriceE6
    : markPriceE6 >= liquidationPriceE6;

  if (crossedLiquidationBoundary) {
    return 0;
  }

  const distanceE6 = isLong ? markPriceE6 - liquidationPriceE6 : liquidationPriceE6 - markPriceE6;

  // Preserve the existing canonical denominators:
  // long  => (mark - liquidation) / mark
  // short => (liquidation - mark) / liquidation
  const denominatorE6 = isLong ? markPriceE6 : liquidationPriceE6;

  // Keep two decimal places without converting large prices to Number first.
  const hundredthsOfPercent = (distanceE6 * 10_000n) / denominatorE6;

  return Math.max(0, Math.min(100, Number(hundredthsOfPercent) / 100));
}
