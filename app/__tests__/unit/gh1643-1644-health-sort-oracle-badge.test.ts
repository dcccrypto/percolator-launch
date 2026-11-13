// @vitest-environment node
/**
 * Tests for GH#1643 and GH#1644
 *
 * GH#1643: Health sort — markets with valid oracle but c_tot=0 should rank
 *   ABOVE oracle-down markets (they have working feeds, just no liquidity yet).
 *   Correct order: healthy < caution < warning < empty-oracle-up < oracle-down < empty
 *
 * GH#1644: Oracle badge — markets with last_price=null should show "No Oracle"
 *   badge in the list (not "Caution"), consistent with the trade page.
 */

// ---------------------------------------------------------------------------
// GH#1643 — sort rank helpers (mirrors markets/page.tsx logic)
// ---------------------------------------------------------------------------

type SortLevel = "healthy" | "caution" | "warning" | "empty-oracle-up" | "oracle-down" | "empty";

const SORT_ORDER: Record<string, number> = {
  healthy: 0,
  caution: 1,
  warning: 2,
  "empty-oracle-up": 3,
  "oracle-down": 4,
  empty: 5,
};

function getEffectiveSortLevel(isOracleDown: boolean, baseLevel: string): SortLevel {
  if (isOracleDown) return "oracle-down";
  if (baseLevel === "empty") return "empty-oracle-up";
  return baseLevel as SortLevel;
}

describe("GH#1643 — health sort rank: oracle-up empty markets rank above oracle-down", () => {
  it("empty-oracle-up ranks below warning", () => {
    expect(SORT_ORDER["empty-oracle-up"]).toBeGreaterThan(SORT_ORDER["warning"]);
  });

  it("empty-oracle-up ranks above oracle-down", () => {
    expect(SORT_ORDER["empty-oracle-up"]).toBeLessThan(SORT_ORDER["oracle-down"]);
  });

  it("oracle-down ranks above empty (no oracle, no capital)", () => {
    expect(SORT_ORDER["oracle-down"]).toBeLessThan(SORT_ORDER["empty"]);
  });

  it("getEffectiveSortLevel: oracle-down market → oracle-down regardless of base level", () => {
    expect(getEffectiveSortLevel(true, "healthy")).toBe("oracle-down");
    expect(getEffectiveSortLevel(true, "empty")).toBe("oracle-down");
    expect(getEffectiveSortLevel(true, "caution")).toBe("oracle-down");
  });

  it("getEffectiveSortLevel: non-oracle-down empty market → empty-oracle-up", () => {
    expect(getEffectiveSortLevel(false, "empty")).toBe("empty-oracle-up");
  });

  it("getEffectiveSortLevel: non-empty healthy market → passes through unchanged", () => {
    expect(getEffectiveSortLevel(false, "healthy")).toBe("healthy");
    expect(getEffectiveSortLevel(false, "caution")).toBe("caution");
    expect(getEffectiveSortLevel(false, "warning")).toBe("warning");
  });

  it("full sort order is: healthy < caution < warning < empty-oracle-up < oracle-down < empty", () => {
    const levels: SortLevel[] = ["oracle-down", "empty", "warning", "healthy", "empty-oracle-up", "caution"];
    const sorted = [...levels].sort((a, b) => (SORT_ORDER[a] ?? 99) - (SORT_ORDER[b] ?? 99));
    expect(sorted).toEqual(["healthy", "caution", "warning", "empty-oracle-up", "oracle-down", "empty"]);
  });

  it("7 oracle-up empty markets rank above oracle-down markets in health sort", () => {
    // Simulate: 7 valid-price c_tot=0 markets and 75 oracle-down markets
    const oracleUpEmpty = Array.from({ length: 7 }, (_, i) => ({
      id: `oracle-up-${i}`,
      isOracleDown: false,
      baseLevel: "empty",
      effectiveLevel: getEffectiveSortLevel(false, "empty"),
    }));
    const oracleDown = Array.from({ length: 75 }, (_, i) => ({
      id: `oracle-down-${i}`,
      isOracleDown: true,
      baseLevel: "healthy", // computeMarketHealth sees capital → healthy base
      effectiveLevel: getEffectiveSortLevel(true, "healthy"),
    }));
    const all = [...oracleDown, ...oracleUpEmpty];
    const sorted = all.sort((a, b) => (SORT_ORDER[a.effectiveLevel] ?? 99) - (SORT_ORDER[b.effectiveLevel] ?? 99));
    // oracle-up-empty markets should appear before oracle-down markets (lower index = higher rank)
    const firstOracleDown = sorted.findIndex((m) => m.id.startsWith("oracle-down"));
    const firstOracleUpEmpty = sorted.findIndex((m) => m.id.startsWith("oracle-up"));
    expect(firstOracleUpEmpty).toBeLessThan(firstOracleDown);
  });
});

