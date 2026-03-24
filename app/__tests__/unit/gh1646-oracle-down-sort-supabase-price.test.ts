/**
 * Tests for GH#1646
 *
 * Bug: 3 SOL markets with on-chain oracle-down (priceE6=0) but Supabase last_price set
 * sorted at rank 0 (healthy) because the vault guard in computeIsOracleDown returned
 * false before checking on-chain oracle state.
 *
 * Fix: On-chain oracle check now takes priority over vault guard.
 */

const MIN_VAULT_FOR_OI = 1_000_000;

type SortLevel = "healthy" | "caution" | "warning" | "empty-oracle-up" | "oracle-down" | "empty";

const SORT_ORDER: Record<string, number> = {
  healthy: 0, caution: 1, warning: 2, "empty-oracle-up": 3, "oracle-down": 4, empty: 5,
};

interface MockMarket {
  hasOnChain: boolean;
  onChainPriceE6: bigint;
  vaultBalance: number | null;
  markPrice: number | null;
  indexPrice: number | null;
  lastPrice: number | null;
  baseHealthLevel: string;
}

function numericOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Mirrors the FIXED computeIsOracleDown from markets/page.tsx
function computeIsOracleDown(m: MockMarket): boolean {
  // On-chain check takes priority (GH#1646 fix)
  if (m.hasOnChain) {
    return m.onChainPriceE6 === 0n;
  }
  // Vault guard for Supabase-only markets
  const vaultBal = numericOrNull(m.vaultBalance);
  if (vaultBal !== null && vaultBal < MIN_VAULT_FOR_OI) {
    return false;
  }
  const mp = numericOrNull(m.markPrice);
  const ip = numericOrNull(m.indexPrice);
  const lp = numericOrNull(m.lastPrice);
  return (mp == null || mp <= 0) && (ip == null || ip <= 0) && (lp == null || lp <= 0);
}

function getEffectiveSortLevel(isOracleDown: boolean, baseLevel: string): SortLevel {
  if (isOracleDown) return "oracle-down";
  if (baseLevel === "empty") return "empty-oracle-up";
  return baseLevel as SortLevel;
}

describe("GH#1646 — on-chain oracle-down markets with Supabase prices sort correctly", () => {
  // The 3 SOL markets from the bug report
  const solMarkets: MockMarket[] = [
    { hasOnChain: true, onChainPriceE6: 0n, vaultBalance: 5_000_000, markPrice: null, indexPrice: null, lastPrice: 500, baseHealthLevel: "healthy" },
    { hasOnChain: true, onChainPriceE6: 0n, vaultBalance: 10_000_000, markPrice: null, indexPrice: null, lastPrice: 1000, baseHealthLevel: "healthy" },
    { hasOnChain: true, onChainPriceE6: 0n, vaultBalance: 2_000_000, markPrice: null, indexPrice: null, lastPrice: 2550, baseHealthLevel: "healthy" },
  ];

  it("computeIsOracleDown returns true for on-chain markets with priceE6=0 regardless of vault balance", () => {
    for (const m of solMarkets) {
      expect(computeIsOracleDown(m)).toBe(true);
    }
  });

  it("effective sort level is oracle-down (not healthy) for these markets", () => {
    for (const m of solMarkets) {
      const level = getEffectiveSortLevel(computeIsOracleDown(m), m.baseHealthLevel);
      expect(level).toBe("oracle-down");
      expect(SORT_ORDER[level]).toBe(4);
    }
  });

  it("on-chain oracle-down markets sort AFTER healthy markets", () => {
    const healthyMarket: MockMarket = {
      hasOnChain: true, onChainPriceE6: 150_000_000n, vaultBalance: 50_000_000,
      markPrice: 150, indexPrice: 150, lastPrice: 150, baseHealthLevel: "healthy",
    };
    const healthyLevel = getEffectiveSortLevel(computeIsOracleDown(healthyMarket), healthyMarket.baseHealthLevel);
    const oracleDownLevel = getEffectiveSortLevel(computeIsOracleDown(solMarkets[0]), solMarkets[0].baseHealthLevel);
    expect(SORT_ORDER[healthyLevel]).toBeLessThan(SORT_ORDER[oracleDownLevel]);
  });

  it("vault guard still works for Supabase-only sub-threshold markets", () => {
    const subThreshold: MockMarket = {
      hasOnChain: false, onChainPriceE6: 0n, vaultBalance: 500_000,
      markPrice: null, indexPrice: null, lastPrice: null, baseHealthLevel: "empty",
    };
    expect(computeIsOracleDown(subThreshold)).toBe(false);
    expect(getEffectiveSortLevel(false, "empty")).toBe("empty-oracle-up");
  });

  it("Supabase-only market with last_price set but mark/index null is NOT oracle-down", () => {
    const supaOnly: MockMarket = {
      hasOnChain: false, onChainPriceE6: 0n, vaultBalance: 5_000_000,
      markPrice: null, indexPrice: null, lastPrice: 100, baseHealthLevel: "healthy",
    };
    // last_price is set → not oracle-down (at least one price signal exists)
    expect(computeIsOracleDown(supaOnly)).toBe(false);
  });

  it("Supabase-only market with all prices null/zero IS oracle-down", () => {
    const supaOnly: MockMarket = {
      hasOnChain: false, onChainPriceE6: 0n, vaultBalance: 5_000_000,
      markPrice: null, indexPrice: null, lastPrice: null, baseHealthLevel: "healthy",
    };
    expect(computeIsOracleDown(supaOnly)).toBe(true);
  });

  it("sort: 3 SOL oracle-down markets rank below all healthy markets", () => {
    const healthy = Array.from({ length: 5 }, () => ({ isOracleDown: false, base: "healthy" }));
    const oracleDown = solMarkets.map(m => ({ isOracleDown: computeIsOracleDown(m), base: m.baseHealthLevel }));
    const all = [...oracleDown, ...healthy].map(x => ({
      ...x,
      level: getEffectiveSortLevel(x.isOracleDown, x.base),
    }));
    const sorted = [...all].sort((a, b) => (SORT_ORDER[a.level] ?? 99) - (SORT_ORDER[b.level] ?? 99));
    // First 5 should be healthy, last 3 should be oracle-down
    sorted.slice(0, 5).forEach(m => expect(m.level).toBe("healthy"));
    sorted.slice(5).forEach(m => expect(m.level).toBe("oracle-down"));
  });
});
