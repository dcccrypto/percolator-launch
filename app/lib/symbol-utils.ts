/**
 * Shared utilities for token symbol resolution.
 * Prevents truncated on-chain addresses from leaking into UI labels.
 */

/**
 * Returns true if the given symbol looks like a placeholder / truncated address
 * rather than a real human-readable token name.
 */
export function isPlaceholderSymbol(sym: string | null | undefined, mint: string): boolean {
  if (!sym) return true;
  // Reject if it's the first N chars of the mint address (StatsCollector default)
  if (mint.startsWith(sym)) return true;
  // Reject pure hex-like strings (8 chars)
  if (/^[0-9a-fA-F]{8}$/.test(sym)) return true;
  // Reject if it looks like a truncated address with ellipsis
  if (/^[A-Za-z0-9]{3,6}[\u2026.]{1,3}[A-Za-z0-9]{3,6}$/.test(sym)) return true;
  return false;
}

/**
 * Sanitize a symbol for display in labels. If the on-chain symbol looks like a
 * placeholder / truncated address, fall back to a generic "Token" label.
 */
export function sanitizeSymbol(sym: string | null | undefined, mintAddress?: string): string {
  if (!sym) return "Token";
  if (mintAddress && isPlaceholderSymbol(sym, mintAddress)) return "Token";
  return sym;
}
