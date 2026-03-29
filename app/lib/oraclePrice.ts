import { PublicKey } from "@solana/web3.js";

/**
 * Maximum valid oracle price in E6 format.
 * Matches the Rust on-chain constant: price <= 1_000_000_000_000_000 (= $1B USD).
 * Values above this are corrupt/uninitialized data and should be treated as zero.
 */
export const MAX_PRICE_E6 = 1_000_000_000_000_000n; // $1,000,000,000 USD

/**
 * Sanitize a price E6 value.
 * Returns 0n for negative, zero, sentinel (u64::MAX), or absurdly large prices.
 */
export function sanitizePriceE6(priceE6: bigint): bigint {
  if (priceE6 <= 0n) return 0n;
  if (priceE6 > MAX_PRICE_E6) return 0n;
  return priceE6;
}

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
 * Apply the market's `invert` flag to a price in E6 format.
 *
 * When `invert === 1`, the price represents an inverted pair (e.g., USD/SOL instead of SOL/USD).
 * We invert by computing: 1e12 / priceE6, which keeps the result in E6 format.
 * (1e6 USD * 1e6 precision / priceE6 = inverted priceE6)
 *
 * Returns 0n if priceE6 is 0 (division by zero guard).
 */
export function applyInvert(priceE6: bigint, invert: number | undefined): bigint {
  if (!invert || priceE6 === 0n) return priceE6;
  // 1e12 / priceE6 to keep E6 format: (1_000_000 USD * 1_000_000 precision) / priceE6
  return 1_000_000_000_000n / priceE6;
}

/**
 * Resolve the correct USD price (in E6 format) for a market based on its oracle mode.
 *
 * For display purposes (markets page, trade page), this returns the best available
 * price from on-chain data. The caller should divide by 1_000_000 to get USD.
 *
 * Applies `invert` flag when set to 1: price = 1e12 / raw_price (inverted pair support).
 *
 * @returns priceE6 (bigint) or 0n if no valid price available
 */
export function resolveMarketPriceE6(cfg: {
  oracleAuthority: PublicKey;
  indexFeedId: PublicKey;
  lastEffectivePriceE6: bigint;
  authorityPriceE6: bigint;
  authorityTimestamp?: bigint;
  invert?: number;
}): bigint {
  const mode = detectOracleMode(cfg);

  let raw: bigint;
  switch (mode) {
    case "pyth-pinned":
      // Pyth-pinned: lastEffectivePriceE6 is the on-chain resolved price
      // authorityPriceE6 may be stale/garbage — never use it
      raw = cfg.lastEffectivePriceE6;
      break;

    case "hyperp":
      // Hyperp (DEX oracle): lastEffectivePriceE6 is the index price from on-chain crank
      // authorityPriceE6 is the mark price — use index price for display
      // Note: authorityTimestamp stores funding rate, NOT a real timestamp
      raw = cfg.lastEffectivePriceE6;
      break;

    case "admin":
      // Admin oracle: authorityPriceE6 is the latest pushed price
      // Fall back to lastEffectivePriceE6 if authority price is 0
      raw = cfg.authorityPriceE6 > 0n ? cfg.authorityPriceE6 : cfg.lastEffectivePriceE6;
      break;

    default:
      return 0n;
  }

  // Apply invert flag: if config.invert === 1, the pair is displayed as the reciprocal
  const inverted = applyInvert(raw, cfg.invert);

  // Sanitize: reject corrupt/uninitialized values that exceed Rust MAX_ORACLE_PRICE
  return sanitizePriceE6(inverted);
}

/**
 * Convert an E6 price to USD number.
 * Returns null if priceE6 is 0 or negative.
 */
export function priceE6ToUsd(priceE6: bigint): number | null {
  if (priceE6 <= 0n) return null;
  return Number(priceE6) / 1_000_000;
}
