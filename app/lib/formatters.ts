/**
 * Format a large number into compact notation using abbreviations.
 * Useful for dashboard displays and summary statistics.
 * 
 * Conversion scale:
 * - ≥ 1e12: Trillions (T)
 * - ≥ 1e9: Billions (B)
 * - ≥ 1e6: Millions (M)
 * - ≥ 1e3: Thousands (K)
 * - < 1e3: Fixed 2 decimals
 * 
 * @param n - Number to format
 * @returns Compactly formatted string with up to 2 decimal places
 * 
 * @example
 * formatCompact(1500000000) // → "1.50B"
 * formatCompact(2500000) // → "2.50M"
 * formatCompact(1200) // → "1.20K"
 * formatCompact(45.678) // → "45.68"
 * formatCompact(NaN) // → "—" (invalid input, e.g. from an upstream 0/0 division)
 */
/**
 * `formatCompact` with a leading `$`, one decimal place, for USD figures.
 *
 * #2313: this existed as two DIVERGENT private copies — `Watchlist.tsx` (no
 * guard at all) and `MarketInfoBar.tsx` (guarded `null` but not NaN) — so a
 * non-finite value rendered as the literal `$NaN`. `(NaN).toFixed(2)` is the
 * string `"NaN"`, and `NaN >= 1_000` is false, so it falls through every
 * magnitude branch to the final `toFixed`.
 *
 * Shared and guarded here so the two call sites cannot drift apart again.
 */
/**
 * Convert a `bigint` of base units to a float, refusing silently-wrong results.
 *
 * #2324: `Number(someBigint)` loses precision above `Number.MAX_SAFE_INTEGER`
 * (~9e15) and says nothing — it returns a plausible, wrong number. For 6-decimal
 * USDC that ceiling is ~9 billion tokens; for a 9-decimal mint it is ~9 million,
 * which is not a comfortable margin.
 *
 * Returns `null` rather than a wrong figure, so the caller renders a placeholder
 * the way it already does for missing data. Returning 0 would be worse than the
 * bug: a silently wrong LARGE number at least looks suspicious, whereas a
 * confident 0 reads as a real balance.
 *
 * Note this checks the RAW base-unit magnitude, before dividing by the decimal
 * scale — that is where the precision is actually lost. Dividing first would
 * hide it.
 */
export function bigintToFloat(raw: bigint, decimals: number): number | null {
  const abs = raw < 0n ? -raw : raw;
  if (abs > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(raw) / 10 ** decimals;
}

/**
 * `bigintToFloat` for a ratio of two bigints, where neither side alone need be
 * small — only their quotient. Scales inside bigint arithmetic first, so a large
 * numerator and denominator still produce an exact result.
 */
export function bigintRatio(numerator: bigint, denominator: bigint, precision = 1_000_000n): number | null {
  if (denominator === 0n) return null;
  const scaled = (numerator * precision) / denominator;
  const abs = scaled < 0n ? -scaled : scaled;
  if (abs > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(scaled) / Number(precision);
}

export function formatCompactUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

/**
 * Render a percentage, or `—` when the value is not finite.
 *
 * #2313: percentages here are division-derived, and a `0 / 0` from an empty
 * pool is NaN. Most sites already guard the divisor at source; this is for the
 * ones where the division happens inline at the render boundary.
 */
export function formatPercent(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

export function formatCompact(n: number): string {
  // Defense-in-depth: NaN/±Infinity can leak in from upstream division-by-zero
  // or malformed on-chain data. Render "—" instead of "NaN"/"Infinity".
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(2);
}
