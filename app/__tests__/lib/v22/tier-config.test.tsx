import "@testing-library/jest-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { GrowthLaunchControls } from "@/components/create/GrowthLaunchControls";
import { TierControls } from "@/components/create/TierControls";
import { V22LaunchOptions, type V22OptionsState } from "@/components/create/V22LaunchOptions";
import { planLaunchV22, type LaunchPlanInput } from "@/lib/v22/launch-plan";
import { EMPTY_TIER_EDIT, amountLabel, collateralDecimalsIssue, isUsdLikeCollateral, tierDefaultsLine, tierLeverageOptions, validateTierEdit, type TierEdit } from "@/lib/v22/tier-config";
import { V22_COPY } from "@/lib/v22/copy";
import { __setLotMarketsEnabledForTest } from "@/lib/v22/lot";

__setLotMarketsEnabledForTest(true);
afterEach(cleanup);

const LAUNCH = 500; // 5x
const MAX = 2_000; // built for 20x
const edit = (o: Partial<{ t: [string, string, string]; l: [string, string, string] }> = {}): TierEdit => ({
  thresholds: o.t ?? ["", "", ""],
  leverage: o.l ?? ["", "", ""],
});
const check = (e: TierEdit, launch = LAUNCH, max = MAX) => validateTierEdit(e, launch, max);

describe("defaults line", () => {
  it("20x market: the protocol defaults, in one line", () => {
    expect(tierDefaultsLine(LAUNCH, MAX)).toBe("5x at $25k · 10x at $100k · 20x at $500k pool depth and market backing");
  });
  it("a market built for 10x never shows a higher default than its own maximum", () => {
    expect(tierDefaultsLine(LAUNCH, 1_000)).toBe("5x at $25k · 10x at $100k · 10x at $500k pool depth and market backing");
  });
});

describe("collateral wording: $ only on a 6-decimal USD-like token", () => {
  const TOK = { decimals: 9, symbol: "TOK", usdLike: false };
  it("amountLabel", () => {
    expect(amountLabel(25_000)).toBe("$25k");
    expect(amountLabel(25_000, TOK)).toBe("25k TOK");
    expect(amountLabel(1_500_000, { decimals: 6, usdLike: true })).toBe("$1.5M");
    expect(amountLabel(5_000, { decimals: 9, usdLike: true, symbol: "USDX" })).toBe("5k USDX");
    expect(amountLabel(5_000, {})).toBe("5k tokens");
    expect(isUsdLikeCollateral("USDC", 6)).toBe(true);
    expect(isUsdLikeCollateral("sim-USDC", 6)).toBe(true);
    expect(isUsdLikeCollateral("USDX", 9)).toBe(false);
    expect(isUsdLikeCollateral("TOK", 6)).toBe(false);
  });
  it("the defaults line names the token", () => {
    expect(tierDefaultsLine(LAUNCH, MAX, TOK)).toBe("5x at 25k TOK · 10x at 100k TOK · 20x at 500k TOK pool depth and market backing");
  });
  it("issues say tokens, not dollars", () => {
    const r = validateTierEdit(edit({ t: ["4999", "", ""] }), LAUNCH, MAX, TOK);
    expect(r.issues[0]?.message).toBe("Tier 1 pool depth must be at least 5,000 TOK.");
    expect(validateTierEdit(edit({ t: ["4999", "", ""] }), LAUNCH, MAX).issues[0]?.message).toBe("Tier 1 pool depth must be at least $5,000.");
    expect(validateTierEdit(edit({ t: ["1.5", "", ""] }), LAUNCH, MAX, TOK).issues[0]?.message).toBe("Tier 1 pool depth must be a whole number of TOK.");
    expect(validateTierEdit(edit({ t: ["1.5", "", ""] }), LAUNCH, MAX).issues[0]?.message).toBe("Tier 1 pool depth must be a whole number of dollars.");
  });
  it("the wizard labels follow the collateral", () => {
    render(<TierControls value={EMPTY_TIER_EDIT} onChange={vi.fn()} lLaunchX100={LAUNCH} lTierX100={MAX} collateral={TOK} defaultOpen />);
    expect(screen.getByText("Tier 1 amount (TOK)")).toBeInTheDocument();
    expect(screen.getByTestId("tier-threshold-1")).toHaveAttribute("placeholder", "Default 25k TOK");
    expect(screen.getByTestId("tier-explain")).toHaveTextContent("floor (5k TOK, 20k TOK, 100k TOK)");
    cleanup();
    render(<TierControls value={EMPTY_TIER_EDIT} onChange={vi.fn()} lLaunchX100={LAUNCH} lTierX100={MAX} defaultOpen />);
    expect(screen.getByText("Tier 1 amount ($)")).toBeInTheDocument();
    expect(screen.getByTestId("tier-explain")).toHaveTextContent("floor ($5k, $20k, $100k)");
  });
});

