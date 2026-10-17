/**
 * N1: Max at the market's max leverage sized the margin to ALL the free capital, with nothing left
 * for the taker fee (charged before the engine's IM gate) or for an engine price above the feed
 * (IM is charged on size x the engine's effective price). Every such Max was refused Custom(49).
 * Harness from OrderTicket.dust-room.test.tsx.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useWalletCompat: vi.fn(),
  useConnectionCompat: vi.fn(),
  useUserAccount: vi.fn(),
  useSlabState: vi.fn(),
  useEngineState: vi.fn(),
  fillCaps: null as unknown,
  limits: null as unknown,
  engineView: {} as unknown,
}));

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: mocks.useWalletCompat, useConnectionCompat: mocks.useConnectionCompat }));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount, useUserAccountScanPending: () => false }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: mocks.useEngineState }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddressSync: vi.fn(() => new PublicKey("11111111111111111111111111111111")) }));
vi.mock("@/hooks/useTrade", () => ({ useTrade: () => ({ trade: vi.fn(), loading: false, error: null }), prewarmTradeSubmission: vi.fn() }));
vi.mock("@/hooks/useMarketFillCap", () => ({ useMarketFillCap: () => mocks.fillCaps }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => null }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: { symbol: "SOL-PERP", max_leverage: 10 } }) }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ isStale: false, stale: false }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: false }) }));
vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyLogin: () => vi.fn(), usePrivyAvailable: () => false }));
vi.mock("@/hooks/useWalletAdapterAvailable", () => ({ useWalletAdapterAvailable: () => true }));
// $150 per SOL: 1 q (1e-6 SOL) = $0.00015, so one cent is 66.67 q.
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 150_000_000n, priceUsd: 150 }) }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/priceStore/priceStore", async (orig) => ({
  ...(await orig<object>()),
  getLivePriceSnapshot: () => ({ priceUsd: 150, priceE6: 150_000_000n }),
}));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccountIdle: () => null, getMockUserAccount: () => null }));
vi.mock("@/lib/tx", () => ({ prewarmTxLanding: vi.fn() }));
vi.mock("@/lib/limits/adl-reduce-only", () => ({ isAdlReduceOnly: () => false }));
vi.mock("@/lib/limits/decode", async (orig) => ({ ...(await orig<object>()), decodeMarketEngineView: () => mocks.engineView }));
vi.mock("@/hooks/useMarketLimits", () => ({ useMarketLimits: () => mocks.limits }));
vi.mock("@/lib/limits/fill-check", () => ({ takeFillResult: () => null }));
vi.mock("@/components/trade/DepositWithdrawCard", () => ({ DepositWithdrawCard: () => <div data-testid="deposit-card" /> }));
vi.mock("@/components/trade/OrderTicketClosePanel", () => ({ OrderTicketClosePanel: () => <div data-testid="close-panel" /> }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));
vi.mock("@/components/trade/TradeConfirmationModal", () => ({ TradeConfirmationModal: () => null }));

import { OrderTicket } from "@/components/trade/OrderTicket";
import { marketLimits } from "../../lib/limits/fixtures";

const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";
const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const U = 1_000_000n;
const submit = () => screen.getByTestId("trade-submit") as HTMLButtonElement;
const summary = () => screen.getByTestId("ticket-summary").textContent ?? "";
const marginShown = () => {
  const m = /Margin([\d,.]+) /.exec(summary());
  return m ? Number(m[1].replace(/,/g, "")) : NaN;
};

function setup(opts: { capital: bigint; wallet: bigint; feeBps: bigint; effectiveE6?: bigint }) {
  mocks.engineView = opts.effectiveE6 ? { effectivePriceE6: opts.effectiveE6, targetPriceE6: opts.effectiveE6 } : {};
  mocks.useConnectionCompat.mockReturnValue({
    connection: { getTokenAccountBalance: vi.fn(async () => ({ value: { amount: opts.wallet.toString(), decimals: 6 } })), getAccountInfo: vi.fn(async () => null) },
  });
  mocks.useUserAccount.mockReturnValue({ account: { capital: opts.capital, positionSize: 0n, entryPrice: 0n, pnl: 0n }, idx: 0 });
  mocks.useEngineState.mockReturnValue({
    engine: null,
    params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n, tradingFeeBps: opts.feeBps },
    insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true,
  });
}

async function maxAtTenX() {
  render(<OrderTicket slabAddress={SLAB} />);
  await act(async () => {});
  const ten = screen.getAllByTestId("trade-leverage-preset").find((b) => /^10/.test(b.textContent ?? ""));
  if (!ten) throw new Error("no 10x preset");
  fireEvent.click(ten);
  const max = screen.getAllByTestId("trade-size-preset").find((b) => b.getAttribute("data-percent") === "100");
  fireEvent.click(max!);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.limits = marketLimits({ state: "off" });
  mocks.fillCaps = null;
  mocks.useWalletCompat.mockReturnValue({ publicKey: new PublicKey("11111111111111111111111111111111"), connected: true });
  mocks.useSlabState.mockReturnValue({
    accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: vi.fn(),
    programId: new PublicKey("11111111111111111111111111111111"), raw: new Uint8Array(8),
  });
});

describe("Max at max leverage fits the engine's gate (fee + engine price)", () => {
  it("100 USDC free, empty wallet, 10x, fee 30 bps: Max margin leaves room for the fee and asks no deposit", async () => {
    setup({ capital: 100n * U, wallet: 0n, feeBps: 30n });
    await maxAtTenX();
    // equity after the fee must cover IM: M x 10 x (10% + 0.3%) <= 100
    expect(marginShown()).toBeLessThanOrEqual(97.09);
    expect(marginShown()).toBeGreaterThan(97);
    expect(submit().textContent).toBe("Long SOL 10×");
  });

  it("engine price 0.5% above the feed: Max shrinks by that gap too", async () => {
    setup({ capital: 100n * U, wallet: 0n, feeBps: 5n, effectiveE6: 150_750_000n });
    await maxAtTenX();
    // 100 / (1.005 x 1.005) = 99.007
    expect(marginShown()).toBeLessThanOrEqual(99.01);
    expect(marginShown()).toBeGreaterThan(98.9);
    expect(submit().textContent).toBe("Long SOL 10×");
  });

  it("a typed margin of all 100 at 10x is not offered as-is: it bundles the fee from the wallet", async () => {
    setup({ capital: 100n * U, wallet: 50n * U, feeBps: 30n });
    render(<OrderTicket slabAddress={SLAB} />);
    await act(async () => {});
    fireEvent.click(screen.getAllByTestId("trade-leverage-preset").find((b) => /^10/.test(b.textContent ?? ""))!);
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "1000" } }); // $1,000 at 10x = 100 margin
    expect(marginShown()).toBe(100);
    expect(submit().textContent).toMatch(/^Deposit [\d.,]+ \S+ & Long/);
  });

  it("CONTROL: at 5x the same account keeps the whole 100 as Max (the engine needs only half)", async () => {
    setup({ capital: 100n * U, wallet: 0n, feeBps: 30n, effectiveE6: 153_000_000n });
    render(<OrderTicket slabAddress={SLAB} />);
    await act(async () => {});
    fireEvent.click(screen.getAllByTestId("trade-leverage-preset").find((b) => /^5/.test(b.textContent ?? ""))!);
    fireEvent.click(screen.getAllByTestId("trade-size-preset").find((b) => b.getAttribute("data-percent") === "100")!);
    // 99.998, not 100: the ticket truncates the size to its display decimals (same on playground)
    expect(marginShown()).toBeGreaterThan(99.99);
  });
});
