/**
 * Two-pot Earn vault (live investigation 2026-10-01b, SI "Payout not sent — Something went wrong"):
 * a pending full withdrawal the vault cannot pay in one go is refused BEFORE signing
 * (EarnPayoutCapError), and the pending card offers ONE calm action, "Withdraw max available now:
 * X USDC", which re-requests the capped shares and then collects by itself when the cooldown ends.
 */
import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: vi.fn(() => ({ connected: true })), useConnectionCompat: () => ({ connection: {} }) }));
vi.mock("@/components/ui/GlowButton", () => ({
  GlowButton: ({ children, disabled, onClick, ...rest }: { children: React.ReactNode; disabled?: boolean; onClick?: () => void; "data-testid"?: string }) => (
    <button disabled={disabled} onClick={onClick} data-testid={rest["data-testid"]}>
      {children}
    </button>
  ),
}));

import { DepositWithdrawPanel } from "@/components/earn/DepositWithdrawPanel";
import { EarnPayoutCapError } from "@/lib/limits/earn-split-pot";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { resolveDevnetProgramIds } from "@/lib/program-ids";

// SI-shaped: the whole position (2,599,991,798 shares) is in a pending ticket.
const props = {
  userBalance: 0n,
  userLpBalance: 0n,
  vaultBalance: 2_602_792_188n,
  lpSupply: 2_599_992_799n,
  vaultAvailable: true,
  decimals: 6,
  collateralSymbol: "USDC",
  loading: false,
  cooldownElapsed: true,
  cooldownSlots: 5n,
  hasPendingRedemption: true,
  pendingRedemptionShares: 2_599_991_798n,
  cooldownRemainingSlots: 0n,
  pricing: { totalShares: 2_599_992_799n, depositSeniorValue: 2_602_792_188n, withdrawSeniorValue: 2_602_792_188n, maxNowAtoms: 2_600_140_063n },
};

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

describe("pending full withdrawal the vault can only partly pay", () => {
  it("offers 'Withdraw max available now', re-requests the capped shares, then collects by itself", async () => {
    let pending = true;
    const onWithdraw = vi.fn(async () => {
      if (pending) throw new EarnPayoutCapError(2_597_343_527n, 2_600_140_063n);
      return { step: "executed" as const };
    });
    // The parent (the Earn page) re-reads the ticket inside onResizeRedemption, as the real one does.
    let setTicket: (t: { elapsed: boolean; shares: bigint }) => void = () => {};
    const onResizeRedemption = vi.fn(async () => {
      pending = false;
      act(() => setTicket({ elapsed: false, shares: 2_597_343_527n }));
    });
    function Harness() {
      const [t, set] = useState({ elapsed: true, shares: 2_599_991_798n });
      setTicket = set;
      return (
        <DepositWithdrawPanel
          {...props}
          cooldownElapsed={t.elapsed}
          cooldownRemainingSlots={t.elapsed ? 0n : 5n}
          pendingRedemptionShares={t.shares}
          onDeposit={vi.fn()}
          onWithdraw={onWithdraw}
          onResizeRedemption={onResizeRedemption}
        />
      );
    }
    render(<Harness />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("earn-withdraw-execute"));
    });
    // No "Payout not sent" / "Something went wrong": one calm line with the max.
    expect(document.body.textContent).not.toMatch(/Payout not sent|Something went wrong/);
    const action = screen.getByRole("button", { name: "Withdraw max available now: 2,600.14 USDC" });
    expect(document.body.textContent).toMatch(/The full amount can't be paid in one go right now\. Nothing moved\./);
    expect(screen.queryByTestId("earn-withdraw-execute")).toBeNull();

    await act(async () => {
      fireEvent.click(action);
    });
    expect(onResizeRedemption).toHaveBeenCalledWith(2_597_343_527n);
    expect(onWithdraw).toHaveBeenCalledTimes(1); // nothing fires while the new cooldown runs

    // The cooldown ends: the payout opens by itself (armed), for the capped shares.
    await act(async () => {
      setTicket({ elapsed: true, shares: 2_597_343_527n });
    });
    expect(onWithdraw).toHaveBeenCalledTimes(2);
    expect(onWithdraw).toHaveBeenLastCalledWith(2_597_343_527n);
  });

  it("Custom 25 on an Earn withdrawal reads as a calm line, not 'Something went wrong'", () => {
    const W = resolveDevnetProgramIds().wrapper;
    const msg = resolveUserMessage(new Error(`Transaction simulation failed: Error processing Instruction 2: custom program error: 0x19\nProgram ${W} failed: custom program error: 0x19`), { surface: "earn-withdraw" });
    // #2740 (0x-SquidSol): the fallback line if a 77 still meets a split pot.
    expect(msg.kind).toBe("earn-payout-split");
    expect(msg.body).toMatch(/Nothing was sent/);
  });

  it("the request path's pre-sign cap refusal also reads calmly", () => {
    const msg = resolveUserMessage(new EarnPayoutCapError(1n, 1n), { surface: "earn-withdraw" });
    expect(msg.title).toBe("Partly available now");
  });
});
