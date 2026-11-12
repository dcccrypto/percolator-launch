/**
 * r8 Council finding (mounted): with a position open, the OPPOSITE side and a typed size smaller than the position (a pure reduce), Buying
 * power and the Max label jumped to wallet x leverage and the room line vanished: the growth room / equity caps were only derived for an
 * order that opens. They must be the same room- and collateral-bounded figure whatever size is typed, and equal what a Max click fills.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maxFillWithHeadroomQ } from "@/lib/limits/ticket";

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
  mocks.useConnectionCompat.mockReturnValue({ connection: { getTokenAccountBalance: vi.fn().mockResolvedValue({ value: { amount: "10000000000", decimals: 6 } }) } });
  mocks.useUserAccount.mockReturnValue({ account: { capital: 20_000_000n, positionSize: 234_000n, entryPrice: 1_000_000n, pnl: 0n, feeCredits: 0n }, idx: 0 });
  mocks.useSlabState.mockReturnValue({
    accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: vi.fn(), raw: null,
    adlFactors: { aLong: 1_000_000_000_000_000n, aShort: 1_000_000_000_000_000n },
    programId: new PublicKey("11111111111111111111111111111111"),
  });
  mocks.useEngineState.mockReturnValue({ engine: null, params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n, tradingFeeBps: 30n }, insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true });
});
beforeEach(() => { px.e6 = 1_000_000n; px.drift = 0n; });
afterEach(() => { __setDevnetV22ForTest(null); slow.lotExp = 0; });



const ROOM = view().short.headroomQ ?? 0n; // the short side's opening room
const sizeBox = () => screen.getByTestId("trade-size-input") as HTMLInputElement;
const maxQ = () => BigInt(screen.getByTestId("limits-max-size-inline").getAttribute("data-max-q")!);
const bpNum = () => Number((screen.getByTestId("buying-power").textContent ?? "").replace(/[^\d.]/g, ""));
const levBtn = (lev: number) => screen.getAllByTestId("trade-leverage-preset").find((b) => Number(b.getAttribute("data-leverage")) === lev)!;
const presetLevs = () => screen.getAllByTestId("trade-leverage-preset").map((b) => Number(b.getAttribute("data-leverage"))).filter((l) => l >= 1 && l <= 10);
const readings = async (typed: string) => {
  render(<OrderTicket slabAddress={SLAB} />);
  await waitFor(() => expect(screen.queryByTestId("limits-max-size-inline")).not.toBeNull(), { timeout: 8000 });
  fireEvent.click(screen.getByTestId("trade-side-short")); // the opposite of the 0.234 long
  const rows: Array<{ lev: number; bp: number; maxQ: bigint; filled: number; roomShown: boolean }> = [];
  const levs = presetLevs();
  expect(levs).toContain(1);
  expect(levs.length).toBeGreaterThanOrEqual(4);
  for (const lev of levs) {
    fireEvent.click(levBtn(lev));
    fireEvent.change(sizeBox(), { target: { value: typed } });
    await act(async () => {});
    const bp = bpNum();
    const mq = maxQ();
    const roomShown = !!screen.queryByTestId("buying-power-capped");
    fireEvent.click(screen.getByTestId("limits-max-size-inline"));
    await act(async () => {});
    rows.push({ lev, bp, maxQ: mq, filled: Number(sizeBox().value), roomShown });
  }
  return rows;
};

describe("r8 council: Buying power and Max stay bounded when the typed order only reduces", () => {
  // opening room on the short side + the long being closed; the wallet (10,000) x leverage is far above it at every leverage here
  const BOUND_Q = ROOM + 234_000n;
  for (const typed of ["0.1", "0.2", ""]) {
    it(`typed "${typed}" (below the 0.234 position): BP == Max, the Max-click fill == Max less its headroom, <= the room/collateral bound, monotonic in leverage`, async () => {
      const rows = await readings(typed);
      for (const r of rows) {
        const boundUsd = Number(BOUND_Q) / 1e6; // price 1.00
        expect(r.bp, `bp at ${r.lev}x`).toBeLessThanOrEqual(boundUsd + 0.01);
        expect(r.maxQ <= BOUND_Q, `max at ${r.lev}x`).toBe(true);
        // #3809: the Max chip fills the live Max less its tick headroom (maxFillWithHeadroomQ), so the fill sits just under BP, never above.
        const headroomFill = Number(maxFillWithHeadroomQ(r.maxQ, "usd", 1_000_000n, 234_000n)) / 1e6; // price 1.00, the ticket's USD unit
        expect(Math.abs(r.filled - headroomFill), `the Max-click fill ${r.filled} vs Max less headroom ${headroomFill} at ${r.lev}x`).toBeLessThan(0.02);
        expect(r.filled, `the Max-click fill ${r.filled} is not above BP ${r.bp} at ${r.lev}x`).toBeLessThanOrEqual(r.bp + 0.01);
        expect(r.bp - r.filled, `BP ${r.bp} vs the Max-click fill ${r.filled} at ${r.lev}x: only the headroom apart`).toBeLessThan(r.bp / 400 + 0.03);
        expect(Math.abs(r.bp - Number(r.maxQ) / 1e6), `BP vs the Max label at ${r.lev}x`).toBeLessThan(0.02);
      }
      for (let i = 1; i < rows.length; i++) expect(rows[i].bp).toBeGreaterThanOrEqual(rows[i - 1].bp);
    });
  }
  it("the figure does not depend on the typed size", async () => {
    const a = await readings("0.1");
    cleanup();
    const b = await readings("5");
    for (let i = 0; i < a.length; i++) {
      expect(a[i].bp, `bp at ${a[i].lev}x`).toBe(b[i].bp);
      expect(a[i].maxQ).toBe(b[i].maxQ);
    }
  });
});
