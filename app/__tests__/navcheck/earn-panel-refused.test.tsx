// Independent review (v22 navcheck): when tag 75 would refuse, the panel must not preview "0 shares"
// and offer an enabled Deposit button (the ledger says this case was fixed by app #3703).
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DepositWithdrawPanel } from "../../components/earn/DepositWithdrawPanel";

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: vi.fn(() => ({ connected: true })),
  useConnectionCompat: () => ({ connection: {} }),
}));
vi.mock("@/components/ui/GlowButton", () => ({
  GlowButton: ({ children, disabled, onClick }: { children: React.ReactNode; disabled?: boolean; onClick?: () => void }) => (
    <button disabled={disabled} onClick={onClick}>{children}</button>
  ),
}));

const base = {
  userBalance: 2_000_000_000n, userLpBalance: 0n, vaultBalance: 0n, lpSupply: 0n, vaultAvailable: true,
  decimals: 6, collateralSymbol: "USDC", loading: false, cooldownElapsed: true,
  onDeposit: vi.fn(async () => undefined), onWithdraw: vi.fn(async () => undefined),
};

describe("navcheck: a deposit the program refuses", () => {
  it("genesis at or below the 1,000 dead shares (500 atoms)", () => {
    render(<DepositWithdrawPanel {...base} />);
    fireEvent.change(screen.getByLabelText("Deposit Amount"), { target: { value: "0.0005" } });
    expect(screen.queryByTestId("earn-deposit-preview")?.textContent ?? "").not.toMatch(/≈ 0(\.0+)? shares/);
    expect(screen.getByRole("button", { name: "Deposit" })).toBeDisabled();
  });
  it("shares outstanding at a zero value", () => {
    render(<DepositWithdrawPanel {...base} lpSupply={5_000n}
      pricing={{ totalShares: 5_000n, depositSeniorValue: 0n, withdrawSeniorValue: 0n, maxNowAtoms: 0n }} />);
    fireEvent.change(screen.getByLabelText("Deposit Amount"), { target: { value: "10" } });
    expect(screen.queryByTestId("earn-deposit-preview")?.textContent ?? "").not.toMatch(/≈ 0(\.0+)? shares/);
    expect(screen.getByRole("button", { name: "Deposit" })).toBeDisabled();
  });
});
