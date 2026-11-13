// @vitest-environment node
/**
 * GH#1608: sort=health returns vault=0 markets first instead of highest-health markets.
 *
 * Root cause:
 *   - Markets with vault_balance=0 but c_tot > 0 and a live price pass the zombie filter
 *     (FF7K keeper market pattern: c_tot > 0 + hasActivity → not zombie).
 *   - computeMarketHealthFromStats suppresses OI to 0 via phantom guard (vault < MIN_VAULT_FOR_OI),
 *     then sees oi=0 + capital=c_tot > 0 → returns "healthy" (rank 0).
 *   - These markets appear FIRST in ascending health sort even though they have no LP vault.
 *
 * Fix:
 *   - In healthRank(), explicitly check vault_balance < MIN_VAULT_FOR_OI → return rank 3 (empty).
 *   - Prevents phantom-healthy classification for no-vault markets.
 */
import { describe, it, expect } from "vitest";
import { computeMarketHealthFromStats } from "../../lib/health";
import { MIN_VAULT_FOR_OI } from "../../lib/phantom-oi";

// ---- Inline reproduction of the fixed healthRank logic from route.ts ----

const HEALTH_ORDER: Record<string, number> = { healthy: 0, caution: 1, warning: 2, empty: 3 };

function healthRank(m: Record<string, unknown>): number {
  // GH#1608: vault < MIN_VAULT_FOR_OI → force empty (rank 3), no further computation.
  const vaultNum = typeof m.vault_balance === "number"
    ? m.vault_balance
    : (m.vault_balance != null ? Number(m.vault_balance) : null);
  if (vaultNum !== null && !Number.isNaN(vaultNum) && vaultNum < MIN_VAULT_FOR_OI) {
    return HEALTH_ORDER["empty"]; // 3
  }
  const h = computeMarketHealthFromStats({
    total_open_interest: m.total_open_interest as number | null,
    open_interest_long: m.open_interest_long as number | null,
    open_interest_short: m.open_interest_short as number | null,
    insurance_balance: m.insurance_balance as number | null,
    insurance_fund: m.insurance_fund as number | null,
    c_tot: m.c_tot as number | null,
    vault_balance: vaultNum,
    total_accounts: m.total_accounts as number | null,
  });
  return HEALTH_ORDER[h.level] ?? 5;
}

function applyHealthSort(
  markets: Record<string, unknown>[],
  order: "asc" | "desc",
): Record<string, unknown>[] {
  const sortDir = order === "desc" ? -1 : 1;
  return [...markets].sort((a, b) => {
    const ra = healthRank(a);
    const rb = healthRank(b);
    return sortDir * (ra - rb);
  });
}

// ---- Fixtures ----

/** vault=0 but c_tot > 0 + live price: FF7K keeper pattern — NOT a zombie, but no LP */
const VAULT_ZERO_WITH_CTOT = {
  symbol: "WENDYS",
  vault_balance: 0,          // numeric 0 (as would appear post-sanitize)
  c_tot: 1_000_000,          // legacy c_tot from slab
  insurance_balance: 0,
  total_open_interest: 0,    // phantom-suppressed
  total_accounts: 0,
  last_price: 0.50,          // live price → not zombie
};

/** vault=0 as raw Supabase string (DB returns NUMERIC as string) */
const VAULT_ZERO_STRING = {
  symbol: "RIGGED",
  vault_balance: "0",        // raw DB string
  c_tot: 500_000,
  insurance_balance: "0",
  total_open_interest: 0,
  total_accounts: 0,
  last_price: 0.10,
};

/** Genuinely healthy market: vault > MIN, good insurance/OI ratio */
const HEALTHY_MARKET = {
  symbol: "AdjMocJX",
  vault_balance: 50_000_000,
  c_tot: 50_000_000,
  insurance_balance: 5_000_000,
  total_open_interest: 1_000_000,
  total_accounts: 42,
  last_price: 1.20,
};

/** Caution market: vault OK, insurance ratio between 2–5% */
const CAUTION_MARKET = {
  symbol: "CAUTION",
  vault_balance: 10_000_000,
  c_tot: 1_000_000,
  insurance_balance: 30_000,    // ~3% — caution band
  total_open_interest: 1_000_000,
  total_accounts: 5,
  last_price: 2.00,
};

/** Warning market: vault OK, insurance ratio < 2% */
const WARNING_MARKET = {
  symbol: "WARN",
  vault_balance: 5_000_000,
  c_tot: 1_000_000,
  insurance_balance: 5_000,     // 0.5% — warning
  total_open_interest: 1_000_000,
  total_accounts: 3,
  last_price: 1.00,
};

