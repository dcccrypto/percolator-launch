import "@testing-library/jest-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DepositWithdrawPanel } from "@/components/earn/DepositWithdrawPanel";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: vi.fn(() => ({ connected: true })), useConnectionCompat: () => ({ connection: {} }) }));
vi.mock("@/components/ui/GlowButton", () => ({
  GlowButton: ({ children, disabled, onClick }: { children: React.ReactNode; disabled?: boolean; onClick?: () => void }) => (
    <button disabled={disabled} onClick={onClick}>{children}</button>
  ),
}));

const props = {
  userBalance: 100_000_000n, userLpBalance: 1_000_000n, vaultBalance: 10_000_000n, lpSupply: 10_000_000n, vaultAvailable: true, decimals: 6,
  collateralSymbol: "USDC", loading: false, cooldownElapsed: true, onDeposit: vi.fn(async () => undefined), onWithdraw: vi.fn(async () => undefined),
};
afterEach(() => { cleanup(); __setDevnetV21ForTest(null); });
const openWithdraw = () => fireEvent.click(screen.getByRole("button", { name: "withdraw" }));

describe("Earn reserve / buffer disclosure (Devnet v2.1)", () => {
  it("v2.1 on, bound vault, Withdraw tab: the exact disclosure line, with the long form on hover", () => {
    __setDevnetV21ForTest(true);
    render(<DepositWithdrawPanel {...props} p3Bound />);
    openWithdraw();
    const n = screen.getByTestId("earn-reserve-note");
    expect(n).toHaveTextContent("Withdrawals above the reserve wait for capital to be recalled from the market.");
    expect(n.getAttribute("title")).toContain("at least 30% of the vault");
  });
  it("CONTROL: the flag off (today) shows nothing", () => {
    __setDevnetV21ForTest(false);
    render(<DepositWithdrawPanel {...props} p3Bound />);
    openWithdraw();
    expect(screen.queryByTestId("earn-reserve-note")).toBeNull();
  });
  it("CONTROL: a non-bound vault has no reserve, so no note even with the flag on", () => {
    __setDevnetV21ForTest(true);
    render(<DepositWithdrawPanel {...props} />);
    openWithdraw();
    expect(screen.queryByTestId("earn-reserve-note")).toBeNull();
  });
  it("CONTROL: the Deposit tab has no note", () => {
    __setDevnetV21ForTest(true);
    render(<DepositWithdrawPanel {...props} p3Bound />);
    expect(screen.queryByTestId("earn-reserve-note")).toBeNull();
  });
});
