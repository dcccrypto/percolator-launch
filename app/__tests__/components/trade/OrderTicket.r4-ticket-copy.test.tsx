/**
 * Council round 4, trade-ticket copy and consistency (mounted: the real OrderTicket + GrowthTicketPanel on a crowd-side growth market).
 * N6: the busy-side line states a large fee, never "small". (The inline-Max vs Max-chip disagreement is handed to the N2 owner: out/ticket-copy/N6-max-handoff.md.)
 * N7: one "Entry" meaning (the quote is "Est. fill"), the deposit note itemises margin + fee + cushion with units, the two leverage
 *     figures explain themselves.
 * R3-13: the size box rejects "-5" / "1e3" / "abc12" instead of reading them as 5 / 13 / 12; no "cannot be undone"; no "110% mgn" in the preview.
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
import { V21_COPY } from "@/lib/v21/copy";
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
const sizeBox = () => screen.getByTestId("trade-size-input") as HTMLInputElement;
const ticketText = () => screen.getByTestId("order-ticket").textContent ?? "";

describe("N6: busy-side fee copy", () => {
  beforeEach(() => {
    mocks.useUserAccount.mockReturnValue({ idx: 3, account: { capital: 10_540_000n, positionSize: 0n, entryPrice: 0n, pnl: 0n, feeCredits: 0n } });
  });
  it("a large busy-side fee is stated, not called small", async () => {
    await mount();
    fireEvent.change(sizeBox(), { target: { value: "350" } });
    await waitFor(() => expect(screen.queryByTestId("growth-fee")).not.toBeNull());
    const t = screen.getByTestId("growth-fee").textContent ?? "";
    expect(t).toMatch(/\d+\.\d\d%/);
    expect(t).not.toMatch(/\bsmall extra/i);
    expect(t).toMatch(/high extra fee/);
  });
  it("CONTROL: a sub-1% fee keeps the calm wording", () => {
    expect(V21_COPY.ticket.fee("0.87%")).toMatch(/small extra fee of 0\.87%/);
    expect(V21_COPY.ticket.fee("1.58%")).not.toMatch(/\bsmall extra/);
    expect(V21_COPY.ticket.fee("5.00%")).not.toMatch(/\bsmall extra/);
  });
});

describe("N7 / R3-13: labels and copy", () => {
  beforeEach(() => {
    mocks.useUserAccount.mockReturnValue({ idx: 3, account: { capital: 10_540_000n, positionSize: 0n, entryPrice: 0n, pnl: 0n, feeCredits: 0n } });
  });
  it("the quote is 'Est. fill', not a second 'Entry'; the deposit note itemises margin, fee and the cushion with units", async () => {
    await mount();
    fireEvent.change(sizeBox(), { target: { value: "100" } });
    await waitFor(() => expect(screen.queryByTestId("ticket-summary")).not.toBeNull());
    const summary = screen.getByTestId("ticket-summary").textContent ?? "";
    expect(summary).toMatch(/Est\. fill/i);
    expect(summary).not.toMatch(/Entry/i);
    const note = screen.getByTestId("fund-explain").textContent ?? "";
    expect(note).toMatch(/USDC margin \+ [\d.]+ USDC fee, plus a [\d.]+ USDC cushion for price moves/);
  });
  it("the preview shows no '% mgn'", async () => {
    await mount();
    fireEvent.change(sizeBox(), { target: { value: "5" } });
    await waitFor(() => expect(screen.queryByTestId("ticket-summary")).not.toBeNull());
    expect(ticketText()).not.toMatch(/% mgn/);
  });
  it.each([["-5"], ["1e3"], ["abc12"]])("size %s is rejected with a reason, not read as another number", async (typed) => {
    await mount();
    fireEvent.change(sizeBox(), { target: { value: typed } });
    expect(sizeBox().value).toBe(typed);
    expect(screen.getByTestId("trade-size-rejection").textContent).toMatch(/./);
    expect(screen.queryByTestId("ticket-summary")).toBeNull();
    expect((screen.getByTestId("trade-submit") as HTMLButtonElement).disabled).toBe(true);
  });
  it("CONTROL: a plain size is accepted with no rejection", async () => {
    await mount();
    fireEvent.change(sizeBox(), { target: { value: "5" } });
    expect(sizeBox().value).toBe("5");
    expect(screen.queryByTestId("trade-size-rejection")).toBeNull();
  });
});


describe("R7 review follow-ups: ticket copy and cleared size box", () => {
  beforeEach(() => {
    mocks.useUserAccount.mockReturnValue({ idx: 3, account: { capital: 10_540_000n, positionSize: 0n, entryPrice: 0n, pnl: 0n, feeCredits: 0n } });
  });
  it("a refused size does not come back after a market switch", async () => {
    const { rerender } = render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("growth-max-long")).not.toBeNull(), { timeout: 8000 });
    fireEvent.change(sizeBox(), { target: { value: "-5" } });
    expect(screen.getByTestId("trade-size-rejection").textContent).toMatch(/./);
    rerender(<OrderTicket slabAddress="9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" />);
    await waitFor(() => expect(sizeBox().value).toBe(""));
    expect(screen.queryByTestId("trade-size-rejection")).toBeNull();
  });
  it("a deposit the user typed is not called a cushion for price moves", async () => {
    await mount();
    fireEvent.change(sizeBox(), { target: { value: "100" } });
    await waitFor(() => expect(screen.queryByTestId("deposit-amount-input")).not.toBeNull());
    fireEvent.change(screen.getByTestId("deposit-amount-input"), { target: { value: "500" } });
    const note = screen.getByTestId("fund-explain").textContent ?? "";
    expect(note).toMatch(/[\d.]+ USDC extra that stays available in your account/);
    expect(note).not.toMatch(/cushion for price moves/);
  });
  it("the Est. fill tooltip says what the estimate is (mark and base fee, no spread)", async () => {
    await mount();
    fireEvent.change(sizeBox(), { target: { value: "100" } });
    await waitFor(() => expect(screen.queryByTestId("ticket-summary")).not.toBeNull());
    const label = screen.getByText("Est. fill");
    fireEvent.mouseEnter(label.querySelector("svg")!.parentElement!);
    const tip = (await screen.findByRole("tooltip")).textContent ?? "";
    expect(tip).toMatch(/base trading fee/);
    expect(tip).not.toMatch(/and spread/);
  });
  it("the Liq. price tooltip names the Est. fill row, not an 'estimated entry'", async () => {
    await mount();
    fireEvent.change(sizeBox(), { target: { value: "100" } });
    await waitFor(() => expect(screen.queryByTestId("ticket-summary")).not.toBeNull());
    const label = screen.getByText("Liq. price");
    fireEvent.mouseEnter(label.querySelector("svg")!.parentElement!);
    const tip = (await screen.findByRole("tooltip")).textContent ?? "";
    expect(tip).toMatch(/est\. fill price/);
    expect(tip).not.toMatch(/estimated entry/);
  });
});
