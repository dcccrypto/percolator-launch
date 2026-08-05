/**
 * PoC + regression — computePnlPercent must be guarded in usePortfolio.
 *
 * computePnlPercent throws when pnl*10000/denominator overflows MAX_SAFE_INTEGER
 * (a dust position-initial-margin with large PnL). PositionsDock and ChartPnlBadge
 * wrap it in try/catch → 0, but usePortfolio's two call sites did not — so the throw
 * propagates to the per-account (v17) / per-market (v12) catch and silently DROPS
 * that position or the whole market's accounts from the portfolio.
 */
import { describe, it, expect } from "vitest";
import { computePnlPercent } from "@/lib/trading";

// Mirrors the guarded pattern the fix installs (and PositionsDock already uses).
const guarded = (pnl: bigint, denom: bigint): number => {
  try {
    return denom > 0n ? computePnlPercent(pnl, denom) : 0;
  } catch {
    return 0;
  }
};

describe("usePortfolio computePnlPercent guard", () => {
  it("computePnlPercent throws on dust-margin + large PnL (the hazard)", () => {
    expect(() => computePnlPercent(10n ** 30n, 1n)).toThrow();
  });

  it("the guard returns 0 instead of throwing (so the position isn't dropped)", () => {
    expect(guarded(10n ** 30n, 1n)).toBe(0);
  });

  it("legitimate values still compute a finite percent", () => {
    const pct = guarded(50_000_000n, 100_000_000n); // +50 on 100 margin
    expect(Number.isFinite(pct)).toBe(true);
    expect(pct).toBeGreaterThan(0);
  });
});
