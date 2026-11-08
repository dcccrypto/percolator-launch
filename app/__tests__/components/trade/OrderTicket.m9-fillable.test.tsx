/**
 * M9 (mounted): the real OrderTicket on a first trade (no account) with a growth side room far below the wallet-bound size.
 * Max is clamped to the room; an oversize ask is clamped / blocked so the deposit, margin and fee never price unfillable size;
 * the busy-side surcharge is in Fee with no matcher quote; a funded wallet with an impossible size sees no "Get test funds".
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useWalletCompat: vi.fn(),
  useConnectionCompat: vi.fn(),
  useUserAccount: vi.fn(),
  useSlabState: vi.fn(),
  useEngineState: vi.fn(),
  useMarketLimits: vi.fn(),
}));

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: mocks.useWalletCompat, useConnectionCompat: mocks.useConnectionCompat }));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount, useUserAccountScanPending: () => false }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/hooks/useMarketLimits", () => ({ useMarketLimits: mocks.useMarketLimits }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: mocks.useEngineState }));
vi.mock("@/hooks/useInitUser", () => ({ useInitUser: () => ({ initUser: vi.fn(), loading: false, error: null }) }));
vi.mock("@/hooks/useFirstTrade", () => ({ useFirstTrade: () => ({ fundAndTrade: vi.fn(), loading: false }) }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddressSync: vi.fn(() => new PublicKey("11111111111111111111111111111111")) }));
vi.mock("@/hooks/useTrade", () => ({ useTrade: () => ({ trade: vi.fn(), loading: false, error: null }), prewarmTradeSubmission: vi.fn() }));
vi.mock("@/hooks/useBandRentView", () => ({ useBandRentView: () => null }));
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
vi.mock("@/components/trade/TradeConfirmationModal", () => ({ TradeConfirmationModal: () => null }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));
vi.mock("@/lib/userAccountScan", async (orig) => ({ ...(await orig<object>()), getPortfolioRawSnapshot: () => null }));
vi.mock("@/lib/close-trading-account", async (orig) => ({ ...(await orig<object>()), isPortfolioClosable: () => ({ closable: false }) }));
vi.mock("@/hooks/useClosePosition", () => ({ useClosePosition: () => ({ closePosition: vi.fn(), prewarmClose: vi.fn(), loading: false, error: null }) }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 1_000_000n, priceUsd: 1 }) }));
vi.mock("@/hooks/useNftWrappedPosition", () => ({ useNftWrappedPosition: () => null }));

import { OrderTicket } from "@/components/trade/OrderTicket";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { growthMarketView } from "@/lib/v21/growth-market";
import { marketLimits } from "../../lib/limits/fixtures";
import { marketRaw } from "../../lib/v21/fixtures";

const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";
const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const OWNER = new PublicKey("11111111111111111111111111111111");

const LOT = 1_000_000n;
const view = () =>
  growthMarketView({
    raw: marketRaw({ launch: 800, tier: 800, ceil: 800, kink: 5000, lambda: 10_000 }),
    engine: { initialMarginBps: 1_000n, effectivePriceE6: 1_000_000n, oiEffLongQ: 600n * LOT, oiEffShortQ: 600n * LOT, tradeFeeBaseBps: 30n, maxTradingFeeBps: 630n },
    lp: { capital: 950_000_000n, pnl: 0n, feeCredits: 0n },
    lpEffectiveQ: -600n * LOT,
    bound: true,
  })!;

beforeEach(() => {
  const g = view();
  mocks.useMarketLimits.mockReturnValue(marketLimits({ matcher: null, growth: g, flags: { p1: false, p2: false, p2FeeCharged: false, p3: false } }));
  __setDevnetV22ForTest(true);
  mocks.useWalletCompat.mockReturnValue({ publicKey: OWNER, connected: true });
  mocks.useConnectionCompat.mockReturnValue({ connection: { getTokenAccountBalance: vi.fn().mockResolvedValue({ value: { amount: "39000000000", decimals: 6 } }) } });
  mocks.useUserAccount.mockReturnValue(null);
  mocks.useSlabState.mockReturnValue({
    accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: vi.fn(), raw: null,
    adlFactors: { aLong: 1_000_000_000_000_000n, aShort: 1_000_000_000_000_000n },
    programId: new PublicKey("11111111111111111111111111111111"),
  });
  mocks.useEngineState.mockReturnValue({ engine: null, params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n, tradingFeeBps: 30n }, insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true });
});
afterEach(() => __setDevnetV22ForTest(null));


const mount = async () => {
  render(<OrderTicket slabAddress={SLAB} />);
  await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
  await waitFor(() => expect(screen.queryByTestId("limits-max-size-inline")).not.toBeNull(), { timeout: 8000 });
};
const maxQ = () => BigInt(screen.getByTestId("limits-max-size-inline").getAttribute("data-max-q")!);
const ROOM = 350n * LOT; // 950 (N_cap) - 600 (users' long OI)

describe("M9 mounted: the quote follows the fillable room (first trade, wallet 39,000 USDC, room $350)", () => {
  it("(1) Max is the room, not the wallet-bound 39,000 x leverage", async () => {
    expect(view().long.headroomQ).toBe(ROOM);
    await mount();
    expect(maxQ()).toBe(ROOM);
    expect(screen.getByTestId("limits-max-size-inline").textContent).toContain("350");
  });

  it("(2) an oversize ask ends up at the fillable amount, with deposit and margin on it, or is blocked", async () => {
    await mount();
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5000" } });
    await waitFor(() => expect((screen.getByTestId("trade-size-input") as HTMLInputElement).value).toBe("350.00"));
    const submit = screen.getByTestId("trade-submit") as HTMLButtonElement;
    // Whatever the summary / deposit field says, it is on 350, never on 5,000.
    const body = document.body.textContent ?? "";
    expect(body).not.toMatch(/5,?000\.00 USDC/);
    const deposit = screen.queryByTestId("first-trade-deposit") as HTMLInputElement | null;
    if (deposit) expect(Number(deposit.value)).toBeLessThan(400);
    expect(submit.textContent).not.toContain("Over the max fillable size");
  });

  it("(3) the Fee row carries the busy-side surcharge with no matcher quote", async () => {
    await mount();
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "300" } });
    await waitFor(() => expect(screen.queryByTestId("ticket-summary")).not.toBeNull());
    const summary = screen.getByTestId("ticket-summary").textContent ?? "";
    expect(summary).toContain("Fee (est.)"); // extras present => labelled as an estimate
    const fee = Number((summary.match(/Fee \(est\.\)([0-9.,]+)/) ?? [])[1]?.replace(/,/g, ""));
    // 300 notional at the 30 bps base alone would be 0.90; the busy-side part makes it larger.
    expect(fee).toBeGreaterThan(0.9);
  });

  it("(4) a funded wallet with an impossible size has no enabled Get-test-funds / deposit CTA", async () => {
    await mount();
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "999999999" } });
    // Right after the change (before the clamp effect lands) and after it settles, the CTA is never an enabled "Get test funds".
    const btn = () => screen.getByTestId("trade-submit") as HTMLButtonElement;
    expect(btn().textContent).not.toContain("Get test funds");
    await waitFor(() => expect((screen.getByTestId("trade-size-input") as HTMLInputElement).value).toBe("350.00"));
    expect(btn().textContent).not.toContain("Get test funds");
  });
});
