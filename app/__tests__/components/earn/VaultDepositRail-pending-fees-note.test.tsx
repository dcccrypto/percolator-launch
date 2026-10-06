/**
 * Two-pot (non-bound) Earn vault: tag 75 prices a deposit on NAV + harvestable LP fees, tag 77
 * pays on NAV alone and doesn't harvest first. So a fresh deposit reads below what went in until
 * the fees are collected, and a withdrawal before that leaves them behind. The card says so.
 * A bound (P3) vault harvests before 77 (earn-ixs earnTxPlan), so it gets no note.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ splitPot: null as unknown }));

vi.mock("@/components/providers/SlabProvider", () => ({
  SlabProvider: ({ children }: { children: React.ReactNode }) => children,
  useSlabState: () => ({ config: null, raw: null }),
}));
vi.mock("@/hooks/useInsuranceLP", () => ({
  useInsuranceLP: () => ({
    state: {
      registryExists: true, mintExists: true, vaultTotalAtoms: 0n, userVaultValueAtoms: 0n, userLpBalance: 0n,
      pendingRedemptionShares: 0n, redemptionCooldownSlots: 0n, userSharePct: 0, backingNavAtoms: 0n, splitPot: h.splitPot,
    },
    loading: false, readError: false, deposit: vi.fn(), withdraw: vi.fn(), resizeRedemption: vi.fn(), refreshState: vi.fn(), lastDrawSummary: null,
  }),
}));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => null }));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ publicKey: null }) }));
vi.mock("@/hooks/useMarketLimits", () => ({ useMarketLimits: () => ({ vaultLp: null }) }));
vi.mock("@/hooks/useMarketHealth", () => ({ useSingleMarketHealth: () => null }));
vi.mock("@/hooks/useVaultLpValuation", () => ({ useVaultLpValuation: () => ({ value: null, sim: null }) }));
vi.mock("@/lib/limits/earn", () => ({
  earnDepositPause: () => null, earnGateShares: () => null, earnViewFromLimits: () => null,
  earnPanelPricing: () => null, withSplitPotPricing: () => null,
}));
vi.mock("@/lib/limits/resolved-finish", () => ({ earnExitProps: () => ({}) }));
vi.mock("@/components/earn/DepositWithdrawPanel", () => ({ DepositWithdrawPanel: () => null }));
vi.mock("@/components/limits/EarnTrancheCard", () => ({ EarnTrancheCardView: () => null }));
vi.mock("@/components/limits/ResolvedExitPanel", () => ({ ResolvedExitPanel: () => null }));
vi.mock("@/components/market/MarketLogo", () => ({ MarketLogo: () => null }));

import { VaultDepositRail } from "@/components/earn/VaultDepositRail";

const SLAB = "6Y4bfYLWrhabgzU4p3onx9CeW1jCKjGjjSCaoCHf2Q9R";
const splitPot = { totalShares: 1n, navAtoms: 1n, maxNowAtoms: null, claimAdjustedNavAtoms: null, vaultMaxNowAtoms: null, withdrawStatus: null, blockedBy: null };

beforeEach(() => { h.splitPot = null; });

describe("Earn card: pending-fees note", () => {
  it("shows on a two-pot vault, before any deposit", async () => {
    h.splitPot = splitPot;
    render(<VaultDepositRail slab={SLAB} vault={null} />);
    expect((await screen.findByTestId("earn-rail-pending-fees-note")).textContent).toBe(
      "Your Value can read a little below what you put in until the vault collects its pending trading fees. Withdrawing before then forfeits your share of them.",
    );
  });

  it("does not show on a bound vault (or one whose pots can't be read)", async () => {
    render(<VaultDepositRail slab={SLAB} vault={null} />);
    await screen.findByTestId("earn-rail-figure-tvl");
    expect(screen.queryByTestId("earn-rail-pending-fees-note")).toBeNull();
  });
});
