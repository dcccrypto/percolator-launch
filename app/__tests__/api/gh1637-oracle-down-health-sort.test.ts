// @vitest-environment node
/**
 * GH#1637: sort=health puts oracle-down markets (null prices) ABOVE healthy markets.
 *
 * Root cause:
 *   - PR #1632 fixed the oracle-down badge but did NOT update the health sort comparator
 *     in route.ts. The HEALTH_ORDER map lacked the "oracle-down" key, so oracle-down markets
 *     fell through to computeMarketHealthFromStats which returned "healthy" (rank 0) for
 *     markets with c_tot>0 and no OI (oi=0 + capital → Infinity ratio → "healthy").
 *   - 82 oracle-down markets with vault>0 and c_tot>0 ranked at positions 0–121,
 *     burying genuinely healthy (priced) markets.
 *   - Additionally, the frontend (markets/page.tsx) had the wrong order map:
 *     { empty: 3, "oracle-down": 4 } — oracle-down was after empty (rank 4 > 3),
 *     making them sort LAST instead of 4th.
 *
 * Fix:
 *   - route.ts: Add oracle-down detection in healthRank() using mark_price/index_price.
 *     If both are null/zero and vault >= MIN_VAULT_FOR_OI → return rank 3 (oracle-down).
 *     Update HEALTH_ORDER to: healthy=0, caution=1, warning=2, oracle-down=3, empty=4.
 *   - markets/page.tsx: Correct HEALTH_ORDER map to oracle-down=3, empty=4.
 *
 * Expected sort order:
 *   1. Healthy      (price + sufficient capital)  → rank 0
 *   2. Caution      (price + lower capital ratio) → rank 1
 *   3. Warning      (price + very low capital)    → rank 2
 *   4. No Oracle    (has capital but no price)    → rank 3
 *   5. Empty        (vault=0, no capital)         → rank 4
 */
import { describe, it, expect } from "vitest";
import { computeMarketHealthFromStats } from "../../lib/health";
import { MIN_VAULT_FOR_OI } from "../../lib/phantom-oi";

// ---- Inline reproduction of the FIXED healthRank logic from route.ts ----

const HEALTH_ORDER: Record<string, number> = {
  healthy: 0,
  caution: 1,
  warning: 2,
  "oracle-down": 3,
  empty: 4,
};

function numericOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function healthRank(m: Record<string, unknown>): number {
  const vaultNum = numericOrNull(m.vault_balance);
  // GH#1608: no-vault markets → rank 4 (empty)
  if (vaultNum !== null && vaultNum < MIN_VAULT_FOR_OI) {
    return HEALTH_ORDER["empty"];
  }
  // GH#1637: oracle-down detection — mark_price and index_price both null/zero
  const mp = numericOrNull(m.mark_price);
  const ip = numericOrNull(m.index_price);
  const isOracleDown = (mp == null || mp <= 0) && (ip == null || ip <= 0);
  if (isOracleDown && vaultNum != null && vaultNum >= MIN_VAULT_FOR_OI) {
    return HEALTH_ORDER["oracle-down"]; // 3
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
    if (ra !== rb) return sortDir * (ra - rb);
    // GH#1612 tiebreaker: vault>0 before vault=0 within same rank
    const va = numericOrNull(a.vault_balance) ?? 0;
    const vb = numericOrNull(b.vault_balance) ?? 0;
    if (va > 0 && vb === 0) return -1;
    if (va === 0 && vb > 0) return 1;
    return 0;
  });
}

// ---- Fixtures ----

/** Oracle-down: vault>0, c_tot>0, NO price — the GH#1637 regression case */
const ORACLE_DOWN_WITH_CAPITAL = {
  symbol: "FKNzcDeY",
  vault_balance: 1_000_000,
  c_tot: 1_000_000_000_000,
  insurance_balance: 0,
  total_open_interest: 0,
  mark_price: null,
  index_price: null,
};

/** Another oracle-down market (price=0 not null) */
const ORACLE_DOWN_ZERO_PRICE = {
  symbol: "8pzvVD4K",
  vault_balance: 1_000_000,
  c_tot: 1_001_000_009_000_000,
  insurance_balance: 0,
  total_open_interest: 0,
  mark_price: 0,
  index_price: 0,
};

/** Genuinely healthy market: vault > MIN, has live price, good insurance/OI */
const HEALTHY_MARKET = {
  symbol: "FWqfo2mw",
  vault_balance: 100_000_000,
  c_tot: 50_000_000,
  insurance_balance: 5_000_000,
  total_open_interest: 8_000_000,
  mark_price: 10,
  index_price: 10,
};

/** Caution market: has price, lower insurance ratio */
const CAUTION_MARKET = {
  symbol: "CAUTION1",
  vault_balance: 50_000_000,
  c_tot: 40_000_000,
  insurance_balance: 1_600_000, // 4% of OI (below 5% threshold)
  total_open_interest: 40_000_000,
  mark_price: 5,
  index_price: 5,
};

/** Warning market: has price, very low capital ratio */
const WARNING_MARKET = {
  symbol: "WARN0001",
  vault_balance: 50_000_000,
  c_tot: 15_000_000, // 37.5% of OI (below 50% threshold)
  insurance_balance: 500_000, // 1.25% of OI
  total_open_interest: 40_000_000,
  mark_price: 3,
  index_price: 3,
};

/** Empty market: vault=0 (no LP) */
const EMPTY_MARKET = {
  symbol: "EMPTY001",
  vault_balance: 0,
  c_tot: 0,
  insurance_balance: 0,
  total_open_interest: 0,
  mark_price: null,
  index_price: null,
};

