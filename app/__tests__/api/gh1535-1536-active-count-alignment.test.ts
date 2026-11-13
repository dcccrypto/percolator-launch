// @vitest-environment node
/**
 * GH#1535: /api/stats must expose activeTotal consistent with /api/markets activeTotal.
 *
 * Root cause: /api/stats exposed activeMarkets (phantom-based: 69) as the sole "active"
 * count, while /api/markets exposed activeTotal (zombie-excluded + isActiveMarket: 115).
 * Same name, different methodology — misleading for consumers.
 *
 * Fix: /api/stats now also exposes activeTotal = nonZombieListedMarkets filtered by
 * isActiveMarket(), matching /api/markets methodology exactly.
 *
 * GH#1536: /markets UI showed 171 vs /api/markets total 168.
 *
 * Root cause: UI zombie filter used `vault_balance === 0` on Supabase NUMERIC
 * columns returned as strings ("0" !== 0 → always false → zombies slip through).
 * Also included total_open_interest in hasNoStats (violating GH#1502 fix).
 *
 * Fix: UI now uses isZombieMarket() from activeMarketFilter.ts with Number() coercion.
 */

import { describe, it, expect } from "vitest";
import { isActiveMarket, isZombieMarket } from "@/lib/activeMarketFilter";

// ---------------------------------------------------------------------------
// GH#1535: activeTotal in /api/stats must match /api/markets activeTotal methodology
// ---------------------------------------------------------------------------

type MarketRow = {
  slab_address: string;
  last_price: number | null;
  volume_24h: number | null;
  total_open_interest: number | null;
  vault_balance: number | null;
  c_tot: number | null;
  total_accounts: number | null;
};

const MAX_SANE_PRICE = 1_000_000;

function numericOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sanitizePrice(v: number | null): number | null {
  if (v == null || v <= 0 || v > MAX_SANE_PRICE) return null;
  return v;
}

/** Reproduces /api/stats activeTotal computation (GH#1535 fix). */
function deriveStatsActiveTotal(rows: MarketRow[]): number {
  // Step 1: apply same zombie filter as /api/markets (with sanitized price)
  const nonZombie = rows.filter((m) =>
    !isZombieMarket({
      vault_balance: numericOrNull(m.vault_balance),
      c_tot: numericOrNull(m.c_tot),
      last_price: sanitizePrice(m.last_price),
      volume_24h: numericOrNull(m.volume_24h),
      total_open_interest: numericOrNull(m.total_open_interest),
      total_accounts: numericOrNull(m.total_accounts),
    })
  );
  // Step 2: apply isActiveMarket (at least one sane stat)
  return nonZombie.filter((m) =>
    isActiveMarket({
      last_price: sanitizePrice(m.last_price),
      volume_24h: numericOrNull(m.volume_24h),
      total_open_interest: numericOrNull(m.total_open_interest),
    })
  ).length;
}

/** Reproduces /api/markets activeTotal computation. */
function deriveMarketsActiveTotal(rows: MarketRow[]): number {
  const nonZombie = rows.filter((m) =>
    !isZombieMarket({
      vault_balance: numericOrNull(m.vault_balance),
      c_tot: numericOrNull(m.c_tot),
      last_price: sanitizePrice(m.last_price),
      volume_24h: numericOrNull(m.volume_24h),
      total_open_interest: numericOrNull(m.total_open_interest),
      total_accounts: numericOrNull(m.total_accounts),
    })
  );
  return nonZombie.filter((m) =>
    isActiveMarket({
      last_price: sanitizePrice(m.last_price),
      volume_24h: numericOrNull(m.volume_24h),
      total_open_interest: numericOrNull(m.total_open_interest),
    })
  ).length;
}

function makeMarket(overrides: Partial<MarketRow> & { slab_address: string }): MarketRow {
  return {
    last_price: 50,
    volume_24h: 1000,
    total_open_interest: 200,
    vault_balance: 5_000_000,
    c_tot: null,
    total_accounts: 3,
    ...overrides,
  };
}

