/**
 * The ticket's after-trade preview (liquidation price, margin health, the confirm modal) on a reduce or a
 * flip priced the remaining position on the pre-trade capital with the old entry, so the closed slice's
 * PnL dropped out: cutting a losing position read as covered, a flip hid the old leg's loss, and cutting
 * a winner read riskier than it is. Renders the real OrderTicket; the modal is mocked to capture its props.
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
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount, useUserAccountScanPending: () => false }));
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
function account(capital: bigint, positionSize = 0n, pnl = 0n, entryPrice = 1_000_000n) {
  mocks.useUserAccount.mockReturnValue({ account: { capital, positionSize, entryPrice, pnl }, idx: 3 });
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

// The engine's long liquidation formula (lib/liquidation-risk.ts), in $ for the expectations below.
const MM = 0.05;
const longLiq = (entry: number, equity: number, q: number) => Math.max(0, (entry * q - equity) / (q * (1 - MM)));
const shortLiq = (entry: number, equity: number, q: number) => (entry * q + equity) / (q * (1 + MM));
const usd = (e6: unknown) => Number(e6 as bigint) / 1e6;
type Display = { kind: string; marginHealthPct: number | null };

// The mark is $1 and the fee 30 bps, so a closing short fills at ~0.997 and the residual of a flip enters there.
// Entry 1.6667 with $8.33 capital is the reviewer's example (long 10 @100, mark 60, $500) scaled to a $1 mark.
const ENTRY_LOSS = 1_666_667n;
const CAP = 8_333_333n;
const FILL_SHORT = 0.997;

describe("ticket after-preview on a reduce or flip counts the closed slice's PnL", () => {
  it("cutting a losing long: a real liquidation price and ~33% health, not 'covered'", async () => {
    account(CAP, 10_000_000n, 0n, ENTRY_LOSS);
    const p = await openConfirm("short", "5");
    const d = p.estimatedLiqDisplay as Display;
    expect(d.kind).toBe("price");
    // equity after = 8.3333 + 5 x (0.997 - 1.6667); the remaining 5 keep the 1.6667 entry
    const equity = 8.333333 + 5 * (FILL_SHORT - 1.666667);
    expect(usd(p.estimatedLiqPrice)).toBeCloseTo(longLiq(1.666667, equity, 5), 3);
    expect(d.marginHealthPct).toBeGreaterThan(32.5);
    expect(d.marginHealthPct).toBeLessThan(33.5);
  });

  it("flipping a losing long to short: the old leg's loss stays in, the fee is counted once", async () => {
    account(CAP, 10_000_000n, 0n, ENTRY_LOSS);
    const p = await openConfirm("short", "15");
    // closed 10 at the fill (fee inside it), residual short 5 entered at the same fill
    const equity = 8.333333 + 10 * (FILL_SHORT - 1.666667);
    expect(usd(p.estimatedLiqPrice)).toBeCloseTo(shortLiq(FILL_SHORT, equity, 5), 3);
  });

  it("cutting a winning long reads healthier than before, not the same", async () => {
    account(CAP, 10_000_000n, 0n, 600_000n);
    const p = await openConfirm("short", "5");
    const d = p.estimatedLiqDisplay as Display;
    // (8.3333 + 5 x (0.997 - 0.6) + 5 x (1 - 0.6)) / 5
    expect(d.marginHealthPct).toBeGreaterThan(245);
    expect(d.marginHealthPct).toBeLessThan(247);
  });

  it("cutting a losing short (a long order) counts its loss too", async () => {
    account(CAP, -10_000_000n, 0n, 600_000n); // short 10 @0.6, mark 1
    const p = await openConfirm("long", "5"); // closes 5 at ~1.003
    const equity = 8.333333 - 5 * (1.003 - 0.6);
    expect(usd(p.estimatedLiqPrice)).toBeCloseTo(shortLiq(0.6, equity, 5), 3);
  });

  it("a flip from a leg whose entry is only the mark fallback never claims 'covered'", async () => {
    account(100_000_000n, -10_000_000n, 0n, 0n); // short 10, no on-chain, cached or pnl-implied entry
    const p = await openConfirm("long", "15"); // the long 5 left would read covered on $100
    expect((p.estimatedLiqDisplay as Display).kind).toBe("unknown");
  });

  it("CONTROL: a fresh open is priced as before (nothing closes)", async () => {
    account(100_000_000n);
    const open = await openConfirm("long", "50");
    expect(usd(open.estimatedLiqPrice)).toBeCloseTo(longLiq(1.003, 100, 50), 3);
  });
});
