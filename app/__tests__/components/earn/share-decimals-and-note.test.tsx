/**
 * v2.2: share counts use the share mint's OWN decimals (a vault from an earlier build keeps 0 for good; a new one is created with the
 * collateral's), and the #3276 wallet note is gated on the decimals difference and on the metadata record. Flag off: unchanged.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: vi.fn(() => ({ connected: true })), useConnectionCompat: () => ({ connection: {} }) }));
vi.mock("@/components/ui/GlowButton", () => ({
  GlowButton: ({ children, disabled, onClick, ...rest }: { children: React.ReactNode; disabled?: boolean; onClick?: () => void; "data-testid"?: string }) => (
    <button disabled={disabled} onClick={onClick} data-testid={rest["data-testid"]}>{children}</button>
  ),
}));

import { DepositWithdrawPanel } from "@/components/earn/DepositWithdrawPanel";
import { LpPositionDashboard } from "@/components/earn/LpPositionDashboard";
import { lpShareWalletNote, lpShareWalletNoteV22 } from "@/lib/lp-share-wallet-note";

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  vi.useRealTimers();
  __setDevnetV22ForTest(null);
});

// 1:1 vault (no pricing): 1,000 USDC deposit = 1,000,000,000 raw shares.
const props = {
  userBalance: 5_000_000_000n,
  userLpBalance: 2_500_000_000n,
  vaultBalance: 10_000_000_000n,
  lpSupply: 10_000_000_000n,
  vaultAvailable: true,
  decimals: 6,
  collateralSymbol: "USDC",
  loading: false,
  cooldownElapsed: true,
  cooldownSlots: 0n,
  onDeposit: vi.fn(),
  onWithdraw: vi.fn(),
};
const typeDeposit = (v: string) => fireEvent.change(screen.getByTestId("earn-deposit-input") ?? screen.getByTestId("earn-withdraw-input"), { target: { value: v } });
const previewText = () => screen.getByTestId("earn-deposit-preview").textContent ?? "";
const note = () => screen.queryByTestId("earn-lp-wallet-note");

describe("pure note gate", () => {
  it("unknown mint decimals: the conservative note, unchanged", () => {
    expect(lpShareWalletNoteV22({ appDecimals: 6, lpDecimals: null })).toBe(lpShareWalletNote(6));
    expect(lpShareWalletNoteV22({ appDecimals: 6 })).toBe(lpShareWalletNote(6));
  });
  it("equal decimals: no conversion; 'unnamed' only when the record is known absent", () => {
    expect(lpShareWalletNoteV22({ appDecimals: 6, lpDecimals: 6, metadataPresent: true })).toBeNull();
    expect(lpShareWalletNoteV22({ appDecimals: 6, lpDecimals: 6, metadataPresent: null })).toBeNull();
    const n = lpShareWalletNoteV22({ appDecimals: 6, lpDecimals: 6, metadataPresent: false })!;
    expect(n).toMatch(/unnamed token/);
    expect(n).not.toMatch(/raw units|1 share here/);
  });
  it("decimals differ (0-decimal mint printed in the collateral's scale): the real ratio; 'unnamed' only without metadata", () => {
    const unnamed = lpShareWalletNoteV22({ appDecimals: 6, lpDecimals: 0, metadataPresent: false })!;
    expect(unnamed).toBe(lpShareWalletNote(6)); // the interim note, byte for byte
    const named = lpShareWalletNoteV22({ appDecimals: 6, lpDecimals: 0, metadataPresent: true })!;
    expect(named).toContain("1 share here is 1,000,000 in your wallet");
    expect(named).toContain("under their name");
    expect(named).not.toMatch(/unnamed/);
    expect(lpShareWalletNoteV22({ appDecimals: 9, lpDecimals: 6, metadataPresent: null })).toContain("1 share here is 1,000 in your wallet");
    expect(lpShareWalletNoteV22({ appDecimals: 6, lpDecimals: 9 })).toMatch(/finer units/);
  });
});

describe("flag OFF (v2.1): shares in the collateral's decimals, the note always, exactly as before", () => {
  it("lpDecimals / lpMetadataPresent are ignored", () => {
    __setDevnetV22ForTest(false);
    render(<DepositWithdrawPanel {...props} lpDecimals={0} lpMetadataPresent />);
    fireEvent.change(screen.getByTestId("earn-deposit-input"), { target: { value: "1000" } });
    expect(previewText()).toMatch(/1,000\.00/);
    expect(note()?.textContent).toBe(lpShareWalletNote(6));
  });
});

describe("flag ON (v2.2)", () => {
  it("a 0-decimal share mint (earlier vault): shares are the RAW count, USDC keeps 6 decimals", () => {
    __setDevnetV22ForTest(true);
    render(<DepositWithdrawPanel {...props} lpDecimals={0} lpMetadataPresent />);
    fireEvent.change(screen.getByTestId("earn-deposit-input"), { target: { value: "1000" } });
    // 1,000 USDC = 1,000,000,000 raw shares at 1:1, shown with the mint's 0 decimals
    expect(previewText()).toMatch(/1,000,000,000\.00/);
    expect(note()).toBeNull(); // the page prints what the wallet shows, and the token is named
  });
  it("a share mint with the collateral's decimals (new vault): same numbers as v2.1, no note once named", () => {
    __setDevnetV22ForTest(true);
    render(<DepositWithdrawPanel {...props} lpDecimals={6} lpMetadataPresent />);
    fireEvent.change(screen.getByTestId("earn-deposit-input"), { target: { value: "1000" } });
    expect(previewText()).toMatch(/1,000\.00/);
    expect(note()).toBeNull();
  });
  it("no metadata on chain: only the unnamed-token line (no conversion), and nothing while it is still unread", () => {
    __setDevnetV22ForTest(true);
    const { unmount } = render(<DepositWithdrawPanel {...props} lpDecimals={6} lpMetadataPresent={false} />);
    fireEvent.change(screen.getByTestId("earn-deposit-input"), { target: { value: "5" } });
    expect(note()?.textContent).toMatch(/unnamed token/);
    expect(note()?.textContent).not.toMatch(/1 share here/);
    unmount();
    render(<DepositWithdrawPanel {...props} lpDecimals={6} lpMetadataPresent={null} />);
    fireEvent.change(screen.getByTestId("earn-deposit-input"), { target: { value: "5" } });
    expect(note()).toBeNull();
  });
  it("lpDecimals not passed: falls back to the collateral's decimals and the conservative note (cannot tell)", () => {
    __setDevnetV22ForTest(true);
    render(<DepositWithdrawPanel {...props} />);
    fireEvent.change(screen.getByTestId("earn-deposit-input"), { target: { value: "5" } });
    expect(note()?.textContent).toBe(lpShareWalletNote(6));
  });
  it("a withdrawal asked for in shares is typed in the mint's decimals (0-decimal mint: 7 shares = 7 raw)", () => {
    __setDevnetV22ForTest(true);
    const onWithdraw = vi.fn(async () => ({ step: "executed" as const }));
    render(<DepositWithdrawPanel {...props} onWithdraw={onWithdraw} lpDecimals={0} lpMetadataPresent userLpBalance={2_500_000_000n} />);
    fireEvent.click(screen.getAllByTestId("earn-tab").find((t) => t.dataset.tab === "withdraw")!);
    fireEvent.click(screen.getByTestId("earn-withdraw-unit"));
    fireEvent.change(screen.getByTestId("earn-withdraw-input"), { target: { value: "7" } });
    expect(screen.getByTestId("earn-withdraw-receive").textContent).toMatch(/\(7\.00 shares\)/);
  });
});

describe("the Earn shares stat uses the share mint's own decimals", () => {
  const base = { userLpBalance: 1_000_000_000n, lpSupply: 2_000_000_000n, vaultBalance: 2_200_000_000n, decimals: 6, collateralSymbol: "USDC", redemptionRateE6: 1_100_000n, loading: false };
  it("0-decimal mint: the raw count; 6-decimal mint: the scaled count (both flags, the stat was already mint-scaled)", () => {
    const { unmount } = render(<LpPositionDashboard {...base} lpDecimals={0} />);
    expect(screen.getByText("Shares").nextSibling?.textContent ?? document.body.textContent).toMatch(/1,000,000,000\.00/);
    unmount();
    render(<LpPositionDashboard {...base} lpDecimals={6} />);
    expect(document.body.textContent).toMatch(/Shares1,000\.00/);
  });
});
