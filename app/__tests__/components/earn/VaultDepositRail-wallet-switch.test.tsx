/**
 * N13: the rail is keyed by slab only, so its "first read landed" latch (everLoaded) survived a
 * wallet switch. The new wallet's figures rendered as loaded before its own read, and the rail
 * reported its not-yet-read $0 to the table, overriding the table's chain-read value.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const WALLET_A = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
const WALLET_B = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");

const h = vi.hoisted(() => ({
  wallet: null as unknown,
  lp: { loading: false, readError: false, userVaultValueAtoms: 0n, userLpBalance: 0n },
}));

vi.mock("@/components/providers/SlabProvider", () => ({
  SlabProvider: ({ children }: { children: React.ReactNode }) => children,
  useSlabState: () => ({ config: null, raw: null }),
}));
vi.mock("@/hooks/useInsuranceLP", () => ({
  useInsuranceLP: () => ({
    state: {
      registryExists: true, mintExists: true, vaultTotalAtoms: 1_000_000_000n, userVaultValueAtoms: h.lp.userVaultValueAtoms,
      userLpBalance: h.lp.userLpBalance, pendingRedemptionShares: 0n, redemptionCooldownSlots: 0n, userSharePct: 0,
      backingNavAtoms: 0n, splitPot: null,
    },
    loading: h.lp.loading, readError: h.lp.readError, deposit: vi.fn(), withdraw: vi.fn(), resizeRedemption: vi.fn(), refreshState: vi.fn(), lastDrawSummary: null,
  }),
}));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => null }));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ publicKey: h.wallet }), useConnectionCompat: () => ({ connection: {} }) }));
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

beforeEach(() => {
  cleanup();
  h.wallet = WALLET_A;
  h.lp = { loading: false, readError: false, userVaultValueAtoms: 500_000_000n, userLpBalance: 500_000_000n };
});

describe("Earn rail on a wallet switch (N13)", () => {
  it("the new wallet's value is unknown until its own read lands, and no $0 is reported", () => {
    const onPositionResolved = vi.fn();
    const { rerender } = render(<VaultDepositRail slab={SLAB} vault={null} onPositionResolved={onPositionResolved} />);
    expect(screen.getByTestId("earn-rail-figure-your-value").textContent).toBe("$500.00");
    expect(onPositionResolved).toHaveBeenLastCalledWith(SLAB, 500);
    onPositionResolved.mockClear();

    // Wallet B: the hook has dropped A's position and B's first read failed.
    h.wallet = WALLET_B;
    h.lp = { loading: false, readError: true, userVaultValueAtoms: 0n, userLpBalance: 0n };
    rerender(<VaultDepositRail slab={SLAB} vault={null} onPositionResolved={onPositionResolved} />);

    expect(screen.getByTestId("earn-rail-figure-your-value").textContent).not.toMatch(/\$/);
    expect(onPositionResolved).not.toHaveBeenCalled();
  });

  it("CONTROL: the same wallet re-reading keeps its figures", () => {
    const onPositionResolved = vi.fn();
    const { rerender } = render(<VaultDepositRail slab={SLAB} vault={null} onPositionResolved={onPositionResolved} />);
    h.lp = { ...h.lp, loading: true };
    rerender(<VaultDepositRail slab={SLAB} vault={null} onPositionResolved={onPositionResolved} />);
    expect(screen.getByTestId("earn-rail-figure-your-value").textContent).toBe("$500.00");
  });
});
