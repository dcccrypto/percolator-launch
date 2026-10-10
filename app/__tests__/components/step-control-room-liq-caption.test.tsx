/**
 * The Leverage dial's "liq at X% move" caption must be the engine's distance, not 1 / leverage.
 *
 * The launch writes maintenance = initial / 2 (deriveMarketParams), and the engine liquidates when
 * equity falls below the maintenance requirement (lib/liquidation-risk.ts). A position opened at
 * the dial's leverage therefore has about half the room 1 / leverage claims: at 10x the caption
 * read "liq at 10.0% move", and the engine liquidates a short after 4.76% and a long after 5.26%.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { StepControlRoom } from "@/components/create/StepControlRoom";
import { computeEngineLiqPrice, liqMovePctAtFullLeverage } from "@/lib/liquidation-risk";
import { deriveLaunchMarketParams } from "@/lib/market-params";

function renderStep(initialMarginBps: number) {
  return render(
    <StepControlRoom
      symbol="TEST"
      oracleLabel="Keeper (Pump.fun)"
      startPrice="$0.004869"
      slabBytes={26508}
      rentSol={0.185}
      initialMarginBps={initialMarginBps}
      tradingFeeBps={20}
      lpCollateral="1000"
      insuranceAmount="100"
      collateralSymbol="USDC"
      seedTotal={3100}
      seedBacking={2000}
      onMarginBpsChange={vi.fn()}
      onLpCollateralChange={vi.fn()}
      onInsuranceChange={vi.fn()}
      onLaunch={vi.fn()}
      onBack={vi.fn()}
    />,
  );
}

describe("liqMovePctAtFullLeverage", () => {
  it("is the nearer side of the engine's liquidation price at full leverage", () => {
    // 10x, mm 5%: short (1.1 / 1.05 - 1) = 4.7619%, long (1 - 0.9 / 0.95) = 5.2632%.
    expect(liqMovePctAtFullLeverage(1000, 500)).toBeCloseTo(4.7619, 3);
    // 2x, mm 25%: short (1.5 / 1.25 - 1) = 20%, long 33.3%.
    expect(liqMovePctAtFullLeverage(5000, 2500)).toBeCloseTo(20, 3);
  });

  it("matches computeEngineLiqPrice for a 10x short", () => {
    const entry = 100_000_000n; // $100
    const q = -1_000_000n; // 1 unit short, $100 notional
    const capital = 10_000_000n; // $10 = 10% initial margin
    const liq = computeEngineLiqPrice(entry, capital, q, 500n);
    const movePct = (Number(liq - entry) / Number(entry)) * 100;
    expect(liqMovePctAtFullLeverage(1000, 500)).toBeCloseTo(movePct, 3);
  });

  it("is null when the margins describe no liquidation line", () => {
    expect(liqMovePctAtFullLeverage(0, 0)).toBeNull();
    expect(liqMovePctAtFullLeverage(500, 500)).toBeNull();
    expect(liqMovePctAtFullLeverage(Number.NaN, 500)).toBeNull();
  });
});

describe("StepControlRoom leverage caption", () => {
  it.each([
    // [initialMarginBps the dial stores, caption]
    [1000, "liq at 4.7% move"], // 10x
    [2000, "liq at 9.0% move"], // 5x: short 1.2 / 1.1 - 1 = 9.09%
    [5000, "liq at 20.0% move"], // 2x
  ])("at %i bps shows %s", (bps, caption) => {
    renderStep(bps);
    expect(screen.getByText(caption)).toBeTruthy();
  });

  it("never shows 1 / leverage", () => {
    renderStep(1000);
    expect(screen.queryByText("liq at 10.0% move")).toBeNull();
  });

  it("uses the margins the launch writes", () => {
    const p = deriveLaunchMarketParams({ initialMarginBps: 1000, lpCollateral: 0n, initialPriceE6: 1_000_000n });
    expect(p.maintenanceMarginBps).toBe(500);
  });
});
