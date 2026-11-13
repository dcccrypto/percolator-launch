// @vitest-environment node
/**
 * GH#1639 — Client-side health sort comparator must apply MIN_VAULT_FOR_OI vault guard
 *
 * Problem: page.tsx's `computeIsOracleDown` did not apply the same vault threshold
 * guard that route.ts applies (MIN_VAULT_FOR_OI = 1_000_000). Markets with
 * vault_balance < 1_000_000 have their phantom OI zeroed server-side, but if the
 * client sorts them as "oracle-down" instead of "empty", the sort rank disagrees with
 * the API response at the threshold boundary.
 *
 * Fix: Before the oracle-down check, return false for sub-threshold-vault markets so
 * they retain an "empty" sort rank (consistent with server-side treatment).
 *
 * These tests validate the pure logic extracted from page.tsx's `computeIsOracleDown`
 * and the resulting sort behaviour near the threshold boundary.
 */

import { MIN_VAULT_FOR_OI } from "@/lib/phantom-oi";

// ── Mirrored logic from page.tsx ─────────────────────────────────────────────

const numericOrNullForSort = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Simplified version of page.tsx's computeIsOracleDown, reflecting the GH#1639 fix.
 * Real page.tsx reads on-chain config; here we accept explicit flags for unit testing.
 */
function computeIsOracleDown({
  vaultBalance,
  onChainPriceZero,   // true if resolveMarketPriceE6 returns 0n
  markPrice,
  indexPrice,
  hasOnChain,
}: {
  vaultBalance: number | null;
  onChainPriceZero?: boolean;
  markPrice?: number | null;
  indexPrice?: number | null;
  hasOnChain?: boolean;
}): boolean {
  // GH#1639: Vault guard — mirrors route.ts MIN_VAULT_FOR_OI (PERC-816)
  const vaultBal = numericOrNullForSort(vaultBalance);
  if (vaultBal !== null && vaultBal < MIN_VAULT_FOR_OI) {
    return false; // sub-threshold → empty, not oracle-down
  }

  if (hasOnChain) {
    return onChainPriceZero === true;
  }

  const mp = numericOrNullForSort(markPrice ?? null);
  const ip = numericOrNullForSort(indexPrice ?? null);
  return (mp == null || mp <= 0) && (ip == null || ip <= 0);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GH#1639 — MIN_VAULT_FOR_OI vault guard in health sort comparator", () => {
  describe("MIN_VAULT_FOR_OI constant", () => {
    it("is 1_000_000", () => {
      expect(MIN_VAULT_FOR_OI).toBe(1_000_000);
    });
  });

  describe("vault guard: sub-threshold markets are NOT oracle-down", () => {
    it("returns false for vault_balance = 0 even if on-chain price is zero", () => {
      expect(
        computeIsOracleDown({ vaultBalance: 0, hasOnChain: true, onChainPriceZero: true })
      ).toBe(false);
    });

    it("returns false for vault_balance = 999_999 (one below threshold)", () => {
      expect(
        computeIsOracleDown({ vaultBalance: 999_999, hasOnChain: true, onChainPriceZero: true })
      ).toBe(false);
    });

    it("returns false for vault_balance = 1 with both prices null", () => {
      expect(
        computeIsOracleDown({ vaultBalance: 1, markPrice: null, indexPrice: null })
      ).toBe(false);
    });

    it("returns false for vault_balance = 500_000 with both prices zero", () => {
      expect(
        computeIsOracleDown({ vaultBalance: 500_000, markPrice: 0, indexPrice: 0 })
      ).toBe(false);
    });
  });

  describe("vault guard: at/above threshold markets use normal oracle-down logic", () => {
    it("returns true for vault_balance = 1_000_000 (exact threshold) with on-chain price zero", () => {
      expect(
        computeIsOracleDown({ vaultBalance: 1_000_000, hasOnChain: true, onChainPriceZero: true })
      ).toBe(true);
    });

    it("returns false for vault_balance = 1_000_000 with on-chain price non-zero", () => {
      expect(
        computeIsOracleDown({ vaultBalance: 1_000_000, hasOnChain: true, onChainPriceZero: false })
      ).toBe(false);
    });

    it("returns true for vault_balance = 5_000_000 with both prices null (Supabase-only market)", () => {
      expect(
        computeIsOracleDown({ vaultBalance: 5_000_000, markPrice: null, indexPrice: null })
      ).toBe(true);
    });

    it("returns false for vault_balance = 5_000_000 with valid mark_price", () => {
      expect(
        computeIsOracleDown({ vaultBalance: 5_000_000, markPrice: 1234, indexPrice: null })
      ).toBe(false);
    });

    it("returns false for vault_balance = 5_000_000 with valid index_price only", () => {
      expect(
        computeIsOracleDown({ vaultBalance: 5_000_000, markPrice: null, indexPrice: 5678 })
      ).toBe(false);
    });
  });

  describe("vault = null: no vault data — falls through to price check", () => {
    it("returns true when vault is null and both prices are null (Supabase-only)", () => {
      expect(
        computeIsOracleDown({ vaultBalance: null, markPrice: null, indexPrice: null })
      ).toBe(true);
    });

    it("returns false when vault is null and mark_price is valid", () => {
      expect(
        computeIsOracleDown({ vaultBalance: null, markPrice: 42, indexPrice: null })
      ).toBe(false);
    });
  });

  describe("sort rank consistency: sub-threshold markets rank as 'empty', not 'oracle-down'", () => {
    const order: Record<string, number> = {
      healthy: 0, caution: 1, warning: 2, "oracle-down": 3, empty: 4,
    };

    function getLevel(params: Parameters<typeof computeIsOracleDown>[0], baseLevel: string) {
      return computeIsOracleDown(params) ? "oracle-down" : baseLevel;
    }

    it("sub-threshold market with 'empty' base level stays at rank 4 (empty)", () => {
      const level = getLevel({ vaultBalance: 999_999, markPrice: null, indexPrice: null }, "empty");
      expect(order[level]).toBe(4);
    });

    it("above-threshold oracle-down market ranks at 3 (oracle-down)", () => {
      const level = getLevel({ vaultBalance: 2_000_000, markPrice: null, indexPrice: null }, "empty");
      expect(order[level]).toBe(3);
    });

    it("healthy above-threshold market ranks at 0 (healthy)", () => {
      const level = getLevel({ vaultBalance: 2_000_000, markPrice: 100, indexPrice: 100, hasOnChain: true, onChainPriceZero: false }, "healthy");
      expect(order[level]).toBe(0);
    });
  });
});
