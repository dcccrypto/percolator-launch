/**
 * UX WP-4 (jsdom half; the fork half is e2e/fork-journeys/ux-wp4-earn-withdraw.spec.ts):
 *  - the request is asked for in USDC, priced like the program (withdraw-side worse-of value);
 *  - after the request the pending card counts down ("Ready in 1:00" for ~150 slots) and, when
 *    the cooldown ends, opens the payout by itself (no click) — two signatures, one flow;
 *  - after a reload (not armed) it says "Finish withdrawal" and waits for the click;
 *  - AC4: never "No active LP position" / "Max: 0 LP" while a ticket is pending;
 *  - 88 before it happens: over max_now the request is held with "Withdraw {max_now}";
 *  - a cooldown-0 vault says "1 approval".
 */
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
import { LpPositionDashboard } from "@/components/earn/LpPositionDashboard";

const pricing = { totalShares: 1_000_000_000n, depositSeniorValue: 1_060_000_000n, withdrawSeniorValue: 1_050_000_000n, maxNowAtoms: null as bigint | null };
const props = {
  userBalance: 500_000_000n,
  userLpBalance: 100_000_000n, // 100 shares ≈ 105 USDC at the withdraw-side value
  vaultBalance: 1_000_000_000n,
  lpSupply: 1_000_000_000n,
  vaultAvailable: true,
  decimals: 6,
  collateralSymbol: "USDC",
  loading: false,
  cooldownElapsed: true,
  cooldownSlots: 150n,
  pricing,
};

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

/** UX_SHOTS_OUT: write the REAL panel markup of a state for scripts/ux-shots/shoot-html.mjs. */
async function snap(name: string) {
  const out = process.env.UX_SHOTS_OUT;
  if (!out) return;
  const fs = await import("node:fs");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(`${out}/${name}.html`, document.body.firstElementChild!.innerHTML);
}
const openWithdraw = () => fireEvent.click(screen.getAllByTestId("earn-tab").find((t) => t.dataset.tab === "withdraw")!);

describe("request in USDC, priced like the program", () => {
  it("10 USDC -> the shares at the withdraw-side value; 'Arrives in about a minute · 2 approvals'", async () => {
    const onWithdraw = vi.fn(async () => ({ step: "requested" as const }));
    render(<DepositWithdrawPanel {...props} onDeposit={vi.fn()} onWithdraw={onWithdraw} />);
    openWithdraw();
    fireEvent.change(screen.getByTestId("earn-withdraw-input"), { target: { value: "10" } });
    expect(screen.getByTestId("earn-withdraw-receive").textContent).toBe("You receive ≈ 9.99 USDC (9.52 shares)");
    expect(screen.getByTestId("earn-withdraw-arrives").textContent).toBe("Arrives in about a minute · 2 approvals");
    expect(document.body.textContent).not.toMatch(/permanently burned|cannot be undone|LP Tokens to Burn/i);
    await snap("request");
    await act(async () => {
      fireEvent.click(screen.getByTestId("earn-withdraw-request"));
    });
    expect(onWithdraw).toHaveBeenCalledWith(9_523_809n);
  });

  it("a cooldown-0 vault: one transaction, 1 approval", () => {
    render(<DepositWithdrawPanel {...props} cooldownSlots={0n} onDeposit={vi.fn()} onWithdraw={vi.fn()} />);
    openWithdraw();
    expect(screen.getByTestId("earn-withdraw-arrives").textContent).toBe("Arrives in one transaction · 1 approval");
  });
});

