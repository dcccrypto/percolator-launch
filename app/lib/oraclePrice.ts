import { PublicKey } from "@solana/web3.js";

/**
 * Maximum valid oracle price in E6 format.
 * Matches the Rust on-chain constant MAX_ORACLE_PRICE = 1_000_000_000_000.
 * AUDIT FIX: was 1_000_000_000_000_000 (1000x too large vs on-chain).
 */
export const MAX_PRICE_E6 = 1_000_000_000_000n; // $1,000,000 USD (1e12 in E6)

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
 *
 * - 'keeper': on-chain oracle_mode byte = 3 (AUTH_MARK, v17 only)
 *   → automated keeper service pushes mark price via PushAuthMark instruction
 *   → use lastEffectivePriceE6 (= markEwmaE6, keeper-updated every crank cycle)
 *   → distinguished from 'admin' (manual push) by the oracle_mode byte, not key structure
 */
export type OracleMode = "pyth-pinned" | "hyperp" | "admin" | "keeper";

const ZERO_KEY = new PublicKey(new Uint8Array(32));

/**
 * Detect oracle mode from market config keys plus the optional on-chain oracle_mode byte.
 *
 * The `oracleModeByte` (from WrapperConfigV17.oracleMode) takes precedence over key-based
 * detection when present. This is necessary because v17 markets with AUTH_MARK (byte=3)
 * have indexFeedId forced to ZERO by SlabProvider (to direct price reads to markEwmaE6),
 * which would otherwise cause key-based detection to return "hyperp" instead of "keeper".
 *
 * Pass `oracleModeByte: d.configV17?.oracleMode` at call sites that have a DiscoveredMarket,
 * or `oracleModeByte: wrapperConfigV17?.oracleMode` at call sites using useSlabState().
 * Omitting it falls back to key-based detection (correct for v12 markets).
 */
export function detectOracleMode(cfg: {
  oracleAuthority: PublicKey;
  indexFeedId: PublicKey;
  /** On-chain oracle_mode byte from WrapperConfigV17 (v17 markets only).
   *  3 = AUTH_MARK → returns "keeper". Omit for v12 markets (key-based detection). */
  oracleModeByte?: number;
}): OracleMode {
  // v17 AUTH_MARK (byte=3): automated keeper service, NOT manual admin entry
  if (cfg.oracleModeByte === 3) return "keeper";
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
  /** See detectOracleMode. Pass wrapperConfigV17?.oracleMode for v17 markets. */
  oracleModeByte?: number;
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

    case "keeper":
      // Keeper oracle (v17 AUTH_MARK, byte=3): keeper pushes mark via PushAuthMark.
      // lastEffectivePriceE6 = wrapperConfigV17.markEwmaE6 (keeper-updated every crank).
      // authorityPriceE6 = assetProfile.oracleTargetPriceE6 (may not be set for all markets).
      // Use lastEffectivePriceE6 as the canonical live price (same as hyperp path).
      raw = cfg.lastEffectivePriceE6;
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

export interface MarketSpreadInfo {
  markPriceE6: bigint | null;
  indexPriceE6: bigint | null;
  spreadBps: number | null;
  oracleMode: OracleMode | null;
}

/**
 * Compute mark/index price and their spread (bps) for a market, mode-aware.
 *
 * Single source of truth for the mark-vs-index spread math shared by
 * MarketStatsCard (analytics) and MarketInfoBar (always-visible top bar) —
 * keep any bug fixes here rather than duplicating at call sites.
 */
export function computeMarketSpread(
  mktConfig: {
    oracleAuthority: PublicKey;
    indexFeedId: PublicKey;
    authorityPriceE6: bigint;
    lastEffectivePriceE6: bigint;
  } | null,
  oracleModeByte?: number,
): MarketSpreadInfo {
  if (!mktConfig) return { markPriceE6: null, indexPriceE6: null, spreadBps: null, oracleMode: null };

  const mode = detectOracleMode({ ...mktConfig, oracleModeByte });
  let mark: bigint | null = null;
  let index: bigint | null = null;

  if (mode === "hyperp" || mode === "admin" || mode === "keeper") {
    // authorityPriceE6 = latest pushed/mark price; lastEffectivePriceE6 = EMA/effective/index price.
    // Bug #1131: for HYPERP/admin markets, authorityPriceE6 can be corrupted (e.g. raw token
    // vault amounts stored as price). Guard: reject if price > MAX_PRICE_E6.
    const rawMark = sanitizePriceE6(mktConfig.authorityPriceE6);
    mark = rawMark > 0n && rawMark <= MAX_PRICE_E6 ? rawMark : null;
    index = sanitizePriceE6(mktConfig.lastEffectivePriceE6);
    if (index === 0n) index = null;
    // Bug #843: for admin mode, lastEffectivePriceE6 may be uninitialized (e.g. 1000 = $0.001)
    // when KeeperCrank hasn't run yet. If index is >100x smaller than mark, suppress it
    // to avoid nonsensical spread display (e.g. +200,000,000%).
    if (mode === "admin" && mark !== null && index !== null && index > 0n) {
      const ratio = Number(mark) / Number(index);
      if (ratio > 100) index = null;
    }
  } else {
    // pyth-pinned: mark ≈ index (Pyth IS the oracle — no separate mark/index distinction)
    const p = sanitizePriceE6(mktConfig.lastEffectivePriceE6);
    mark = p > 0n ? p : null;
    index = mark;
  }

  let bps: number | null = null;
  if (mark !== null && index !== null && index > 0n) {
    bps = (Number(mark - index) / Number(index)) * 10000;
  }

  return { markPriceE6: mark, indexPriceE6: index, spreadBps: bps, oracleMode: mode };
}
