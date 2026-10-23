/**
 * With no size (empty or zero) the open button says what is missing ("Enter a size")
 * instead of naming an order of nothing: "Deposit 0.00 USDC & Long" on a first trade,
 * "Long SOL 1×" for a funded account. It stays disabled, as before; a typed size brings
 * the order label back.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount, useUserAccountScanPending: () => false }));
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

describe("order button with no size", () => {
  it("first trade (no account, tokens in the wallet): 'Enter a size', not 'Deposit 0.00 USDC & Long'", async () => {
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    expect(submit().textContent).toBe("Enter a size");
    expect(submit().disabled).toBe(true);
    size("5");
    expect(submit().textContent).toBe("Deposit 5.52 USDC & Long");
    expect(submit().disabled).toBe(false);
  });

  it("a zero size reads the same as an empty one", async () => {
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    size("0");
    expect(submit().textContent).toBe("Enter a size");
    expect(submit().disabled).toBe(true);
  });

  it("a funded account: 'Enter a size', then the order once a size is typed", async () => {
    mocks.useUserAccount.mockReturnValue({ account: { capital: 100_000_000n, positionSize: 0n, entryPrice: 0n, pnl: 0n }, idx: 3 });
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    expect(submit().textContent).toBe("Enter a size");
    expect(submit().disabled).toBe(true);
    size("5");
    expect(submit().textContent).toBe("Long SOL 1×");
    expect(submit().disabled).toBe(false);
  });
});
