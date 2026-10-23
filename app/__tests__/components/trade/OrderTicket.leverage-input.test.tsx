/**
 * GH#2628 — typing a fractional leverage into the real order ticket.
 *
 * The unit tests cover lib/leverage-control.ts. They cannot cover the WIRING,
 * and the wiring is where the defect lived: `onChange` set the text and
 * `updateLeverage` immediately overwrote it, so the keystroke that typed "."
 * erased it and the next digit produced "45" — clamped to the market maximum.
 *
 * I first claimed this component was too heavy to render. That was wrong:
 * DepositWithdrawCard.wallet-switch.test.tsx in this directory renders a
 * sibling with the same `{ slabAddress }` prop behind 13 mocks, and most of
 * them are reusable. Without this file, every call-site revert — Math.round
 * back around the value, a local `const LEVERAGE_STEP = 1` shadowing the
 * import, a working snap re-added one line from the helper — passes.
 */

import { fireEvent, render } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useWalletCompat: vi.fn(),
  useConnectionCompat: vi.fn(),
  useUserAccount: vi.fn(),
  useSlabState: vi.fn(),
  useEngineState: vi.fn(),
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: mocks.useWalletCompat,
  useConnectionCompat: mocks.useConnectionCompat,
}));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount, useUserAccountScanPending: () => false }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: mocks.useEngineState }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddressSync: vi.fn(() => new PublicKey("11111111111111111111111111111111")) }));
vi.mock("@/hooks/useTrade", () => ({
  useTrade: () => ({ trade: vi.fn(), loading: false, error: null }),
  prewarmTradeSubmission: vi.fn(),
}));
vi.mock("@/hooks/useMarketFillCap", () => ({ useMarketFillCap: () => ({ maxFillAbs: null }) }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => null }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ isStale: false, stale: false }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ isStale: false, stale: false }) }));
vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyLogin: () => vi.fn(), usePrivyAvailable: () => false }));
vi.mock("@/hooks/useWalletAdapterAvailable", () => ({ useWalletAdapterAvailable: () => true }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 1_000_000n }) }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccountIdle: () => null, getMockUserAccount: () => null }));
vi.mock("@/lib/tx", () => ({ prewarmTxLanding: vi.fn() }));
vi.mock("@/components/trade/DepositWithdrawCard", () => ({ DepositWithdrawCard: () => null }));
vi.mock("@/components/trade/TradeConfirmationModal", () => ({ TradeConfirmationModal: () => null }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));

import { OrderTicket } from "@/components/trade/OrderTicket";

const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";
const MINT = new PublicKey("So11111111111111111111111111111111111111112");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useWalletCompat.mockReturnValue({
    publicKey: new PublicKey("11111111111111111111111111111111"),
    connected: true,
  });
  mocks.useConnectionCompat.mockReturnValue({ connection: {} });
  mocks.useUserAccount.mockReturnValue({ account: { capital: 1_000_000_000n }, accountIndex: 0 });
  mocks.useSlabState.mockReturnValue({
    accounts: [],
    config: { collateralMint: MINT, decimals: 6 },
    header: null,
    refresh: vi.fn(),
    programId: new PublicKey("11111111111111111111111111111111"),
  });
  // 1000 bps -> a 10x market.
  mocks.useEngineState.mockReturnValue({
    engine: null,
    params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n },
    insuranceBalance: 0n,
    totalOI: 0n,
    hasData: true,
  });
});

/** The leverage box, found the way a user identifies it. */
const box = () => document.getElementById("order-leverage-input") as HTMLInputElement;
/** The range input specifically — several nodes carry the "Leverage" label. */
const slider = () =>
  document.querySelector('input[type="range"][aria-label="Leverage"]') as HTMLInputElement;

describe("the leverage box accepts a typed decimal", () => {
  it("renders the control at all", () => {
    // CONTROL for everything below: if the ticket bailed early (disconnected,
    // no market data) the assertions would pass vacuously on a missing element.
    render(<OrderTicket slabAddress={SLAB} />);
    expect(box()).toBeTruthy();
    expect(box().getAttribute("inputMode") ?? box().getAttribute("inputmode")).toBe("decimal");
  });

  it("the decimal point survives the keystroke that types it", () => {
    render(<OrderTicket slabAddress={SLAB} />);
    fireEvent.change(box(), { target: { value: "2" } });
    expect(box().value).toBe("2");
    // THE regression. This used to redraw as "2" — parseFloat("2.") is 2 — so
    // the next digit produced "25".
    fireEvent.change(box(), { target: { value: "2." } });
    expect(box().value).toBe("2.");
  });

  it("typing 2.5 applies 2.5, not the market maximum", () => {
    render(<OrderTicket slabAddress={SLAB} />);
    for (const v of ["2", "2.", "2.5"]) fireEvent.change(box(), { target: { value: v } });
    expect(box().value).toBe("2.5");
    // The old behaviour on this 10x market was "10".
    expect(box().value).not.toBe("10");
  });

  it("CONTROL: an over-range value is still clamped", () => {
    // Proves the clamp runs, so the tests above are about the decimal point
    // rather than an inert input.
    render(<OrderTicket slabAddress={SLAB} />);
    fireEvent.change(box(), { target: { value: "99" } });
    fireEvent.blur(box());
    expect(box().value).toBe("10");
  });

  it("the slider steps in halves, not whole numbers", () => {
    render(<OrderTicket slabAddress={SLAB} />);
    // CONTROL: the range input exists, so the attribute assertions below are
    // about its values rather than a missing node.
    expect(slider()).toBeTruthy();
    // Kills a local `const LEVERAGE_STEP = 1` shadowing the import, which the
    // source scan cannot see.
    expect(slider().getAttribute("step")).toBe("0.5");
    expect(slider().getAttribute("max")).toBe("10");
  });

  it("N3: a click on the track above the 5x label sets 5x, not the linear 7x", () => {
    render(<OrderTicket slabAddress={SLAB} />);
    // jsdom has no layout: give the track a 300px box. Presets on this 10x market are 1/3/5/10,
    // drawn at 0/100/200/300px.
    const track = slider().parentElement as HTMLElement;
    track.getBoundingClientRect = () => ({ left: 0, width: 300, top: 0, height: 24, right: 300, bottom: 24, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.pointerDown(track, { button: 0, clientX: 200, pointerId: 1 });
    expect(box().value).toBe("5");
    // The native input still reads the leverage, for the keyboard and screen readers.
    expect(slider().getAttribute("aria-valuetext")).toBe("5x");
  });

  it("N3: a touch that the browser turns into a page scroll leaves the leverage as it was", () => {
    render(<OrderTicket slabAddress={SLAB} />);
    const track = slider().parentElement as HTMLElement;
    track.getBoundingClientRect = () => ({ left: 0, width: 300, top: 0, height: 24, right: 300, bottom: 24, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.pointerDown(track, { button: 0, clientX: 200, pointerId: 2, pointerType: "touch" });
    expect(box().value).toBe("5");
    // touch-action: pan-y hands a vertical swipe to the page and cancels the pointer.
    fireEvent.pointerCancel(track, { pointerId: 2, pointerType: "touch" });
    expect(box().value).toBe("1");
  });

  it("dragging the slider is not overridden by a snap to a preset", () => {
    render(<OrderTicket slabAddress={SLAB} />);
    fireEvent.change(slider(), { target: { value: "4.5" } });
    // A re-added working snap pulls this to 5 — and it can be re-added at the
    // call site, one line from the helper the unit tests guard.
    expect(box().value).toBe("4.5");
  });
});
