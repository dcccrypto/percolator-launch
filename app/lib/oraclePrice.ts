import { PublicKey } from "@solana/web3.js";

/**
 * Oracle mode for a Percolator market.
 *
 * - 'pyth-pinned': oracleAuthority == [0;32] && indexFeedId != [0;32]
 *   → staleness enforced on-chain by Pyth CPI; use lastEffectivePriceE6
 *
 * - 'hyperp': indexFeedId == [0;32]
 *   → DEX oracle mode; authorityPriceE6 is mark price, lastEffectivePriceE6 is index price
 *   → authorityTimestamp stores funding rate, NOT a real timestamp
 *   → use lastEffectivePriceE6 for display
 *
 * - 'admin': oracleAuthority != [0;32] && indexFeedId != [0;32]
 *   → off-chain authority pushes prices; authorityPriceE6 is the latest pushed price
 *   → use authorityPriceE6 (with optional staleness check via authorityTimestamp)
 */
export type OracleMode = "pyth-pinned" | "hyperp" | "admin";

const ZERO_KEY = new PublicKey(new Uint8Array(32));

/**
 * Detect oracle mode from market config keys.
 * Centralizes mode detection for consistent behavior across the app.
 */
export function detectOracleMode(cfg: {
  oracleAuthority: PublicKey;
  indexFeedId: PublicKey;
}): OracleMode {
  if (cfg.indexFeedId.equals(ZERO_KEY)) return "hyperp";
  if (cfg.oracleAuthority.equals(ZERO_KEY)) return "pyth-pinned";
  return "admin";
}

/**
 * Resolve the correct USD price (in E6 format) for a market based on its oracle mode.
 *
 * For display purposes (markets page, trade page), this returns the best available
 * price from on-chain data. The caller should divide by 1_000_000 to get USD.
 *
 * @returns priceE6 (bigint) or 0n if no valid price available
 */
export function resolveMarketPriceE6(cfg: {
  oracleAuthority: PublicKey;
  indexFeedId: PublicKey;
  lastEffectivePriceE6: bigint;
  authorityPriceE6: bigint;
  authorityTimestamp?: bigint;
}): bigint {
  const mode = detectOracleMode(cfg);

  switch (mode) {
    case "pyth-pinned":
      // Pyth-pinned: lastEffectivePriceE6 is the on-chain resolved price
      // authorityPriceE6 may be stale/garbage — never use it
      return cfg.lastEffectivePriceE6;

    case "hyperp":
      // Hyperp (DEX oracle): lastEffectivePriceE6 is the index price from on-chain crank
      // authorityPriceE6 is the mark price — use index price for display
      // Note: authorityTimestamp stores funding rate, NOT a real timestamp
      return cfg.lastEffectivePriceE6;

    case "admin":
      // Admin oracle: authorityPriceE6 is the latest pushed price
      // Fall back to lastEffectivePriceE6 if authority price is 0
      if (cfg.authorityPriceE6 > 0n) return cfg.authorityPriceE6;
      return cfg.lastEffectivePriceE6;

    default:
      return 0n;
  }
}

/**
 * Convert an E6 price to USD number.
 * Returns null if priceE6 is 0 or negative.
 */
export function priceE6ToUsd(priceE6: bigint): number | null {
  if (priceE6 <= 0n) return null;
  return Number(priceE6) / 1_000_000;
}