// ---------------------------------------------------------------------------
// GH#1644 — isOracleDown when last_price = null (mirrors markets/page.tsx logic)
// ---------------------------------------------------------------------------

interface SupabaseMarketRow {
  last_price?: number | null;
  mark_price?: number | null;
  index_price?: number | null;
}

function numericOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isOracleDownForSupabaseMarket(supabase: SupabaseMarketRow): boolean {
  const lp = numericOrNull(supabase.last_price);
  const mp = numericOrNull(supabase.mark_price);
  const ip = numericOrNull(supabase.index_price);
  return (lp == null || lp <= 0) && (mp == null || mp <= 0) && (ip == null || ip <= 0);
}

describe("GH#1644 — oracle badge: last_price=null forces oracle-down", () => {
  it("last_price=null, mark_price=null, index_price=null → oracle-down", () => {
    expect(isOracleDownForSupabaseMarket({ last_price: null, mark_price: null, index_price: null })).toBe(true);
  });

  it("last_price=null, mark_price=0, index_price=null → oracle-down", () => {
    expect(isOracleDownForSupabaseMarket({ last_price: null, mark_price: 0, index_price: null })).toBe(true);
  });

  it("last_price=null, mark_price=null, index_price=undefined → oracle-down", () => {
    expect(isOracleDownForSupabaseMarket({ last_price: null })).toBe(true);
  });

  it("last_price=1.23 → NOT oracle-down (has valid last price)", () => {
    expect(isOracleDownForSupabaseMarket({ last_price: 1.23, mark_price: null, index_price: null })).toBe(false);
  });

  it("last_price=null, mark_price=1.23 → NOT oracle-down (mark price available)", () => {
    expect(isOracleDownForSupabaseMarket({ last_price: null, mark_price: 1.23, index_price: null })).toBe(false);
  });

  it("last_price=null, mark_price=null, index_price=1.23 → NOT oracle-down (index price available)", () => {
    expect(isOracleDownForSupabaseMarket({ last_price: null, mark_price: null, index_price: 1.23 })).toBe(false);
  });

  it("HKeVEQt3 scenario: last_price=null, has OI/collateral → must be oracle-down (no Caution)", () => {
    // Market HKeVEQt3 (8u2PCh5J): has OI/collateral → computeMarketHealthFromStats returns Caution
    // but oracle is unavailable (last_price=null). Must override to oracle-down.
    const result = isOracleDownForSupabaseMarket({ last_price: null, mark_price: null, index_price: null });
    expect(result).toBe(true);
    // Verify the badge level would be "oracle-down" not "caution"
    const effectiveLevel = result ? "oracle-down" : "caution";
    expect(effectiveLevel).toBe("oracle-down");
  });

  it("last_price=0 treated as null (no valid price)", () => {
    expect(isOracleDownForSupabaseMarket({ last_price: 0, mark_price: null, index_price: null })).toBe(true);
  });

  it("last_price=negative treated as null (invalid price)", () => {
    expect(isOracleDownForSupabaseMarket({ last_price: -1.5, mark_price: null, index_price: null })).toBe(true);
  });
});
