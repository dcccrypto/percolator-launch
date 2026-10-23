/**
 * #3143: the fee card on /analytics named the fee shares "Protocol / Creator / LP / Insurance" and the
 * create flow's fee split "Creator / LP vault / Insurance", while the fee breakdown (lib/fee-breakdown
 * FEE_LEGS) says "Earn deposits / Market creator / Insurance fund". "LP" is also a banned term in
 * user-visible copy. Both now take the names from FEE_LEGS.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FEE_LEGS, legLabel } from "@/lib/fee-breakdown";

const slab = vi.hoisted(() => ({
  state: {
    wrapperConfigV17: {
      collateralMint: null,
      tradeFeeBps: 10n,
      creatorShareBps: 1_600,
      lpShareBps: 4_800,
      insuranceShareBps: 1_600,
      protocolFeeAccruedAtoms: 1_000_000n,
      creatorFeeClaimableAtoms: 2_000_000n,
      lpFeeAccruedAtoms: 3_000_000n,
      insuranceReserveAccruedAtoms: 4_000_000n,
    },
    assetProfile: null,
  },
}));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => slab.state }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ decimals: 6 }) }));

import { FeeDistributionCard } from "@/components/market/FeeDistributionCard";
import { FeeSplitControl } from "@/components/create/FeeSplitControl";

afterEach(cleanup);

describe("#3143: fee shares have one name everywhere", () => {
  it("legLabel returns the FEE_LEGS names", () => {
    expect(FEE_LEGS.map((l) => legLabel(l.id))).toEqual(["Earn deposits", "Protocol", "Market creator", "Insurance fund"]);
  });

  it("the /analytics fee card uses them, and never says LP", () => {
    const { container } = render(<FeeDistributionCard />);
    for (const name of ["Earn deposits", "Protocol", "Market creator", "Insurance fund"]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    expect(container.textContent).not.toMatch(/\bLP\b/);
  });

  it("the fee split control uses them, and never says LP", () => {
    const { container } = render(
      <FeeSplitControl value={{ creatorShareBps: 1_600, lpShareBps: 4_800, insuranceShareBps: 1_600 }} onChange={() => {}} />,
    );
    for (const name of ["Earn deposits", "Market creator", "Insurance fund"]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    expect(container.textContent).not.toMatch(/\bLP\b/);
  });
});