describe("D-L1: collateral above 12 decimals", () => {
  const LINE = "This collateral has more than 12 decimals, so a leveraged market cannot use it.";
  it("one calm line, from 13 decimals up", () => {
    expect(collateralDecimalsIssue(6)).toBeNull();
    expect(collateralDecimalsIssue(12)).toBeNull();
    expect(collateralDecimalsIssue(13)).toBe(LINE);
    expect(collateralDecimalsIssue(18)).toBe(LINE);
  });
  it("the tier form is blocked by it, even when empty", () => {
    const r = validateTierEdit(EMPTY_TIER_EDIT, LAUNCH, MAX, { decimals: 13, symbol: "WIDE" });
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual([{ field: "collateral", message: LINE }]);
    expect(validateTierEdit(edit({ t: ["10000", "", ""] }), LAUNCH, MAX, { decimals: 13 }).ok).toBe(false);
    expect(validateTierEdit(EMPTY_TIER_EDIT, LAUNCH, MAX, { decimals: 12 }).ok).toBe(true);
  });
  it("TierControls shows it as the one whole-form line", () => {
    render(<TierControls value={EMPTY_TIER_EDIT} onChange={vi.fn()} lLaunchX100={LAUNCH} lTierX100={MAX} collateral={{ decimals: 13, symbol: "WIDE" }} defaultOpen />);
    expect(screen.getByTestId("tier-issue")).toHaveTextContent(LINE);
  });
  it("the growth controls show it and the wizard copy is the same sentence", () => {
    render(<GrowthLaunchControls value={{ on: true }} onChange={vi.fn()} engineImrBps={1_000} maintenanceMarginBps={500} maxPriceMoveBpsPerSlot={1} baseFeeBps={30} juniorAtoms={100_000_000_000_000n} collateralDecimals={13} collateralSymbol="WIDE" />);
    expect(screen.getByTestId("growth-decimals-issue")).toHaveTextContent(LINE);
    cleanup();
    render(<GrowthLaunchControls value={{ on: true }} onChange={vi.fn()} engineImrBps={1_000} maintenanceMarginBps={500} maxPriceMoveBpsPerSlot={1} baseFeeBps={30} juniorAtoms={100_000_000n} collateralDecimals={6} collateralSymbol="USDC" />);
    expect(screen.queryByTestId("growth-decimals-issue")).toBeNull();
  });
});

describe("validation: every bound", () => {
  it("empty form = the protocol defaults: ok, nothing on the wire", () => {
    expect(check(EMPTY_TIER_EDIT)).toEqual({ ok: true, issues: [] });
  });
  it("a valid edit yields the wire block (whole dollars, leverage x100)", () => {
    const r = check(edit({ t: ["10000", "50000", "200000"], l: ["6", "12.5", "20"] }));
    expect(r.ok).toBe(true);
    expect(r.config).toEqual({ thresholdUsd: [10_000, 50_000, 200_000], leverageX100: [600, 1_250, 2_000] });
  });
  it.each([
    [["4999", "", ""], 1, "Tier 1 pool depth must be at least $5,000."],
    [["", "19999", ""], 2, "Tier 2 pool depth must be at least $20,000."],
    [["", "", "99999"], 3, "Tier 3 pool depth must be at least $100,000."],
  ] as const)("below the floor %j", (t, tier, message) => {
    const r = check(edit({ t: [...t] as [string, string, string] }));
    expect(r.ok).toBe(false);
    expect(r.issues).toContainEqual({ field: "thresholds", tier, message });
  });
  it("thresholds must rise", () => {
    const r = check(edit({ t: ["30000", "30000", "500000"] }));
    expect(r.issues).toContainEqual({ field: "thresholds", tier: 2, message: "Tier 2 pool depth must be higher than tier 1." });
  });
  it("a non-numeric threshold or leverage is a field issue, not a crash", () => {
    expect(check(edit({ t: ["abc", "", ""] })).issues[0]).toMatchObject({ field: "thresholds", tier: 1 });
    expect(check(edit({ l: ["", "x", ""] })).issues[0]).toMatchObject({ field: "leverage", tier: 2 });
  });
  it("leverage below the launch leverage", () => {
    const r = check(edit({ l: ["4", "", ""] }));
    expect(r.issues).toContainEqual({ field: "leverage", tier: 1, message: "Tier 1 leverage cannot be below the launch leverage of 5x." });
  });
  it("leverage must rise tier over tier", () => {
    const r = check(edit({ l: ["8", "7", "9"] }));
    expect(r.issues).toContainEqual({ field: "leverage", tier: 2, message: "Tier 2 leverage cannot be below tier 1's 8x." });
  });
  it("leverage above the market's built-in maximum", () => {
    const r = check(edit({ l: ["", "", "25"] }));
    expect(r.issues).toContainEqual({ field: "leverage", tier: 3, message: "Tier 3 leverage cannot exceed this market's maximum of 20x." });
  });
  it("leverage choices stop at the market's maximum and start at the launch leverage", () => {
    const o = tierLeverageOptions(LAUNCH, MAX);
    expect(o[0]).toBe(500);
    expect(Math.max(...o)).toBe(2_000);
    expect(tierLeverageOptions(500, 1_000).at(-1)).toBe(1_000);
    expect(tierLeverageOptions(550, 1_000)[0]).toBe(550);
  });
});

