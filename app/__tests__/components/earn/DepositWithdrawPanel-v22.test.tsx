/**
 * v2.2 Earn panel wiring: with the flag on and the exit params present, the withdraw tab is the quote-first exit
 * (no one-step "request" button) and an elapsed pending redemption is claimed through the same quote (a bare legacy
 * tag 77 would be answered 118 on a book that is not loss-current). Flag off or params absent: the existing UI, untouched.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: vi.fn(() => ({ connected: true })), useConnectionCompat: () => ({ connection: {} }) }));
const useEarnExitV22 = vi.fn();
vi.mock("@/hooks/useEarnExitV22", () => ({ useEarnExitV22: (p: unknown) => useEarnExitV22(p) }));
vi.mock("@/components/ui/GlowButton", () => ({
  GlowButton: ({ children, disabled, onClick, ...rest }: { children: React.ReactNode; disabled?: boolean; onClick?: () => void; "data-testid"?: string }) => (
    <button disabled={disabled} onClick={onClick} data-testid={rest["data-testid"]}>
      {children}
    </button>
  ),
}));

import { DepositWithdrawPanel } from "@/components/earn/DepositWithdrawPanel";

const pricing = { totalShares: 1_000_000_000n, depositSeniorValue: 1_060_000_000n, withdrawSeniorValue: 1_050_000_000n, maxNowAtoms: null as bigint | null };
const base = {
  userBalance: 500_000_000n,
  userLpBalance: 100_000_000n,
  vaultBalance: 1_000_000_000n,
  lpSupply: 1_000_000_000n,
  vaultAvailable: true,
  decimals: 6,
  collateralSymbol: "USDC",
  loading: false,
  cooldownElapsed: true,
  cooldownSlots: 0n,
  pricing,
  onDeposit: vi.fn(),
  onWithdraw: vi.fn(),
};
const exitV22 = { market: new PublicKey("11111111111111111111111111111112"), programId: new PublicKey("11111111111111111111111111111113"), collateralMint: new PublicKey("11111111111111111111111111111114"), sourceDomain: 0 };
const api = (phase: string, quote: unknown = null) => ({ state: { phase, quote, requoted: false, message: null, signature: null }, getQuote: vi.fn(), confirm: vi.fn() });
const openWithdraw = () => fireEvent.click(screen.getAllByTestId("earn-tab").find((t) => t.dataset.tab === "withdraw")!);

beforeEach(() => {
  useEarnExitV22.mockReset();
  useEarnExitV22.mockReturnValue(api("idle"));
});
afterEach(() => cleanup());
afterEach(() => __setDevnetV22ForTest(null));

describe("withdraw tab", () => {
  it("flag on + params: the quote-first exit replaces the one-step button", () => {
    __setDevnetV22ForTest(true);
    render(<DepositWithdrawPanel {...base} exitV22={exitV22} />);
    openWithdraw();
    fireEvent.change(screen.getByTestId("earn-withdraw-input"), { target: { value: "10" } });
    expect(screen.getByTestId("earn-exit-get-quote")).toBeTruthy();
    expect(screen.queryByTestId("earn-withdraw-request")).toBeNull();
    // the hook got the mode for a cooldown-0 vault (one transaction)
    expect(useEarnExitV22.mock.calls.at(-1)![0]).toMatchObject({ mode: "pair", sourceDomain: 0 });
  });
  it("CONTROL flag off (params present): the existing button, no v2.2 hook", () => {
    render(<DepositWithdrawPanel {...base} exitV22={exitV22} />);
    openWithdraw();
    expect(screen.getByTestId("earn-withdraw-request")).toBeTruthy();
    expect(screen.queryByTestId("earn-exit-v22")).toBeNull();
    expect(useEarnExitV22).not.toHaveBeenCalled();
  });
  it("CONTROL flag on without params: the existing button", () => {
    __setDevnetV22ForTest(true);
    render(<DepositWithdrawPanel {...base} />);
    openWithdraw();
    expect(screen.getByTestId("earn-withdraw-request")).toBeTruthy();
  });
});

describe("pending redemption", () => {
  const pending = { ...base, hasPendingRedemption: true, pendingRedemptionShares: 9_523_809n };
  it("ready (cooldown elapsed) + flag on: claimed through the quote step in execute mode", () => {
    __setDevnetV22ForTest(true);
    render(<DepositWithdrawPanel {...pending} exitV22={exitV22} />);
    expect(screen.getByTestId("earn-pending-claim-v22")).toBeTruthy();
    expect(screen.queryByTestId("earn-withdraw-execute")).toBeNull();
    expect(useEarnExitV22.mock.calls.some((c) => c[0].mode === "execute" && c[0].shares === 9_523_809n)).toBe(true);
  });
  it("still counting down + flag on: the existing countdown card", () => {
    __setDevnetV22ForTest(true);
    render(<DepositWithdrawPanel {...pending} cooldownElapsed={false} cooldownRemainingSlots={150n} exitV22={exitV22} />);
    expect(screen.getByTestId("earn-pending-withdrawal").dataset.phase).toBe("counting");
    expect(screen.queryByTestId("earn-pending-claim-v22")).toBeNull();
  });
  it("CONTROL flag off: the legacy 'Finish withdrawal' claim", () => {
    render(<DepositWithdrawPanel {...pending} exitV22={exitV22} />);
    expect(screen.getByTestId("earn-withdraw-execute")).toBeTruthy();
    expect(screen.queryByTestId("earn-pending-claim-v22")).toBeNull();
  });
});
