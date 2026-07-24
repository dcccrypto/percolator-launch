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

const COLLATERAL = new PublicKey("EqDqqRzRwA5xnZYu7oJ6LfJbcFuwkTKs7KBSTu2xaG66");
const OPERATOR = new PublicKey("FbTbDeGWQpjrEqJdqoBHX3sTWHoAmU2xywD7wyxH6WC7");

/** Mirrors the tag-90 hook's return shape — a single market-level claimable. */
function hookValue(over: Record<string, unknown> = {}) {
  return {
    isOperator: true,
    claimable: 5_005_176_875n, // 5005.176875 USDC
    collateralMint: COLLATERAL,
    claimAuthority: OPERATOR,
    decimals: 6,
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
    vi.mocked(useCreatorClaim).mockReturnValue(hookValue({ claimable: 0n }) as never);
    render(<CreatorClaimPanel slabAddress="slab" />);
    const btn = screen.getByTestId("creator-claim-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toMatch(/no fees to claim/i);
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
      hookValue({ error: "Claim exceeds the creator fees this market has accrued." }) as never,
    );
    render(<CreatorClaimPanel slabAddress="slab" />);
    expect(screen.getByTestId("creator-claim-error").textContent).toMatch(/exceeds/i);
  });
});

describe("CreatorClaimPanel — copy must not sell the loss backstop as revenue", () => {
  it("describes the balance as the creator's share of TRADE FEES", () => {
    vi.mocked(useCreatorClaim).mockReturnValue(hookValue() as never);
    render(<CreatorClaimPanel slabAddress="slab" />);
    expect(screen.getByText(/share of this market's trade fees/i)).toBeInTheDocument();
  });

  it("states that the insurance fund is separate and NOT claimable", () => {
    vi.mocked(useCreatorClaim).mockReturnValue(hookValue() as never);
    const { container } = render(<CreatorClaimPanel slabAddress="slab" />);
    const text = container.textContent ?? "";
    expect(text).toMatch(/separate from the insurance fund/i);
    expect(text).toMatch(/not\s+claimable/i);
    // The old panel offered the insurance pot itself as the thing being claimed.
    expect(text).not.toMatch(/claim (your |the )?insurance/i);
    expect(text).not.toMatch(/insurance (pool|budget|revenue|earnings)/i);
  });

  it("shows no cooldown UI — tag 90 applies no cooldown", () => {
    // The tag-57 path was rate-limited by insurance_withdraw_cooldown_slots;
    // handle_withdraw_creator_fee deliberately has no such gate, so a countdown
    // here would block a claim the program would have accepted.
    vi.mocked(useCreatorClaim).mockReturnValue(hookValue() as never);
    const { container } = render(<CreatorClaimPanel slabAddress="slab" />);
    expect(container.textContent ?? "").not.toMatch(/cooldown/i);
  });
});