describe("GH#1608 — health sort: vault=0 markets must not rank as healthy", () => {
  describe("healthRank()", () => {
    it("vault=0 (numeric) → rank 3 (empty)", () => {
      expect(healthRank(VAULT_ZERO_WITH_CTOT)).toBe(3);
    });

    it("vault=0 (string from Supabase) → rank 3 (empty)", () => {
      expect(healthRank(VAULT_ZERO_STRING)).toBe(3);
    });

    it("vault=null → no vault guard fires, falls through to computeMarketHealthFromStats", () => {
      // Without vault data, health is computed from other fields.
      // With c_tot=1M and oi=0, the function returns "healthy" (oi=0 + capital > 0).
      const noVault = { ...VAULT_ZERO_WITH_CTOT, vault_balance: null };
      // vault=null → guard doesn't fire → computeMarketHealthFromStats called
      // result depends on stats, but we just verify no crash and a valid rank
      const rank = healthRank(noVault);
      expect([0, 1, 2, 3]).toContain(rank);
    });

    it("vault=999999 (dust, < MIN_VAULT_FOR_OI) → rank 3 (empty)", () => {
      expect(healthRank({ ...VAULT_ZERO_WITH_CTOT, vault_balance: 999_999 })).toBe(3);
    });

    it("vault=MIN_VAULT_FOR_OI (1_000_000) → NOT forced empty, computed normally", () => {
      // At the exact threshold, vault guard does NOT fire (uses strict <).
      // computeMarketHealthFromStats sees vault=1M, oi=0 → "healthy" (rank 0).
      const atThreshold = { ...VAULT_ZERO_WITH_CTOT, vault_balance: MIN_VAULT_FOR_OI };
      expect(healthRank(atThreshold)).toBeLessThan(3); // not forced empty
    });

    it("healthy market → rank 0", () => {
      expect(healthRank(HEALTHY_MARKET)).toBe(0);
    });

    it("caution market → rank 1", () => {
      expect(healthRank(CAUTION_MARKET)).toBe(1);
    });

    it("warning market → rank 2", () => {
      expect(healthRank(WARNING_MARKET)).toBe(2);
    });
  });

  describe("applyHealthSort() — ascending (best health first)", () => {
    const ALL_MARKETS = [
      VAULT_ZERO_WITH_CTOT,
      VAULT_ZERO_STRING,
      WARNING_MARKET,
      CAUTION_MARKET,
      HEALTHY_MARKET,
    ];

    it("vault=0 markets appear LAST, not first", () => {
      const sorted = applyHealthSort(ALL_MARKETS, "asc");
      const lastTwo = sorted.slice(-2).map((m) => m.symbol);
      expect(lastTwo).toContain("WENDYS");
      expect(lastTwo).toContain("RIGGED");
    });

    it("healthy market appears first", () => {
      const sorted = applyHealthSort(ALL_MARKETS, "asc");
      expect(sorted[0].symbol).toBe("AdjMocJX");
    });

    it("order: healthy (0) → caution (1) → warning (2) → empty (3)", () => {
      const sorted = applyHealthSort(ALL_MARKETS, "asc");
      const ranks = sorted.map((m) => healthRank(m));
      for (let i = 0; i < ranks.length - 1; i++) {
        expect(ranks[i]).toBeLessThanOrEqual(ranks[i + 1]);
      }
    });

    it("descending: vault=0 markets appear first (worst health at top)", () => {
      const sorted = applyHealthSort(ALL_MARKETS, "desc");
      const firstTwo = sorted.slice(0, 2).map((m) => m.symbol);
      expect(firstTwo).toContain("WENDYS");
      expect(firstTwo).toContain("RIGGED");
    });
  });

  describe("regression: vault=0 with c_tot > 0 is NOT falsely healthy", () => {
    it("without fix (baseline): computeMarketHealthFromStats alone would say 'healthy'", () => {
      // This demonstrates the bug: when called with oi=0 and c_tot=1M, health returns "healthy".
      // The fix bypasses this via the vault guard in healthRank().
      const h = computeMarketHealthFromStats({
        total_open_interest: 0,       // phantom-suppressed
        insurance_balance: 0,
        c_tot: 1_000_000,
        vault_balance: 0,             // vault=0 → phantom guard fires inside health fn too
        total_accounts: 0,
      });
      // computeMarketHealthFromStats with vault=0 → isPhantomOI=true → oi=0 → capital=1M → "healthy"
      // (This is the bug: health fn returns "healthy" for vault=0 markets with c_tot > 0)
      expect(h.level).toBe("healthy");
    });

    it("with fix: healthRank() returns 3 (empty) for vault=0 despite c_tot > 0", () => {
      expect(healthRank({
        vault_balance: 0,
        c_tot: 1_000_000,
        insurance_balance: 0,
        total_open_interest: 0,
        total_accounts: 0,
      })).toBe(3);
    });
  });
});
