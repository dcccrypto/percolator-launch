/**
 * Earn withdraw "Max" / "100%" in USDC must redeem the whole position.
 *
 * The USDC max is floor(shares * value / S); converting it back is floor(atoms * S / value), so
 * the round trip came out one share short at almost every share price. The request burned
 * all-but-one share and the leftover dust share kept the vault as an open $0.00 position
 * (Your Deposit $0, Pool Share 0.00%) that the USDC withdraw could never reach (Max: 0).
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: vi.fn(() => ({ connected: true })), useConnectionCompat: () => ({ connection: {} }) }));
vi.mock("@/components/ui/GlowButton", () => ({
  GlowButton: ({ children, disabled, onClick, ...rest }: { children: React.ReactNode; disabled?: boolean; onClick?: () => void; "data-testid"?: string }) => (
    <button disabled={disabled} onClick={onClick} data-testid={rest["data-testid"]}>
      {children}
    </button>
  ),
}));

import { DepositWithdrawPanel } from "@/components/earn/DepositWithdrawPanel";

const SHARES = 123_456_789n; // 123.456789 shares

function setup(withdrawSeniorValue: bigint) {
  const onWithdraw = vi.fn(async () => ({ step: "requested" as const }));
  render(
    <DepositWithdrawPanel
      userBalance={500_000_000n}
      userLpBalance={SHARES}
      vaultBalance={1_000_000_000n}
      lpSupply={1_000_000_000n}
      vaultAvailable
      decimals={6}
      collateralSymbol="USDC"
      loading={false}
      cooldownElapsed
      cooldownSlots={150n}
      pricing={{ totalShares: 1_000_000_000n, depositSeniorValue: withdrawSeniorValue, withdrawSeniorValue, maxNowAtoms: null }}
      onDeposit={vi.fn()}
      onWithdraw={onWithdraw}
    />,
  );
  fireEvent.click(screen.getAllByTestId("earn-tab").find((t) => t.dataset.tab === "withdraw")!);
  return onWithdraw;
}

const request = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId("earn-withdraw-request"));
  });
};

describe("Earn withdraw Max / 100% burns every share", () => {
  // Share price above 1 (fees accrued) and below 1 (a two-pot vault after a loss).
  it.each([
    ["share price 1.052345678", 1_052_345_678n, "129.919218"],
    ["share price 0.987654321", 987_654_321n, "121.932631"],
  ])("Max at %s", async (_n, value, maxText) => {
    const onWithdraw = setup(value);
    fireEvent.click(screen.getByRole("button", { name: /Set maximum amount:/ }));
    expect((screen.getByTestId("earn-withdraw-input") as HTMLInputElement).value).toBe(maxText);
    await request();
    expect(onWithdraw).toHaveBeenCalledWith(SHARES);
  });

  it("100% chip", async () => {
    const onWithdraw = setup(1_052_345_678n);
    fireEvent.click(screen.getByRole("button", { name: "100%" }));
    await request();
    expect(onWithdraw).toHaveBeenCalledWith(SHARES);
  });

  it("CONTROL: a partial amount still converts at the withdraw-side value (floor)", async () => {
    const onWithdraw = setup(1_052_345_678n);
    fireEvent.change(screen.getByTestId("earn-withdraw-input"), { target: { value: "10" } });
    await request();
    // floor(10_000_000 * 1e9 / 1_052_345_678)
    expect(onWithdraw).toHaveBeenCalledWith(9_502_580n);
  });
});
