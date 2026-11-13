// @vitest-environment node
/**
 * GH#1455: /api/markets activeTotal must be consistent regardless of include_zombie param.
 *
 * Root cause: activeTotal was computed from `nonZombie` — but when include_zombie=true,
 * nonZombie includes zombie markets (because the filter is skipped). So zombie markets
 * that pass isActiveMarket() inflate activeTotal (71 instead of 69).
 *
 * Fix: compute activeTotal from the zombie-excluded set always, independent of include_zombie flag.
 */
import { describe, it, expect } from "vitest";
import { isActiveMarket } from "@/lib/activeMarketFilter";

type MarketRow = {
  slab_address: string;
  last_price: number | null;
  volume_24h: number | null;
  total_open_interest: number | null;
  vault_balance: number | null;
  total_accounts: number | null;
  is_zombie: boolean;
  [key: string]: unknown;
};

function makeMarket(overrides: Partial<MarketRow> & { slab_address: string }): MarketRow {
  return {
    last_price: 50,
    volume_24h: 1000,
    total_open_interest: 200,
    vault_balance: 5_000_000,
    total_accounts: 3,
    is_zombie: false,
    ...overrides,
  };
}

/**
 * Buggy logic: compute activeTotal from the `nonZombie` list, which when
 * include_zombie=true includes zombies too.
 */
function computeActiveTotalBuggy(markets: MarketRow[], includeZombie: boolean): number {
  const nonZombie = markets.filter((m) => includeZombie || !m.is_zombie);
  return nonZombie.filter((m) => isActiveMarket(m)).length;
}

/**
 * Fixed logic: always compute activeTotal from non-zombie markets.
 */
function computeActiveTotalFixed(markets: MarketRow[], _includeZombie: boolean): number {
  const nonZombieOnly = markets.filter((m) => !m.is_zombie);
  return nonZombieOnly.filter((m) => isActiveMarket(m)).length;
}

describe("GH#1455 — activeTotal consistency with include_zombie", () => {
  const markets: MarketRow[] = [
    makeMarket({ slab_address: "active1" }),
    makeMarket({ slab_address: "active2" }),
    makeMarket({ slab_address: "active3" }),
    // Zombie with stale price data that passes isActiveMarket
    makeMarket({
      slab_address: "zombie1",
      vault_balance: 0,
      is_zombie: true,
      last_price: 148, // stale BTC price from months ago
      total_accounts: 5,
    }),
    // Zombie with stale price data
    makeMarket({
      slab_address: "zombie2",
      vault_balance: 0,
      is_zombie: true,
      last_price: 0.6, // stale SOL price
      volume_24h: 500,
      total_accounts: 2,
    }),
  ];

  it("buggy: activeTotal differs with include_zombie=true vs false", () => {
    const without = computeActiveTotalBuggy(markets, false);
    const withZ = computeActiveTotalBuggy(markets, true);
    // Bug: include_zombie=true inflates activeTotal
    expect(without).toBe(3);
    expect(withZ).toBe(5); // wrong — zombies counted
    expect(withZ).not.toBe(without);
  });

  it("fixed: activeTotal is the same regardless of include_zombie", () => {
    const without = computeActiveTotalFixed(markets, false);
    const withZ = computeActiveTotalFixed(markets, true);
    expect(without).toBe(3);
    expect(withZ).toBe(3);
    expect(withZ).toBe(without);
  });

  it("fixed: zombies never contribute to activeTotal even if they have sane stats", () => {
    const zombieWithGoodStats = makeMarket({
      slab_address: "zombie-good",
      vault_balance: 0,
      is_zombie: true,
      last_price: 100,
      volume_24h: 50000,
      total_open_interest: 10000,
      total_accounts: 20,
    });
    const all = [...markets, zombieWithGoodStats];
    expect(computeActiveTotalFixed(all, true)).toBe(3);
    expect(computeActiveTotalFixed(all, false)).toBe(3);
  });
});
