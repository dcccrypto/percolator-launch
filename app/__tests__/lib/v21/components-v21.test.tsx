import "@testing-library/jest-dom";
import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { GrowthTicketPanel } from "@/components/trade/GrowthTicketPanel";
import { CloseOnlyBannerView } from "@/components/trade/CloseOnlyBanner";
import { GrowthLaunchControls, type GrowthLaunchState } from "@/components/create/GrowthLaunchControls";
import { LpPositionDashboard } from "@/components/earn/LpPositionDashboard";
import { growthMarketView, growthTicketDecision } from "@/lib/v21/growth-market";
import { V21_COPY } from "@/lib/v21/copy";
import { ENGINE, LP, marketRaw } from "./fixtures";

afterEach(cleanup);

const view = (oiLong = 30_000_000n, lpQ = -20_000_000n) =>
  growthMarketView({ raw: marketRaw({}), engine: { ...ENGINE, oiEffLongQ: oiLong }, lp: LP, lpEffectiveQ: lpQ, bound: true })!;

describe("GrowthTicketPanel", () => {
  it("shows 'leverage adjusts with market backing', both sides' live max, a capacity bar and the close promise", () => {
    const v = view(80_000_000n, -50_000_000n);
    render(<GrowthTicketPanel view={v} decision={growthTicketDecision(v, "long", 0n, 1_000_000n)} direction="long" />);
    expect(screen.getByTestId("growth-adjusts")).toHaveTextContent("Leverage adjusts with market backing.");
    expect(screen.getByTestId("growth-max-short")).toHaveTextContent("5.5x");
    const longMax = screen.getByTestId("growth-max-long").textContent!;
    expect(longMax).not.toContain("5.5x"); // the crowd side stepped down
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "80");
    expect(screen.getByTestId("growth-capacity-fill")).toHaveStyle({ width: "80%" });
    expect(screen.getByText(/never limited by this/)).toBeInTheDocument();
  });
  it("a full side says so, calmly, and shows 'full'", () => {
    const v = view(100_000_000n, -50_000_000n);
    render(<GrowthTicketPanel view={v} decision={growthTicketDecision(v, "long", 0n, 1_000_000n)} direction="long" />);
    expect(screen.getByTestId("growth-closed")).toHaveTextContent(/full for now/);
    expect(screen.getByTestId("growth-max-long")).toHaveTextContent("full");
  });
  it("the busy-side fee appears only when this order owes one", () => {
    const v = view(60_000_000n, -50_000_000n);
    const { rerender } = render(<GrowthTicketPanel view={v} decision={growthTicketDecision(v, "long", 0n, 20_000_000n)} direction="long" />);
    expect(screen.getByTestId("growth-fee")).toHaveTextContent(/small extra fee of 3\.00%/);
    rerender(<GrowthTicketPanel view={v} decision={growthTicketDecision(v, "long", -20_000_000n, 20_000_000n)} direction="long" />);
    expect(screen.queryByTestId("growth-fee")).toBeNull();
  });
});

describe("CloseOnlyBannerView", () => {
  const base = { line: "x", canWindDown: false, busy: false, error: null, done: false, onWindDown: vi.fn() };
  it("says closing works first; offers the wind-down only when allowed", () => {
    const { rerender } = render(<CloseOnlyBannerView {...base} line={V21_COPY.lock.countdownNotStarted} />);
    expect(screen.getByTestId("close-only-banner")).toHaveTextContent("You can reduce or close your position.");
    expect(screen.queryByTestId("adl-wind-down")).toBeNull();
    const onWindDown = vi.fn();
    rerender(<CloseOnlyBannerView {...base} canWindDown onWindDown={onWindDown} />);
    fireEvent.click(screen.getByTestId("adl-wind-down"));
    expect(onWindDown).toHaveBeenCalledTimes(1);
  });
  it("busy disables it; an error is shown calmly; done replaces it", () => {
    const { rerender } = render(<CloseOnlyBannerView {...base} canWindDown busy />);
    expect(screen.getByTestId("adl-wind-down")).toBeDisabled();
    rerender(<CloseOnlyBannerView {...base} canWindDown error="Try again in a moment." />);
    expect(screen.getByTestId("adl-wind-down-error")).toHaveTextContent("Try again in a moment.");
    rerender(<CloseOnlyBannerView {...base} canWindDown done />);
    expect(screen.queryByTestId("adl-wind-down")).toBeNull();
    expect(screen.getByTestId("adl-wind-down-done")).toBeInTheDocument();
  });
});

