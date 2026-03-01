export function formatTokenAmount(
  raw: bigint | null | undefined,
  decimals: number = 6,
  maxDisplayDecimals?: number,
): string {
  if (raw == null) return "0";
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  let fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");

  // Optionally truncate to maxDisplayDecimals (rounds down)
  if (maxDisplayDecimals != null && fracStr.length > maxDisplayDecimals) {
    fracStr = fracStr.slice(0, maxDisplayDecimals).replace(/0+$/, "");
  }

  const formatted = fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
  return negative ? `-${formatted}` : formatted;
}

export function formatPriceE6(priceE6: bigint): string {
  return formatTokenAmount(priceE6, 6);
}

export function formatBps(bps: bigint | number): string {
  const n = typeof bps === "bigint" ? Number(bps) : bps;
  return `${(n / 100).toFixed(2)}%`;
}

/**
 * Sentinel returned by computeLiqPrice when a short position is over-collateralised
 * (maintenanceMarginBps >= 100%). Signals "this position cannot be liquidated."
 * Using max u64 as the sentinel matches the on-chain convention.
 */
export const LIQ_PRICE_UNLIQUIDATABLE = 18446744073709551615n; // max u64

export function formatUsd(priceE6: bigint | null | undefined): string {
  if (priceE6 == null) return "$0.00";
  // Defense-in-depth: reject absurd values (matches Rust MAX_ORACLE_PRICE = 1e15)
  if (priceE6 > 1_000_000_000_000_000n) return "$—";
  if (priceE6 < 0n) return "$—";
  // PERC-297: 0 price means oracle data unavailable — show dash instead of "$0.00"
  if (priceE6 === 0n) return "$—";
  const val = Number(priceE6) / 1_000_000;
  return `$${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

/**
 * Format a liquidation price in e6 format.
 * Returns "∞" when the position is unliquidatable (liqPrice === max u64),
 * "-" when zero/null, otherwise delegates to formatUsd.
 */
export function formatLiqPrice(liqPriceE6: bigint | null | undefined): string {
  if (liqPriceE6 == null || liqPriceE6 === 0n) return "-";
  if (liqPriceE6 >= LIQ_PRICE_UNLIQUIDATABLE) return "∞";
  return formatUsd(liqPriceE6);
}

export function shortenAddress(address: string, chars: number = 4): string {
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

export function formatSlotAge(currentSlot: bigint | null | undefined, targetSlot: bigint | null | undefined): string {
  if (currentSlot == null || targetSlot == null) return "—";
  const diff = currentSlot - targetSlot;
  if (diff <= 0n) return "0s";
  const seconds = Number(diff) / 2.5;
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

export function formatI128Amount(raw: bigint, decimals: number = 6): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const formatted = whole.toString();
  return negative ? `-${formatted}` : formatted;
}

/** Format PnL with full precision and +/- prefix */
export function formatPnl(raw: bigint | null | undefined, decimals: number = 6): string {
  if (raw == null) return "0";
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  const num = fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
  if (negative) return `-${num}`;
  if (raw > 0n) return `+${num}`;
  return num;
}

/** Format margin percentage from bps */
export function formatMarginPct(marginBps: number): string {
  return `${(marginBps / 100).toFixed(1)}%`;
}

/** Format a number as a signed percentage string e.g. "+12.34%" or "-5.67%" */
export function formatPercent(value: number, decimals: number = 2): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(decimals)}%`;
}

/** Format funding rate from per-slot bps to annualized % string. */
export function formatFundingRate(bpsPerSlot: bigint): string {
  const slotsPerYear = 2.5 * 60 * 60 * 24 * 365;
  const annualized = (Number(bpsPerSlot) * slotsPerYear) / 100; // bps/slot × slots/yr / 100 = %/yr
  const sign = annualized > 0 ? "+" : "";
  return `${sign}${annualized.toFixed(2)}%`;
}
