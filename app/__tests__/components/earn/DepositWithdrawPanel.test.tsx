import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DepositWithdrawPanel } from "../../../components/earn/DepositWithdrawPanel";

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: vi.fn(() => ({
    connected: true,
  })),
  useConnectionCompat: () => ({ connection: {} }),
}));

vi.mock("@/components/ui/GlowButton", () => ({
  GlowButton: ({
    children,
    disabled,
    onClick,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

const defaultProps = {
  userBalance: 0n,
  userLpBalance: 0n,
  vaultBalance: 0n,
  lpSupply: 0n,
  vaultAvailable: true,
  decimals: 6,
  collateralSymbol: "USDC",
  loading: false,
  cooldownElapsed: true,
  onDeposit: vi.fn(async () => undefined),
  onWithdraw: vi.fn(async () => undefined),
};

describe("DepositWithdrawPanel", () => {
  it("does not show a zero max deposit balance while loading", () => {
    const { rerender } = render(
      <DepositWithdrawPanel
        {...defaultProps}
        loading={true}
        userBalance={0n}
      />,
    );

    expect(screen.getByText(/Max:\s*—\s*USDC/)).toBeInTheDocument();
    expect(screen.queryByText(/Max:\s*0\s*USDC/)).not.toBeInTheDocument();

    rerender(
      <DepositWithdrawPanel
        {...defaultProps}
        loading={false}
        userBalance={16_000_000_000n}
      />,
    );

    expect(screen.getByText(/Max:\s*16000\s*USDC/)).toBeInTheDocument();
  });

  it("keeps the initial 1:1 LP preview for an available initialized-empty vault", () => {
    render(
      <DepositWithdrawPanel
        {...defaultProps}
        vaultAvailable={true}
        userBalance={2_000_000_000n}
        lpSupply={0n}
        vaultBalance={0n}
      />,
    );

    fireEvent.change(screen.getByLabelText("Deposit Amount"), {
      target: { value: "1000" },
    });

    expect(screen.getByText(/≈ 1,000\.00 shares/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deposit" })).toBeEnabled();
  });

  it("fails closed and hides the LP preview when the vault becomes unavailable", () => {
    const onDeposit = vi.fn(async () => undefined);

    const { rerender } = render(
      <DepositWithdrawPanel
        {...defaultProps}
        vaultAvailable={true}
        userBalance={2_000_000_000n}
        lpSupply={0n}
        vaultBalance={0n}
        onDeposit={onDeposit}
      />,
    );

    fireEvent.change(screen.getByLabelText("Deposit Amount"), {
      target: { value: "1000" },
    });

    expect(screen.getByText(/≈ 1,000\.00 shares/)).toBeInTheDocument();

    rerender(
      <DepositWithdrawPanel
        {...defaultProps}
        vaultAvailable={false}
        userBalance={2_000_000_000n}
        lpSupply={0n}
        vaultBalance={0n}
        onDeposit={onDeposit}
      />,
    );

    expect(screen.getByLabelText("Deposit Amount")).toBeDisabled();

    expect(
      screen.getByRole("button", { name: /Set maximum amount:/ }),
    ).toBeDisabled();

    for (const pct of [25, 50, 75, 100]) {
      expect(
        screen.getByRole("button", { name: `${pct}%` }),
      ).toBeDisabled();
    }

    expect(screen.queryByText(/≈ 1,000\.00 shares/)).not.toBeInTheDocument();

    const depositButton = screen.getByRole("button", { name: "Deposit" });
    expect(depositButton).toBeDisabled();

    fireEvent.click(depositButton);
    expect(onDeposit).not.toHaveBeenCalled();
  });

  it("keeps withdrawal actions disabled when the vault is unavailable", () => {
    const onWithdraw = vi.fn(async () => undefined);

    render(
      <DepositWithdrawPanel
        {...defaultProps}
        vaultAvailable={false}
        userLpBalance={1_000_000n}
        onWithdraw={onWithdraw}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "withdraw" }),
    );

    expect(screen.getByLabelText("Withdraw Amount")).toBeDisabled();

    const withdrawButton = screen.getByRole("button", {
      name: /^Withdraw /,
    });

    expect(withdrawButton).toBeDisabled();

    fireEvent.click(withdrawButton);
    expect(onWithdraw).not.toHaveBeenCalled();
  });

  it("blocks a pending-redemption claim while the vault is unavailable", () => {
    const onWithdraw = vi.fn(async () => undefined);

    render(
      <DepositWithdrawPanel
        {...defaultProps}
        vaultAvailable={false}
        hasPendingRedemption={true}
        pendingRedemptionShares={1_000_000n}
        cooldownElapsed={true}
        onWithdraw={onWithdraw}
      />,
    );

    const claimButton = screen.getByRole("button", {
      name: "Finish withdrawal",
    });

    expect(claimButton).toBeDisabled();

    fireEvent.click(claimButton);
    expect(onWithdraw).not.toHaveBeenCalled();
  });
  it("shows an inline error and disables submit when the deposit exceeds the wallet balance", () => {
    const onDeposit = vi.fn(async () => undefined);
    render(
      <DepositWithdrawPanel
        {...defaultProps}
        onDeposit={onDeposit}
        userBalance={2_000_000n}
        lpSupply={0n}
        vaultBalance={0n}
      />,
    );
    fireEvent.change(screen.getByLabelText("Deposit Amount"), { target: { value: "1000" } });
    expect(screen.getByTestId("earn-deposit-amount-error").textContent).toMatch(
      /exceeds your wallet balance \(2 USDC available\)/i,
    );
    const submit = screen.getAllByRole("button", { name: /^deposit$/i }).at(-1) as HTMLButtonElement; // [tab, submit]
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(onDeposit).not.toHaveBeenCalled();
    // Within balance -> no error, submit enabled.
    fireEvent.change(screen.getByLabelText("Deposit Amount"), { target: { value: "2" } });
    expect(screen.queryByTestId("earn-deposit-amount-error")).toBeNull();
  });

  it("does not flash the over-balance error while the balance is still loading", () => {
    render(<DepositWithdrawPanel {...defaultProps} loading={true} userBalance={0n} />);
    fireEvent.change(screen.getByLabelText("Deposit Amount"), { target: { value: "5" } });
    expect(screen.queryByTestId("earn-deposit-amount-error")).toBeNull();
  });
});
