// @vitest-environment node
/**
 * GH#1314 / GH#1318 / GH#1321 / GH#1425: /api/stats phantom OI vault boundary + price fallback tests.
 *
 * GH#1425: totalMarkets overcount (~40 zombie markets). phantomAwareData only zeroed OI fields,
 * leaving last_price intact. Zombie markets (vault_balance=0) with stale last_price still
 * passed isActiveMarket() via the last_price path. Fix: zero ALL stat fields for phantom markets
 * (mirrors GH#1412 homepage fix). Expected: totalMarkets=128, was: totalMarkets=168.
 *
 * History:
 * - PR#1299 (GH#1297): first vault guard, strict < 1M. Correct, but also fixed $1 fallback.
 * - PR#1303 (GH#1300): changed to inclusive <= 1M. Incorrectly excluded vault=1M real markets
 *   (usdEkK5G $59,994, MOLTBOT $4,620) → stats showed $0 instead of $64K.
 * - PR#1307 (GH#1304): over-corrected to (vaultBal <= 1M && rawOi === 0). Left a gap:
 *   markets with vault < 1M AND rawOi > 0 were not phantom in stats but were in /api/markets,
 *   causing $42K residual phantom OI ($107K vs $64K).
 * - PR#1315 (GH#1314): revert to strict < 1M, mirroring /api/markets exactly. Still had
 *   $42K phantom OI because 33 vault=1M uncranked markets had stale non-zero OI and no
 *   oracle price — the $1 fallback gave them each ~$2K USD OI.
 * - PR#1319 (GH#1318): remove $1 fallback — markets without a valid oracle price have
 *   indeterminate USD value and must not contribute to totalOpenInterest.
 *   BUT: used MAX_SANE_PRICE_USD=$10K — too tight. MOLTBOT last_price ~$210K was
 *   rejected → OI silently dropped → $59,994 instead of $64,614 (GH#1321).
 * - PR#this (GH#1321): raise MAX_SANE_PRICE_USD from $10K → $1M, matching
 *   /api/markets sanitizePrice cap. Admin-set devnet prices up to ~$999K are valid.
 *
 * Rules:
 *   isPhantomOI = accountsCount === 0 || vaultBal < 1_000_000  (strict <, unchanged)
 *   price = last_price if 0 < p <= 1_000_000, else 0 (no $1 fallback) → skip if p <= 0
 *
 * Coverage:
 * - vault=0         → phantom (no vault at all)
 * - vault=999_999   → phantom (below threshold, dust)
 * - vault=1_000_000 → NOT phantom (creation-deposit markets like usdEkK5G / MOLTBOT)
 * - vault=1_000_001 → NOT phantom (real LP above threshold)
 * - accounts=0      → phantom regardless of vault
 * - GH#1314 regression: vault < 1M + rawOi > 0 → phantom (excluded)
 * - GH#1318 regression: vault=1M + rawOi > 0 + NO PRICE → skipped (p=0). No $1 fallback.
 * - GH#1321 regression: vault=1M + valid price $210K → correctly counted (was dropped by $10K cap)
 */

import { describe, it, expect } from "vitest";

/** Mirrors the vault boundary constant in app/app/api/stats/route.ts */
const MIN_VAULT_FOR_OI_STATS = 1_000_000;
/** GH#1321: raised from $10K → $1M to match /api/markets sanitizePrice cap */
const MAX_SANE_PRICE_USD = 1_000_000;
const MAX_PER_MARKET_USD = 10_000_000_000;

/** GH#1314: strict < mirroring /api/markets isPhantomOI exactly */
function isPhantomMarket(vaultBal: number, accountsCount: number): boolean {
  return accountsCount === 0 || vaultBal < MIN_VAULT_FOR_OI_STATS;
}

/** GH#1318: simulates the full OI reducer including price guard (no $1 fallback) */
function simulateOISum(
  markets: Array<{
    vault_balance: number;
    total_accounts: number;
    total_open_interest: number;
    last_price?: number | null;
    decimals?: number | null;
  }>
): number {
  return markets.reduce((sum, m) => {
    if (isPhantomMarket(m.vault_balance, m.total_accounts)) return sum;
    const rawOi = m.total_open_interest;
    if (rawOi <= 0 || !Number.isFinite(rawOi) || rawOi >= 1e18) return sum;
    const d = Math.min(Math.max(m.decimals ?? 6, 0), 18);
    // GH#1318: no $1 fallback — skip markets without a valid oracle price
    const p = (m.last_price != null && m.last_price > 0 && m.last_price <= MAX_SANE_PRICE_USD)
      ? m.last_price
      : 0;
    if (p <= 0) return sum;
    const usd = (rawOi / 10 ** d) * p;
    return sum + (usd > MAX_PER_MARKET_USD ? 0 : usd);
  }, 0);
}

