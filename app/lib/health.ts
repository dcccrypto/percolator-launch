import type { EngineState } from "@percolator/sdk";

export type HealthLevel = "healthy" | "caution" | "warning" | "empty";

export interface MarketHealth {
  level: HealthLevel;
  label: string;
  insuranceRatio: number;
  capitalRatio: number;
}

/**
 * Sentinel values used on-chain for uninitialized fields.
 * u64::MAX = 18446744073709551615
 * Values near or above this threshold should be treated as "no data" / zero.
 */
const U64_MAX = 18446744073709551615n;
const U64_SENTINEL_THRESHOLD = 18000000000000000000n; // ~97.5% of u64::MAX

/** Returns true if a bigint looks like a u64::MAX sentinel (uninitialized on-chain value). */
export function isSentinelValue(v: bigint): boolean {
  return v >= U64_SENTINEL_THRESHOLD;
}

/**
 * Sanitize an on-chain bigint value: returns 0n if it's a sentinel (u64::MAX) or negative.
 */
export function sanitizeOnChainValue(v: bigint): bigint {
  if (v <= 0n) return 0n;
  if (isSentinelValue(v)) return 0n;
  return v;
}

/**
 * Sanitize a basis-point parameter from on-chain risk params.
 * Valid BPS values are in [0, maxBps]. Anything above is treated as garbage
 * (uninitialized on-chain data) and returns null so the UI can show "—".
 */
export function sanitizeBps(
  bps: bigint | number | null | undefined,
  maxBps: number = 10_000, // 100%
): number | null {
  if (bps == null) return null;
  const n = typeof bps === "bigint" ? Number(bps) : bps;
  if (n < 0 || n > maxBps || !Number.isFinite(n)) return null;
  return n;
}

/**
 * Maximum possible account slots across all slab tiers (large slab = 4096).
 * Any numUsedAccounts value above this is garbage data from an uninitialized slab.
 */
const MAX_SLAB_ACCOUNTS = 4096;

/**
 * Sanitize the numUsedAccounts value from on-chain engine state.
 * Returns 0 if the value exceeds the maximum slab capacity (garbage/uninitialized data)
 * or if it's negative.
 *
 * Optionally accepts maxAccounts from the slab's risk params for a tighter bound.
 */
export function sanitizeAccountCount(count: number, maxAccounts?: number): number {
  if (count < 0) return 0;
  const cap = maxAccounts != null && maxAccounts > 0 ? maxAccounts : MAX_SLAB_ACCOUNTS;
  if (count > cap) return 0;
  return count;
}

/**
 * Sanitize a raw on-chain `funding_rate_bps_per_slot_last` (i64) value.
 *
 * The Rust program enforces: if abs(rate) > 10_000, it zeroes the field and skips
 * accrual. Any value outside [-10_000, 10_000] in the account data is therefore
 * stale/garbage (wrong offset, uninitialized slab, or layout mismatch) and must
 * be treated as "no data" to avoid rendering astronomically large percentages.
 *
 * Returns null when the value is out of range so callers can show "—".
 */
export const FUNDING_RATE_BPS_MAX = 10_000n; // matches on-chain guard
export function sanitizeFundingRateBps(v: bigint | null | undefined): bigint | null {
  if (v == null) return null;
  if (v < -FUNDING_RATE_BPS_MAX || v > FUNDING_RATE_BPS_MAX) return null;
  return v;
}

/**
 * Compute market health from on-chain EngineState.
 * Handles sentinel values (u64::MAX for uninitialized insurance) and
 * treats them as zero rather than showing absurd numbers.
 */
export function computeMarketHealth(engine: EngineState): MarketHealth {
  const oi = sanitizeOnChainValue(engine.totalOpenInterest);
  const capital = sanitizeOnChainValue(engine.cTot);
  const insurance = sanitizeOnChainValue(engine.insuranceFund.balance);

  if (capital === 0n && insurance === 0n && oi === 0n) {
    return { level: "empty", label: "Empty", insuranceRatio: 0, capitalRatio: 0 };
  }

  // Markets with capital or insurance but no OI are healthy (no exposure)
  if (oi === 0n) {
    return { level: "healthy", label: "Healthy", insuranceRatio: Infinity, capitalRatio: Infinity };
  }

  // If we have OI but no insurance AND no capital → warning
  if (capital === 0n && insurance === 0n) {
    return { level: "warning", label: "Low Liquidity", insuranceRatio: 0, capitalRatio: 0 };
  }

  const insuranceRatio = insurance > 0n
    ? Number(insurance * 1_000_000n / oi) / 1_000_000
    : 0;
  const capitalRatio = capital > 0n
    ? Number(capital * 1_000_000n / oi) / 1_000_000
    : 0;

  if (insuranceRatio < 0.02 || capitalRatio < 0.5) {
    return { level: "warning", label: "Low Liquidity", insuranceRatio, capitalRatio };
  }

  if (insuranceRatio < 0.05 || capitalRatio < 0.8) {
    return { level: "caution", label: "Caution", insuranceRatio, capitalRatio };
  }

  return { level: "healthy", label: "Healthy", insuranceRatio, capitalRatio };
}

/**
 * Compute market health from Supabase stats (for markets without on-chain data).
 * Uses the same thresholds as the on-chain version but works with numeric Supabase fields.
 */
export function computeMarketHealthFromStats(stats: {
  total_open_interest?: number | null;
  open_interest_long?: number | null;
  open_interest_short?: number | null;
  insurance_balance?: number | null;
  insurance_fund?: number | null;
  c_tot?: number | null;
  vault_balance?: number | null;
}): MarketHealth {
  const oiRaw = stats.total_open_interest
    ?? ((stats.open_interest_long ?? 0) + (stats.open_interest_short ?? 0));
  const insuranceRaw = stats.insurance_balance ?? stats.insurance_fund ?? 0;
  const capitalRaw = stats.c_tot ?? stats.vault_balance ?? 0;

  // Filter out sentinel-like numeric values (JS number precision of u64::MAX ≈ 1.844e19).
  // GH#1208: Use 5e17 cap — near-sentinel corrupted values like 7.997e17 also slip through.
  const isSentinelNum = (v: number) => v > 5e17;
  const oi = isSentinelNum(oiRaw) ? 0 : Math.max(0, oiRaw);
  const insurance = isSentinelNum(insuranceRaw) ? 0 : Math.max(0, insuranceRaw);
  const capital = isSentinelNum(capitalRaw) ? 0 : Math.max(0, capitalRaw);

  if (capital === 0 && insurance === 0 && oi === 0) {
    return { level: "empty", label: "Empty", insuranceRatio: 0, capitalRatio: 0 };
  }

  if (oi === 0) {
    return { level: "healthy", label: "Healthy", insuranceRatio: Infinity, capitalRatio: Infinity };
  }

  if (capital === 0 && insurance === 0) {
    return { level: "warning", label: "Low Liquidity", insuranceRatio: 0, capitalRatio: 0 };
  }

  const insuranceRatio = insurance > 0 ? insurance / oi : 0;
  const capitalRatio = capital > 0 ? capital / oi : 0;

  if (insuranceRatio < 0.02 || capitalRatio < 0.5) {
    return { level: "warning", label: "Low Liquidity", insuranceRatio, capitalRatio };
  }

  if (insuranceRatio < 0.05 || capitalRatio < 0.8) {
    return { level: "caution", label: "Caution", insuranceRatio, capitalRatio };
  }

  return { level: "healthy", label: "Healthy", insuranceRatio, capitalRatio };
}