describe("GrowthLaunchControls", () => {
  const props = { engineImrBps: 1000, maintenanceMarginBps: 500, maxPriceMoveBpsPerSlot: 4, baseFeeBps: 30, juniorAtoms: 5_000_000n, collateralDecimals: 6, collateralSymbol: "USDC" };
  const mount = (value: GrowthLaunchState, onChange = vi.fn()) => ({ onChange, ...render(<GrowthLaunchControls {...props} value={value} onChange={onChange} />) });
  it("off: only the toggle and the one-line promise", () => {
    mount({ on: false });
    expect(screen.getByTestId("growth-launch-adjusts")).toHaveTextContent("Leverage adjusts with market backing.");
    expect(screen.queryByTestId("growth-l-launch")).toBeNull();
  });
  it("on: defaults are the honest ones (5x, lowest safe r_gap), the facts list the fee cap, funding and $1 junior", () => {
    mount({ on: true });
    expect(screen.getByTestId("growth-l-launch")).toHaveValue("500");
    expect(screen.getByTestId("growth-r-gap")).toHaveValue(2); // percent in the UI, 200 bps on the wire
    const facts = screen.getByTestId("growth-launch-facts");
    expect(facts).toHaveTextContent("about 0.10% per hour");
    expect(facts).toHaveTextContent("6.30%");
    expect(facts).toHaveTextContent("at least 1 USDC");
    expect(screen.queryByTestId("growth-launch-issue")).toBeNull();
  });
  it("offers 1x up to the tier only, and reports edits", () => {
    const { onChange } = mount({ on: true });
    const opts = within(screen.getByTestId("growth-l-launch")).getAllByRole("option").map((o) => Number((o as HTMLOptionElement).value));
    expect(opts[0]).toBe(100);
    expect(opts[opts.length - 1]).toBe(1000);
    fireEvent.change(screen.getByTestId("growth-l-launch"), { target: { value: "800" } });
    expect(onChange).toHaveBeenCalledWith({ on: true, lLaunchX100: 800 });
    fireEvent.change(screen.getByTestId("growth-r-gap"), { target: { value: "3.5" } });
    expect(onChange).toHaveBeenLastCalledWith({ on: true, rGapBps: 350 });
  });
  it("an r_gap below the floor and a junior below $1 are shown, not sent", () => {
    mount({ on: true, rGapBps: 100 });
    expect(screen.getByTestId("growth-launch-issue")).toHaveTextContent(/price-gap allowance is outside/);
    cleanup();
    render(<GrowthLaunchControls {...props} juniorAtoms={500_000n} value={{ on: true }} onChange={vi.fn()} />);
    expect(screen.getByTestId("growth-launch-issue")).toHaveTextContent(/below the minimum/);
  });
});

describe("LpPositionDashboard entry vs exit (R3-L1)", () => {
  const base = { userLpBalance: 100_000_000n, lpSupply: 100_000_000n, vaultBalance: 100_000_000n, decimals: 6, lpDecimals: 6, collateralSymbol: "USDC", redemptionRateE6: 1_000_000n, loading: false };
  it("absent on today's programs", () => {
    render(<LpPositionDashboard {...base} />);
    expect(screen.queryByTestId("lp-entry-vs-exit")).toBeNull();
  });
  it("shows entry -> exit per share and the calm 'below' line", () => {
    render(<LpPositionDashboard {...base} entryVsExit={{ entryAtoms: 100_000_000n, exitAtoms: 91_000_000n, entryPerShare: 1, exitPerShare: 0.91, below: true, belowPct: 9 }} />);
    const el = screen.getByTestId("lp-entry-vs-exit");
    expect(el).toHaveAttribute("data-below", "1");
    expect(el).toHaveTextContent("Entry price vs current exit value");
    expect(el).toHaveTextContent("1.0000 → 0.9100");
    expect(el).toHaveTextContent(/worth less than you put in/);
  });
});
