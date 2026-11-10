/**
 * Council r4: N8 (Earn collect: honest steps; an expired quote must not still offer "Collect 19.99 USDC"),
 * N9 (creator fee vesting explained in the wizard), LP lows (over-max withdraw says it was clamped).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { V22LaunchOptions } from "@/components/create/V22LaunchOptions";
import { planLaunchV22 } from "@/lib/v22/launch-plan";
import { __setLotMarketsEnabledForTest } from "@/lib/v22/lot";
import { stakePoolsUrl, markStakeTx } from "@/lib/stake-pools-url";

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: vi.fn(() => ({ connected: true })), useConnectionCompat: () => ({ connection: {} }) }));
const useEarnExitV22 = vi.fn();
vi.mock("@/hooks/useEarnExitV22", () => ({ useEarnExitV22: (p: unknown) => useEarnExitV22(p) }));
import { DepositWithdrawPanel } from "@/components/earn/DepositWithdrawPanel";

const pricing = { totalShares: 1_000_000_000n, depositSeniorValue: 1_060_000_000n, withdrawSeniorValue: 1_050_000_000n, maxNowAtoms: null as bigint | null };
const base = {
  userBalance: 500_000_000n, userLpBalance: 100_000_000n, vaultBalance: 1_000_000_000n, lpSupply: 1_000_000_000n, vaultAvailable: true,
  decimals: 6, collateralSymbol: "USDC", loading: false, cooldownElapsed: true, cooldownSlots: 0n, pricing, onDeposit: vi.fn(), onWithdraw: vi.fn(),
  hasPendingRedemption: true, pendingRedemptionShares: 9_523_809n,
};
const exitV22 = { market: new PublicKey("11111111111111111111111111111112"), programId: new PublicKey("11111111111111111111111111111113"), collateralMint: new PublicKey("11111111111111111111111111111114"), sourceDomain: 0 };
const quote = { mode: "execute", quote: 1_000_000n, minPayout: 999_500n, staleCount: 0, refreshSelected: 0, refreshDeferred: 0, computeUnits: 1, estimate: false };
const api = (phase: string, q: unknown = null) => ({ state: { phase, quote: q, requoted: false, message: null, signature: null }, getQuote: vi.fn(), confirm: vi.fn(), reset: vi.fn() });

beforeEach(() => { useEarnExitV22.mockReset(); useEarnExitV22.mockReturnValue(api("idle")); __setDevnetV22ForTest(true); });
afterEach(() => { cleanup(); __setDevnetV22ForTest(null); });

describe("N8 Earn collect steps", () => {
  it("the collect card says which step it is", () => {
    render(<DepositWithdrawPanel {...base} exitV22={exitV22} />);
    expect(screen.getByTestId("earn-exit-step").textContent).toMatch(/Step 2 of 2/);
  });
  it("after the quote expires the button offers a refresh, not the stale amount", () => {
    useEarnExitV22.mockReturnValue(api("quoted", quote));
    const { rerender } = render(<DepositWithdrawPanel {...base} exitV22={exitV22} />);
    expect(screen.getByTestId("earn-exit-confirm")).toBeTruthy();
    useEarnExitV22.mockReturnValue(api("idle"));
    rerender(<DepositWithdrawPanel {...base} exitV22={exitV22} />);
    expect(screen.getByTestId("earn-exit-expired")).toBeTruthy();
    const btn = screen.getByTestId("earn-exit-get-quote");
    expect(btn.textContent).not.toMatch(/\d+\.\d\d USDC/);
    expect(btn.textContent).toMatch(/Refresh/i);
  });
  it("CONTROL: before any expiry the button still names the amount", () => {
    render(<DepositWithdrawPanel {...base} exitV22={exitV22} />);
    expect(screen.getByTestId("earn-exit-get-quote").textContent).toBe("Collect 9.99 USDC");
  });
  it("the withdraw request on a two-step vault is labelled step 1 of 2", () => {
    render(<DepositWithdrawPanel {...base} hasPendingRedemption={false} pendingRedemptionShares={0n} cooldownSlots={150n} exitV22={exitV22} />);
    fireEvent.click(screen.getAllByTestId("earn-tab").find((t) => t.dataset.tab === "withdraw")!);
    fireEvent.change(screen.getByTestId("earn-withdraw-input"), { target: { value: "10" } });
    expect(screen.getByTestId("earn-exit-step").textContent).toMatch(/Step 1 of 2/);
  });
});

describe("LP low: over-max withdraw is not clamped silently", () => {
  const open = () => {
    render(<DepositWithdrawPanel {...base} hasPendingRedemption={false} pendingRedemptionShares={0n} exitV22={exitV22} />);
    fireEvent.click(screen.getAllByTestId("earn-tab").find((t) => t.dataset.tab === "withdraw")!);
  };
  it("typing more than the position says it will withdraw the whole position", () => {
    open();
    fireEvent.change(screen.getByTestId("earn-withdraw-input"), { target: { value: "5000" } });
    expect(screen.getByTestId("earn-withdraw-clamped").textContent).toMatch(/more than you have/i);
  });
  it("CONTROL: an amount within the position shows no clamp note", () => {
    open();
    fireEvent.change(screen.getByTestId("earn-withdraw-input"), { target: { value: "10" } });
    expect(screen.queryByTestId("earn-withdraw-clamped")).toBeNull();
  });
});

describe("N9 creator fee vesting in the wizard", () => {
  it("explains when creator fees unlock", () => {
    __setLotMarketsEnabledForTest(true);
    const plan = planLaunchV22({ tokenPriceE6: 400n, collateralDecimals: 6, collateralSymbol: "USDC", oracleMode: "keeper", growthOn: true });
    render(<V22LaunchOptions value={{}} onChange={vi.fn()} plan={plan} symbol="TOK" />);
    const t = screen.getByTestId("v22-creator-vesting").textContent ?? "";
    expect(t).toMatch(/vest/i);
    expect(t).toMatch(/cushion/i);
    expect(t).toMatch(/target/i);
  });
});

describe("R2-10 stake pools right after the user's own tx", () => {
  it("a reload shortly after a stake tx bypasses the CDN-cached snapshot", () => {
    expect(stakePoolsUrl(0)).toBe("/api/stake/pools");
    markStakeTx();
    expect(stakePoolsUrl(0)).toMatch(/^\/api\/stake\/pools\?r=0-\d+/);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 5 * 60_000);
    expect(stakePoolsUrl(0)).toBe("/api/stake/pools");
    vi.useRealTimers();
    void act;
  });
});
