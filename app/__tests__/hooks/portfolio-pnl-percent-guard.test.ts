// @vitest-environment node
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
  // The pinned @percolatorct/sdk 8.0.0 (391be368 / 45abff9a) no longer throws on
  // overflow: computePnlPercent clamps to ±MAX_SAFE_INTEGER/100. The original
  // hazard (a throw dropping the position) is therefore gone at the source; the
  // usePortfolio try/catch stays as defence in depth. These two cases used to
  // assert the SDK-7 throw and the guard's 0 fallback for it.
  it("computePnlPercent clamps on dust-margin + large PnL instead of throwing (SDK 8)", () => {
    expect(() => computePnlPercent(10n ** 30n, 1n)).not.toThrow();
    expect(computePnlPercent(10n ** 30n, 1n)).toBe(Number.MAX_SAFE_INTEGER / 100);
    expect(computePnlPercent(-(10n ** 30n), 1n)).toBe(-(Number.MAX_SAFE_INTEGER / 100));
  });

  it("the guarded call yields a finite number for the outlier (so the position isn't dropped)", () => {
    const pct = guarded(10n ** 30n, 1n);
    expect(Number.isFinite(pct)).toBe(true);
    expect(pct).toBe(Number.MAX_SAFE_INTEGER / 100);
    expect(guarded(10n ** 30n, 0n)).toBe(0);
  });

  it("legitimate values still compute a finite percent", () => {
    const pct = guarded(50_000_000n, 100_000_000n); // +50 on 100 margin
    expect(Number.isFinite(pct)).toBe(true);
    expect(pct).toBeGreaterThan(0);
  });
});
