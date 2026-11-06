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
  const pct = computeLiquidationMovePct(positionSize, markPriceE6, liquidationPriceE6, fallbackDistancePct);
  return Math.max(0, Math.min(100, pct));
}

/**
 * The price move, as a percentage of the CURRENT MARK, that takes the position
 * to its liquidation price: (mark - liq) / mark for a long, (liq - mark) / mark
 * for a short. Unclamped above (a short can be more than 100% from liq), 0 once
 * the boundary is crossed. This is the number a trader checks by hand, so the
 * "X% to liq" labels print it unclamped; computeLiquidationDistancePct clamps it
 * to 0..100 for bars and severity tiers.
 *
 * Council GO1106 (trader seat): a short at mark $0.006612 with liq $0.009697
 * read "31.8% to liq" because the short side divided by the liq price; the move
 * to liq is 46.7%.
 */
export function computeLiquidationMovePct(
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

  // Keep two decimal places without converting large prices to Number first.
  const hundredthsOfPercent = (distanceE6 * 10_000n) / markPriceE6;

  return Number(hundredthsOfPercent) / 100;
}
