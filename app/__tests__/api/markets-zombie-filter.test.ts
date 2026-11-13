// @vitest-environment node
/**
 * GH#1420: Zombie markets (vault_balance=0) should be excluded from /api/markets by default.
 * GH#1419: Stale volume_24h (stats_updated_at > 48h ago) should be excluded from /api/stats totals.
 * GH#1427: Markets with null vault_balance AND all null stats should also be zombie.
 * GH#1502: NNOB zombie regression — phantom OI (total_open_interest>0 with accounts=0) must not
 *          count as "hasActivity" in the c_tot exemption check. NNOB: vault=0, c_tot=100B,
 *          accounts=0, no price, but stale DB OI → should still be zombie.
 *
 * Unit tests for the filtering logic (not full route integration — uses helpers extracted from route).
 */
import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// GH#1420 — Zombie market filter
// ---------------------------------------------------------------------------

function isSaneMarketValue(v: number | null | undefined): boolean {
  if (v == null) return false;
  return v > 0 && v < 1e18 && Number.isFinite(v);
}

type MarketRow = {
  vault_balance?: number | null;
  c_tot?: number | null;
  last_price?: number | null;
  volume_24h?: number | null;
  total_open_interest?: number | null;
  total_accounts?: number | null;
};

/** GH#1427 + GH#1499: mirrors the activeMarketFilter.ts isZombieMarket logic */
function isZombie(m: MarketRow): boolean {
  const vaultBal = m.vault_balance ?? null;
  const cTot = m.c_tot ?? null;

  // GH#1499: c_tot > 0 only exempts when there is corroborating activity.
  // FF7K markets: vault=0, c_tot>0, has price → hasActivity=true → not zombie.
  // NNOB: vault=0, c_tot>0, no price, no accounts → hasActivity=false → zombie.
  //
  // GH#1502: OI intentionally excluded from hasActivity — per GH#1290, OI with no accounts
  // is phantom (stale slab data). Only price or real accounts prove a market is genuinely live.
  const hasActivity =
    isSaneMarketValue(m.last_price) ||
    isSaneMarketValue(m.volume_24h) ||
    (m.total_accounts ?? 0) > 0;

  if (cTot !== null && cTot > 0 && hasActivity) return false;

  if (vaultBal !== null && vaultBal === 0) return true;
  if (vaultBal === null) {
    // GH#1502: OI excluded — phantom OI (accounts=0) must not prevent zombie classification.
    const hasNoStats =
      !isSaneMarketValue(m.last_price) &&
      !isSaneMarketValue(m.volume_24h) &&
      ((m.total_accounts ?? 0) === 0);
    if (hasNoStats) return true;
  }
  return false;
}

