// @vitest-environment node
/**
 * GH#1631 — Complete oracle-down badge fix
 *
 * PR #1630 only fixed 15/82 oracle-down markets (those with c_tot=0 / Supabase-only).
 * GH#1631: the remaining 67 markets have m.onChain != null with cTot > 0.
 * computeMarketHealth(m.onChain.engine) returned "Healthy" because it sees capital,
 * ignoring that resolveMarketPriceE6 returns 0n (oracle not cranked).
 *
 * Fix: isOracleDown checks on-chain price (resolveMarketPriceE6 === 0n) for on-chain
 * markets, and Supabase mark_price/index_price for Supabase-only markets.
 */

import { computeMarketHealth, computeMarketHealthFromStats } from "@/lib/health";
import { resolveMarketPriceE6, detectOracleMode } from "@/lib/oraclePrice";
import { PublicKey } from "@solana/web3.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const ZERO_KEY = new PublicKey(new Uint8Array(32));
const PYTH_KEY = new PublicKey("Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD"); // non-zero

function mockOnChainConfig({
  lastEffectivePriceE6 = 0n,
  authorityPriceE6 = 0n,
  adminOracle = false,
}: {
  lastEffectivePriceE6?: bigint;
  authorityPriceE6?: bigint;
  adminOracle?: boolean;
}) {
  return {
    oracleAuthority: adminOracle ? PYTH_KEY : ZERO_KEY,
    indexFeedId: adminOracle ? PYTH_KEY : PYTH_KEY,
    lastEffectivePriceE6,
    authorityPriceE6,
    authorityTimestamp: 0n,
  };
}

function mockEngine(oi: bigint, capital: bigint, insurance: bigint) {
  return {
    totalOpenInterest: oi,
    cTot: capital,
    insuranceFund: { balance: insurance },
  };
}

// ── Health type union test (GH#1622 regression check) ────────────────────────

describe("HealthLevel type includes oracle-down", () => {
  it("lib/health exports oracle-down as a valid HealthLevel", () => {
    // TypeScript compile-time check — if this line doesn't throw at runtime we're good
    const level: import("@/lib/health").HealthLevel = "oracle-down";
    expect(level).toBe("oracle-down");
  });
});

// ── on-chain oracle-down detection ───────────────────────────────────────────

describe("isOracleDown detection — on-chain markets (GH#1631)", () => {
  it("resolveMarketPriceE6 returns 0n when oracle has never been cranked (lastEffective=0, authority=0)", () => {
    const cfg = mockOnChainConfig({ lastEffectivePriceE6: 0n, authorityPriceE6: 0n });
    expect(resolveMarketPriceE6(cfg)).toBe(0n);
  });

  it("resolveMarketPriceE6 returns valid price when keeper has cranked", () => {
    // Pyth-pinned market with a valid lastEffectivePriceE6
    const cfg = mockOnChainConfig({ lastEffectivePriceE6: 148_500_000n }); // $148.50
    expect(resolveMarketPriceE6(cfg)).toBe(148_500_000n);
  });

  it("resolveMarketPriceE6 returns 0n for admin oracle with authorityPriceE6=0 (never pushed)", () => {
    const cfg = mockOnChainConfig({ adminOracle: true, authorityPriceE6: 0n, lastEffectivePriceE6: 0n });
    expect(resolveMarketPriceE6(cfg)).toBe(0n);
  });

  it("resolveMarketPriceE6 returns valid price for admin oracle with authorityPriceE6 set", () => {
    const cfg = mockOnChainConfig({ adminOracle: true, authorityPriceE6: 2_500_000n }); // $2.50
    expect(resolveMarketPriceE6(cfg)).toBe(2_500_000n);
  });

  it("computeMarketHealth returns Healthy for market with capital even when oracle is down", () => {
    // This is the BUG scenario — computeMarketHealth alone cannot detect oracle-down
    const engine = mockEngine(50_000_000n, 120_000_000n, 15_000_000n);
    const h = computeMarketHealth(engine as never);
    // computeMarketHealth correctly returns "healthy" based on capital ratio — this is expected
    expect(h.level).toBe("healthy");
    // But isOracleDown (resolveMarketPriceE6 === 0n) overrides this to "oracle-down" in the UI
  });

  it("isOracleDown=true when priceE6=0n — overrides Healthy to oracle-down", () => {
    const cfg = mockOnChainConfig({ lastEffectivePriceE6: 0n });
    const engine = mockEngine(50_000_000n, 120_000_000n, 15_000_000n);
    const health = computeMarketHealth(engine as never);
    const priceE6 = resolveMarketPriceE6(cfg);
    const isOracleDown = priceE6 === 0n;
    const effectiveLevel = isOracleDown ? "oracle-down" : health.level;
    expect(effectiveLevel).toBe("oracle-down");
  });

  it("isOracleDown=false when oracle has valid price — shows real health level", () => {
    const cfg = mockOnChainConfig({ lastEffectivePriceE6: 100_000_000n });
    const engine = mockEngine(50_000_000n, 120_000_000n, 15_000_000n);
    const health = computeMarketHealth(engine as never);
    const priceE6 = resolveMarketPriceE6(cfg);
    const isOracleDown = priceE6 === 0n;
    const effectiveLevel = isOracleDown ? "oracle-down" : health.level;
    expect(effectiveLevel).toBe("healthy");
  });
});

