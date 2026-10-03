/**
 * GH#2882 (SI): with the market's counterparty out of funds, trading is paused, and the creator
 * deposited to Earn expecting it to reopen. On an unbound vault an Earn deposit goes to the backing
 * that pays traders' payouts and never reaches the counterparty. The Deposit tab now says so,
 * without blocking the deposit. A P3-bound vault does fund the counterparty, so it gets no note.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DepositWithdrawPanel } from "@/components/earn/DepositWithdrawPanel";

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: vi.fn(() => ({ connected: true })), useConnectionCompat: () => ({ connection: {} }) }));
vi.mock("@/components/ui/GlowButton", () => ({
  GlowButton: ({ children, disabled, onClick }: { children: React.ReactNode; disabled?: boolean; onClick?: () => void }) => (
    <button disabled={disabled} onClick={onClick}>{children}</button>
  ),
}));

const props = {
  userBalance: 100_000_000n,
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

const note = () => screen.queryByTestId("earn-lp-depleted-note");

describe("Earn deposit note when the market's counterparty is out of funds", () => {
  it("unbound vault, depleted: the Deposit tab says deposits don't reopen trading", () => {
    render(<DepositWithdrawPanel {...props} lpDepleted />);
    expect(note()?.textContent).toContain("Deposits here back traders' payouts and don't reopen trading.");
  });

  it("does not block the deposit", () => {
    render(<DepositWithdrawPanel {...props} lpDepleted />);
    fireEvent.change(screen.getByLabelText("Deposit Amount"), { target: { value: "10" } });
    expect(screen.getByRole("button", { name: "Deposit" })).not.toBeDisabled();
  });

  it("CONTROL: a P3-bound vault gets no note (its deposits do fund the counterparty)", () => {
    render(<DepositWithdrawPanel {...props} lpDepleted p3Bound />);
    expect(note()).toBeNull();
  });

  it("CONTROL: not depleted, no note", () => {
    render(<DepositWithdrawPanel {...props} />);
    expect(note()).toBeNull();
  });

  it("CONTROL: the Withdraw tab has no note", () => {
    render(<DepositWithdrawPanel {...props} lpDepleted userLpBalance={1_000_000n} />);
    fireEvent.click(screen.getByRole("button", { name: "withdraw" }));
    expect(note()).toBeNull();
  });

  // Both Earn deposit surfaces render this panel; wiring only one would leave the other silent.
  it("both parents pass the market's lpDepleted", () => {
    for (const rel of ["app/earn/[slab]/page.tsx", "components/earn/VaultDepositRail.tsx"]) {
      const src = readFileSync(join(__dirname, "..", "..", "..", rel), "utf8");
      expect(src, rel).toMatch(/lpDepleted=\{marketHealth\?\.lpDepleted === true\}/);
      expect(src, rel).toMatch(/const marketHealth = useSingleMarketHealth\(/);
    }
  });
});
