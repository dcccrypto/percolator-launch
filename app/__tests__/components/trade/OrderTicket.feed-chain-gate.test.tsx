/**
 * S2: GH#2525 refuses an order when the live feed disagrees with the on-chain price by more than
 * 200 bps, because the order's limit is derived from the feed. useTrade only checks a limit it
 * derives itself; the ticket always passes its own feed-derived limit (and fund-and-trade never
 * reaches useTrade), so the check never ran for a ticket order. It now runs when the confirm opens.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useWalletCompat: vi.fn(),
  useConnectionCompat: vi.fn(),
  useUserAccount: vi.fn(),
  useSlabState: vi.fn(),
  useEngineState: vi.fn(),
  trade: vi.fn(),
  check: vi.fn(),
  refresh: vi.fn(),
  chainE6: 1_000_000n as bigint | (() => bigint),
}));

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: mocks.useWalletCompat, useConnectionCompat: mocks.useConnectionCompat }));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount, useUserAccountScanPending: () => false }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: mocks.useEngineState }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddressSync: vi.fn(() => new PublicKey("11111111111111111111111111111111")) }));
vi.mock("@/hooks/useTrade", () => ({ useTrade: () => ({ trade: mocks.trade, loading: false, error: null }), prewarmTradeSubmission: vi.fn() }));
vi.mock("@/hooks/useMarketFillCap", () => ({ useMarketFillCap: () => null }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => null }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ isStale: false, stale: false }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: false }) }));
vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyLogin: () => vi.fn(), usePrivyAvailable: () => false }));
vi.mock("@/hooks/useWalletAdapterAvailable", () => ({ useWalletAdapterAvailable: () => true }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 1_000_000n, priceUsd: 1 }) }));
vi.mock("@/lib/oraclePrice", async (orig) => ({
  ...(await orig<object>()),
  resolveMarketPriceE6: () => (typeof mocks.chainE6 === "function" ? mocks.chainE6() : mocks.chainE6),
}));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/priceStore/priceStore", async (orig) => ({
  ...(await orig<object>()),
  getLivePriceSnapshot: () => ({ priceUsd: 1, priceE6: 1_000_000n }),
}));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccountIdle: () => null, getMockUserAccount: () => null }));
vi.mock("@/lib/tx", async (orig) => ({
  ...(await orig<typeof import("@/lib/tx")>()),
  prewarmTxLanding: vi.fn(),
  checkSignatureLanded: mocks.check,
}));
vi.mock("@/components/trade/DepositWithdrawCard", () => ({ DepositWithdrawCard: () => null }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));
vi.mock("@/components/trade/TradeConfirmationModal", () => ({
  TradeConfirmationModal: (p: { onConfirm: () => void }) => (
    <button data-testid="confirm-trade" onClick={p.onConfirm}>confirm</button>
  ),
}));

import { OrderTicket } from "@/components/trade/OrderTicket";

const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";
const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const submit = async () => {
  fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5" } });
  await act(async () => { fireEvent.click(screen.getByTestId("trade-submit")); });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useWalletCompat.mockReturnValue({ publicKey: new PublicKey("11111111111111111111111111111111"), connected: true });
  mocks.useConnectionCompat.mockReturnValue({ connection: { tag: "conn" } });
  mocks.useUserAccount.mockReturnValue({ account: { capital: 1_000_000_000n, positionSize: 0n, entryPrice: 0n, pnl: 0n }, accountIndex: 0 });
  mocks.useSlabState.mockReturnValue({ accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: mocks.refresh, programId: new PublicKey("11111111111111111111111111111111") });
  mocks.useEngineState.mockReturnValue({ engine: null, params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n }, insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true });
});
afterEach(() => cleanup());

describe("ticket order: the feed must agree with the chain before the confirm opens (S2)", () => {
  it("feed 5% off the on-chain price: refused with the reason, no confirm, nothing sent, slab re-read", async () => {
    mocks.chainE6 = 1_050_000n; // feed reads $1.00
    render(<OrderTicket slabAddress={SLAB} />);
    await submit();
    expect(screen.queryByTestId("confirm-trade")).toBeNull();
    expect(screen.getByText(/Price feed disagrees with the on-chain oracle/)).toBeTruthy();
    expect(mocks.trade).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("CONTROL: feed within the bound opens the confirm as before", async () => {
    mocks.chainE6 = 1_001_000n;
    render(<OrderTicket slabAddress={SLAB} />);
    await submit();
    expect(screen.getByTestId("confirm-trade")).toBeTruthy();
  });

  it("an unreadable on-chain price is no check, not a refusal", async () => {
    mocks.chainE6 = () => { throw new TypeError("no oracle config"); };
    render(<OrderTicket slabAddress={SLAB} />);
    await submit();
    expect(screen.getByTestId("confirm-trade")).toBeTruthy();
  });
});

describe("the refusal is what the trader sees (S2 review)", () => {
  const confirmIfOpen = async () => {
    const c = screen.queryByTestId("confirm-trade");
    if (c) await act(async () => { fireEvent.click(c); });
  };

  it("an earlier on-chain refusal doesn't hide it: the slot shows the feed reason, not the old one", async () => {
    mocks.chainE6 = 1_000_000n;
    // EngineLockActive (21): shown as its own message, which the status slot ranks above humanError.
    mocks.trade.mockRejectedValueOnce(new Error("Transaction simulation failed: custom program error: 0x15"));
    render(<OrderTicket slabAddress={SLAB} />);
    await submit();
    await confirmIfOpen();
    expect(mocks.trade).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("trade-error").dataset.kind).not.toBe("trade"); // the earlier refusal or lock is showing
    await act(async () => { await new Promise((r) => setTimeout(r, 1_300)); }); // the error phase re-enables submit
    mocks.chainE6 = 1_050_000n; // the feed now disagrees; same size, click again
    await act(async () => { fireEvent.click(screen.getByTestId("trade-submit")); });
    expect(screen.queryByTestId("confirm-trade")).toBeNull();
    expect(screen.getByText(/Price feed disagrees with the on-chain oracle/)).toBeTruthy();
  });

  it("once the feed agrees again, the next click opens the confirm and the banner goes", async () => {
    mocks.chainE6 = 1_050_000n;
    render(<OrderTicket slabAddress={SLAB} />);
    await submit();
    expect(screen.getByText(/Price feed disagrees/)).toBeTruthy();
    mocks.chainE6 = 1_000_000n;
    await act(async () => { fireEvent.click(screen.getByTestId("trade-submit")); });
    expect(screen.getByTestId("confirm-trade")).toBeTruthy();
    expect(screen.queryByText(/Price feed disagrees/)).toBeNull();
  });
});
