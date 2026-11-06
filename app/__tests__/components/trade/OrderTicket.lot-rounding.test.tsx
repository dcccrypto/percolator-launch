/**
 * Council GO1106 (trader seat): on a lot market the ticket quoted the typed size while the fill was rounded down to
 * whole lots, and a size under one lot just disabled the button with no reason.
 *   PENGU: 1 lot = 10,000 PENGU = $66.12 (the per-LOT mark). Typed $100 at 1x opens ONE lot.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bandView: null as unknown,
  lotExp: 0,
  scanPending: false,
  useWalletCompat: vi.fn(),
  useConnectionCompat: vi.fn(),
  useUserAccount: vi.fn(),
  useSlabState: vi.fn(),
  useEngineState: vi.fn(),
  initUser: vi.fn(),
  fund: vi.fn(),
  trade: vi.fn(),
  rawSnap: vi.fn(() => null as unknown),
  closable: vi.fn(() => ({ closable: false }) as { closable: boolean }),
}));

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: mocks.useWalletCompat, useConnectionCompat: mocks.useConnectionCompat }));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount, useUserAccountScanPending: () => mocks.scanPending }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: mocks.useEngineState }));
vi.mock("@/hooks/useInitUser", () => ({ useInitUser: () => ({ initUser: mocks.initUser, loading: false, error: null }) }));
vi.mock("@/hooks/useFirstTrade", () => ({ useFirstTrade: () => ({ fundAndTrade: mocks.fund, loading: false }) }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddressSync: vi.fn(() => new PublicKey("11111111111111111111111111111111")) }));
vi.mock("@/hooks/useTrade", () => ({ useTrade: () => ({ trade: mocks.trade, loading: false, error: null }), prewarmTradeSubmission: vi.fn() }));
vi.mock("@/hooks/useBandRentView", () => ({ useBandRentView: () => mocks.bandView }));
vi.mock("@/hooks/useMarketFillCap", () => ({ useMarketFillCap: () => null }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ symbol: "USDC", decimals: 6 }) }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: { symbol: "PENGU-PERP", max_leverage: 10 } }) }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ isStale: false, stale: false }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: false }) }));
vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyLogin: () => vi.fn(), usePrivyAvailable: () => false }));
vi.mock("@/hooks/useWalletAdapterAvailable", () => ({ useWalletAdapterAvailable: () => true }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/priceStore/priceStore", async (orig) => ({ ...(await orig<object>()), getLivePriceSnapshot: () => ({ priceUsd: 66.12, priceE6: 66_120_000n }) }));
vi.mock("@/lib/v22/lot", async (orig) => ({ ...(await orig<object>()), lotExpOf: () => mocks.lotExp }));
vi.mock("@/hooks/useLotTradingGuard", () => ({ useLotTradingGuard: () => null }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccountIdle: () => null, getMockUserAccount: () => null }));
vi.mock("@/lib/tx", () => ({ prewarmTxLanding: vi.fn() }));
vi.mock("@/components/trade/DepositWithdrawCard", () => ({ DepositWithdrawCard: () => <div data-testid="deposit-card" /> }));
vi.mock("@/components/trade/TradeConfirmationModal", () => ({
  TradeConfirmationModal: (p: { onConfirm: () => void }) => <button data-testid="confirm-trade" onClick={p.onConfirm}>confirm</button>,
}));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));
vi.mock("@/lib/userAccountScan", async (orig) => ({ ...(await orig<object>()), getPortfolioRawSnapshot: () => mocks.rawSnap() }));
vi.mock("@/lib/close-trading-account", async (orig) => ({ ...(await orig<object>()), isPortfolioClosable: () => mocks.closable() }));

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
  mocks.rawSnap.mockReturnValue(null);
  mocks.closable.mockReturnValue({ closable: false });
  mocks.bandView = null;
  mocks.scanPending = false;
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

describe("council GO1106: the ticket shows the lot-rounded order", () => {
  beforeEach(() => {
    mocks.lotExp = 4;
    mocks.useUserAccount.mockReturnValue({ account: { capital: 500_000_000n, positionSize: 0n, entryPrice: 0n, pnl: 0n }, idx: 3 });
  });
  afterEach(() => { mocks.lotExp = 0; });

  it("$100 typed opens 1 lot (10,000 PENGU, about $66.12) and says so; margin follows the rounded size", async () => {
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("100");
    const line = await screen.findByTestId("lot-rounded");
    expect(line.textContent).toContain("10,000 PENGU (1 lot, about $66.12)");
    // the margin shown is for the $66.12 that is sent, not the $100 typed (1x)
    expect(document.body.textContent).toMatch(/Margin\s*66\.12\d* USDC/);
    expect(document.body.textContent).not.toMatch(/Margin\s*100(\.0+)? USDC/);
    expect(screen.queryByTestId("lot-below-min")).toBeNull();
    expect(submit().disabled).toBe(false);
  });

  it("$0.50 typed is below one lot: the reason and the minimum are on screen, and 'Use 1 lot' fills it", async () => {
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("0.5");
    const msg = await screen.findByTestId("lot-below-min");
    expect(msg.textContent).toContain("Minimum order here is 1 lot = 10,000 PENGU (about $66.12)");
    expect(submit().disabled).toBe(true);
    expect(submit().textContent).toContain("Below the 1-lot minimum");
    await act(async () => fireEvent.click(screen.getByTestId("lot-use-one")));
    await waitFor(() => expect(screen.queryByTestId("lot-below-min")).toBeNull());
    expect(submit().disabled).toBe(false);
  });

  it("NEGATIVE CONTROL: no lots (lotExp 0) shows neither line", async () => {
    mocks.lotExp = 0;
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("100");
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByTestId("lot-rounded")).toBeNull();
    expect(screen.queryByTestId("lot-below-min")).toBeNull();
  });
});
