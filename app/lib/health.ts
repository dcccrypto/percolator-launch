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

  // Filter out sentinel-like numeric values (JS number precision of u64::MAX ≈ 1.844e19)
  const isSentinelNum = (v: number) => v > 1e18;
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