describe("GH#1314: /api/stats phantom OI strict < 1M boundary (mirrors /api/markets)", () => {
  it("excludes markets with vault_balance=0 (empty vault)", () => {
    const markets = [{ vault_balance: 0, total_accounts: 5, total_open_interest: 50_000, last_price: 1.0 }];
    expect(simulateOISum(markets)).toBe(0);
  });

  it("excludes markets with vault_balance=999_999 (dust/sub-threshold)", () => {
    const markets = [{ vault_balance: 999_999, total_accounts: 3, total_open_interest: 42_909, last_price: 1.0 }];
    expect(simulateOISum(markets)).toBe(0);
  });

  it("includes markets with vault_balance=1_000_000 and valid price (creation-deposit — usdEkK5G / MOLTBOT pattern)", () => {
    // GH#1314: strict < means vault=1M is NOT phantom. PR#1303 broke this with <=.
    // GH#1318: must have a valid last_price — no $1 fallback.
    const markets = [{ vault_balance: 1_000_000, total_accounts: 3, total_open_interest: 59_994_000_000, last_price: 1.0, decimals: 6 }];
    expect(simulateOISum(markets)).toBeCloseTo(59_994, 0);
  });

  it("includes markets with vault_balance=1_000_001 (real LP above threshold)", () => {
    const markets = [{ vault_balance: 1_000_001, total_accounts: 5, total_open_interest: 4_620_000_000, last_price: 1.0, decimals: 6 }];
    expect(simulateOISum(markets)).toBeCloseTo(4_620, 0);
  });

  it("excludes markets with accounts_count=0 regardless of vault", () => {
    const markets = [{ vault_balance: 999_999_999, total_accounts: 0, total_open_interest: 100_000, last_price: 1.0 }];
    expect(simulateOISum(markets)).toBe(0);
  });

  it("GH#1314 regression: excludes vault<1M markets with non-zero rawOi (PR#1307 gap)", () => {
    // PR#1307 used (vaultBal <= 1M && rawOi === 0) — let vault=500K + rawOi>0 slip through.
    // /api/markets filters these (vaultBal < 1M), so stats was overcounting by ~$42K.
    const markets = [{ vault_balance: 500_000, total_accounts: 5, total_open_interest: 42_909, last_price: 1.0 }];
    expect(simulateOISum(markets)).toBe(0);
  });

  it("correctly filters mixed set — only non-phantom markets with valid prices contribute OI", () => {
    const markets = [
      // Phantom: vault=0
      { vault_balance: 0, total_accounts: 2, total_open_interest: 10_000, last_price: 1.0, decimals: 6 },
      // Phantom: vault=999_999 (dust, below threshold) — GH#1314 regression case
      { vault_balance: 999_999, total_accounts: 5, total_open_interest: 42_909, last_price: 1.0, decimals: 6 },
      // Phantom: no accounts
      { vault_balance: 5_000_000, total_accounts: 0, total_open_interest: 20_000, last_price: 1.0, decimals: 6 },
      // Real: vault=1_000_000 (creation-deposit, like usdEkK5G) — has valid price
      { vault_balance: 1_000_000, total_accounts: 3, total_open_interest: 59_994_000_000, last_price: 1.0, decimals: 6 },
      // Real: vault > 1M with accounts and valid price
      { vault_balance: 2_000_000, total_accounts: 1, total_open_interest: 4_620_000_000, last_price: 1.0, decimals: 6 },
    ];
    // Only last two contribute: 59_994 + 4_620 = 64_614
    expect(simulateOISum(markets)).toBeCloseTo(59_994 + 4_620, 0);
  });

  it("reproduces GH#1314 scenario: $107K → $64K after correcting phantom guard", () => {
    // Before fix (PR#1307): vault=500K markets with rawOi>0 slipped through → $107K
    // After fix (strict <): vault<1M excluded → $64,614 matches /api/markets
    const markets = [
      { vault_balance: 500_000, total_accounts: 5, total_open_interest: 42_909_000_000, last_price: 1.0, decimals: 6 },  // phantom, excluded
      { vault_balance: 1_000_000, total_accounts: 3, total_open_interest: 59_994_000_000, last_price: 1.0, decimals: 6 }, // real (usdEkK5G)
      { vault_balance: 1_000_000, total_accounts: 2, total_open_interest: 4_620_000_000, last_price: 1.0, decimals: 6 },  // real (MOLTBOT)
    ];
    expect(simulateOISum(markets)).toBeCloseTo(59_994 + 4_620, 0); // = 64_614
  });
});

