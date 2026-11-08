/**
 * M9 (mounted): the real OrderTicket on a first trade (no account) with a growth side room far below the wallet-bound size.
 * Max is clamped to the room; an oversize ask is clamped / blocked so the deposit, margin and fee never price unfillable size;
 * the busy-side surcharge is in Fee with no matcher quote; a funded wallet with an impossible size sees no "Get test funds".
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
    // The bundled deposit field is the first-trade quote: it must be there and sized on the 350 fill (margin + fee + buffer), not on 5,000.
    await waitFor(() => expect(document.getElementById("first-trade-deposit")).not.toBeNull());
    const deposit = document.getElementById("first-trade-deposit") as HTMLInputElement;
    const quoted = Number(deposit.placeholder.replace(/,/g, "")); // the field is empty until edited; the placeholder is the quoted deposit
    expect(quoted).toBeGreaterThan(350); // margin + fee + buffer on the 350 fill
    expect(quoted).toBeLessThan(450); // the 5,000 ask would quote ~5,500
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
    // The tooltip names the busy-side fee, and does NOT credit a matcher quote fee that does not exist on this market.
    const tip = Array.from(document.querySelectorAll('[role="tooltip"]')).map((e) => e.textContent ?? "").find((t) => t.startsWith("Estimated") && t.includes("base fee"));
    expect(tip).toBeTruthy();
    expect(tip).toContain("the busy-side fee");
    expect(tip).not.toContain("quote fee");
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

  it("(5) in the render BEFORE the clamp lands, an oversize ask is already blocked and labelled, never 'Get test funds'", async () => {
    await mount();
    probe.commits.length = 0;
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5000" } });
    const pre = probe.commits.find((c) => c.size === "5000");
    expect(pre).toBeTruthy();
    expect(pre!.disabled).toBe(true);
    expect(pre!.label).toContain("Over the max fillable size");
    expect(pre!.label).not.toContain("Get test funds");
    probe.commits.length = 0;
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "999999999" } });
    const pre2 = probe.commits.find((c) => c.size === "999999999");
    expect(pre2).toBeTruthy();
    expect(pre2!.disabled).toBe(true);
    expect(pre2!.label).not.toContain("Get test funds");
    // And once the clamp lands the order is the fillable one and submit is live again.
    await waitFor(() => expect((screen.getByTestId("trade-size-input") as HTMLInputElement).value).toBe("350.00"));
    expect((screen.getByTestId("trade-submit") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("M9 mounted: the room is a required input (loading / failed room read fails closed on a room-limited v22 market)", () => {
  const unknown = (growthRoom: "loading" | "error") =>
    mocks.useMarketLimits.mockReturnValue(marketLimits({ matcher: null, growth: null, growthRoom, flags: { p1: false, p2: false, p2FeeCharged: false, p3: false } }));
  const mountUnknown = async () => {
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
  };
  const btn = () => screen.getByTestId("trade-submit") as HTMLButtonElement;

  for (const [state, label] of [["loading", "Checking room"], ["error", "Market room unavailable"]] as const) {
    it(`(6-${state}) room ${state}: no wallet-bound Max, submit disabled + labelled, never a deposit CTA or Get test funds, for any size`, async () => {
      unknown(state);
      await mountUnknown();
      // Max is not offered (it used to show the wallet balance x leverage).
      expect(screen.queryByTestId("limits-max-size-inline")).toBeNull();
      for (const size of ["", "300", "5000", "999999999"]) {
        fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: size } });
        expect(btn().disabled).toBe(true);
        expect(btn().textContent).toContain(label);
        expect(btn().textContent).not.toContain("Get test funds");
        expect(btn().textContent).not.toMatch(/DEPOSIT/i);
        expect(screen.queryByTestId("limits-max-size-inline")).toBeNull();
      }
      expect(document.body.textContent).not.toContain("Reduced to the most available");
      // No quote for the unfillable size: no deposit box / explain / summary Fee+Margin, only the calm note.
      expect(document.getElementById("first-trade-deposit")).toBeNull();
      expect(screen.queryByTestId("deposit-amount-input")).toBeNull();
      expect(screen.queryByTestId("fund-explain")).toBeNull();
      expect(screen.queryByTestId("starter-deposit-error")).toBeNull();
      expect(screen.queryByTestId("ticket-summary")).toBeNull();
      expect(screen.getByTestId("room-unknown-note").textContent).toContain(state === "loading" ? "Checking room" : "Market room unavailable");
      expect(document.body.textContent).not.toMatch(/5,?516|1,?002,?999,?998/);
    });
  }

  it("(8) a NON-null fill cap (LP inventory room) does not clamp or message while the room is unknown", async () => {
    mocks.useMarketFillCap.mockReturnValue({ maxFillAbs: 252_489_196n * LOT, sideRoomQ: () => 252_489_196n * LOT });
    unknown("loading");
    await mountUnknown();
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "999999999" } });
    await new Promise((r) => setTimeout(r, 50));
    expect((screen.getByTestId("trade-size-input") as HTMLInputElement).value).toBe("999999999");
    expect(document.body.textContent).not.toContain("Reduced to the most available");
    expect(document.getElementById("first-trade-deposit")).toBeNull();
    expect(btn().disabled).toBe(true);
    expect(btn().textContent).toContain("Checking room");
  });

  it("(9) a stuck 'loading' turns into 'Market room unavailable' once the slow flag fires", async () => {
    unknown("loading");
    await mountUnknown();
    expect(btn().textContent).toContain("Checking room");
    slow.on = true;
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "300" } }); // re-render (memoised ticket)
    await waitFor(() => expect(btn().textContent).toContain("Market room unavailable"));
    expect(btn().disabled).toBe(true);
    slow.on = false;
  });

  it("(7) control: once the room loads, Max is the room and an in-room order is submittable again", async () => {
    unknown("loading");
    const { rerender } = render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    expect(btn().textContent).toContain("Checking room");
    mocks.useMarketLimits.mockReturnValue(marketLimits({ matcher: null, growth: view(), growthRoom: "known", flags: { p1: false, p2: false, p2FeeCharged: false, p3: false } }));
    rerender(<OrderTicket slabAddress={SLAB} />);
    // The ticket is memoised on its props: a local edit is what re-reads the hook (as the 20 s poll's state update does in the app).
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "1" } });
    await waitFor(() => expect(screen.queryByTestId("limits-max-size-inline")).not.toBeNull(), { timeout: 8000 });
    expect(maxQ()).toBe(ROOM);
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "300" } });
    await waitFor(() => expect(btn().disabled).toBe(false));
    expect(btn().textContent).not.toContain("Checking room");
  });

  it("(10) a reduce of the open position is not held on the room read (opposite side, no larger than the position)", async () => {
    mocks.useUserAccount.mockReturnValue({ idx: 3, account: { capital: 500_000_000n, positionSize: 200n * LOT, entryPrice: 1_000_000n, pnl: 0n, feeCredits: 0n } });
    unknown("loading");
    await mountUnknown();
    // Same-direction (long) add is held on the room ...
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "50" } });
    expect(btn().textContent).toContain("Checking room");
    // ... a short smaller than the long position is a reduce: not held by the room read.
    fireEvent.click(screen.getByTestId("trade-side-short"));
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "50" } });
    expect(btn().textContent).not.toContain("Checking room");
    expect(btn().textContent).not.toContain("Market room unavailable");
  });

  it("(11) room unknown: Max and the % chips never exceed the open position on the reducing side, and offer nothing on the adding side, whatever is typed", async () => {
    mocks.useUserAccount.mockReturnValue({ idx: 3, account: { capital: 500_000_000n, positionSize: 200n * LOT, entryPrice: 1_000_000n, pnl: 0n, feeCredits: 0n } });
    unknown("loading");
    await mountUnknown();
    const input = () => screen.getByTestId("trade-size-input") as HTMLInputElement;
    const preset = (pct: number) => screen.getAllByTestId("trade-size-preset").find((b) => b.getAttribute("data-percent") === String(pct))!;
    // Adding side (long on a long position): no Max, chips do nothing.
    for (const typed of ["", "50"]) {
      fireEvent.change(input(), { target: { value: typed } });
      expect(screen.queryByTestId("limits-max-size-inline")).toBeNull();
      fireEvent.click(preset(100));
      fireEvent.click(preset(50));
      expect(input().value).toBe(typed);
    }
    // Reducing side (short): Max is at most the position (a full close), for any typed size, and the chips cannot fill above it.
    fireEvent.click(screen.getByTestId("trade-side-short"));
    for (const typed of ["", "50", "200"]) {
      fireEvent.change(input(), { target: { value: typed } });
      expect(maxQ()).toBe(200n * LOT);
      fireEvent.click(preset(100));
      expect(Number(input().value)).toBeLessThanOrEqual(200);
      expect(Number(input().value)).toBe(200);
      fireEvent.click(preset(50));
      expect(Number(input().value)).toBe(100);
    }
  });

  it("(12) the confirm modal re-checks the room: a room lost after the modal opened does not send", async () => {
    await mount();
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "300" } });
    await waitFor(() => expect(btn().disabled).toBe(false));
    fireEvent.click(btn());
    await waitFor(() => expect(screen.queryByTestId("confirm-modal")).not.toBeNull());
    // The room read is lost while the modal is open (a re-render picks it up, as the poll's state update would).
    unknown("loading");
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "301" } });
    await waitFor(() => expect(btn().textContent).toContain("Checking room"));
    await act(async () => { mocks.modal.props!.onConfirm(); });
    expect(mocks.fundAndTrade).not.toHaveBeenCalled();
  });

  it("(12-control) with the room known the same confirm does send", async () => {
    await mount();
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "300" } });
    await waitFor(() => expect(btn().disabled).toBe(false));
    fireEvent.click(btn());
    await waitFor(() => expect(screen.queryByTestId("confirm-modal")).not.toBeNull());
    await act(async () => { mocks.modal.props!.onConfirm(); });
    await waitFor(() => expect(mocks.fundAndTrade).toHaveBeenCalled());
  });
});
