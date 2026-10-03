/**
 * Finding #3: the confirm modal's Risk Lev. was this order's notional over the capital from
 * before any deposit, so it ignored the position already open (understated on a scale-in,
 * overstated on a reduce) and the deposit bundled into a fund-and-trade (overstated), and
 * the modal never showed that deposit. It now describes the account the trade leaves, on
 * the same basis as the liquidation row: resulting position over capital + deposit + pnl.
 * Renders the real OrderTicket; the modal is mocked to capture its props.
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
  modal: null as null | Record<string, unknown>,
  priceE6: 1_000_000n,
  decimals: 6,
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
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ symbol: "USDC", decimals: mocks.decimals }) }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: { symbol: "SOL-PERP", max_leverage: 10 } }) }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ isStale: false, stale: false }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: false }) }));
vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyLogin: () => vi.fn(), usePrivyAvailable: () => false }));
vi.mock("@/hooks/useWalletAdapterAvailable", () => ({ useWalletAdapterAvailable: () => true }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/priceStore/priceStore", async (orig) => ({ ...(await orig<object>()), getLivePriceSnapshot: () => ({ priceUsd: Number(mocks.priceE6) / 1e6, priceE6: mocks.priceE6 }) }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccountIdle: () => null, getMockUserAccount: () => null }));
vi.mock("@/lib/tx", () => ({ prewarmTxLanding: vi.fn() }));
vi.mock("@/components/trade/DepositWithdrawCard", () => ({ DepositWithdrawCard: () => <div data-testid="deposit-card" /> }));
vi.mock("@/components/trade/TradeConfirmationModal", () => ({
  TradeConfirmationModal: (p: Record<string, unknown>) => {
    mocks.modal = p;
    return <div data-testid="confirm-modal" />;
  },
}));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));

import { OrderTicket } from "@/components/trade/OrderTicket";

const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";
const MINT = new PublicKey("So11111111111111111111111111111111111111112");

function wallet(amount: string) {
  mocks.useConnectionCompat.mockReturnValue({
    connection: { getTokenAccountBalance: vi.fn().mockResolvedValue({ value: { amount, decimals: mocks.decimals } }) },
  });
}
function account(capital: bigint, positionSize = 0n, pnl = 0n) {
  mocks.useUserAccount.mockReturnValue({ account: { capital, positionSize, entryPrice: 1_000_000n, pnl }, idx: 3 });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.modal = null;
  mocks.priceE6 = 1_000_000n;
  mocks.decimals = 6;
  mocks.useWalletCompat.mockReturnValue({ publicKey: new PublicKey("11111111111111111111111111111111"), connected: true });
  wallet("0");
  mocks.useUserAccount.mockReturnValue(null);
  mocks.useSlabState.mockReturnValue({
    accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: vi.fn(),
    programId: new PublicKey("11111111111111111111111111111111"),
  });
  mocks.useEngineState.mockReturnValue({ engine: null, params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n, tradingFeeBps: 30n }, insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true });
});

const submit = () => screen.getByTestId("trade-submit") as HTMLButtonElement;
const size = (v: string) => fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: v } });

async function openConfirm(direction: "long" | "short", amount: string) {
  render(<OrderTicket slabAddress={SLAB} />);
  await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
  if (direction === "short") fireEvent.click(screen.getByTestId("trade-side-short"));
  size(amount);
  await act(async () => fireEvent.click(submit()));
  expect(mocks.modal).not.toBeNull();
  return mocks.modal!;
}

// Orders below are at 1x and a $1 price unless noted, so an order of "5" is a $5 position.
describe("confirm modal Risk Lev. describes the account after the trade", () => {
  it("scale-in counts the position already open (was understated)", async () => {
    account(100_000_000n, 300_000_000n); // 100 USDC, long 300
    const p = await openConfirm("long", "5");
    expect(p.riskLeverage).toBe(3.05); // (300 + 5) / 100; before: 5 / 100
  });

  it("a reduce shrinks it (was shown as added exposure)", async () => {
    account(100_000_000n, 300_000_000n);
    const p = await openConfirm("short", "5");
    expect(p.riskLeverage).toBe(2.95);
  });

  it("a full close hides the row", async () => {
    account(100_000_000n, 50_000_000n);
    const p = await openConfirm("short", "50");
    expect(p.riskLeverage).toBeNull();
  });

  it("a flip uses the position left on the other side", async () => {
    account(100_000_000n, 50_000_000n);
    const p = await openConfirm("short", "80");
    expect(p.riskLeverage).toBe(0.3); // short 30 / 100
  });

  it("fund-and-trade counts the bundled deposit and passes it to the modal", async () => {
    wallet("12000000");
    account(1_000_000n); // 1 USDC; a $5 order bundles a 4.42 deposit
    const p = await openConfirm("long", "5");
    expect(p.riskLeverage).toBe(0.92); // 5 / 5.42; before: 5 / 1
    expect(p.depositAmount).toBe(4_420_000n);
  });

  it("a first trade with no account shows the row, on the deposit", async () => {
    wallet("12000000");
    const p = await openConfirm("long", "5"); // bundles 5.52
    expect(p.riskLeverage).toBe(0.91);
    expect(p.depositAmount).toBe(5_520_000n);
  });

  it("pnl is part of the collateral, as on the position panel's Lev", async () => {
    account(100_000_000n, 300_000_000n, -50_000_000n);
    const p = await openConfirm("long", "5");
    expect(p.riskLeverage).toBe(6.1); // 305 / 50
  });

  it("CONTROL: a flat account with no deposit keeps today's figure and no deposit", async () => {
    account(100_000_000n);
    const p = await openConfirm("long", "5");
    expect(p.riskLeverage).toBe(0.05);
    expect(p.depositAmount).toBe(0n);
  });

  it("CONTROL: a flat account at a non-round price reads 1, not 0.9999", async () => {
    mocks.priceE6 = 150_123_457n;
    account(100_000_000n);
    const p = await openConfirm("long", "100");
    expect(p.riskLeverage).toBe(1);
  });

  it("CONTROL: a flat account on 9-decimal collateral keeps today's figure", async () => {
    mocks.decimals = 9;
    wallet("0");
    account(100_000_000_000n); // 100 units at 9 decimals
    const p = await openConfirm("long", "5");
    expect(p.riskLeverage).toBe(0.05);
  });
});