describe("TierControls: collapsed by default, live validation", () => {
  const mount = (value = EMPTY_TIER_EDIT, open = false) => {
    const onChange = vi.fn();
    render(<TierControls value={value} onChange={onChange} lLaunchX100={LAUNCH} lTierX100={MAX} defaultOpen={open} />);
    return onChange;
  };
  it("closed: the title and the defaults only; the editor is hidden", () => {
    mount();
    expect(screen.getByTestId("tier-toggle")).toHaveTextContent("Advanced: leverage tiers");
    expect(screen.getByTestId("tier-defaults")).toHaveTextContent("5x at $25k · 10x at $100k · 20x at $500k pool depth and market backing");
    expect(screen.queryByTestId("tier-editor")).toBeNull();
    fireEvent.click(screen.getByTestId("tier-toggle"));
    expect(screen.getByTestId("tier-editor")).toBeInTheDocument();
    expect(screen.getByTestId("tier-explain")).toHaveTextContent("Each depth amount has a floor ($5k, $20k, $100k)");
  });
  it("typing reports the whole form", () => {
    const onChange = mount(EMPTY_TIER_EDIT, true);
    fireEvent.change(screen.getByTestId("tier-threshold-2"), { target: { value: "40000" } });
    expect(onChange).toHaveBeenCalledWith({ thresholds: ["", "40000", ""], leverage: ["", "", ""] });
  });
  it("an issue is shown next to its field", () => {
    mount(edit({ t: ["1000", "", ""], l: ["", "", "25"] }), true);
    expect(within(screen.getByTestId("tier-row-1")).getByTestId("tier-threshold-issue-1")).toHaveTextContent("Tier 1 pool depth must be at least $5,000.");
    expect(within(screen.getByTestId("tier-row-3")).getByTestId("tier-leverage-issue-3")).toHaveTextContent("cannot exceed this market's maximum of 20x");
    expect(screen.queryByTestId("tier-threshold-issue-2")).toBeNull();
  });
  it("the leverage list never offers more than the market's maximum", () => {
    mount(EMPTY_TIER_EDIT, true);
    const values = Array.from((screen.getByTestId("tier-leverage-1") as HTMLSelectElement).options).map((o) => o.value).filter(Boolean).map(Number);
    expect(Math.max(...values)).toBe(20);
  });
});

describe("wizard: shown only for band (tiered) markets", () => {
  const input = (o: Partial<LaunchPlanInput> = {}): LaunchPlanInput => ({ tokenPriceE6: 400n, collateralDecimals: 6, collateralSymbol: "USDC", oracleMode: "keeper", growthOn: true, ...o });
  const mount = (o: Partial<LaunchPlanInput>, value: V22OptionsState = {}) =>
    render(<V22LaunchOptions value={value} onChange={vi.fn()} plan={planLaunchV22(input(o))} symbol="TOK" tierBounds={{ lLaunchX100: LAUNCH, lTierX100: MAX }} />);
  it("price protection (band) on: the disclosure is there", () => {
    mount({ protection: true });
    expect(screen.getByTestId("tier-controls")).toBeInTheDocument();
  });
  it("price protection off: no tier section at all", () => {
    mount({ protection: false });
    expect(screen.queryByTestId("tier-controls")).toBeNull();
  });
});