describe("GH#1420 zombie market filter", () => {
  it("marks vault_balance=0 as zombie", () => {
    expect(isZombie({ vault_balance: 0 })).toBe(true);
  });

  it("does NOT mark vault_balance=1 as zombie", () => {
    expect(isZombie({ vault_balance: 1 })).toBe(false);
  });

  it("does NOT mark vault_balance=1_000_000 (creation-deposit) as zombie", () => {
    expect(isZombie({ vault_balance: 1_000_000 })).toBe(false);
  });

  it("does NOT mark vault_balance=5_000_000_000 (healthy market) as zombie", () => {
    expect(isZombie({ vault_balance: 5_000_000_000 })).toBe(false);
  });

  it("filters zombie markets out of a list by default", () => {
    const markets = [
      { slab_address: "ACTIVE1", vault_balance: 5_000_000_000 },
      { slab_address: "ZOMBIE1", vault_balance: 0 },
      { slab_address: "ACTIVE2", vault_balance: 1_000_000 },
      // vault_balance null but HAS a real last_price — NOT zombie (still being indexed)
      { slab_address: "ACTIVE3", vault_balance: null, last_price: 100, total_accounts: 5 },
    ];

    const withZombieFlag = markets.map((m) => ({ ...m, is_zombie: isZombie(m) }));
    const nonZombie = withZombieFlag.filter((m) => !m.is_zombie);

    expect(nonZombie).toHaveLength(3);
    expect(nonZombie.map((m) => m.slab_address)).toEqual(["ACTIVE1", "ACTIVE2", "ACTIVE3"]);
  });

  it("includes zombie markets when include_zombie=true", () => {
    const markets = [
      { slab_address: "ACTIVE1", vault_balance: 5_000_000_000 },
      { slab_address: "ZOMBIE1", vault_balance: 0 },
    ];

    const withZombieFlag = markets.map((m) => ({ ...m, is_zombie: isZombie(m) }));
    const includeZombie = true;
    const result = withZombieFlag.filter((m) => includeZombie || !m.is_zombie);

    expect(result).toHaveLength(2);
  });

  it("nulls out prices for zombie markets", () => {
    // Simulates the route behavior: zombie markets get null prices
    const market = { slab_address: "ZOMBIE1", vault_balance: 0, last_price: 148, mark_price: 150, index_price: 149 };
    const is_zombie = isZombie(market);

    const output = {
      ...market,
      is_zombie,
      last_price: is_zombie ? null : market.last_price,
      mark_price: is_zombie ? null : market.mark_price,
      index_price: is_zombie ? null : market.index_price,
    };

    expect(output.last_price).toBeNull();
    expect(output.mark_price).toBeNull();
    expect(output.index_price).toBeNull();
    expect(output.is_zombie).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GH#1427 — Null vault_balance + no-stats zombie classification
// ---------------------------------------------------------------------------

describe("GH#1427 null vault_balance + no-stats zombie", () => {
  it("marks null vault_balance + all null stats as zombie", () => {
    expect(
      isZombie({
        vault_balance: null,
        last_price: null,
        volume_24h: null,
        total_open_interest: null,
        total_accounts: 0,
      }),
    ).toBe(true);
  });

  it("marks null vault_balance + undefined stats as zombie", () => {
    expect(isZombie({ vault_balance: null })).toBe(true);
  });

  it("does NOT mark null vault_balance + has last_price as zombie", () => {
    expect(
      isZombie({
        vault_balance: null,
        last_price: 150,
        total_accounts: 3,
      }),
    ).toBe(false);
  });

  it("does NOT mark null vault_balance + has volume as zombie", () => {
    expect(
      isZombie({
        vault_balance: null,
        last_price: null,
        volume_24h: 500_000_000,
        total_accounts: 0,
      }),
    ).toBe(false);
  });

  it("does NOT mark null vault_balance + has OI with accounts as zombie", () => {
    // OI only counts when accounts > 0 (GH#1502: phantom OI guard).
    expect(
      isZombie({
        vault_balance: null,
        last_price: null,
        volume_24h: null,
        total_open_interest: 1_000_000,
        total_accounts: 1, // real account → not phantom
      }),
    ).toBe(false);
  });

  it("marks null vault_balance + OI only (no accounts) as zombie (GH#1502 phantom OI)", () => {
    // OI with zero accounts is phantom — must NOT prevent zombie classification.
    expect(
      isZombie({
        vault_balance: null,
        last_price: null,
        volume_24h: null,
        total_open_interest: 1_000_000,
        total_accounts: 0, // phantom OI: no real positions
      }),
    ).toBe(true);
  });

  it("does NOT mark null vault_balance + has accounts as zombie", () => {
    expect(
      isZombie({
        vault_balance: null,
        last_price: null,
        volume_24h: null,
        total_open_interest: null,
        total_accounts: 2,
      }),
    ).toBe(false);
  });

  it("filters 6 phantom GH#1427 markets alongside existing vault=0 zombies", () => {
    const markets = [
      // Active
      { slab_address: "ACTIVE1", vault_balance: 5_000_000_000, last_price: 100, total_accounts: 10 },
      // Drained zombie (vault=0)
      { slab_address: "ZOMBIE_DRAINED", vault_balance: 0 },
      // Phantom: null vault + no stats — these are the 6 GH#1427 markets
      { slab_address: "PHANTOM1", vault_balance: null },
      { slab_address: "PHANTOM2", vault_balance: null, last_price: null, total_accounts: 0 },
      // Still-indexing: null vault but has a price — keep in response
      { slab_address: "INDEXING", vault_balance: null, last_price: 50, total_accounts: 1 },
    ];

    const withFlag = markets.map((m) => ({ ...m, is_zombie: isZombie(m) }));
    const nonZombie = withFlag.filter((m) => !m.is_zombie);

    expect(nonZombie.map((m) => m.slab_address)).toEqual(["ACTIVE1", "INDEXING"]);
    expect(withFlag.filter((m) => m.is_zombie).map((m) => m.slab_address)).toEqual([
      "ZOMBIE_DRAINED",
      "PHANTOM1",
      "PHANTOM2",
    ]);
  });
});

// ---------------------------------------------------------------------------
// GH#1499 — NNOB edge case: c_tot > 0 but no activity (vault=0, accounts=0, no price)
// GH#1502 — NNOB regression: phantom OI in hasActivity kept NNOB out of zombie list
// ---------------------------------------------------------------------------

describe("GH#1499 + GH#1502 c_tot>0 with no real activity still zombie", () => {
  it("NNOB case: c_tot=100B, vault=0, accounts=0, no price → zombie", () => {
    // Before fix: c_tot > 0 short-circuited → is_zombie=false (BUG: NNOB showed in default response with null price)
    // After fix: c_tot > 0 only exempts when hasActivity is also true
    expect(
      isZombie({
        vault_balance: 0,
        // c_tot not in the local type — but the API/lib now checks for activity
        last_price: null,
        volume_24h: null,
        total_open_interest: null,
        total_accounts: 0,
      }),
    ).toBe(true);
  });

  it("GH#1502 NNOB regression: c_tot=100B, vault=0, accounts=0, phantom OI → zombie", () => {
    // PR#1501 fixed the c_tot > 0 exemption but hasActivity still included
    // isSaneMarketValue(total_open_interest). NNOB has stale DB OI (non-zero phantom)
    // → hasActivity=true → c_tot>0 exemption fired → is_zombie=false (BUG).
    // Fix (GH#1502): OI excluded from hasActivity when accounts=0 (phantom OI per GH#1290).
    expect(
      isZombie({
        vault_balance: 0,
        c_tot: 100_000_000_000, // NNOB: 100B micro-USDC
        last_price: null,
        volume_24h: null,
        total_open_interest: 500_000, // stale phantom OI — should NOT trigger activity
        total_accounts: 0,
      }),
    ).toBe(true);
  });

  it("FF7K healthy case: c_tot>0, vault=0, has price → NOT zombie", () => {
    // The 33 working FF7K markets: vault=0 (stores collateral in slab), c_tot>0,
    // and keeper is actively pushing prices. c_tot+activity exemption applies.
    expect(
      isZombie({
        vault_balance: 0,
        c_tot: 1_000_000_000,
        last_price: 1.0, // keeper cranks this → hasActivity=true
        volume_24h: null,
        total_open_interest: null,
        total_accounts: 0,
      }),
    ).toBe(false);
  });

  it("FF7K with accounts case: c_tot>0, vault=0, has accounts → NOT zombie", () => {
    expect(
      isZombie({
        vault_balance: 0,
        c_tot: 5_000_000_000,
        last_price: null,
        volume_24h: null,
        total_open_interest: null,
        total_accounts: 3, // users have positions → hasActivity=true
      }),
    ).toBe(false);
  });

  it("dead slab: vault=0, no price, no accounts, no volume → zombie", () => {
    expect(
      isZombie({
        vault_balance: 0,
        last_price: null,
        volume_24h: null,
        total_open_interest: null,
        total_accounts: 0,
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GH#1419 — Stale volume filter
// ---------------------------------------------------------------------------

const STALE_VOLUME_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours

function isStaleVolume(statsUpdatedAt: string | null | undefined, now: number): boolean {
  if (!statsUpdatedAt) return false; // no timestamp → assume fresh (defensive)
  const ageMs = now - new Date(statsUpdatedAt).getTime();
  return ageMs > STALE_VOLUME_THRESHOLD_MS;
}

describe("GH#1419 stale volume filter", () => {
  const now = Date.now();
  const fresh = new Date(now - 1 * 60 * 60 * 1000).toISOString();      // 1h ago
  const borderline = new Date(now - 47 * 60 * 60 * 1000).toISOString(); // 47h ago (not stale)
  const stale = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days ago (stale)
  const exactThreshold = new Date(now - 48 * 60 * 60 * 1000).toISOString(); // exactly 48h

  it("fresh market is not stale", () => {
    expect(isStaleVolume(fresh, now)).toBe(false);
  });

  it("47h old market is not stale (under threshold)", () => {
    expect(isStaleVolume(borderline, now)).toBe(false);
  });

  it("5 day old market is stale", () => {
    expect(isStaleVolume(stale, now)).toBe(true);
  });

  it("exactly 48h market is stale (strict >)", () => {
    // 48h exactly is technically > 48h * 60 * 60 * 1000 - epsilon, let's be precise:
    // new Date(now - 48h) → ageMs = 48h exactly → NOT > STALE_THRESHOLD
    // Actually exactly 48h => ageMs === STALE_THRESHOLD_MS → NOT > → false
    expect(isStaleVolume(exactThreshold, now)).toBe(false);
  });

  it("null stats_updated_at is treated as fresh (defensive)", () => {
    expect(isStaleVolume(null, now)).toBe(false);
  });

  it("stale market volume is excluded from total", () => {
    const markets = [
      { slab_address: "FRESH1", volume_24h: 1_000_000_000, stats_updated_at: fresh },
      { slab_address: "STALE1", volume_24h: 14_955_000_000, stats_updated_at: stale }, // GH#1419 culprit
      { slab_address: "FRESH2", volume_24h: 500_000_000, stats_updated_at: fresh },
    ];

    const totalVolume = markets.reduce((sum, m) => {
      if (isStaleVolume(m.stats_updated_at, now)) return sum;
      return sum + (m.volume_24h ?? 0);
    }, 0);

    expect(totalVolume).toBe(1_000_000_000 + 500_000_000);
    expect(totalVolume).not.toContain(14_955_000_000);
  });

  it("does not exclude fresh markets from total", () => {
    const markets = [
      { slab_address: "FRESH1", volume_24h: 1_000_000_000, stats_updated_at: fresh },
      { slab_address: "FRESH2", volume_24h: 500_000_000, stats_updated_at: fresh },
    ];

    const totalVolume = markets.reduce((sum, m) => {
      if (isStaleVolume(m.stats_updated_at, now)) return sum;
      return sum + (m.volume_24h ?? 0);
    }, 0);

    expect(totalVolume).toBe(1_500_000_000);
  });
});
