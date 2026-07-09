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
 */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '\u2014';
  if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(2);
}
