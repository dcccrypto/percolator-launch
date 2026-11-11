/**
 * r8 (mounted): a size chosen with Max must never leave the ticket blocked when the mark ticks. Max writes a USD (or token) string that the
 * ticket re-divides by the ticking price and rounds, so a tick could put the order a hair over the room; the clamp fired only when the room
 * changed, so the ticket stayed on "Over the max fillable size" (live, 1 of 6 long Max clicks).
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const slow = vi.hoisted(() => ({ on: false, lotExp: 0 }));
const px = vi.hoisted(() => ({ e6: 1_000_000n, drift: 0n, floor: 0n }));
vi.mock("@/lib/v22/lot", async (orig) => ({ ...(await orig<object>()), lotExpOf: () => slow.lotExp }));
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
// Probe: GrowthTicketPanelLive is a real child of the ticket. Its layout effect runs in the SAME commit as the render that follows an edit,
// after the DOM is updated and BEFORE the ticket's passive clamp effect, so it sees the pre-clamp state that act() otherwise hides.
const probe = vi.hoisted(() => ({ commits: [] as Array<{ size: string; disabled: boolean; label: string }> }));
vi.mock("@/components/trade/GrowthTicketPanelLive", async () => {
  const React = await import("react");
  return {
    GrowthTicketPanelLive: () => {
      React.useLayoutEffect(() => {
        const input = document.querySelector('[data-testid="trade-size-input"]') as HTMLInputElement | null;
        const btn = document.querySelector('[data-testid="trade-submit"]') as HTMLButtonElement | null;
        if (input && btn) probe.commits.push({ size: input.value, disabled: btn.disabled, label: btn.textContent ?? "" });
      });
      return null;
    },
  };
});
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
vi.mock("@/lib/priceStore/priceStore", async (orig) => ({ ...(await orig<object>()), getLivePriceSnapshot: () => {
    // a feed that keeps ticking between renders: each read moves the mark by `drift` until it reaches `floor`
    if (px.drift !== 0n && (px.drift < 0n ? px.e6 > px.floor : px.e6 < px.floor)) px.e6 += px.drift;
    return { priceUsd: Number(px.e6) / 1e6, priceE6: px.e6 };
  } }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccountIdle: () => null, getMockUserAccount: () => null }));
vi.mock("@/lib/tx", () => ({ prewarmTxLanding: vi.fn() }));
vi.mock("@/components/trade/DepositWithdrawCard", () => ({ DepositWithdrawCard: (p: { offerFaucet?: boolean }) => <div data-testid="deposit-card" data-offer-faucet={String(!!p.offerFaucet)} /> }));
vi.mock("@/components/trade/TradeConfirmationModal", () => ({ TradeConfirmationModal: (p: { onConfirm: () => void }) => { mocks.modal.props = p; return <div data-testid="confirm-modal" />; } }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));
vi.mock("@/lib/userAccountScan", async (orig) => ({ ...(await orig<object>()), getPortfolioRawSnapshot: () => null }));
vi.mock("@/lib/close-trading-account", async (orig) => ({ ...(await orig<object>()), isPortfolioClosable: () => ({ closable: false }) }));
vi.mock("@/hooks/useClosePosition", () => ({ useClosePosition: () => ({ closePosition: vi.fn(), prewarmClose: vi.fn(), loading: false, error: null }) }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: px.e6, priceUsd: Number(px.e6) / 1e6 }) }));
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
beforeEach(() => { px.e6 = 1_000_000n; px.drift = 0n; });
afterEach(() => { __setDevnetV22ForTest(null); slow.lotExp = 0; });


const mount = async () => {
  render(<OrderTicket slabAddress={SLAB} />);
  await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
  await waitFor(() => expect(screen.queryByTestId("limits-max-size-inline")).not.toBeNull(), { timeout: 8000 });
};
const maxQ = () => BigInt(screen.getByTestId("limits-max-size-inline").getAttribute("data-max-q")!);
const ROOM = 350n * LOT; // 950 (N_cap) - 600 (users' long OI)


// OrderTicket is memoised and reads the price non-reactively (the live feed re-renders it): a changing extra prop stands in for a feed tick.
const tickProp = (n: number) => ({ tick: n }) as object;
const submit = () => screen.getByTestId("trade-submit") as HTMLButtonElement;
const sizeBox = () => screen.getByTestId("trade-size-input") as HTMLInputElement;
const ROOM_Q = 350n * LOT; // the side room in q: it does not move with the mark

/** The order's size in q the way the ticket derives it: the box (USD or token) at the live price. */
const orderQ = (unit: "usd" | "token") => {
  const n = Number(sizeBox().value);
  const tokens = unit === "usd" ? n / (Number(px.e6) / 1e6) : n;
  return BigInt(Math.floor(tokens * 1e6));
};

