import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

vi.mock("@/hooks/useCreatorClaim", () => ({ useCreatorClaim: vi.fn() }));
vi.mock("@/hooks/useTokenMeta", () => ({
  useTokenMeta: vi.fn(() => ({ symbol: "USDC", name: "USDC", decimals: 6 })),
}));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: vi.fn(() => ({ config: { collateralMint: new PublicKey("EqDqqRzRwA5xnZYu7oJ6LfJbcFuwkTKs7KBSTu2xaG66") } })),
}));

import { useCreatorClaim } from "@/hooks/useCreatorClaim";
import { CreatorClaimPanel } from "@/components/market/CreatorClaimPanel";

function hookValue(over: Record<string, unknown> = {}) {
  return {
    isOperator: true,
    claimable: 5_005_176_875n, // 5005.176875 USDC
    claimableAssets: [{ assetIndex: 0, claimable: 5_005_176_875n }],
    decimals: 6,
    cooldownActive: false,
    cooldownRemainingSlots: 0n,
    loading: false,
    error: null,
    success: null,
    claim: vi.fn().mockResolvedValue("sig"),
    refresh: vi.fn(),
    clearStatus: vi.fn(),
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("CreatorClaimPanel", () => {
  it("renders NOTHING for a non-operator (traders never see it)", () => {
    vi.mocked(useCreatorClaim).mockReturnValue(hookValue({ isOperator: false }) as never);
    const { container } = render(<CreatorClaimPanel slabAddress="slab" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the human-formatted claimable and an active Claim button for the operator", () => {
    vi.mocked(useCreatorClaim).mockReturnValue(hookValue() as never);
    render(<CreatorClaimPanel slabAddress="slab" />);
    expect(screen.getByText(/Creator fees/i)).toBeInTheDocument();
    // 5_005_176_875 raw / 1e6 = 5005.176875
    expect(screen.getByTestId("creator-claimable").textContent).toContain("5005.176875");
    const btn = screen.getByTestId("creator-claim-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toMatch(/claim fees/i);
  });

  it("disables the button and shows an empty state when there is nothing to claim", () => {
    vi.mocked(useCreatorClaim).mockReturnValue(
      hookValue({ claimable: 0n, claimableAssets: [{ assetIndex: 0, claimable: 0n }] }) as never,
    );
    render(<CreatorClaimPanel slabAddress="slab" />);
    const btn = screen.getByTestId("creator-claim-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toMatch(/no fees to claim/i);
  });

  it("disables the button and surfaces the cooldown while a cooldown is active", () => {
    vi.mocked(useCreatorClaim).mockReturnValue(
      hookValue({ cooldownActive: true, cooldownRemainingSlots: 150000n }) as never,
    );
    render(<CreatorClaimPanel slabAddress="slab" />);
    const btn = screen.getByTestId("creator-claim-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toMatch(/cooldown/i);
    expect(screen.getByText(/once per cooldown window/i)).toBeInTheDocument();
  });

  it("calls claim() when the button is pressed", async () => {
    const v = hookValue();
    vi.mocked(useCreatorClaim).mockReturnValue(v as never);
    render(<CreatorClaimPanel slabAddress="slab" />);
    fireEvent.click(screen.getByTestId("creator-claim-button"));
    await waitFor(() => expect(v.claim).toHaveBeenCalledTimes(1));
  });

  it("surfaces the specific error message from the hook", () => {
    vi.mocked(useCreatorClaim).mockReturnValue(
      hookValue({ error: "Withdrawal cooldown is still active." }) as never,
    );
    render(<CreatorClaimPanel slabAddress="slab" />);
    expect(screen.getByTestId("creator-claim-error").textContent).toMatch(/cooldown/i);
  });
});