// ---- Tests ----

describe("GH#1637: oracle-down markets rank below healthy/caution/warning in health sort", () => {
  it("oracle-down market (null prices, vault>0) ranks 3 in HEALTH_ORDER", () => {
    expect(healthRank(ORACLE_DOWN_WITH_CAPITAL)).toBe(3);
  });

  it("oracle-down market (price=0, vault>0) ranks 3 in HEALTH_ORDER", () => {
    expect(healthRank(ORACLE_DOWN_ZERO_PRICE)).toBe(3);
  });

  it("healthy market ranks 0", () => {
    expect(healthRank(HEALTHY_MARKET)).toBe(0);
  });

  it("caution market ranks 1", () => {
    expect(healthRank(CAUTION_MARKET)).toBe(1);
  });

  it("warning market ranks 2", () => {
    expect(healthRank(WARNING_MARKET)).toBe(2);
  });

  it("empty market (vault=0) ranks 4", () => {
    expect(healthRank(EMPTY_MARKET)).toBe(4);
  });

  it("sort=health asc: healthy first, then caution, warning, oracle-down, empty last", () => {
    const markets = [
      ORACLE_DOWN_WITH_CAPITAL,
      EMPTY_MARKET,
      WARNING_MARKET,
      HEALTHY_MARKET,
      CAUTION_MARKET,
      ORACLE_DOWN_ZERO_PRICE,
    ];
    const sorted = applyHealthSort(markets, "asc");
    const symbols = sorted.map((m) => m.symbol);
    expect(symbols.indexOf("FWqfo2mw")).toBeLessThan(symbols.indexOf("CAUTION1"));
    expect(symbols.indexOf("CAUTION1")).toBeLessThan(symbols.indexOf("WARN0001"));
    expect(symbols.indexOf("WARN0001")).toBeLessThan(symbols.indexOf("FKNzcDeY"));
    expect(symbols.indexOf("WARN0001")).toBeLessThan(symbols.indexOf("8pzvVD4K"));
    // Both oracle-down markets rank before empty
    expect(symbols.indexOf("FKNzcDeY")).toBeLessThan(symbols.indexOf("EMPTY001"));
    expect(symbols.indexOf("8pzvVD4K")).toBeLessThan(symbols.indexOf("EMPTY001"));
  });

  it("oracle-down markets rank BELOW healthy market (the regression from GH#1637)", () => {
    const markets = [ORACLE_DOWN_WITH_CAPITAL, HEALTHY_MARKET];
    const sorted = applyHealthSort(markets, "asc");
    // Healthy must come before oracle-down
    expect(sorted[0].symbol).toBe("FWqfo2mw");
    expect(sorted[1].symbol).toBe("FKNzcDeY");
  });

  it("82 oracle-down markets all rank below the first healthy market", () => {
    const oracleDownMarkets = Array.from({ length: 82 }, (_, i) => ({
      symbol: `ODOWN${i.toString().padStart(3, "0")}`,
      vault_balance: 1_000_000,
      c_tot: 1_000_000_000,
      insurance_balance: 0,
      total_open_interest: 0,
      mark_price: null,
      index_price: null,
    }));
    const markets = [...oracleDownMarkets, HEALTHY_MARKET];
    const sorted = applyHealthSort(markets, "asc");
    // Healthy market must appear FIRST (position 0)
    expect(sorted[0].symbol).toBe("FWqfo2mw");
    // All oracle-down markets must appear after the healthy market
    for (let i = 1; i <= 82; i++) {
      expect(sorted[i].symbol).toMatch(/^ODOWN\d+$/);
    }
  });

  it("oracle-down with only mark_price null (index_price also null) → rank 3", () => {
    const m = {
      symbol: "MNULL001",
      vault_balance: 1_000_000,
      c_tot: 5_000_000,
      mark_price: null,
      index_price: null,
      total_open_interest: 0,
      insurance_balance: 0,
    };
    expect(healthRank(m)).toBe(3);
  });

  it("market with only mark_price defined (index null) → NOT oracle-down if mark_price > 0", () => {
    const m = {
      symbol: "MPONLY01",
      vault_balance: 10_000_000,
      c_tot: 5_000_000,
      insurance_balance: 500_000,
      total_open_interest: 5_000_000,
      mark_price: 1.5, // live price
      index_price: null,
    };
    // Has mark_price > 0, so not oracle-down; should be healthy/caution/warning
    const rank = healthRank(m);
    expect(rank).toBeLessThan(3);
  });

  it("oracle-down with vault just at MIN_VAULT_FOR_OI threshold → rank 3", () => {
    const m = {
      symbol: "MINVAULT",
      vault_balance: MIN_VAULT_FOR_OI, // exactly at threshold
      c_tot: 1_000_000,
      mark_price: null,
      index_price: null,
      total_open_interest: 0,
      insurance_balance: 0,
    };
    expect(healthRank(m)).toBe(3);
  });

  it("oracle-down with vault just below MIN_VAULT_FOR_OI → rank 4 (empty, not oracle-down)", () => {
    const m = {
      symbol: "BELOWMIN",
      vault_balance: MIN_VAULT_FOR_OI - 1,
      c_tot: 1_000_000,
      mark_price: null,
      index_price: null,
      total_open_interest: 0,
      insurance_balance: 0,
    };
    // vault < MIN → empty (GH#1608 guard takes priority)
    expect(healthRank(m)).toBe(4);
  });
});
