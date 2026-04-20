/**
 * GH#1647: TradingChart container must have overflow-hidden to prevent
 * lightweight-charts toolbar/pagination controls from escaping chart bounds
 * and appearing in adjacent components (e.g., ACCOUNTS cell in STATS tab).
 *
 * Root cause: lightweight-charts v4 renders ◀ ▶ ✕ pagination controls as
 * absolutely-positioned DOM children. Without overflow:hidden on the chart
 * wrapper, these bleed into surrounding layout elements.
 */

import * as fs from "fs";
import * as path from "path";

describe("GH#1647: TradingChart overflow-hidden guard", () => {
  const chartFile = path.resolve(
    __dirname,
    "../../components/trade/TradingChart.tsx"
  );
  const pageFile = path.resolve(
    __dirname,
    "../../app/trade/[slab]/page.tsx"
  );

  let chartSource: string;
  let pageSource: string;

  beforeAll(() => {
    chartSource = fs.readFileSync(chartFile, "utf-8");
    pageSource = fs.readFileSync(pageFile, "utf-8");
  });

  it("TradingChart.tsx: relative chart wrapper has overflow-hidden", () => {
    // The inner chart wrapper (contains containerRef div) must have
    // both 'relative' and 'overflow-hidden' to clip lwc toolbar
    const relativeWrappers = chartSource.match(
      /className="[^"]*relative[^"]*"/g
    ) ?? [];

    const hasOverflowHidden = relativeWrappers.some((cls) =>
      cls.includes("overflow-hidden")
    );

    expect(hasOverflowHidden).toBe(true);
  });

  it("TradingChart.tsx: containerRef div is a child of overflow-hidden wrapper", () => {
    // The containerRef div must appear after the overflow-hidden wrapper in source order
    const overflowIdx = chartSource.indexOf("overflow-hidden");
    const containerRefIdx = chartSource.indexOf('ref={containerRef}');

    expect(overflowIdx).toBeGreaterThan(-1);
    expect(containerRefIdx).toBeGreaterThan(overflowIdx);
  });

  it("page.tsx: desktop TradingChart wrapper has overflow-hidden", () => {
    // The desktop chart wrapper must include overflow-hidden on the div that
    // immediately wraps <TradingChart .../>. The exact sizing class has
    // changed over time (flex-1 min-h-[500px] → h-[640px]); match on
    // `overflow-hidden` adjacent to the TradingChart tag instead.
    const desktopWrapperRegex =
      /<div className="[^"]*overflow-hidden[^"]*">\s*<TradingChart/;
    expect(pageSource).toMatch(desktopWrapperRegex);
  });
});