describe("GH#1318: /api/stats no $1 fallback — markets without oracle price skipped", () => {
  it("excludes vault=1M markets with stale OI and no price (was $2K each via $1 fallback)", () => {
    // These are uncranked creation-deposit markets: vault=1M, accounts>0, OI>0 in DB,
    // but no oracle price (indexer no longer processing them). With $1 fallback they
    // contributed ~$2K each (33 markets = ~$47K phantom OI). Fix: skip if no price.
    const markets = [
      { vault_balance: 1_000_000, total_accounts: 3, total_open_interest: 2_000_000_000_000, last_price: null, decimals: 9 },
      { vault_balance: 1_000_000, total_accounts: 2, total_open_interest: 2_660_054_000_000, last_price: null, decimals: 9 },
    ];
    expect(simulateOISum(markets)).toBe(0); // No price → no contribution
  });

  it("still counts vault=1M markets WITH a valid oracle price (usdEkK5G / MOLTBOT)", () => {
    const markets = [
      // usdEkK5G: vault=1M, accounts=2, has real price
      { vault_balance: 1_000_000, total_accounts: 2, total_open_interest: 59_994_000_000, last_price: 1.0, decimals: 6 },
      // MOLTBOT: vault=1M, accounts=2, has real price
      { vault_balance: 1_000_000, total_accounts: 2, total_open_interest: 4_620_000_000, last_price: 1.0, decimals: 6 },
    ];
    expect(simulateOISum(markets)).toBeCloseTo(59_994 + 4_620, 0);
  });

  it("GH#1318 full scenario: 33 phantom no-price markets + 2 real priced markets → $64K", () => {
    // Before fix: 33 × ~$2K ($1 fallback) + $64,614 = ~$107K
    // After fix: no contribution from no-price markets → $64,614 only
    const phantomMarkets = Array.from({ length: 33 }, () => ({
      vault_balance: 1_000_000, total_accounts: 2, total_open_interest: 2_000_000_000_000,
      last_price: null, decimals: 9,
    }));
    const realMarkets = [
      { vault_balance: 1_000_000, total_accounts: 2, total_open_interest: 59_994_000_000, last_price: 1.0, decimals: 6 },
      { vault_balance: 1_000_000, total_accounts: 2, total_open_interest: 4_620_000_000, last_price: 1.0, decimals: 6 },
    ];
    const result = simulateOISum([...phantomMarkets, ...realMarkets]);
    expect(result).toBeCloseTo(59_994 + 4_620, 0); // ≈ $64,614 (no phantom OI)
  });

  it("excludes markets with corrupt/garbage price (> MAX_SANE_PRICE_USD = $1M)", () => {
    // Admin-mode markets with garbage authorityPriceE6 written as raw u64 (e.g. $7.9T)
    // GH#1321: cap raised from $10K → $1M. Values above $1M (e.g. $1.5M, $7.9T) are still rejected.
    const markets = [
      { vault_balance: 2_000_000, total_accounts: 5, total_open_interest: 5_000_000_000, last_price: 1_500_000, decimals: 6 }, // > $1M cap → p=0
    ];
    expect(simulateOISum(markets)).toBe(0);
  });

  it("includes markets with price at exactly MAX_SANE_PRICE_USD boundary ($1M)", () => {
    // GH#1321: boundary raised from $10K to $1M to match /api/markets
    const markets = [
      { vault_balance: 2_000_000, total_accounts: 3, total_open_interest: 1_000_000, last_price: 1_000_000, decimals: 6 },
    ];
    // 1_000_000 / 1e6 * 1_000_000 = 1 * 1_000_000 = $1,000,000
    expect(simulateOISum(markets)).toBeCloseTo(1_000_000, 0);
  });

  it("GH#1321 regression: counts vault=1M market with price $210K (MOLTBOT-pattern — was dropped by old $10K cap)", () => {
    // MOLTBOT last_price ~$210,011. Old $10K cap → p=0 → OI silently dropped.
    // New $1M cap → price valid → OI correctly counted.
    // raw_oi=22_000 micro-units at decimals=6 → 22_000/1e6 * 210_011 ≈ $4,620
    const markets = [
      // usdEkK5G: last_price $1.0, raw_oi=59_994_000_000 → 59_994 tokens * $1 = $59,994
      { vault_balance: 1_000_000, total_accounts: 2, total_open_interest: 59_994_000_000, last_price: 1.0, decimals: 6 },
      // MOLTBOT: last_price $210,011 (above old $10K cap, below new $1M cap)
      // 22_000 / 1e6 * 210_011 = 0.022 tokens * $210,011 ≈ $4,620
      { vault_balance: 1_000_000, total_accounts: 2, total_open_interest: 22_000, last_price: 210_011, decimals: 6 },
    ];
    const result = simulateOISum(markets);
    expect(result).toBeGreaterThan(59_994); // MOLTBOT now contributes
    expect(result).toBeCloseTo(59_994 + 4_620, -1); // ≈ $64,614 (within $10)
  });
});

