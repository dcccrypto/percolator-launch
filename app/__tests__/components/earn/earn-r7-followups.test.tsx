/**
 * Review follow-ups: Shares-mode over-balance copy (no "whole position" claim when nothing is clamped), and an amount
 * edit after a quote must not read as an expired quote.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: vi.fn(() => ({ connected: true })), useConnectionCompat: () => ({ connection: {} }) }));
const useEarnExitV22 = vi.fn();
vi.mock("@/hooks/useEarnExitV22", () => ({ useEarnExitV22: (p: unknown) => useEarnExitV22(p) }));
import { DepositWithdrawPanel } from "@/components/earn/DepositWithdrawPanel";

const pricing = { totalShares: 1_000_000_000n, depositSeniorValue: 1_060_000_000n, withdrawSeniorValue: 1_050_000_000n, maxNowAtoms: null as bigint | null };
const base = {
  userBalance: 500_000_000n, userLpBalance: 100_000_000n, vaultBalance: 1_000_000_000n, lpSupply: 1_000_000_000n, vaultAvailable: true,
  decimals: 6, collateralSymbol: "USDC", loading: false, cooldownElapsed: true, cooldownSlots: 0n, pricing, onDeposit: vi.fn(), onWithdraw: vi.fn(),
  hasPendingRedemption: false, pendingRedemptionShares: 0n,
};
const exitV22 = { market: new PublicKey("11111111111111111111111111111112"), programId: new PublicKey("11111111111111111111111111111113"), collateralMint: new PublicKey("11111111111111111111111111111114"), sourceDomain: 0 };
const quote = { mode: "pair", quote: 1_000_000n, minPayout: 999_500n, staleCount: 0, refreshSelected: 0, refreshDeferred: 0, computeUnits: 1, estimate: false };
const api = (phase: string, q: unknown = null) => ({ state: { phase, quote: q, requoted: false, message: null, signature: null }, getQuote: vi.fn(), confirm: vi.fn(), reset: vi.fn() });

beforeEach(() => { useEarnExitV22.mockReset(); useEarnExitV22.mockReturnValue(api("idle")); __setDevnetV22ForTest(true); });
afterEach(() => { cleanup(); __setDevnetV22ForTest(null); });

const openWithdraw = () => {
  const r = render(<DepositWithdrawPanel {...base} exitV22={exitV22} />);
  fireEvent.click(screen.getAllByTestId("earn-tab").find((t) => t.dataset.tab === "withdraw")!);
  return r;
};

describe("Shares mode over the balance", () => {
  it("says it is more than you have, not that the whole position is withdrawn; button stays disabled", () => {
    openWithdraw();
    fireEvent.click(screen.getByTestId("earn-withdraw-unit"));
    fireEvent.change(screen.getByTestId("earn-withdraw-input"), { target: { value: "5000" } });
    expect(screen.queryByTestId("earn-withdraw-clamped")).toBeNull();
    expect(screen.getByTestId("earn-withdraw-over-shares").textContent).toMatch(/more than your/i);
    expect(screen.getByTestId("earn-withdraw-over-shares").textContent).not.toMatch(/whole position/i);
    expect(screen.queryByTestId("earn-withdraw-receive")).toBeNull();
    expect(screen.getByTestId("earn-exit-get-quote")).toBeDisabled();
  });
  it("CONTROL: USDC mode over the position still says the whole position is withdrawn", () => {
    openWithdraw();
    fireEvent.change(screen.getByTestId("earn-withdraw-input"), { target: { value: "5000" } });
    expect(screen.getByTestId("earn-withdraw-clamped").textContent).toMatch(/whole position/i);
    expect(screen.queryByTestId("earn-withdraw-over-shares")).toBeNull();
  });
});

describe("editing the amount after a quote", () => {
  const edit = (value: string) => fireEvent.change(screen.getByTestId("earn-withdraw-input"), { target: { value } });
  it("asks for a new quote, not 'Refresh the price' / 'quote expired'", () => {
    const { rerender } = openWithdraw();
    useEarnExitV22.mockReturnValue(api("quoted", quote));
    edit("10");
    expect(screen.getByTestId("earn-exit-confirm")).toBeTruthy();
    // The hook drops the quote to idle when the amount changes.
    useEarnExitV22.mockReturnValue(api("idle"));
    edit("20");
    rerender(<DepositWithdrawPanel {...base} exitV22={exitV22} />);
    expect(screen.queryByTestId("earn-exit-expired")).toBeNull();
    expect(screen.getByTestId("earn-exit-get-quote").textContent).toBe("See exit price");
    expect(screen.getByTestId("earn-exit-amount-changed").textContent).toMatch(/changed the amount/i);
  });
  it("CONTROL: a real expiry (same amount) still says expired and offers a refresh", () => {
    const { rerender } = openWithdraw();
    useEarnExitV22.mockReturnValue(api("quoted", quote));
    edit("10");
    useEarnExitV22.mockReturnValue(api("idle"));
    rerender(<DepositWithdrawPanel {...base} exitV22={exitV22} />);
    expect(screen.getByTestId("earn-exit-expired")).toBeTruthy();
    expect(screen.getByTestId("earn-exit-get-quote").textContent).toMatch(/Refresh/i);
    expect(screen.queryByTestId("earn-exit-amount-changed")).toBeNull();
  });
});
