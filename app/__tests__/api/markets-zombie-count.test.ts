/**
 * GH#1445: Markets UI shows 168 markets but /api/markets returns 122.
 *
 * Root cause: the frontend activeMarkets filter zeroed OI for zombie markets but
 * NOT last_price or volume_24h. Zombie markets with stale cached prices passed
 * isActiveMarket() via the last_price field, inflating the UI count vs the API.
 *
 * Fix: match the API route's zombie definition exactly — null out last_price,
 * mark_price, index_price, AND volume_24h (not just OI) for zombie markets.
 *
 * Zombie definition (mirrors api/markets/route.ts is_zombie):
 *   vault_balance === 0  →  zombie (drained LP)
 *   vault_balance == null AND all key stats null AND accounts == 0  →  zombie (GH#1427 phantom)
 */

import { describe, it, expect } from "vitest";
import { isActiveMarket, isSaneMarketValue } from "@/lib/activeMarketFilter";

// ---------------------------------------------------------------------------
// Helpers (mirrors frontend activeMarkets useMemo logic after GH#1445 fix)
// ---------------------------------------------------------------------------

const MIN_VAULT_FOR_ACTIVE = 1_000_000;

type Stats = {
  last_price?: number | null;
  volume_24h?: number | null;
  total_open_interest?: number | null;
  open_interest_long?: number | null;
  open_interest_short?: number | null;
  vault_balance?: number | null;
  total_accounts?: number | null;
};

function isZombie(s: Stats): boolean {
  const accountsCount = s.total_accounts ?? 0;
  const hasNoStats =
    !isSaneMarketValue(s.last_price) &&
    !isSaneMarketValue(s.volume_24h) &&
    !isSaneMarketValue(s.total_open_interest) &&
    accountsCount === 0;
  return (
    (s.vault_balance != null && s.vault_balance === 0) ||
    (s.vault_balance == null && hasNoStats)
  );
}

function isPhantomOnly(s: Stats): boolean {
  const accountsCount = s.total_accounts ?? 0;
  const vaultBal = s.vault_balance ?? 0;
  return accountsCount === 0 || vaultBal < MIN_VAULT_FOR_ACTIVE;
}

/**
 * Simulates the fixed activeMarkets filter from markets/page.tsx.
 * Returns true if the market should be shown as "active".
 */
