/**
 * GH#2959: a first fund-and-trade the user turns down in the wallet must leave a calm line in the
 * ticket ("Trade cancelled in your wallet."), never a silent reset. Other cancels stay quiet.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useWalletCompat: vi.fn(),
  useConnectionCompat: vi.fn(),
  useUserAccount: vi.fn(),
  useSlabState: vi.fn(),
  useEngineState: vi.fn(),
  initUser: vi.fn(),
  fund: vi.fn(),
  trade: vi.fn(),
}));

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: mocks.useWalletCompat, useConnectionCompat: mocks.useConnectionCompat }));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: mocks.useEngineState }));
vi.mock("@/hooks/useInitUser", () => ({ useInitUser: () => ({ initUser: mocks.initUser, loading: false, error: null }) }));
vi.mock("@/hooks/useFirstTrade", () => ({ useFirstTrade: () => ({ fundAndTrade: mocks.fund, loading: false }) }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddressSync: vi.fn(() => new PublicKey("11111111111111111111111111111111")) }));
vi.mock("@/hooks/useTrade", () => ({ useTrade: () => ({ trade: mocks.trade, loading: false, error: null }), prewarmTradeSubmission: vi.fn() }));
vi.mock("@/hooks/useMarketFillCap", () => ({ useMarketFillCap: () => null }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ symbol: "USDC", decimals: 6 }) }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: { symbol: "SOL-PERP", max_leverage: 10 } }) }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ isStale: false, stale: false }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: false }) }));
vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyLogin: () => vi.fn(), usePrivyAvailable: () => false }));
vi.mock("@/hooks/useWalletAdapterAvailable", () => ({ useWalletAdapterAvailable: () => true }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/priceStore/priceStore", async (orig) => ({ ...(await orig<object>()), getLivePriceSnapshot: () => ({ priceUsd: 1, priceE6: 1_000_000n }) }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccountIdle: () => null, getMockUserAccount: () => null }));
vi.mock("@/lib/tx", () => ({ prewarmTxLanding: vi.fn() }));
vi.mock("@/components/trade/DepositWithdrawCard", () => ({ DepositWithdrawCard: () => <div data-testid="deposit-card" /> }));
vi.mock("@/components/trade/TradeConfirmationModal", () => ({
  TradeConfirmationModal: (p: { onConfirm: () => void }) => <button data-testid="confirm-trade" onClick={p.onConfirm}>confirm</button>,
}));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));

import { OrderTicket } from "@/components/trade/OrderTicket";

const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";
const MINT = new PublicKey("So11111111111111111111111111111111111111112");

function wallet(amount: string) {
  mocks.useConnectionCompat.mockReturnValue({
    connection: { getTokenAccountBalance: vi.fn().mockResolvedValue({ value: { amount, decimals: 6 } }) },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useWalletCompat.mockReturnValue({ publicKey: new PublicKey("11111111111111111111111111111111"), connected: true });
  wallet("12000000"); // 12 USDC in the wallet
  mocks.useUserAccount.mockReturnValue(null); // no trading account on this market yet
  mocks.useSlabState.mockReturnValue({
    accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: vi.fn(),
    programId: new PublicKey("11111111111111111111111111111111"),
  });
  mocks.useEngineState.mockReturnValue({ engine: null, params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n, tradingFeeBps: 30n }, insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true });
  mocks.fund.mockResolvedValue({ signature: "sigFirst", portfolio: new PublicKey("11111111111111111111111111111111"), prompts: 1, created: true });
});

const submit = () => screen.getByTestId("trade-submit") as HTMLButtonElement;
const size = (v: string) => fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: v } });

async function place() {
  await act(async () => fireEvent.click(submit()));
  await act(async () => fireEvent.click(screen.getByTestId("confirm-trade")));
}

const rejected = () => Object.assign(new Error("User rejected the request."), { code: 4001 });

describe("GH#2959 wallet rejection on the first trade", () => {
  it("no account: rejecting in the wallet shows 'Trade cancelled in your wallet.'", async () => {
    mocks.fund.mockRejectedValueOnce(rejected());
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("5");
    await place();
    await waitFor(() => expect(screen.queryByTestId("status-line")).not.toBeNull());
    expect(screen.getByTestId("status-line").dataset.kind).toBe("cancelled");
    expect(screen.getByTestId("status-line-body").textContent).toBe("Trade cancelled in your wallet.");
    // the ticket is usable again
    expect(submit().disabled).toBe(false);
  });

  it("NEGATIVE CONTROL: a funded account's plain trade rejected in the wallet stays quiet", async () => {
    mocks.useUserAccount.mockReturnValue({ account: { capital: 100_000_000n, positionSize: 0n, entryPrice: 0n, pnl: 0n }, idx: 3 });
    mocks.trade.mockRejectedValue(rejected());
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("5");
    await place();
    await waitFor(() => expect(mocks.trade).toHaveBeenCalled());
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(mocks.fund).not.toHaveBeenCalled();
    expect(screen.queryByTestId("status-line")).toBeNull();
  });

  it("the line clears on the next submit", async () => {
    mocks.fund.mockRejectedValueOnce(rejected());
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("5");
    await place();
    await waitFor(() => expect(screen.queryByTestId("status-line")).not.toBeNull());
    await place();
    await waitFor(() => expect(mocks.fund).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Trade cancelled in your wallet.")).toBeNull();
  });
});
