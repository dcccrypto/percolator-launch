/**
 * The order ticket labelled position size with marketInfo?.symbol ?? collateralSymbol: "5 USDC"
 * for a SOL position while market info was missing, and "5 SOL-PERP" once it loaded. Size is in
 * the BASE asset, so the confirmation and the close form now get the same base ticker as the
 * size input ("SOL", or the neutral "TOKEN" before market info loads).
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
  market: { symbol: "SOL-PERP", max_leverage: 10 } as { symbol: string; max_leverage: number } | null,
  modalSymbol: [] as string[],
  closeSymbol: [] as string[],
}));

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: mocks.useWalletCompat, useConnectionCompat: mocks.useConnectionCompat }));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount, useUserAccountScanPending: () => false }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: mocks.useEngineState }));
vi.mock("@/hooks/useInitUser", () => ({ useInitUser: () => ({ initUser: mocks.initUser, loading: false, error: null }) }));
vi.mock("@/hooks/useFirstTrade", () => ({ useFirstTrade: () => ({ fundAndTrade: mocks.fund, loading: false }) }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddressSync: vi.fn(() => new PublicKey("11111111111111111111111111111111")) }));
vi.mock("@/hooks/useTrade", () => ({ useTrade: () => ({ trade: mocks.trade, loading: false, error: null }), prewarmTradeSubmission: vi.fn() }));
vi.mock("@/hooks/useMarketFillCap", () => ({ useMarketFillCap: () => null }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ symbol: "USDC", decimals: 6 }) }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: mocks.market }) }));
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
  TradeConfirmationModal: (p: { symbol: string }) => {
    mocks.modalSymbol.push(p.symbol);
    return <div data-testid="confirm-trade" />;
  },
}));
vi.mock("@/components/trade/OrderTicketClosePanel", () => ({
  OrderTicketClosePanel: (p: { symbol: string }) => {
    mocks.closeSymbol.push(p.symbol);
    return <div data-testid="close-panel" />;
  },
}));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));

import { OrderTicket } from "@/components/trade/OrderTicket";

const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";
const MINT = new PublicKey("So11111111111111111111111111111111111111112");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.modalSymbol.length = 0;
  mocks.closeSymbol.length = 0;
  mocks.useWalletCompat.mockReturnValue({ publicKey: new PublicKey("11111111111111111111111111111111"), connected: true });
  mocks.useConnectionCompat.mockReturnValue({
    connection: { getTokenAccountBalance: vi.fn().mockResolvedValue({ value: { amount: "12000000", decimals: 6 } }) },
  });
  mocks.useUserAccount.mockReturnValue(null);
  mocks.useSlabState.mockReturnValue({
    accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: vi.fn(),
    programId: new PublicKey("11111111111111111111111111111111"),
  });
  mocks.useEngineState.mockReturnValue({ engine: null, params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n, tradingFeeBps: 30n }, insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true });
});

async function openConfirmation() {
  render(<OrderTicket slabAddress={SLAB} />);
  await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
  fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5" } });
  await act(async () => fireEvent.click(screen.getByTestId("trade-submit")));
  expect(screen.getByTestId("confirm-trade")).toBeTruthy();
}

describe("position size is labelled with the base asset", () => {
  it("confirmation: SOL, not SOL-PERP", async () => {
    mocks.market = { symbol: "SOL-PERP", max_leverage: 10 };
    await openConfirmation();
    expect(mocks.modalSymbol.at(-1)).toBe("SOL");
  });

  it("confirmation without market info: TOKEN, never the collateral (USDC)", async () => {
    mocks.market = null;
    await openConfirmation();
    expect(mocks.modalSymbol.at(-1)).toBe("TOKEN");
  });

  it("close form gets the base asset too", async () => {
    mocks.market = null;
    render(<OrderTicket slabAddress={SLAB} />);
    fireEvent.click(screen.getAllByTestId("trade-mode-tab").find((b) => b.getAttribute("data-mode") === "close")!);
    expect(mocks.closeSymbol.at(-1)).toBe("TOKEN");
  });
});
