import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DepositWithdrawPanel } from "../../../components/earn/DepositWithdrawPanel";

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: vi.fn(() => ({
    connected: true,
  })),
}));

vi.mock("@/components/ui/GlowButton", () => ({
  GlowButton: ({
    children,
    disabled,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
  }) => <button disabled={disabled}>{children}</button>,
}));

const defaultProps = {
  userBalance: 0n,
  userLpBalance: 0n,
  vaultBalance: 0n,
  lpSupply: 0n,
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
});