describe("r8: Max then a mark tick leaves the ticket submittable, with the size within the room", () => {
  for (const unit of ["usd", "token"] as const) {
    // the tick sizes: sub-cent drifts both ways, and larger ones; the room itself is fixed in q
    for (const tick of [999_900n, 999_990n, 999_999n, 1_000_001n, 1_000_100n, 1_001_000n, 990_000n, 1_010_000n]) {
      it(`${unit} units: Max, then the mark moves 1.000000 -> ${Number(tick) / 1e6}: submit is enabled and the size is within the room`, async () => {
        const { rerender } = render(<OrderTicket slabAddress={SLAB} />);
        await waitFor(() => expect(screen.queryByTestId("limits-max-size-inline")).not.toBeNull(), { timeout: 8000 });
        if (unit === "token") fireEvent.click(screen.getByTitle(/Switch size unit/));
        await waitFor(() => expect(screen.getByTestId("limits-max-size-inline").getAttribute("data-unit")).toBe(unit));
        fireEvent.click(screen.getByTestId("limits-max-size-inline"));
        await waitFor(() => expect(Number(sizeBox().value)).toBeGreaterThan(0));
        px.e6 = tick;
        await act(async () => { rerender(<OrderTicket slabAddress={SLAB} {...tickProp(1)} />); });
        // a second and third tick, as the live feed keeps moving
        px.e6 = tick + (tick > 1_000_000n ? 137n : -137n);
        await act(async () => { rerender(<OrderTicket slabAddress={SLAB} {...tickProp(2)} />); });
        await waitFor(() => {
          expect(submit().textContent).not.toContain("Over the max fillable size");
          expect(submit().disabled).toBe(false);
        });
        // the order never asks for more than is fillable
        expect(orderQ(unit), `box ${sizeBox().value} px ${px.e6} btn ${submit().textContent} dis ${submit().disabled}`).toBeLessThanOrEqual(ROOM_Q);
      });
    }
  }
});

describe("r8: the mark keeps moving between the clamp and the next render (a live feed)", () => {
  for (const unit of ["usd", "token"] as const) {
    for (const [name, drift, floor] of [["falling", -7n, 999_000n], ["rising", 7n, 1_001_000n]] as const) {
      it(`${unit} units, ${name} mark: once the feed settles the ticket is submittable and within the room`, async () => {
        const { rerender } = render(<OrderTicket slabAddress={SLAB} />);
        await waitFor(() => expect(screen.queryByTestId("limits-max-size-inline")).not.toBeNull(), { timeout: 8000 });
        if (unit === "token") fireEvent.click(screen.getByTitle(/Switch size unit/));
        await waitFor(() => expect(screen.getByTestId("limits-max-size-inline").getAttribute("data-unit")).toBe(unit));
        fireEvent.click(screen.getByTestId("limits-max-size-inline"));
        await waitFor(() => expect(Number(sizeBox().value)).toBeGreaterThan(0));
        px.drift = drift;
        px.floor = floor;
        for (let i = 0; i < 40; i++) await act(async () => { rerender(<OrderTicket slabAddress={SLAB} {...tickProp(10 + i)} />); });
        px.drift = 0n;
        await act(async () => { rerender(<OrderTicket slabAddress={SLAB} {...tickProp(99)} />); });
        await waitFor(() => {
          expect(submit().textContent).not.toContain("Over the max fillable size");
          expect(submit().disabled).toBe(false);
        });
        expect(orderQ(unit)).toBeLessThanOrEqual(ROOM_Q);
      });
    }
  }
});