describe("GH#1425: /api/stats totalMarkets zombie overcount — all stat fields zeroed for phantoms", () => {
  /**
   * Simulates the phantomAwareData mapping + isActiveMarket filtering to reproduce GH#1425.
   * BEFORE fix: only OI fields zeroed → vault=0 zombies with stale last_price still active.
   * AFTER fix: ALL stat fields zeroed → zombies fail isActiveMarket() → excluded from totalMarkets.
   */

  const MIN_VAULT = 1_000_000;

  function isSane(v: number | null | undefined): boolean {
    if (v == null) return false;
    return v > 0 && v < 1e18 && Number.isFinite(v);
  }

  function isActive(row: {
    last_price?: number | null;
    volume_24h?: number | null;
    total_open_interest?: number | null;
    open_interest_long?: number | null;
    open_interest_short?: number | null;
  }): boolean {
    if (isSane(row.last_price)) return true;
    if (isSane(row.volume_24h)) return true;
    if (isSane(row.total_open_interest)) return true;
    const combined = (row.open_interest_long ?? 0) + (row.open_interest_short ?? 0);
    if (isSane(combined)) return true;
    return false;
  }

  function simulateTotalMarketsAfterFix(
    markets: Array<{
      vault_balance: number;
      total_accounts: number;
      last_price?: number | null;
      volume_24h?: number | null;
      total_open_interest?: number | null;
      open_interest_long?: number | null;
      open_interest_short?: number | null;
    }>
  ): number {
    const phantomAware = markets.map((m) => {
      const isPhantom = m.total_accounts === 0 || m.vault_balance < MIN_VAULT;
      if (!isPhantom) return m;
      // GH#1425 fix: zero ALL stat fields (including last_price, volume_24h)
      return {
        ...m,
        last_price: 0,
        volume_24h: 0,
        total_open_interest: 0,
        open_interest_long: 0,
        open_interest_short: 0,
      };
    });
    return phantomAware.filter(isActive).length;
  }

  function simulateTotalMarketsBeforeFix(
    markets: Array<{
      vault_balance: number;
      total_accounts: number;
      last_price?: number | null;
      volume_24h?: number | null;
      total_open_interest?: number | null;
    }>
  ): number {
    const phantomAware = markets.map((m) => {
      const isPhantom = m.total_accounts === 0 || m.vault_balance < MIN_VAULT;
      if (!isPhantom) return m;
      // BEFORE fix: only OI fields zeroed — last_price left intact
      return {
        ...m,
        total_open_interest: 0,
        open_interest_long: 0,
        open_interest_short: 0,
      };
    });
    return phantomAware.filter(isActive).length;
  }

  it("GH#1425: zombie markets (vault=0) with stale last_price overcount before fix", () => {
    const markets = Array.from({ length: 40 }, () => ({
      vault_balance: 0,
      total_accounts: 5,
      last_price: 1.23, // stale, non-zero → leaked through old phantom guard
      volume_24h: 0,
      total_open_interest: 0,
    }));
    // Before fix: zombies pass isActive via stale last_price → overcounted by 40
    expect(simulateTotalMarketsBeforeFix(markets)).toBe(40);
    // After fix: all stat fields zeroed → isActive returns false → excluded
    expect(simulateTotalMarketsAfterFix(markets)).toBe(0);
  });

  it("GH#1425 regression: reproduces 168 → 128 totalMarkets correction", () => {
    // 128 real markets + 40 zombie markets (vault=0, stale price)
    const realMarkets = Array.from({ length: 128 }, (_, i) => ({
      vault_balance: 2_000_000,
      total_accounts: 3,
      last_price: 1.0 + i * 0.01,
      volume_24h: 1000,
      total_open_interest: 1_000_000,
    }));
    const zombieMarkets = Array.from({ length: 40 }, () => ({
      vault_balance: 0,
      total_accounts: 2,
      last_price: 0.95, // stale last_price — zombie was once active
      volume_24h: null,
      total_open_interest: null,
    }));
    const all = [...realMarkets, ...zombieMarkets];
    expect(simulateTotalMarketsBeforeFix(all)).toBe(168); // before fix: zombies counted
    expect(simulateTotalMarketsAfterFix(all)).toBe(128);  // after fix: zombies excluded
  });

  it("does not exclude real markets (vault >= 1M) that have valid last_price", () => {
    const markets = [
      { vault_balance: 1_000_000, total_accounts: 2, last_price: 1.0, volume_24h: 500, total_open_interest: 1_000 },
      { vault_balance: 5_000_000, total_accounts: 10, last_price: 200.0, volume_24h: 50_000, total_open_interest: null },
    ];
    expect(simulateTotalMarketsAfterFix(markets)).toBe(2); // both real → both counted
  });
});
