/**
 * Format a raw token amount (in smallest units) into a human-readable decimal string.
 * 
 * @param raw - The token amount in smallest units (e.g., lamports for SOL). Can be null/undefined.
 * @param decimals - Number of decimal places the token uses (default: 6 for most SPL tokens)
 * @param maxDisplayDecimals - Optional limit on displayed decimal places (truncates the fractional part)
 * @returns Human-readable formatted string, e.g. "100.5" or "0" if input is null/undefined
 * 
 * @example
 * // SOL with 9 decimals
 * formatTokenAmount(1500000000n, 9) // → "1.5"
 * formatTokenAmount(100000n, 6) // → "0.1"
 * formatTokenAmount(null, 6) // → "0"
 * formatTokenAmount(1500000n, 6, 2) // → "1.5" (truncated to 2 decimals)
 */
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

/**
 * Format an oracle price in E6 format (price * 10^6) into a readable decimal string.
 * Convenience wrapper around formatTokenAmount for 6-decimal prices.
 * 
 * @param priceE6 - Price value with 6 decimal places (E6 format)
 * @returns Formatted price string (e.g. "0.05" for 50000 E6)
 * 
 * @example
 * formatPriceE6(50000n) // → "0.05"
 * formatPriceE6(1000000n) // → "1"
 */
export function formatPriceE6(priceE6: bigint): string {
  return formatTokenAmount(priceE6, 6);
}

/**
 * Format a basis points value (1/100th of a percent) into a percentage string.
 * 
 * @param bps - Basis points value. Can be bigint or number.
 * @returns Percentage string with 2 decimal places (e.g. "0.50%" for 50 basis points)
 * 
 * @example
 * formatBps(50n) // → "0.50%"
 * formatBps(100) // → "1.00%"
 * formatBps(10000n) // → "100.00%"
 */
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

/**
 * Format a price in E6 format (price * 10^6) into USD notation with validation.
 * 
 * Handles edge cases:
 * - Returns "$—" (dash) for absurd values (>1e15), negative values, or zero (oracle unavailable)
 * - Returns "$0.00" only when price is null/undefined
 * - Uses max 6 decimal places for small amounts, min 2 for standard amounts
 * 
 * @param priceE6 - Price with 6 decimal places, or null/undefined
 * @returns Formatted USD string (e.g. "$1.50") or "$—" if invalid/unavailable
 * 
 * @example
 * formatUsd(1500000n) // → "$1.50"
 * formatUsd(0n) // → "$—" (oracle unavailable)
 * formatUsd(null) // → "$0.00" (unknown price)
 * formatUsd(-1000000n) // → "$—" (invalid negative)
 */
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
  if (liqPriceE6 == null || liqPriceE6 <= 0n) return "N/A";
  if (liqPriceE6 >= LIQ_PRICE_UNLIQUIDATABLE) return "∞";
  return formatUsd(liqPriceE6);
}

/**
 * Abbreviate a long address (e.g., Solana public key) to first and last N characters.
 * Useful for display in UI tables and labels where horizontal space is limited.
 * 
 * @param address - Full address string
 * @param chars - Number of leading/trailing characters to keep (default: 4)
 * @returns Abbreviated address in format "1234...5678"
 * 
 * @example
 * shortenAddress("So11111111111111111111111111111111111111112") // → "So11...1112"
 * shortenAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 3) // → "EPj...Dt1v"
 */
export function shortenAddress(address: string, chars: number = 4): string {
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/**
 * Format a token amount compactly for dashboard/stats display.
 * ≥ 1 000 000 → "2.0M", ≥ 1 000 → "1.5K", otherwise comma-separated.
 * Falls back to formatTokenAmount for sub-1 values.
 */
export function formatCompactTokenAmount(
  raw: bigint | null | undefined,
  decimals: number = 6,
): string {
  // null/undefined → unknown; known zero → "0.00" (never bare "0" per design rule #865)
  if (raw == null) return "—";
  if (raw <= 0n) return "0.00";
  const divisor = 10n ** BigInt(decimals);
  const num = Number(raw) / Number(divisor);
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  if (num >= 1) return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Sub-1 amounts: use full precision
  return formatTokenAmount(raw, decimals);
}

/**
 * Format a stat panel value with strict zero/null rules (#865):
 * - null/undefined           → "—"   (unknown/unavailable)
 * - known zero (currency)    → "$0.00"
 * - known zero (percent)     → "0.00%"
 * - known zero (number)      → "0.00"
 * - positive value           → compact formatted with unit
 */
export function formatStatValue(
  value: bigint | number | null | undefined,
  type: 'currency' | 'percent' | 'number' = 'number',
  decimals: number = 6,
): string {
  if (value == null) return "—";
  const n = typeof value === 'bigint'
    ? Number(value) / Math.pow(10, decimals)
    : value;
  if (isNaN(n)) return "—";
  if (type === 'currency') {
    if (n <= 0) return "$0.00";
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
    if (n >= 1) return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return `$${n.toFixed(4)}`;
  }
  if (type === 'percent') {
    return `${n <= 0 ? "0" : n.toFixed(2)}%`;
  }
  // 'number'
  if (n <= 0) return "0.00";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  if (n >= 1) return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n.toFixed(4);
}

/**
 * Calculate time elapsed between two Solana slots and format as human-readable duration.
 * Assumes 2.5 second average block time on Solana.
 * 
 * @param currentSlot - Current blockchain slot number (or null/undefined)
 * @param targetSlot - Reference slot number (or null/undefined)
 * @returns Human-readable duration (e.g. "30s", "5.2m", "2.1h") or "—" if inputs invalid
 * 
 * @example
 * formatSlotAge(1000n, 995n) // → "1s" (5 slots * 2.5s/slot)
 * formatSlotAge(1000n, 976n) // → "10.0m" (24 slots * 2.5s/slot)
 * formatSlotAge(null, 500n) // → "—"
 */
export function formatSlotAge(currentSlot: bigint | null | undefined, targetSlot: bigint | null | undefined): string {
  if (currentSlot == null || targetSlot == null) return "—";
  const diff = currentSlot - targetSlot;
  if (diff <= 0n) return "0s";
  const seconds = Number(diff) / 2.5;
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

/**
 * Format a signed 128-bit integer into a whole number string.
 * Useful for displaying net PnL or balance changes that can be negative.
 * 
 * @param raw - Signed i128 value in smallest units
 * @param decimals - Number of decimal places (default: 6)
 * @returns Formatted integer string with optional minus sign (e.g. "-100" or "50")
 * 
 * @example
 * formatI128Amount(500000000n, 6) // → "500"
 * formatI128Amount(-250000000n, 6) // → "-250"
 */
export function formatI128Amount(raw: bigint, decimals: number = 6): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const formatted = whole.toString();
  return negative ? `-${formatted}` : formatted;
}

/**
 * Format a profit/loss amount with signed indicator and full fractional precision.
 * Returns +/- prefixed value suitable for portfolio/position displays.
 * 
 * @param raw - PnL value in smallest units (positive for gains, negative for losses), or null/undefined
 * @param decimals - Number of decimal places (default: 6)
 * @returns Formatted PnL string with +/- prefix (e.g. "+42.5" or "-10.25") or "0" if null/undefined
 * 
 * @example
 * formatPnL(4250000n, 6) // → "+42.5"
 * formatPnL(-100000000n, 6) // → "-100"
 * formatPnL(0n, 6) // → "0"
 * formatPnL(null, 6) // → "0"
 */
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
