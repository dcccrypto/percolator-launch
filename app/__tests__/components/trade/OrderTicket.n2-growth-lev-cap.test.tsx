/**
 * N2 (Council round 4, Trader on the DEPLOYED preview, seats/trader/out/lev-open2-*): with "Max leverage now: 6.8x long" on screen the
 * ticket still let the trader pick 10x, quoted margin 4 and a 1.16 deposit, passed confirm, and the chain refused (Custom 49, no funds
 * moved). Right: the leverage selector and the sizing clamp to the live growth cap ("Max leverage now" for this size), and a bundled
 * deposit covers the deployed wrapper's growth requirement on the WHOLE post-fill position (growth_v19.rs growth_gate).
 * Mounted: the real OrderTicket and the real GrowthTicketPanel on a crowd-side growth market.
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

import { OrderTicket } from "@/components/trade/OrderTicket";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { growthMarketView, growthMaxLeverageForOrder } from "@/lib/v21/growth-market";
import { growthGate } from "@/lib/v22/growth-gate";
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
const levInput = () => screen.getByTestId("trade-leverage-input") as HTMLInputElement;
const capShown = () => Number((screen.getByTestId("growth-max-long").textContent ?? "").replace(/[^0-9.]/g, ""));

describe("N2 mounted: the leverage selector follows the live growth cap (first trade, crowd side)", () => {
  const SIZE = 300n * LOT;

  it("(1) the fixture is a real gap: the size's cap is below the side's zero-size cap and the market's 10x", () => {
    const g = view();
    const fill = growthMaxLeverageForOrder(g, "long", 0n, SIZE)!;
    expect(fill).not.toBeNull();
    expect(fill).toBeLessThan(g.long.maxLeverageX100 / 100);
    expect(fill).toBeLessThan(10);
    expect(fill).toBeGreaterThanOrEqual(1);
  });

  it("(2) typing a leverage above the cap shown ends at the cap; presets and slider never exceed it", async () => {
    const fill = growthMaxLeverageForOrder(view(), "long", 0n, SIZE)!;
    await mount();
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "300" } });
    await waitFor(() => expect(capShown()).toBeCloseTo(fill, 1));
    fireEvent.change(levInput(), { target: { value: "10" } });
    fireEvent.blur(levInput());
    await waitFor(() => expect(Number(levInput().value)).toBeLessThanOrEqual(fill));
    for (const b of screen.getAllByTestId("trade-leverage-preset")) expect(Number(b.getAttribute("data-leverage"))).toBeLessThanOrEqual(fill);
    // The fixture's cap (1.1x) is above 1x, so the slider must render: the bound is checked unconditionally (review of #3778, Info).
    const slider = screen.getByTestId("trade-leverage-slider") as HTMLInputElement;
    expect(Number(slider.max)).toBeLessThanOrEqual(fill);
  });

  it("(3) the highest preset is clamped to the cap, not the market's 10x", async () => {
    const fill = growthMaxLeverageForOrder(view(), "long", 0n, SIZE)!;
    await mount();
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "300" } });
    await waitFor(() => expect(capShown()).toBeCloseTo(fill, 1));
    const presets = screen.getAllByTestId("trade-leverage-preset");
    fireEvent.click(presets[presets.length - 1]);
    await waitFor(() => expect(Number(levInput().value)).toBeLessThanOrEqual(fill));
    expect(Number(levInput().value)).toBeGreaterThan(fill - 1);
  });
});

describe("N2 mounted: a bundled deposit covers the growth requirement on the whole post-fill position (existing long)", () => {
  // An open 200 long backed by 25 USDC (8x on 200): adding 100 more on the crowd side lifts the dynamic IMR for the WHOLE position.
  const CAPITAL = 25_000_000n;
  const POS = 200n * LOT;
  const ADD = 100n * LOT;
  beforeEach(() => {
    mocks.useUserAccount.mockReturnValue({ idx: 3, account: { capital: CAPITAL, positionSize: POS, entryPrice: 1_000_000n, pnl: 0n, feeCredits: 0n } });
  });

  it("(4) the quoted deposit is at least what the deployed growth gate needs, so the chain does not refuse the order", async () => {
    const gate = growthGate({ view: view(), direction: "long", takerEffQ: POS, askQ: ADD, takerEquity: CAPITAL });
    expect(gate.passes).toBe(false);
    expect(gate.extraEquityNeeded).toBeGreaterThan(0n);
    await mount();
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "100" } });
    await waitFor(() => expect(document.getElementById("first-trade-deposit")).not.toBeNull());
    const field = (document.getElementById("first-trade-deposit")) as HTMLInputElement;
    const quoted = Number(field.placeholder.replace(/,/g, ""));
    // The deposit lands before the trade in one transaction: equity after it must meet the post-fill requirement (+ the fee).
    expect(BigInt(Math.round(quoted * 1e6))).toBeGreaterThanOrEqual(gate.extraEquityNeeded);
  });

  const quotedDepositAtoms = async () => {
    await mount();
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "100" } });
    await waitFor(() => expect(document.getElementById("first-trade-deposit")).not.toBeNull());
    const field = document.getElementById("first-trade-deposit") as HTMLInputElement;
    return BigInt(Math.round(Number(field.placeholder.replace(/,/g, "")) * 1e6));
  };

  it("(5) review of #3778 Low-1: the fill fee the gate already counts is not asked twice", async () => {
    const gate = growthGate({ view: view(), direction: "long", takerEffQ: POS, askQ: ADD, takerEquity: CAPITAL });
    const gateFee = CAPITAL - gate.equityAtClip;
    expect(gateFee).toBeGreaterThan(0n);
    const quoted = await quotedDepositAtoms();
    // The quote is the need plus a 10% buffer. With the fee counted twice it was (extra + fee) x 1.1 (measured 156.41 for 139.52 + 2.67).
    expect(quoted).toBeGreaterThanOrEqual(gate.extraEquityNeeded);
    expect(quoted).toBeLessThan(((gate.extraEquityNeeded + gateFee) * 11n) / 10n);
  });
});

describe("N2 mounted: a typed deposit below what the gate needs is refused (existing long)", () => {
  const CAPITAL = 25_000_000n;
  const POS = 200n * LOT;
  const ADD = 100n * LOT;
  beforeEach(() => {
    mocks.useUserAccount.mockReturnValue({ idx: 3, account: { capital: CAPITAL, positionSize: POS, entryPrice: 1_000_000n, pnl: 0n, feeCredits: 0n } });
  });
  it("(5b) a deposit one cent under extraEquityNeeded keeps submit disabled; one at the quoted amount enables it", async () => {
    const gate = growthGate({ view: view(), direction: "long", takerEffQ: POS, askQ: ADD, takerEquity: CAPITAL });
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    await waitFor(() => expect(screen.queryByTestId("growth-max-long")).not.toBeNull(), { timeout: 8000 });
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "100" } });
    await waitFor(() => expect(document.getElementById("first-trade-deposit")).not.toBeNull());
    const field = document.getElementById("first-trade-deposit") as HTMLInputElement;
    const under = (Number(gate.extraEquityNeeded) - 10_000) / 1e6;
    fireEvent.change(field, { target: { value: under.toFixed(2) } });
    await waitFor(() => expect((screen.getByTestId("trade-submit") as HTMLButtonElement).disabled).toBe(true));
    fireEvent.change(field, { target: { value: field.placeholder.replace(/,/g, "") } });
    await waitFor(() => expect((screen.getByTestId("trade-submit") as HTMLButtonElement).disabled).toBe(false));
  });
});

describe("N2 mounted: the deposit floor uses conservative equity (review of #3778 Low-2: negative pnl / fee credits)", () => {
  const CAPITAL = 25_000_000n;
  const POS = 200n * LOT;
  const ADD = 100n * LOT;
  const LOSS = -10_000_000n;
  const quote = async (account: { pnl: bigint; feeCredits: bigint }) => {
    mocks.useUserAccount.mockReturnValue({ idx: 3, account: { capital: CAPITAL, positionSize: POS, entryPrice: 1_000_000n, ...account } });
    const r = render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    await waitFor(() => expect(screen.queryByTestId("growth-max-long")).not.toBeNull(), { timeout: 8000 });
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "100" } });
    await waitFor(() => expect(document.getElementById("first-trade-deposit")).not.toBeNull());
    const v = BigInt(Math.round(Number((document.getElementById("first-trade-deposit") as HTMLInputElement).placeholder.replace(/,/g, "")) * 1e6));
    r.unmount();
    return v;
  };

  for (const [label, acct] of [["negative fee credits", { pnl: 0n, feeCredits: LOSS }], ["negative pnl", { pnl: LOSS, feeCredits: 0n }]] as const) {
    it(`(6) ${label} lower the equity the deposit floor starts from, so the deposit still covers the gate`, async () => {
      const gate = growthGate({ view: view(), direction: "long", takerEffQ: POS, askQ: ADD, takerEquity: CAPITAL + LOSS });
      const flat = await quote({ pnl: 0n, feeCredits: 0n });
      const losing = await quote(acct);
      expect(losing).toBeGreaterThanOrEqual(gate.extraEquityNeeded);
      expect(losing - flat).toBeGreaterThanOrEqual(-LOSS - 1n);
    });
  }
});

describe("r8 (review of #3804, LOW-A): an order the in-market balance backs but the growth gate does not is a deposit order", () => {
  // 200 long open, 80 USDC: adding 100 at 10x needs ~10 USDC of margin (inside what is free) but the whole 300 position's dynamic IMR
  // needs more equity than 33. The ticket must bundle the gate's shortfall (a Deposit field and a Deposit button), not offer a plain
  // order the program refuses. Fails without `|| needsGrowthDeposit` in fundingMode.
  const CAPITAL = 80_000_000n;
  const POS = 200n * LOT;
  const ADD = 100n * LOT;
  beforeEach(() => {
    mocks.useUserAccount.mockReturnValue({ idx: 3, account: { capital: CAPITAL, positionSize: POS, entryPrice: 1_000_000n, pnl: 0n, feeCredits: 0n } });
  });

  it("a deposit is bundled for the gate shortfall, and the deposit label names the collateral the market requires", async () => {
    const gate = growthGate({ view: view(), direction: "long", takerEffQ: POS, askQ: ADD, takerEquity: CAPITAL });
    expect(gate.passes).toBe(false);
    await mount();
    fireEvent.change(levInput(), { target: { value: "10" } });
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "100" } });
    await waitFor(() => expect(document.getElementById("first-trade-deposit")).not.toBeNull());
    const field = document.getElementById("first-trade-deposit") as HTMLInputElement;
    const quoted = BigInt(Math.round(Number(field.placeholder.replace(/,/g, "")) * 1e6));
    expect(quoted).toBeGreaterThanOrEqual(gate.extraEquityNeeded);
    expect(screen.getByTestId("trade-submit").textContent).toMatch(/deposit/i);
    // LOW-D: the amount is gate equity, not "margin"
    expect(screen.getByTestId("fund-explain").textContent).toContain("of the collateral this market requires for this size");
  });
});
