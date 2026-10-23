/**
 * The Earn position card's "Shares" figure was divided by the LP mint's own decimals, which are 0
 * on chain (percolator-prog#542 interim), so it showed the raw count: 1,000,000x what the deposit
 * preview, the withdraw form and the vault's "Earn shares" stat show. Shares are counted in
 * collateral-atom units, and the app shows them in the collateral's decimals (lib/lp-share-wallet-note.ts).
 * Figures are devnet market HBU9iug…'s: LP mint supply 1,999,999,000 raw, decimals 0.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LpPositionDashboard } from "@/components/earn/LpPositionDashboard";

describe("LpPositionDashboard Shares", () => {
  it("counts shares in the collateral's decimals, not the raw count", () => {
    render(
      <LpPositionDashboard
        userLpBalance={1_999_999_000n}
        lpSupply={1_999_999_000n}
        vaultBalance={2_000_530_692n}
        decimals={6}
        collateralSymbol="USDC"
        redemptionRateE6={1_000_265n}
        loading={false}
      />,
    );
    expect(screen.getByText("1,999.99")).toBeInTheDocument();
    expect(screen.queryByText("1,999,999,000.00")).toBeNull();
    // The cell beside it: ~1.0003 USDC per share, so shares x price ~ the position's value.
    expect(screen.getByText("1.0003 USDC")).toBeInTheDocument();
  });
});