describe("two signatures, one flow", () => {
  it("after the request: countdown, then the payout opens by itself (no click)", async () => {
    const onWithdraw = vi
      .fn()
      .mockResolvedValueOnce({ step: "requested" })
      .mockResolvedValueOnce({ step: "executed" });
    const onRefresh = vi.fn();
    const { rerender } = render(<DepositWithdrawPanel {...props} onDeposit={vi.fn()} onWithdraw={onWithdraw} onRefresh={onRefresh} />);
    openWithdraw();
    fireEvent.change(screen.getByTestId("earn-withdraw-input"), { target: { value: "10" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("earn-withdraw-request"));
    });
    // the chain now has the ticket: 150 slots to go
    rerender(
      <DepositWithdrawPanel {...props} userLpBalance={90_476_191n} hasPendingRedemption pendingRedemptionShares={9_523_809n} cooldownElapsed={false} cooldownRemainingSlots={150n} onDeposit={vi.fn()} onWithdraw={onWithdraw} onRefresh={onRefresh} />,
    );
    const card = screen.getByTestId("earn-pending-withdrawal");
    expect(card.dataset.phase).toBe("counting");
    expect(card.textContent).toContain("Withdrawal in progress: 9.99 USDC");
    expect(screen.getByTestId("earn-pending-countdown").textContent).toBe("Ready in 1:00");
    await snap("pending-countdown");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(onRefresh).toHaveBeenCalled(); // the clock ran out: ask the chain
    expect(onWithdraw).toHaveBeenCalledTimes(1);
    rerender(
      <DepositWithdrawPanel {...props} userLpBalance={90_476_191n} hasPendingRedemption pendingRedemptionShares={9_523_809n} cooldownElapsed cooldownRemainingSlots={0n} onDeposit={vi.fn()} onWithdraw={onWithdraw} onRefresh={onRefresh} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(onWithdraw).toHaveBeenCalledTimes(2);
    expect(onWithdraw).toHaveBeenLastCalledWith(9_523_809n);
    expect(screen.getByTestId("earn-withdraw-sent").textContent).toBe("Sent ≈ 9.99 USDC to your wallet.");
  });

  it("CONTROL: after a reload (not requested in this session) it waits for 'Finish withdrawal'", async () => {
    const onWithdraw = vi.fn(async () => ({ step: "executed" as const }));
    render(<DepositWithdrawPanel {...props} hasPendingRedemption pendingRedemptionShares={9_523_809n} cooldownElapsed onDeposit={vi.fn()} onWithdraw={onWithdraw} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(onWithdraw).not.toHaveBeenCalled();
    expect(screen.getByTestId("earn-pending-withdrawal").dataset.phase).toBe("ready");
    const finish = screen.getByTestId("earn-withdraw-execute");
    expect(finish.textContent).toBe("Finish withdrawal");
    await snap("finish-withdrawal");
    await act(async () => {
      fireEvent.click(finish);
    });
    expect(onWithdraw).toHaveBeenCalledWith(9_523_809n);
  });

  it("AC4: never 'No active LP position' / 'Max: 0 LP' while a ticket is pending", () => {
    render(
      <>
        <DepositWithdrawPanel {...props} userLpBalance={0n} hasPendingRedemption pendingRedemptionShares={100_000_000n} cooldownElapsed={false} cooldownRemainingSlots={150n} onDeposit={vi.fn()} onWithdraw={vi.fn()} />
        <LpPositionDashboard userLpBalance={0n} lpSupply={1n} vaultBalance={1n} decimals={6} lpDecimals={6} collateralSymbol="USDC" redemptionRateE6={1_000_000n} loading={false} pendingWithdrawalLabel="105 USDC" />
      </>,
    );
    openWithdraw();
    expect(document.body.textContent).not.toMatch(/No active LP position|Max:\s*0\s*LP|Max:\s*0\s*USDC/);
    expect(screen.getByTestId("earn-withdraw-in-progress")).toBeTruthy();
    expect(screen.getByTestId("earn-position-pending").textContent).toContain("Withdrawal in progress: 105 USDC");
  });
});

describe("88 before it happens (max_now)", () => {
  it("over what the vault can pay now: held, with 'Withdraw {max_now}' that fills it", async () => {
    const onWithdraw = vi.fn();
    render(<DepositWithdrawPanel {...props} pricing={{ ...pricing, maxNowAtoms: 40_000_000n }} onDeposit={vi.fn()} onWithdraw={onWithdraw} />);
    openWithdraw();
    fireEvent.change(screen.getByTestId("earn-withdraw-input"), { target: { value: "100" } });
    const line = screen.getByTestId("status-line");
    expect(line.dataset.kind).toBe("earn-max-now");
    expect(screen.getByTestId("status-line-body").textContent).toMatch(/You can withdraw up to 40\.00 USDC now/);
    expect((screen.getByTestId("earn-withdraw-request") as HTMLButtonElement).disabled).toBe(true);
    await snap("max-now");
    fireEvent.click(screen.getByTestId("status-line-action"));
    expect((screen.getByTestId("earn-withdraw-input") as HTMLInputElement).value).toBe("40");
    expect(screen.queryByTestId("status-line")).toBeNull();
    expect((screen.getByTestId("earn-withdraw-request") as HTMLButtonElement).disabled).toBe(false);
  });
});
