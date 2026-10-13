/**
 * #3459: the order ticket builds an open's worst-fill bound from the live feed and passes it to
 * the trade hooks as an explicit limit. That feed is checked against the on-chain price when the
 * button is pressed (before the confirm screen shows a worst price), and the feed price travels
 * with the limit (`limitFeedE6`) so useTrade / useFirstTrade check the same number at send time.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeLimitPriceE6, FEED_DISAGREES_TICKET_COPY, FeedDisagreementError } from "@/lib/slippage";

const mocks = vi.hoisted(() => ({
  useWalletCompat: vi.fn(),
  useConnectionCompat: vi.fn(),
  useUserAccount: vi.fn(),
  useSlabState: vi.fn(),
  useEngineState: vi.fn(),
  initUser: vi.fn(),
  fund: vi.fn(),
  trade: vi.fn(),
  feedE6: 1_000_000n as bigint,
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
vi.mock("@/lib/priceStore/priceStore", async (orig) => ({
  ...(await orig<object>()),
  getLivePriceSnapshot: () => ({ priceUsd: Number(mocks.feedE6) / 1e6, priceE6: mocks.feedE6 }),
}));
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
// An admin-oracle market that reads 1.000000 on chain (real resolveMarketPriceE6, not a stub).
const CHAIN_AT_ONE = {
  collateralMint: MINT, decimals: 6,
  oracleAuthority: new PublicKey(new Uint8Array(32).fill(7)), indexFeedId: PublicKey.default,
  authorityPriceE6: 1_000_000n, lastEffectivePriceE6: 1_000_000n,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.feedE6 = 1_000_000n;
  mocks.useWalletCompat.mockReturnValue({ publicKey: new PublicKey("11111111111111111111111111111111"), connected: true });
  mocks.useConnectionCompat.mockReturnValue({
    connection: { getTokenAccountBalance: vi.fn().mockResolvedValue({ value: { amount: "12000000", decimals: 6 } }) },
  });
  mocks.useUserAccount.mockReturnValue({ account: { capital: 100_000_000n, positionSize: 0n, entryPrice: 0n, pnl: 0n }, idx: 3 });
  mocks.useSlabState.mockReturnValue({
    accounts: [], config: CHAIN_AT_ONE, header: null, refresh: vi.fn(),
    programId: new PublicKey("11111111111111111111111111111111"),
  });
  mocks.useEngineState.mockReturnValue({ engine: null, params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n, tradingFeeBps: 30n }, insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true });
  mocks.trade.mockResolvedValue("sigTrade");
  mocks.fund.mockResolvedValue({ signature: "sigFirst", portfolio: new PublicKey("11111111111111111111111111111111"), prompts: 1, created: true });
});

async function pressOrder(sizeInput: string) {
  render(<OrderTicket slabAddress={SLAB} />);
  await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
  fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: sizeInput } });
  const btn = screen.getByTestId("trade-submit") as HTMLButtonElement;
  await waitFor(() => expect(btn.disabled).toBe(false));
  fireEvent.click(btn);
}

describe("#3459: the ticket checks the feed its worst price is built from", () => {
  it("feed 10% below the chain: no confirm screen, the ticket says why, nothing reaches the trade hook", async () => {
    mocks.feedE6 = 900_000n;
    await pressOrder("5");
    expect(screen.queryByTestId("confirm-trade")).toBeNull();
    expect(screen.getByText(FEED_DISAGREES_TICKET_COPY)).toBeTruthy();
    expect(mocks.trade).not.toHaveBeenCalled();
  });

  it("feed 10% above the chain is refused the same way", async () => {
    mocks.feedE6 = 1_100_000n;
    await pressOrder("5");
    expect(screen.queryByTestId("confirm-trade")).toBeNull();
    expect(screen.getByText(FEED_DISAGREES_TICKET_COPY)).toBeTruthy();
  });

  it("control: a feed 1% off the chain confirms, and the limit carries the feed it was built from", async () => {
    mocks.feedE6 = 1_010_000n;
    await pressOrder("5");
    fireEvent.click(await screen.findByTestId("confirm-trade"));
    await waitFor(() => expect(mocks.trade).toHaveBeenCalledTimes(1));
    const params = mocks.trade.mock.calls[0][0] as { limitPriceE6?: bigint; limitFeedE6?: bigint; size: bigint };
    expect(params.limitPriceE6).toBe(computeLimitPriceE6({ markE6: 1_010_000n, size: params.size }));
    expect(params.limitFeedE6).toBe(1_010_000n);
    expect(screen.queryByText(FEED_DISAGREES_TICKET_COPY)).toBeNull();
  });

  it("first trade (no account): the deposit-and-trade carries the feed too", async () => {
    mocks.useUserAccount.mockReturnValue(null);
    mocks.feedE6 = 1_010_000n;
    await pressOrder("5");
    fireEvent.click(await screen.findByTestId("confirm-trade"));
    await waitFor(() => expect(mocks.fund).toHaveBeenCalledTimes(1));
    const p = mocks.fund.mock.calls[0][0] as { limitPriceE6: bigint; limitFeedE6?: bigint; size: bigint };
    expect(p.limitPriceE6).toBe(computeLimitPriceE6({ markE6: 1_010_000n, size: p.size }));
    expect(p.limitFeedE6).toBe(1_010_000n);
  });

  it("first trade with a disagreeing feed is stopped before the confirm screen", async () => {
    mocks.useUserAccount.mockReturnValue(null);
    mocks.feedE6 = 900_000n;
    await pressOrder("5");
    expect(screen.queryByTestId("confirm-trade")).toBeNull();
    expect(mocks.fund).not.toHaveBeenCalled();
  });

  it("an on-chain price that can't be read does not block the ticket (the guard's no-op)", async () => {
    mocks.useSlabState.mockReturnValue({
      accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: vi.fn(),
      programId: new PublicKey("11111111111111111111111111111111"),
    });
    mocks.feedE6 = 900_000n;
    await pressOrder("5");
    expect(await screen.findByTestId("confirm-trade")).toBeTruthy();
  });

  it("a send-time refusal (the chain moved after the press) reads the same line, not 'Price moved'", async () => {
    // The press passes (feed 1% off). useTrade then refuses with the message it really throws.
    mocks.feedE6 = 1_010_000n;
    mocks.trade.mockRejectedValue(
      new FeedDisagreementError(
        "Price feed disagrees with the on-chain oracle by 300 bps (limit is 200). Refusing to derive a slippage limit " +
          "from it — the limit would not mean what the screen says. Wait for the feed to reconverge, or set an explicit limit price.",
      ),
    );
    await pressOrder("5");
    fireEvent.click(await screen.findByTestId("confirm-trade"));
    expect(await screen.findByText(FEED_DISAGREES_TICKET_COPY)).toBeTruthy();
    expect(screen.queryByText(/set an explicit limit price/)).toBeNull();
    expect(screen.queryByText(/The price moved while you were confirming/)).toBeNull();
    expect(mocks.trade).toHaveBeenCalledTimes(1); // not retried: the wallet never opened
  });
});
