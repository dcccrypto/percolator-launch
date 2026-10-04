/**
 * The create wizard showed max leverage as floor(10000 / bps). The margin is rounded UP from
 * the dial (6x stores 1667 bps), so 6x read as 5x (7x as 6x, 2.5x as 2x) on the success screen and in the price-floor
 * reason. It now uses leverageFromMarginBps, as create() does when it records the market.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { leverageToMarginBps } from "@/components/create/StepControlRoom";
import { flooredInitialMarginBps } from "@/hooks/useCreateMarket";
import { leverageFromMarginBps, MAX_LEVERAGE_X, MIN_LEVERAGE_X } from "@/lib/market-params";

describe("create wizard max leverage", () => {
  it("every dial setting shows its leverage, never above what the engine accepts", () => {
    for (let lev = MIN_LEVERAGE_X; lev <= MAX_LEVERAGE_X; lev += 0.5) {
      const bps = flooredInitialMarginBps(leverageToMarginBps(lev));
      const shown = leverageFromMarginBps(bps);
      // Whole steps show the dial value (leverageFromMarginBps's launch round-trip rule); a half
      // step whose margin rounds up (5.5x stores 1819 bps, a 5.498x cap) shows the cap floored
      // to 0.1x, never above it, as the markets list does.
      if (Number.isInteger(lev)) {
        expect(shown, `dial ${lev}x`).toBe(lev);
      } else {
        expect(shown, `dial ${lev}x`).toBeLessThanOrEqual(10_000 / bps);
        expect(shown, `dial ${lev}x`).toBeGreaterThanOrEqual(lev - 0.1);
      }
    }
  });

  it("the naive floor this replaces showed 6x as 5x and 7x as 6x", () => {
    const naive = (lev: number) => Math.floor(10000 / flooredInitialMarginBps(leverageToMarginBps(lev)));
    expect(naive(6)).toBe(5);
    expect(naive(7)).toBe(6);
  });

  it("the wizard uses it", () => {
    const src = readFileSync(resolve(process.cwd(), "components/create/CreateMarketWizard.tsx"), "utf8");
    expect(src).toContain("const maxLeverage = leverageFromMarginBps(flooredInitialMarginBps(wizard.initialMarginBps));");
  });
});
