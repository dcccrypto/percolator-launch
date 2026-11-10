/**
 * N2 follow-up (sub-1x): if the live growth cap for THIS size ("Max leverage now") is below 1x, no leverage the selector can offer
 * (its floor is 1x) is accepted by the wrapper's growth gate, so the selector must not offer 1x and submit must be blocked with a reason.
 * On the deployed wrapper (percolator-prog 3ba5bc37, growth_v19::MAX_IMR_BPS = 10_000) the dynamic IMR is capped at 100%, so the cap
 * bottoms out at exactly 1.00x and this state is not reachable from a valid record: test (1) pins that. The guard is fail-closed
 * defence in depth, exercised by forcing the decision's cap below 1 (tests 2-4) on the real OrderTicket.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const slow = vi.hoisted(() => ({ on: false }));
const mocks = vi.hoisted(() => ({
  useWalletCompat: vi.fn(),
  useConnectionCompat: vi.fn(),
  useUserAccount: vi.fn(),
  useSlabState: vi.fn(),
  useEngineState: vi.fn(),
  useMarketLimits: vi.fn(),
  useMarketFillCap: vi.fn(),
  fundAndTrade: vi.fn(),
  modal: { props: null as null | { onConfirm: () => void } },
}));

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: mocks.useWalletCompat, useConnectionCompat: mocks.useConnectionCompat }));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount, useUserAccountScanPending: () => false }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/hooks/useClusterSlot", () => ({ useClusterSlot: () => null, useClusterSlotObservation: () => null }));
vi.mock("@/hooks/useSlowFlag", async (orig) => ({ ...(await orig<object>()), useSlowFlag: (active: boolean) => active && slow.on }));
vi.mock("@/hooks/useMarketLimits", () => ({ useMarketLimits: mocks.useMarketLimits }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: mocks.useEngineState }));
vi.mock("@/hooks/useInitUser", () => ({ useInitUser: () => ({ initUser: vi.fn(), loading: false, error: null }) }));
vi.mock("@/hooks/useFirstTrade", () => ({ useFirstTrade: () => ({ fundAndTrade: mocks.fundAndTrade, loading: false }) }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddressSync: vi.fn(() => new PublicKey("11111111111111111111111111111111")) }));
vi.mock("@/hooks/useTrade", () => ({ useTrade: () => ({ trade: vi.fn(), loading: false, error: null }), prewarmTradeSubmission: vi.fn() }));
vi.mock("@/hooks/useBandRentView", () => ({ useBandRentView: () => null }));
vi.mock("@/hooks/useMarketFillCap", () => ({ useMarketFillCap: mocks.useMarketFillCap }));
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
vi.mock("@/components/trade/TradeConfirmationModal", () => ({ TradeConfirmationModal: (p: { onConfirm: () => void }) => { mocks.modal.props = p; return <div data-testid="confirm-modal" />; } }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));
vi.mock("@/lib/userAccountScan", async (orig) => ({ ...(await orig<object>()), getPortfolioRawSnapshot: () => null }));
vi.mock("@/lib/close-trading-account", async (orig) => ({ ...(await orig<object>()), isPortfolioClosable: () => ({ closable: false }) }));
vi.mock("@/hooks/useClosePosition", () => ({ useClosePosition: () => ({ closePosition: vi.fn(), prewarmClose: vi.fn(), loading: false, error: null }) }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 1_000_000n, priceUsd: 1 }) }));
vi.mock("@/hooks/useNftWrappedPosition", () => ({ useNftWrappedPosition: () => null }));

const sub1 = vi.hoisted(() => ({ cap: null as number | null }));
vi.mock("@/lib/v21/growth-market", async (orig) => {
  const m = await orig<typeof import("@/lib/v21/growth-market")>();
  return {
    ...m,
    growthTicketDecision: (...a: Parameters<typeof m.growthTicketDecision>) => {
      const d = m.growthTicketDecision(...a);
      return sub1.cap !== null && d.fillMaxLeverage !== null ? { ...d, fillMaxLeverage: sub1.cap } : d;
    },
  };
});

import { OrderTicket } from "@/components/trade/OrderTicket";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { growthMarketView, growthMaxLeverageForOrder } from "@/lib/v21/growth-market";
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
  mocks.modal.props = null;
  mocks.fundAndTrade.mockReset();
  mocks.useMarketFillCap.mockReturnValue(null);
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
  await waitFor(() => expect(screen.queryByTestId("growth-max-long")).not.toBeNull(), { timeout: 8000 });
};
const submit = () => screen.getByTestId("trade-submit") as HTMLButtonElement;

describe("N2 sub-1x: a growth cap below 1x blocks 1x and submit", () => {
  afterEach(() => { sub1.cap = null; });

  it("(1) unreachable on the deployed wrapper: at the side's full room the cap is exactly 1x, never below", () => {
    const g = view();
    const room = g.long.headroomQ!;
    for (const q of [room / 2n, room - LOT, room]) {
      const cap = growthMaxLeverageForOrder(g, "long", 0n, q);
      expect(cap).not.toBeNull();
      expect(cap!).toBeGreaterThanOrEqual(1);
    }
  });

  it("(2) control: with the real cap (>= 1x) the ticket is submittable and offers no below-1x note", async () => {
    await mount();
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "300" } });
    await waitFor(() => expect(submit().disabled).toBe(false));
    expect(screen.queryByTestId("leverage-below-one")).toBeNull();
  });

  it("(3) a cap of 0.8x: the selector does not offer 1x (input disabled, no presets/slider, a note) and submit is blocked with a reason", async () => {
    sub1.cap = 0.8;
    await mount();
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "300" } });
    await waitFor(() => expect(screen.queryByTestId("leverage-below-one")).not.toBeNull());
    expect(screen.getByTestId("leverage-below-one").textContent).toContain("0.8");
    expect((screen.getByTestId("trade-leverage-input") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryAllByTestId("trade-leverage-preset")).toHaveLength(0);
    expect(screen.queryByText(/1x \(fixed\)/)).toBeNull();
    expect(submit().disabled).toBe(true);
    expect(submit().textContent).toMatch(/smaller size/i);
    fireEvent.click(submit());
    expect(screen.queryByTestId("confirm-modal")).toBeNull();
    expect(mocks.fundAndTrade).not.toHaveBeenCalled();
  });

  it("(4) a cap that drops below 1x after the confirm dialog opened: confirming sends nothing", async () => {
    await mount();
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "300" } });
    await waitFor(() => expect(submit().disabled).toBe(false));
    fireEvent.click(submit());
    await waitFor(() => expect(mocks.modal.props).not.toBeNull());
    sub1.cap = 0.8;
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "300.000001" } });
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "300" } });
    await waitFor(() => expect(screen.queryByTestId("leverage-below-one")).not.toBeNull());
    await act(async () => { mocks.modal.props!.onConfirm(); });
    expect(mocks.fundAndTrade).not.toHaveBeenCalled();
  });
});