function isMarketActive(s: Stats): boolean {
  const isZomb = isZombie(s);
  const isPhantom = isPhantomOnly(s);

  const effectiveStats: Stats = isZomb
    ? {
        ...s,
        last_price: null,
        volume_24h: null,
        total_open_interest: 0,
        open_interest_long: 0,
        open_interest_short: 0,
      }
    : isPhantom
    ? { ...s, total_open_interest: 0, open_interest_long: 0, open_interest_short: 0 }
    : s;

  return isActiveMarket(effectiveStats);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GH#1445 zombie market frontend count fix", () => {
  // --- Zombie: vault explicitly 0 ---

  it("zombie (vault=0) with stale last_price is NOT active", () => {
    // Before fix: this passed isActiveMarket via last_price → inflated count
    expect(
      isMarketActive({ vault_balance: 0, last_price: 148, total_accounts: 0 }),
    ).toBe(false);
  });

  it("zombie (vault=0) with stale volume_24h is NOT active", () => {
    expect(
      isMarketActive({ vault_balance: 0, volume_24h: 5_000_000, total_accounts: 0 }),
    ).toBe(false);
  });

  it("zombie (vault=0) with all null stats is NOT active", () => {
    expect(
      isMarketActive({ vault_balance: 0, last_price: null, volume_24h: null, total_open_interest: null }),
    ).toBe(false);
  });

  // --- Zombie: vault null + no stats (GH#1427 phantom) ---

  it("GH#1427 phantom (vault=null, no stats) is NOT active", () => {
    expect(
      isMarketActive({
        vault_balance: null,
        last_price: null,
        volume_24h: null,
        total_open_interest: null,
        total_accounts: 0,
      }),
    ).toBe(false);
  });

  it("vault=null + has real price + no accounts is still active (not a zombie)", () => {
    // vault null + has a sane price → hasNoStats=false → not GH#1427 zombie.
    // The API does NOT mark this as zombie either — it's a fresh/indexing market.
    // isPhantomOI applies (suppresses OI) but last_price passes isActiveMarket.
    expect(
      isMarketActive({
        vault_balance: null,
        last_price: 50,
        volume_24h: null,
        total_open_interest: null,
        total_accounts: 0,
      }),
    ).toBe(true);
  });

  // --- Active markets should still pass ---

  it("healthy market (vault > 1M, price, volume) is active", () => {
    expect(
      isMarketActive({
        vault_balance: 5_000_000_000,
        last_price: 148,
        volume_24h: 2_000_000,
        total_open_interest: 50_000_000_000,
        total_accounts: 10,
      }),
    ).toBe(true);
  });

  it("creation-deposit market (vault=1M exactly, has price) is active", () => {
    expect(
      isMarketActive({
        vault_balance: 1_000_000,
        last_price: 150,
        total_accounts: 0,
      }),
    ).toBe(true);
  });

  it("fresh market (vault=null, has price and accounts) is active", () => {
    // vault null but HAS a real last_price + accounts → still indexing → keep
    expect(
      isMarketActive({
        vault_balance: null,
        last_price: 100,
        total_accounts: 3,
      }),
    ).toBe(true);
  });

  it("phantom-OI only market (vault<1M, has price) is active with suppressed OI", () => {
    // vault=1 (dust but not 0) with a real price — isPhantom suppresses OI but price passes
    expect(
      isMarketActive({
        vault_balance: 1,
        last_price: 100,
        total_open_interest: 9_000_000_000_000, // phantom OI — suppressed
        total_accounts: 0,
      }),
    ).toBe(true);
  });

  // --- Bulk count simulation (core of GH#1445) ---

  it("bulk: zombie markets do not inflate count vs API", () => {
    const markets: Stats[] = [
      // Active (5)
      { vault_balance: 5_000_000_000, last_price: 100, volume_24h: 1_000_000, total_accounts: 10 },
      { vault_balance: 5_000_000_000, last_price: 50, volume_24h: 500_000, total_accounts: 5 },
      { vault_balance: 1_000_000, last_price: 30, total_accounts: 0 },
      { vault_balance: 2_000_000, volume_24h: 100_000, total_accounts: 1 },
      { vault_balance: null, last_price: 10, total_accounts: 2 }, // fresh indexing

      // Zombie vault=0 with stale prices (previously leaked through)
      { vault_balance: 0, last_price: 148, total_accounts: 0 },    // GH#1445 case
      { vault_balance: 0, volume_24h: 5_000_000, total_accounts: 0 },
      { vault_balance: 0, last_price: null, total_accounts: 0 },

      // Phantom (vault=null, no stats) — GH#1427 zombies
      // Note: vault=null + last_price=50 + accounts=0 is NOT a zombie (hasNoStats=false → price is sane)
      // Those come through as active (they are indexing). True GH#1427 zombies = all stats null.
      { vault_balance: null, last_price: null, volume_24h: null, total_open_interest: null, total_accounts: 0 },
      { vault_balance: null, last_price: null, volume_24h: null, total_open_interest: null, total_accounts: 0 },
    ];

    const activeCount = markets.filter(isMarketActive).length;
    expect(activeCount).toBe(5); // exactly the 5 real active markets
  });

  it("isSaneMarketValue rejects null, 0, negative, sentinel (1e19)", () => {
    expect(isSaneMarketValue(null)).toBe(false);
    expect(isSaneMarketValue(0)).toBe(false);
    expect(isSaneMarketValue(-1)).toBe(false);
    expect(isSaneMarketValue(1e19)).toBe(false);
    expect(isSaneMarketValue(100)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GH#1455: activeTotal must be zombie-independent (same with or without include_zombie)
// ---------------------------------------------------------------------------

describe("GH#1455 — activeTotal is independent of include_zombie flag", () => {
  function isSaneVal(v: number | null | undefined): boolean {
    if (v == null) return false;
    return v > 0 && v < 1e18 && Number.isFinite(v);
  }

  type MarketRow = {
    slab_address: string;
    is_zombie: boolean;
    last_price?: number | null;
    volume_24h?: number | null;
    total_open_interest?: number | null;
    open_interest_long?: number | null;
    open_interest_short?: number | null;
  };

  function computeActiveTotal(sanitized: MarketRow[]): number {
    // Fixed: always use non-zombie subset only
    const nonZombieOnly = sanitized.filter((m) => !m.is_zombie);
    return nonZombieOnly.filter((m) => isActiveMarket(m)).length;
  }

  it("returns same activeTotal regardless of include_zombie flag", () => {
    const sanitized: MarketRow[] = [
      // 2 active non-zombie markets
      { slab_address: "A1", is_zombie: false, last_price: 150, volume_24h: 1_000_000 },
      { slab_address: "A2", is_zombie: false, last_price: 50, volume_24h: 500_000 },
      // 2 zombie markets with stale volume that would pass isActiveMarket
      { slab_address: "Z1", is_zombie: true, last_price: null, volume_24h: 800_000_000 },
      { slab_address: "Z2", is_zombie: true, last_price: null, volume_24h: 500_000_000 },
    ];

    // activeTotal should be 2 regardless of include_zombie
    expect(computeActiveTotal(sanitized)).toBe(2);
    // Verify zombies WOULD have inflated the count if we used nonZombie (the bug)
    // When include_zombie=true, nonZombie = sanitized (all 4 markets)
    const buggyCount = sanitized.filter((m) => isActiveMarket(m)).length;
    expect(buggyCount).toBe(4); // demonstrates the inflation
  });

  it("activeTotal === 69 even when include_zombie returns 71 total non-zombie (simulated production)", () => {
    // Simulate the production scenario: 69 active non-zombies, 2 zombie with stale volume
    const actives: MarketRow[] = Array.from({ length: 69 }, (_, i) => ({
      slab_address: `active-${i}`,
      is_zombie: false,
      last_price: 100 + i,
      volume_24h: 1_000_000,
    }));
    const staleZombies: MarketRow[] = [
      { slab_address: "zombie-btc", is_zombie: true, last_price: null, volume_24h: 500_000_000 },
      { slab_address: "zombie-sol", is_zombie: true, last_price: null, volume_24h: 300_000_000 },
    ];
    const sanitized = [...actives, ...staleZombies];

    // Fixed behavior: activeTotal = 69 (zombie-independent)
    expect(computeActiveTotal(sanitized)).toBe(69);
  });
});
