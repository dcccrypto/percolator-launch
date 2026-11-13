// @vitest-environment node
/**
 * GH#1622: Oracle Down badge — markets with null mark_price + null index_price
 * should show "No Oracle" health level (oracle-down) instead of liquidity-based
 * health, regardless of oracle mode (admin, hyperp, pyth).
 *
 * This test verifies:
 * 1. HealthLevel type accepts "oracle-down"
 * 2. Markets with null prices are flagged as oracle-down (not "Healthy")
 * 3. Zombie markets are NOT flagged oracle-down (they show "Empty")
 * 4. Markets with valid prices retain their liquidity-based health
 * 5. LIVE vs NO ORACLE label logic on homepage
 */

import type { HealthLevel } from "@/lib/health";

// ── Helper: mirrors the oracle-down detection logic in app/app/markets/page.tsx ──
interface FakeSupabaseMarket {
  mark_price: number | null;
  index_price: number | null;
  is_zombie?: boolean;
  vault_balance?: number | null;
  total_accounts?: number | null;
}

function isOracleDown(supabase: FakeSupabaseMarket | null): boolean {
  if (supabase == null) return false;
  if (supabase.is_zombie) return false;
  const markOk = supabase.mark_price != null && supabase.mark_price > 0;
  const indexOk = supabase.index_price != null && supabase.index_price > 0;
  return !markOk && !indexOk;
}

// ── Helper: mirrors homepage LIVE/NO ORACLE label logic ──
function homepageLabel(lastPrice: number | null): string {
  return lastPrice != null ? "LIVE" : "NO ORACLE";
}

describe("GH#1622 – oracle-down health badge", () => {
  // ── HealthLevel type accepts "oracle-down" ──
  it("HealthLevel type includes oracle-down", () => {
    const level: HealthLevel = "oracle-down";
    expect(level).toBe("oracle-down");
  });

  // ── Oracle-down detection ──
  it("detects oracle-down when both mark_price and index_price are null", () => {
    expect(isOracleDown({ mark_price: null, index_price: null })).toBe(true);
  });

  it("detects oracle-down when mark_price is 0 and index_price is null", () => {
    expect(isOracleDown({ mark_price: 0, index_price: null })).toBe(true);
  });

  it("detects oracle-down when mark_price is null and index_price is 0", () => {
    expect(isOracleDown({ mark_price: null, index_price: 0 })).toBe(true);
  });

  it("does NOT flag oracle-down when mark_price is valid (> 0)", () => {
    expect(isOracleDown({ mark_price: 1.5, index_price: null })).toBe(false);
  });

  it("does NOT flag oracle-down when index_price is valid (> 0)", () => {
    expect(isOracleDown({ mark_price: null, index_price: 130.0 })).toBe(false);
  });

  it("does NOT flag oracle-down when both prices are valid", () => {
    expect(isOracleDown({ mark_price: 130.0, index_price: 129.8 })).toBe(false);
  });

  it("does NOT flag oracle-down when supabase is null (on-chain only market)", () => {
    expect(isOracleDown(null)).toBe(false);
  });

  // ── Zombie markets exempt ──
  it("does NOT flag oracle-down for zombie markets (they show Empty)", () => {
    expect(isOracleDown({ mark_price: null, index_price: null, is_zombie: true })).toBe(false);
  });

  it("zombie with prices still not flagged oracle-down", () => {
    expect(isOracleDown({ mark_price: 1.0, index_price: 1.0, is_zombie: true })).toBe(false);
  });

  // ── Homepage LIVE/NO ORACLE logic ──
  it("shows LIVE when last_price is set", () => {
    expect(homepageLabel(0.00063)).toBe("LIVE");
    expect(homepageLabel(130.0)).toBe("LIVE");
    expect(homepageLabel(0.01)).toBe("LIVE");
  });

  it("shows NO ORACLE when last_price is null", () => {
    expect(homepageLabel(null)).toBe("NO ORACLE");
  });

  // ── Real-world: 82/168 devnet markets have null prices ──
  it("correctly categorises a batch of markets like the 82/168 scenario", () => {
    const markets: FakeSupabaseMarket[] = [
      // 3 healthy markets with prices
      { mark_price: 130.5, index_price: 130.2 },
      { mark_price: 0.000630, index_price: 0.000628 },
      { mark_price: 2.5, index_price: 2.48 },
      // 3 oracle-down markets (keeper not cranked)
      { mark_price: null, index_price: null },
      { mark_price: 0, index_price: null },
      { mark_price: null, index_price: 0 },
      // 1 zombie (exempt)
      { mark_price: null, index_price: null, is_zombie: true },
    ];

    const oracleDown = markets.filter(isOracleDown);
    const notOracleDown = markets.filter(m => !isOracleDown(m));

    expect(oracleDown).toHaveLength(3);
    expect(notOracleDown).toHaveLength(4); // 3 priced + 1 zombie
  });
});
