/**
 * #2692 (indexer#207) rebased: the Earned row on the Earn position card. Exact figures are
 * signed; with no indexed basis the row is not shown at all, and while the basis catches up
 * it is a calm "—" — never protocol wording on the card.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LpPositionDashboard } from "@/components/earn/LpPositionDashboard";
import type { LpEarned } from "@/lib/lp-earned";

const base = {
  userLpBalance: 1_000_000_000n,
  lpSupply: 2_000_000_000n,
  vaultBalance: 2_200_000_000n,
  decimals: 6,
  collateralSymbol: "USDC",
  redemptionRateE6: 1_100_000n,
  loading: false,
};

const renderWith = (earned?: LpEarned) => render(<LpPositionDashboard {...base} earned={earned} />);

describe("LpPositionDashboard Earned row", () => {
  it("shows a signed exact gain", () => {
    renderWith({ kind: "exact", earnedAtoms: 12_500_000n, unrealizedAtoms: 12_500_000n, realizedAtoms: 0n, costBasisAtoms: 1_087_500_000n });
    expect(screen.getByTestId("lp-earned").textContent).toContain("+12.50 USDC");
  });

  it("shows a loss with a minus sign", () => {
    renderWith({ kind: "exact", earnedAtoms: -3_000_000n, unrealizedAtoms: -3_000_000n, realizedAtoms: 0n, costBasisAtoms: 1_103_000_000n });
    expect(screen.getByTestId("lp-earned").textContent).toContain("−3.00 USDC");
  });

  it("hides the row when there is no indexed basis (indexer not serving this wallet)", () => {
    renderWith({ kind: "unavailable", reason: "no-data" });
    expect(screen.queryByTestId("lp-earned")).toBeNull();
  });

  it("reads a calm dash while the basis catches up, with no protocol wording", () => {
    renderWith({ kind: "unavailable", reason: "out-of-sync" });
    const row = screen.getByTestId("lp-earned");
    expect(row.textContent).toBe("Earned—");
    expect(row.textContent).not.toMatch(/index|vault|cost/i);
  });

  it("transferred-in shares: dash only, reason on hover", () => {
    renderWith({ kind: "unavailable", reason: "basis-unknown" });
    const row = screen.getByTestId("lp-earned");
    expect(row.textContent).toBe("Earned—");
    expect(row.textContent).not.toMatch(/LP moved outside the vault/);
  });
});
