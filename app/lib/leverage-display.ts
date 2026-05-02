export const ORDER_LEVERAGE_LABEL = "Order Lev.";
export const RISK_LEVERAGE_LABEL = "Risk Lev.";

export const ORDER_LEVERAGE_TITLE =
  "Order leverage is the slider value used to size this trade.";

export const RISK_LEVERAGE_TITLE =
  "Risk leverage is this market account's effective exposure: position notional divided by collateral in this slab account. Extra collateral lowers liquidation risk.";

export function formatLeverageValue(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return Number.isInteger(value) ? value.toString() : value.toFixed(1);
}

export function formatLeverage(value: number): string {
  return `${formatLeverageValue(value)}x`;
}
