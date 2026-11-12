/**
 * r9 review of #3809 (mounted): (MED-1) the Max pin is frozen while the confirm modal is open and the signed deposit is the one the confirm
 * screen showed; (MED-2) a Max bound only by the position being closed fills the exact close (no dust), headroom only above it.
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
  modal: { props: null as null | { onConfirm: () => void; onCancel?: () => void; depositAmount?: bigint; positionSize?: bigint } },
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
vi.mock("@/components/trade/TradeConfirmationModal", () => ({ TradeConfirmationModal: (p: { onConfirm: () => void; onCancel?: () => void; depositAmount?: bigint; positionSize?: bigint }) => { mocks.modal.props = p; return <div data-testid="confirm-modal" />; } }));
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

const sizeBox = () => screen.getByTestId("trade-size-input") as HTMLInputElement;
const submit = () => screen.getByTestId("trade-submit") as HTMLButtonElement;
const tickProp = (n: number) => ({ tick: n }) as object;

describe("r9 MED-1: the Max pin is frozen while the confirm modal is open, and the signed deposit is the reviewed one", () => {
  let room = 300n * LOT;
  const open = async () => {
    room = 300n * LOT;
    mocks.useMarketFillCap.mockImplementation(() => ({ maxFillAbs: room, sideRoomQ: () => room }));
    const r = render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("limits-max-size-inline")).not.toBeNull(), { timeout: 8000 });
    fireEvent.click(screen.getByTestId("limits-max-size-inline"));
    await waitFor(() => expect(Number(sizeBox().value)).toBeGreaterThan(0));
    await act(async () => { fireEvent.click(submit()); });
    await waitFor(() => expect(mocks.modal.props).not.toBeNull());
    return r;
  };
  const growRoom = async (rerender: (ui: React.ReactElement) => void, n: number) => {
    room = (room * 110n) / 100n;
    await act(async () => { rerender(<OrderTicket slabAddress={SLAB} {...tickProp(n)} />); });
    await act(async () => { rerender(<OrderTicket slabAddress={SLAB} {...tickProp(n + 1)} />); });
  };
  afterEach(() => { mocks.useMarketFillCap.mockReturnValue(null); });

  it("the size box does not move while the confirm is open, even as the room grows 10%", async () => {
    const { rerender } = await open();
    const atOpen = sizeBox().value;
    await growRoom(rerender, 1);
    expect(sizeBox().value).toBe(atOpen);
  });

  it("the deposit and size signed are exactly what the confirm screen showed, after the room and the mark moved", async () => {
    mocks.fundAndTrade.mockImplementation(() => new Promise(() => {}));
    const { rerender } = await open();
    const reviewedDeposit = mocks.modal.props!.depositAmount!;
    const reviewedSize = mocks.modal.props!.positionSize!;
    expect(reviewedDeposit).toBeGreaterThan(0n);
    await growRoom(rerender, 1);
    px.e6 = 1_100_000n; // the mark moves while the modal is open
    await growRoom(rerender, 3);
    await act(async () => { mocks.modal.props!.onConfirm(); });
    await waitFor(() => expect(mocks.fundAndTrade).toHaveBeenCalled());
    const arg = mocks.fundAndTrade.mock.calls[0][0] as { depositAtoms: bigint; size: bigint };
    expect(arg.depositAtoms).toBe(reviewedDeposit);
    expect(arg.size).toBe(reviewedSize);
  });

  it("CONTROL: after the confirm is cancelled the pin follows the room again", async () => {
    const { rerender } = await open();
    await act(async () => { mocks.modal.props!.onCancel?.(); });
    const before = sizeBox().value;
    await growRoom(rerender, 1);
    expect(Number(sizeBox().value)).toBeGreaterThan(Number(before));
  });
});

describe("r9 MED-2: a Max bound only by the position being closed fills the exact close", () => {
  const SHORT_SIDE = async (pos: bigint, unit: "usd" | "token", lotExp: number) => {
    slow.lotExp = lotExp;
    mocks.useConnectionCompat.mockReturnValue({ connection: { getTokenAccountBalance: vi.fn().mockResolvedValue({ value: { amount: "10000000000", decimals: 6 } }) } });
    mocks.useUserAccount.mockReturnValue({ account: { capital: 20_000_000n, positionSize: pos, entryPrice: 1_000_000n, pnl: 0n, feeCredits: 0n }, idx: 0 });
    mocks.useMarketFillCap.mockImplementation(() => ({ maxFillAbs: pos, sideRoomQ: () => pos })); // the cap admits only the close
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("limits-max-size-inline")).not.toBeNull(), { timeout: 8000 });
    fireEvent.click(screen.getByTestId("trade-side-short"));
    if (unit === "token") fireEvent.click(screen.getByTitle(/Switch size unit/));
    await waitFor(() => expect(screen.getByTestId("limits-max-size-inline").getAttribute("data-unit")).toBe(unit));
    expect(BigInt(screen.getByTestId("limits-max-size-inline").getAttribute("data-max-q")!)).toBe(pos);
    fireEvent.click(screen.getByTestId("limits-max-size-inline"));
    await act(async () => {});
  };
  afterEach(() => { mocks.useMarketFillCap.mockReturnValue(null); });

  it("token units: Max 0.234 fills 0.234 (not 0.233414)", async () => {
    await SHORT_SIDE(234_000n, "token", 0);
    expect(sizeBox().value).toBe("0.234");
  });
  it("usd units: Max 234 fills 234.00 (not 233.40)", async () => {
    await SHORT_SIDE(234_000_000n, "usd", 0);
    expect(sizeBox().value).toBe("234.00");
  });
  it("lot market: Max 100,000 lots fills all 100,000 lots (not 99,749)", async () => {
    await SHORT_SIDE(100_000n, "token", 1); // 1 lot = 10 micro-tokens: 100,000 lots = 1 token
    expect(Number(sizeBox().value)).toBe(1);
  });
});
