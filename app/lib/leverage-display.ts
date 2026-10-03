export const ORDER_LEVERAGE_LABEL = "Order Lev.";
export const RISK_LEVERAGE_LABEL = "Risk Lev.";

export const ORDER_LEVERAGE_TITLE =
  "Order leverage is the slider value used to size this trade.";

export const RISK_LEVERAGE_TITLE =
  "Risk leverage is this market account's effective exposure: position notional divided by collateral in this slab account. Extra collateral lowers liquidation risk.";

/**
 * Risk Lev. for the confirm modal: the position the account holds AFTER the trade
 * (`sizeAfter`, in order-ticket size units: notional * 1e6 / price) over the collateral
 * after it (capital + any deposit bundled with the trade + pnl). Null hides the row:
 * the account ends flat, there is no price, or no collateral.
 *
 * Not computePositionLeverage: that takes engine Q and scales by the collateral
 * decimals, so on ticket sizes it is off by 10^(decimals - 6) on non-6-decimal markets.
 * Rounded to 2dp so a plain 2x isn't printed as "2.0x" after the size round trip, with a
 * 0.01 floor so a tiny open position doesn't read "0x".
 */
export function computeRiskLeverage(sizeAfter: bigint, priceE6: bigint, collateralAfter: bigint): number | null {
  if (sizeAfter === 0n || priceE6 <= 0n || collateralAfter <= 0n) return null;
  const notional = ((sizeAfter < 0n ? -sizeAfter : sizeAfter) * priceE6) / 1_000_000n;
  const value = Math.round(Number((notional * 10_000n) / collateralAfter) / 100) / 100;
  if (!Number.isFinite(value)) return null;
  // An open position never reads "0x": below 0.005 shows the smallest 2dp step.
  return value > 0 ? value : 0.01;
}

export function formatLeverageValue(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (Number.isInteger(value)) return value.toString();
  // Up to 2dp, trailing zero trimmed. GH#2628: this was toFixed(1), which could
  // not show a value the rest of the pipeline can produce — a market's max is
  // derived to 2dp, so a 6.66x market's own preset button read "6.7x" while
  // applying 6.66, and a typed 4.56 displayed as "4.6". A control must not
  // apply a number it cannot show.
  return value.toFixed(2).replace(/0$/, "");
}

export function formatLeverage(value: number): string {
  return `${formatLeverageValue(value)}x`;
}