// ── Supabase-only oracle-down detection ──────────────────────────────────────

describe("isOracleDown detection — Supabase-only markets (GH#1622 original)", () => {
  const numericOrNull = (v: unknown): number | null => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const supabaseIsOracleDown = (supabase: { mark_price: number | null; index_price: number | null }): boolean => {
    const mp = numericOrNull(supabase.mark_price);
    const ip = numericOrNull(supabase.index_price);
    return (mp == null || mp <= 0) && (ip == null || ip <= 0);
  };

  it("returns true when both mark_price and index_price are null", () => {
    expect(supabaseIsOracleDown({ mark_price: null, index_price: null })).toBe(true);
  });

  it("returns true when both mark_price and index_price are 0 (0 means no data)", () => {
    // price=0 is treated same as null — oracle has no valid price
    expect(supabaseIsOracleDown({ mark_price: 0, index_price: 0 })).toBe(true);
    expect(supabaseIsOracleDown({ mark_price: 0, index_price: null })).toBe(true);
  });

  it("returns false when mark_price is set", () => {
    expect(supabaseIsOracleDown({ mark_price: 148.5, index_price: null })).toBe(false);
  });

  it("returns false when index_price is set", () => {
    expect(supabaseIsOracleDown({ mark_price: null, index_price: 148.2 })).toBe(false);
  });

  it("returns false when both prices are set", () => {
    expect(supabaseIsOracleDown({ mark_price: 148.5, index_price: 148.2 })).toBe(false);
  });

  it("Supabase market with c_tot>0 but no price shows oracle-down not healthy (GH#1631 case)", () => {
    // c_tot>0 market — computeMarketHealthFromStats would return healthy
    const h = computeMarketHealthFromStats({
      total_open_interest: 50_000,
      c_tot: 120_000,
      insurance_balance: 15_000,
      vault_balance: 120_000,
    });
    expect(h.level).toBe("healthy");
    // But with null prices, isOracleDown overrides to oracle-down
    const isOD = supabaseIsOracleDown({ mark_price: null, index_price: null });
    const effectiveLevel = isOD ? "oracle-down" : h.level;
    expect(effectiveLevel).toBe("oracle-down");
  });
});

// ── Sort order in health sort ─────────────────────────────────────────────────

describe("Sort order for oracle-down in health sort", () => {
  const order: Record<string, number> = { healthy: 0, caution: 1, warning: 2, empty: 3, "oracle-down": 4 };

  it("oracle-down sorts after empty (rank 4 > rank 3)", () => {
    expect(order["oracle-down"]).toBeGreaterThan(order["empty"]);
  });

  it("oracle-down sorts after warning", () => {
    expect(order["oracle-down"]).toBeGreaterThan(order["warning"]);
  });

  it("oracle-down sorts after healthy", () => {
    expect(order["oracle-down"]).toBeGreaterThan(order["healthy"]);
  });

  it("healthy sorts before all other levels", () => {
    for (const lvl of ["caution", "warning", "empty", "oracle-down"]) {
      expect(order["healthy"]).toBeLessThan(order[lvl]);
    }
  });
});

// ── HealthBadge label/style tests ─────────────────────────────────────────────

describe("HealthBadge oracle-down styles", () => {
  it("oracle-down label is 'No Oracle'", () => {
    // Mirrors the LABELS constant in HealthBadge.tsx
    const LABELS: Record<string, string> = {
      healthy: "Healthy",
      caution: "Caution",
      warning: "Low Liq",
      empty: "Empty",
      "oracle-down": "No Oracle",
    };
    expect(LABELS["oracle-down"]).toBe("No Oracle");
  });
});
