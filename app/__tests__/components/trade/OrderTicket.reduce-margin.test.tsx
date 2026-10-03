/**
 * Finding #2: an Open-tab order on the other side of the open position was charged its full
 * margin as new exposure, so a reduce or close with little free margin asked for a deposit
 * ("Deposit X & Short") and showed "Available to trade" falling. The program only checks
 * initial margin when the trade leaves the position at least as large as before, so a reduce,
 * a close and a flip that ends smaller need no deposit; a flip that ends larger is charged on
 * the part past the old position.
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
const short = () => fireEvent.click(screen.getByTestId("trade-side-short"));
const acct = (capital: bigint, positionSize: bigint) => ({ account: { capital, positionSize, entryPrice: 1_000_000n, pnl: 0n }, idx: 3 });
// Long 10 SOL @ $1, IM 10% => 1 USDC locked; capital 2 => 1 USDC free on this market.
const LONG_10 = acct(2_000_000n, 10_000_000n);

async function ticket(account: unknown) {
  mocks.useUserAccount.mockReturnValue(account);
  render(<OrderTicket slabAddress={SLAB} />);
  await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
}
function available() {
  fireEvent.click(screen.getByTestId("ticket-details-toggle"));
  return screen.getByTestId("ticket-details").textContent?.match(/Available to trade(.*?USDC.*?USDC)/)?.[1];
}

describe("Open-tab order against the open position", () => {
  it("a partial reduce asks for no deposit and frees margin", async () => {
    await ticket(LONG_10);
    short();
    size("5");
    expect(submit().textContent).toBe("Short SOL 1×");
    expect(available()).toBe("1 USDC→1.5 USDC");
  });

  it("a full close through the Open tab asks for no deposit", async () => {
    await ticket(LONG_10);
    short();
    size("10");
    expect(submit().textContent).toBe("Short SOL 1×");
    expect(available()).toBe("1 USDC→2 USDC");
  });

  it("is symmetric for a short position", async () => {
    await ticket(acct(2_000_000n, -10_000_000n));
    size("5");
    expect(submit().textContent).toBe("Long SOL 1×");
  });

  it("a flip that ends smaller than the position asks for no deposit", async () => {
    await ticket(LONG_10);
    short();
    size("15");
    expect(submit().textContent).toBe("Short SOL 1×");
  });

  it("a flip that ends as large as the position is charged on the part past it", async () => {
    await ticket(LONG_10);
    short();
    size("20"); // short 10 after: |next| = |current| keeps the check; 10 USDC at 1x vs 2 USDC of capital
    expect(submit().textContent).toMatch(/^Deposit [0-9.]+ USDC & Short$/);
  });

  it("a reduce on an account under its locked margin asks for no deposit", async () => {
    await ticket(acct(500_000n, 10_000_000n)); // capital 0.5 < 1 USDC locked
    short();
    size("5");
    expect(submit().textContent).toBe("Short SOL 1×");
  });

  it("CONTROL: a same-side add is unchanged and still asks for a deposit", async () => {
    await ticket(LONG_10);
    size("5");
    expect(submit().textContent).toMatch(/^Deposit [0-9.]+ USDC & Long$/);
  });

  it("CONTROL: same-side receipt is unchanged", async () => {
    await ticket(LONG_10);
    size("0.5");
    expect(available()).toBe("1 USDC→0.5 USDC");
  });

  it("CONTROL: flat-account receipt is unchanged", async () => {
    await ticket(acct(2_000_000n, 0n));
    size("0.5");
    expect(available()).toBe("2 USDC→1.5 USDC");
  });
});