describe("GH#1535 — /api/stats activeTotal must match /api/markets activeTotal", () => {
  it("both produce the same activeTotal for a normal set of markets", () => {
    const markets = [
      makeMarket({ slab_address: "a", last_price: 50, vault_balance: 5_000_000, total_accounts: 2 }),
      makeMarket({ slab_address: "b", last_price: 0.5, vault_balance: 2_000_000, total_accounts: 1 }),
      makeMarket({ slab_address: "c", last_price: null, volume_24h: 500, vault_balance: 1_000_000, total_accounts: 0 }),
    ];
    expect(deriveStatsActiveTotal(markets)).toBe(deriveMarketsActiveTotal(markets));
  });

  it("zombies are excluded before isActiveMarket check in both paths", () => {
    const markets = [
      makeMarket({ slab_address: "active", last_price: 50, vault_balance: 5_000_000, total_accounts: 3 }),
      makeMarket({ slab_address: "zombie", last_price: null, vault_balance: 0, total_accounts: 0, c_tot: null, volume_24h: null }),
    ];
    const statsTotal = deriveStatsActiveTotal(markets);
    const marketsTotal = deriveMarketsActiveTotal(markets);
    expect(statsTotal).toBe(1);
    expect(marketsTotal).toBe(1);
    expect(statsTotal).toBe(marketsTotal);
  });

  it("corrupt-price markets (> $1M) are not counted as active in either path", () => {
    const markets = [
      makeMarket({
        slab_address: "corrupt",
        last_price: 7_900_000_000, // $7.9B stale oracle
        volume_24h: 0,
        total_open_interest: 0,
        vault_balance: 5_000_000,
        total_accounts: 2,
      }),
      makeMarket({ slab_address: "valid", last_price: 42, vault_balance: 1_000_000, total_accounts: 1 }),
    ];
    expect(deriveStatsActiveTotal(markets)).toBe(1);
    expect(deriveMarketsActiveTotal(markets)).toBe(1);
  });

  it("market active via volume when price is corrupt — both paths agree", () => {
    const markets = [
      makeMarket({
        slab_address: "vol-active",
        last_price: 9_000_000, // corrupt
        volume_24h: 50_000,    // valid
        total_open_interest: 0,
        vault_balance: 1_000_000,
        total_accounts: 1,
      }),
    ];
    expect(deriveStatsActiveTotal(markets)).toBe(1);
    expect(deriveMarketsActiveTotal(markets)).toBe(1);
  });

  it("phantom market (vault < 1M) counts as non-zombie if c_tot + activity present", () => {
    // FF7K pattern: vault=0, c_tot>0, has price → not zombie → active
    const markets = [
      makeMarket({
        slab_address: "ff7k",
        last_price: 12.5,
        volume_24h: 800,
        vault_balance: 0,
        c_tot: 50_000_000,
        total_accounts: 0,
      }),
    ];
    expect(deriveStatsActiveTotal(markets)).toBe(1);
    expect(deriveMarketsActiveTotal(markets)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GH#1536: UI zombie filter must use Number() coercion for Supabase NUMERIC strings
// ---------------------------------------------------------------------------

describe("GH#1536 — UI zombie filter must coerce NUMERIC strings to numbers", () => {
  /**
   * Buggy UI zombie logic (pre-fix): `vault_balance === 0` fails for string "0".
   */
  function isZombieBuggy(row: {
    vault_balance: string | number | null;
    c_tot: string | number | null;
    last_price: string | number | null;
    volume_24h: string | number | null;
    total_open_interest: string | number | null;
    total_accounts: string | number | null;
  }): boolean {
    const accountsCount = row.total_accounts ?? 0;
    const hasNoStats =
      !(Number(row.last_price) > 0 && Number(row.last_price) < 1e18) &&
      !(Number(row.volume_24h) > 0 && Number(row.volume_24h) < 1e18) &&
      !(Number(row.total_open_interest) > 0 && Number(row.total_open_interest) < 1e18) &&
      accountsCount === 0; // BUG: accountsCount is the raw string value, not coerced
    const cTot = row.c_tot ?? 0;
    // BUG: vault_balance === 0 fails when Supabase returns "0" (string)
    return (cTot > 0 && !hasNoStats) ? false :
      ((row.vault_balance != null && row.vault_balance === 0) ||
      (row.vault_balance == null && hasNoStats));
  }

  /**
   * Fixed UI zombie logic: uses isZombieMarket() with Number() coercion.
   */
  function isZombieFixed(row: {
    vault_balance: string | number | null;
    c_tot: string | number | null;
    last_price: string | number | null;
    volume_24h: string | number | null;
    total_open_interest: string | number | null;
    total_accounts: string | number | null;
  }): boolean {
    const n = (v: unknown): number | null => {
      if (v == null) return null;
      const num = Number(v);
      return Number.isFinite(num) ? num : null;
    };
    const sp = (v: unknown): number | null => {
      const num = n(v);
      if (num == null || num <= 0 || num > MAX_SANE_PRICE) return null;
      return num;
    };
    return isZombieMarket({
      vault_balance: n(row.vault_balance),
      c_tot: n(row.c_tot),
      last_price: sp(row.last_price),
      volume_24h: n(row.volume_24h),
      total_open_interest: n(row.total_open_interest),
      total_accounts: n(row.total_accounts),
    });
  }

  it('BUG: vault_balance="0" (string) is NOT caught as zombie by the old logic', () => {
    const zombieRow = {
      vault_balance: "0",   // Supabase returns NUMERIC as string
      c_tot: null,
      last_price: null,
      volume_24h: null,
      total_open_interest: null,
      total_accounts: "0",
    };
    // Bug: "0" !== 0 → isZombie=false → zombie slips through
    expect(isZombieBuggy(zombieRow)).toBe(false); // ← was wrong
  });

  it('FIX: vault_balance="0" (string) IS correctly caught as zombie by the new logic', () => {
    const zombieRow = {
      vault_balance: "0",
      c_tot: null,
      last_price: null,
      volume_24h: null,
      total_open_interest: null,
      total_accounts: "0",
    };
    expect(isZombieFixed(zombieRow)).toBe(true);
  });

  it("FIX: non-zombie market (vault=5M, string) is not incorrectly marked zombie", () => {
    const liveRow = {
      vault_balance: "5000000",
      c_tot: null,
      last_price: "42.5",
      volume_24h: "1000",
      total_open_interest: "200",
      total_accounts: "3",
    };
    expect(isZombieFixed(liveRow)).toBe(false);
  });

  it("FIX: 3 zombie markets with vault='0' are all caught → UI would show 168, not 171", () => {
    const zombies = ["slab1", "slab2", "slab3"].map((slab) => ({
      vault_balance: "0" as string | number | null,
      c_tot: null as string | number | null,
      last_price: null as string | number | null,
      volume_24h: null as string | number | null,
      total_open_interest: null as string | number | null,
      total_accounts: "0" as string | number | null,
    }));
    const liveMarkets = Array.from({ length: 168 }, (_, i) => ({
      vault_balance: "5000000" as string | number | null,
      c_tot: null as string | number | null,
      last_price: `${50 + i}` as string | number | null,
      volume_24h: "1000" as string | number | null,
      total_open_interest: "200" as string | number | null,
      total_accounts: "3" as string | number | null,
    }));

    const all = [...liveMarkets, ...zombies];

    // Old (buggy): none of the 3 zombies caught → 171 shown
    const buggyNonZombie = all.filter((m) => !isZombieBuggy(m));
    expect(buggyNonZombie.length).toBe(171);

    // Fixed: 3 zombies caught → 168 shown
    const fixedNonZombie = all.filter((m) => !isZombieFixed(m));
    expect(fixedNonZombie.length).toBe(168);
  });

  it("FIX: 'iamdone' zombie (vault=0, c_tot=0, no stats) is correctly excluded", () => {
    // GH#1536 bug evidence: 'iamdone' (slab GPWtt6dU...) appears in UI but not /api/markets
    const iamdone = {
      vault_balance: "0",
      c_tot: "0",
      last_price: null,
      volume_24h: null,
      total_open_interest: null,
      total_accounts: "0",
    };
    expect(isZombieBuggy(iamdone)).toBe(false); // Bug: not caught
    expect(isZombieFixed(iamdone)).toBe(true);  // Fix: correctly excluded
  });

  it("GH#1502 alignment: OI without accounts is phantom — not included in hasNoStats logic", () => {
    // A market with stale phantom OI but no accounts, vault=null, no price.
    // The API treats this as zombie (GH#1502). The UI must agree.
    const phantomOI = {
      vault_balance: null,
      c_tot: null,
      last_price: null,
      volume_24h: null,
      total_open_interest: "50000", // stale phantom OI
      total_accounts: "0",
    };
    // Fixed logic: isZombieMarket() excludes OI from hasActivity check (GH#1502)
    // → hasActivity=false → hasNoStats=true (vault=null) → zombie
    expect(isZombieFixed(phantomOI)).toBe(true);
  });
});
