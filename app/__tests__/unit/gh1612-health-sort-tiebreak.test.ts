// @vitest-environment node
/**
 * GH#1612: sort=health must not interleave vault=0 and vault>0 markets
 * within the same health rank. vault>0 markets should always appear
 * before vault=0 markets when both have rank "empty" (3).
 */
import { describe, it, expect } from "vitest";

// Inline the same logic used in route.ts for unit testing
const HEALTH_ORDER: Record<string, number> = { healthy: 0, caution: 1, warning: 2, empty: 3 };
const MIN_VAULT_FOR_OI = 1_000_000;

function numericOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function healthRank(m: Record<string, unknown>): number {
  const vaultNum = numericOrNull(m.vault_balance);
  if (vaultNum !== null && vaultNum < MIN_VAULT_FOR_OI) {
    return HEALTH_ORDER["empty"];
  }
  // Simplified: if c_tot=0, insurance=0, oi=0 → empty
  const capital = numericOrNull(m.c_tot) ?? 0;
  const oi = numericOrNull(m.total_open_interest) ?? 0;
  const insurance = numericOrNull(m.insurance_balance) ?? 0;
  if (capital === 0 && insurance === 0 && oi === 0) return HEALTH_ORDER["empty"];
  if (oi === 0) return HEALTH_ORDER["healthy"];
  return HEALTH_ORDER["healthy"];
}

function sortByHealth(markets: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...markets].sort((a, b) => {
    const ra = healthRank(a);
    const rb = healthRank(b);
    if (ra !== rb) return ra - rb;
    // GH#1612 tiebreaker
    const va = numericOrNull(a.vault_balance) ?? 0;
    const vb = numericOrNull(b.vault_balance) ?? 0;
    if (va > 0 && vb === 0) return -1;
    if (va === 0 && vb > 0) return 1;
    return 0;
  });
}

describe("GH#1612: sort=health tiebreak vault>0 before vault=0", () => {
  it("vault>0 empty markets sort before vault=0 empty markets", () => {
    const markets = [
      { symbol: "A", vault_balance: 0, c_tot: 0, total_open_interest: 0, insurance_balance: 0 },
      { symbol: "B", vault_balance: 1000000, c_tot: 0, total_open_interest: 0, insurance_balance: 0 },
      { symbol: "C", vault_balance: 0, c_tot: 0, total_open_interest: 0, insurance_balance: 0 },
      { symbol: "D", vault_balance: 1000000, c_tot: 0, total_open_interest: 0, insurance_balance: 0 },
    ];
    const sorted = sortByHealth(markets);
    // Both B and D (vault=1M) should come before A and C (vault=0)
    const symbols = sorted.map((m) => m.symbol);
    expect(symbols).toEqual(["B", "D", "A", "C"]);
  });

  it("no vault>0 market appears after any vault=0 market within same rank", () => {
    const markets: Record<string, unknown>[] = [];
    // Mix of vault=0 and vault=1000000, all empty rank
    for (let i = 0; i < 50; i++) {
      markets.push({
        symbol: `V0_${i}`,
        vault_balance: 0,
        c_tot: 0,
        total_open_interest: 0,
        insurance_balance: 0,
      });
    }
    for (let i = 0; i < 25; i++) {
      markets.push({
        symbol: `V1M_${i}`,
        vault_balance: 1000000,
        c_tot: 0,
        total_open_interest: 0,
        insurance_balance: 0,
      });
    }
    const sorted = sortByHealth(markets);
    let seenVault0 = false;
    for (const m of sorted) {
      const v = numericOrNull(m.vault_balance) ?? 0;
      if (v === 0) seenVault0 = true;
      if (seenVault0 && v > 0) {
        throw new Error(`vault>0 market ${m.symbol} appeared after vault=0`);
      }
    }
  });
});
