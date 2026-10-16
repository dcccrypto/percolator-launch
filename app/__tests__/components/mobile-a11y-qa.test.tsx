/**
 * v2.2 QA Mob-1 / Mob-2 / Mob-3 / A11y-1. Layout is verified at 390 px in headless Chromium on the preview
 * (scripts/mobile-audit, ledger); these pin the class contracts and names that make it so.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { VAULT_GRID_COLS, VAULT_UTIL_CELL } from "@/components/earn/VaultRow";
import { timeframeLabel } from "@/lib/chart-timeframe-label";

const src = (f: string) => readFileSync(path.join(__dirname, "../..", f), "utf8");

describe("Mob-1: the Earn vault table fits 390 px", () => {
  it("four columns below sm (no Utilization), five from sm; no 560 px minimum on phones", () => {
    expect(VAULT_GRID_COLS).toMatch(/^grid grid-cols-\[minmax\(88px,1fr\)_72px_48px_76px\] sm:grid-cols-\[/);
    // 88 + 72 + 48 + 76 + 3 x 12 gap + 24 padding = 344 <= 390 - 2 x 16 page padding
    expect(88 + 72 + 48 + 76 + 36 + 24).toBeLessThanOrEqual(358);
    expect(VAULT_UTIL_CELL).toBe("hidden sm:block");
    const grid = src("components/earn/VaultGrid.tsx");
    expect(grid).toContain('className="min-w-0 sm:min-w-[560px]"');
    expect(grid).not.toContain('<div className="min-w-[560px]">');
  });
});

describe("Mob-2: the trade stat strip wraps on phones", () => {
  it("flex-wrap below md, the single scrollable row from md", () => {
    const s = src("components/trade/MarketInfoBar.tsx");
    expect(s).toMatch(/data-testid="market-info-stats" className="flex flex-1 flex-wrap [^"]*md:flex-nowrap md:overflow-x-auto/);
  });
});

describe("Mob-3: touch targets >= 32 px on coarse pointers", () => {
  it.each([
    ["components/trade/ChartZoomControls.tsx", /h-6 w-6 pointer-coarse:h-8 pointer-coarse:w-8/],
    ["components/trade/TokenCopyMenu.tsx", /pointer-coarse:min-h-8 pointer-coarse:min-w-8/],
    ["components/trade/TradingChart.tsx", /pointer-coarse:min-h-8 pointer-coarse:min-w-8/],
    ["components/layout/Footer.tsx", /h-7 w-7 pointer-coarse:h-8 pointer-coarse:w-8/],
    ["app/trade/[slab]/page.tsx", /data-testid="market-analytics-link"\s+className="[^"]*pointer-coarse:min-h-8/],
  ])("%s", (f, re) => expect(src(f)).toMatch(re));
});

describe("A11y-1: the chart timeframe buttons keep their visible name, add a spoken description and pressed state", () => {
  it("labels", () => {
    expect(["1m", "5m", "15m", "1h", "4h", "1d"].map(timeframeLabel)).toEqual([
      "1 minute candles", "5 minutes candles", "15 minutes candles", "1 hour candles", "4 hours candles", "1 day candles",
    ]);
  });
  it("TradingChart wires title + aria-pressed on each (name stays the visible '4h': label-in-name)", () => {
    const s = src("components/trade/TradingChart.tsx");
    expect(s).toMatch(/onClick=\{\(\) => setTimeframe\(tf\)\}\s+title=\{timeframeLabel\(tf\)\}\s+aria-pressed=\{timeframe === tf\}/);
    render(<button title={timeframeLabel("4h")} aria-pressed>4h</button>);
    expect(screen.getByRole("button", { name: "4h", pressed: true })).toBeTruthy();
  });
});
