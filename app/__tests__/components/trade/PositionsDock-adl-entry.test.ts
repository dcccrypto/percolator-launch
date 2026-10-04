/**
 * On a deleveraged (ADL) position with no cached entry, the dock back-solves the
 * derived entry from on-chain pnl (`diff = pnl / size`). That back-solve MUST use
 * the SAME size the PnL is computed over — the ADL-adjusted `effectiveSize`. Using
 * raw `account.positionSize` made the dock understate PnL by the ADL factor (up to
 * 10x) versus ChartPnlBadge / usePortfolio, which already back-solve over effective
 * size — so the same position read, e.g., +$17 in the dock while +$104 elsewhere.
 *
 * Source-binding (same rationale as LiveMarketRail-header / PositionsDock-sticky):
 * rendering the dock needs ~20 hook/provider mocks just to assert this argument.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../../../components/trade/PositionsDock.tsx"),
  "utf8",
);

describe("PositionsDock derived-entry back-solve size", () => {
  it("back-solves the derived entry over effectiveSize, not raw positionSize", () => {
    expect(SRC).toMatch(/resolveEntryPrice\(\s*effectiveSize,/);
    expect(SRC).not.toMatch(/resolveEntryPrice\(\s*account\.positionSize,/);
  });
});
