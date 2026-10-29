import "@testing-library/jest-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { V22LaunchOptions } from "@/components/create/V22LaunchOptions";
import { planLaunchV22, type LaunchPlanInput } from "@/lib/v22/launch-plan";
import { V22_COPY } from "@/lib/v22/copy";
import { __setLotMarketsEnabledForTest } from "@/lib/v22/lot";
// Lot markets are only creatable once every trade surface is lot-aware (review F3); these tests exercise the lot path itself.
__setLotMarketsEnabledForTest(true);

afterEach(cleanup);

const input = (o: Partial<LaunchPlanInput> = {}): LaunchPlanInput => ({ tokenPriceE6: 400n, collateralDecimals: 6, collateralSymbol: "USDC", oracleMode: "keeper", growthOn: true, ...o });
const mount = (o: Partial<LaunchPlanInput> = {}, value = {}) => {
  const onChange = vi.fn();
  const plan = planLaunchV22(input(o));
  const r = render(<V22LaunchOptions value={value} onChange={onChange} plan={plan} symbol="TOK" />);
  return { onChange, plan, ...r };
};

describe("V22LaunchOptions", () => {
  it("memecoin preset: protection and holding fee start ON, bond OFF; calm facts are shown", () => {
    mount();
    expect(screen.getByTestId("v22-protection-toggle")).toBeChecked();
    expect(screen.getByTestId("v22-holding-fee-toggle")).toBeChecked();
    expect(screen.getByTestId("v22-bond-toggle")).not.toBeChecked();
    expect(screen.getByTestId("v22-notes")).toHaveTextContent("64 minutes");
    expect(screen.getByTestId("v22-notes")).toHaveTextContent("Minimum position size 100 USDC.");
    expect(screen.getByTestId("v22-lot-tip")).toHaveTextContent("1 lot = 100,000 TOK");
    expect(screen.queryByTestId("v22-launch-issue")).toBeNull();
  });
  it("creator share disclosure (D5): the wizard launches a fee-only pool and says so plainly; no first-loss choice is implied", () => {
    const { container } = mount();
    const box = screen.getByTestId("v22-creator-share");
    expect(screen.getByTestId("v22-creator-share-fee-only")).toHaveTextContent("Your market's stake pool is fee-only: the creator share (16% of fees) is yours.");
    expect(box.textContent).toBe(V22_COPY.stake.creatorShare.feeOnly);
    expect(box.textContent).not.toMatch(/first-loss|protocol|asset.?admin|burn|tag \d+|authority/i);
    expect(screen.queryByTestId("v22-creator-share-first-loss")).toBeNull();
    expect(screen.queryByTestId("v22-creator-share-compare")).toBeNull();
    expect(container.textContent).toContain("16%");
  });
  it("creator share disclosure is not shown when the launch options are unavailable", () => {
    const plan = { ...planLaunchV22(input()), available: false } as ReturnType<typeof planLaunchV22>;
    render(<V22LaunchOptions value={{}} onChange={vi.fn()} plan={plan} symbol="TOK" />);
    expect(screen.queryByTestId("v22-creator-share")).toBeNull();
  });
  it("admin oracle: both OFF, no notes", () => {
    mount({ oracleMode: "admin" });
    expect(screen.getByTestId("v22-protection-toggle")).not.toBeChecked();
    expect(screen.queryByTestId("v22-notes")).toBeNull();
  });
  it("names no protocol field anywhere in the rendered text", () => {
    const { container } = mount({ bond: true });
    expect(container.textContent).not.toMatch(/lot_?exp|kink|band_bps|rent_max|tag \d+|InitBondTranche/i);
    expect(container.textContent).toContain("Price protection");
    expect(container.textContent).toContain("Holding fee");
  });
  it("toggles report edits", () => {
    const { onChange } = mount();
    fireEvent.click(screen.getByTestId("v22-protection-toggle"));
    expect(onChange).toHaveBeenLastCalledWith({ protection: false });
    fireEvent.click(screen.getByTestId("v22-bond-toggle"));
    expect(onChange).toHaveBeenLastCalledWith({ bond: true });
  });
  it("bond on: the honest facts (loss order, capped fee coupon, flat-book exit, one transaction)", () => {
    mount({ bond: true });
    const f = screen.getByTestId("v22-bond-facts");
    expect(f).toHaveTextContent(V22_COPY.bond.absorbs);
    expect(f).toHaveTextContent(V22_COPY.bond.coupon);
    expect(f).toHaveTextContent(V22_COPY.bond.exit);
    expect(f).toHaveTextContent(V22_COPY.wizard.bondAtomic);
  });
  it("NEGATIVE CONTROL: a launch price below the floor shows the clear one-line refusal; the same plan with a good price shows none", () => {
    mount({ tokenPriceE6: 0n });
    expect(screen.getByTestId("v22-launch-issue")).toHaveTextContent(V22_COPY.wizard.priceUnknown);
    cleanup();
    mount({ tokenPriceE6: 100_000_000_000n });
    expect(screen.getByTestId("v22-launch-issue")).toHaveTextContent("at most $10,000 per lot");
    cleanup();
    mount({ tokenPriceE6: 5_000_000n });
    expect(screen.queryByTestId("v22-launch-issue")).toBeNull();
  });
  it("renders nothing when v2.2 does not apply (growth block off)", () => {
    const { container } = mount({ growthOn: false });
    expect(container).toBeEmptyDOMElement();
  });
});

describe("V22LaunchOptions creator seed line (S1)", () => {
  it("says, in one line, what happens to the insurance seed at close", () => {
    mount();
    expect(screen.getByTestId("v22-creator-seed")).toHaveTextContent(
      "If this market closes, you get back your insurance seed (or what's left of it after losses). Anything above it goes to stakers.",
    );
  });
});
