import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LiqEdgeChip } from "@/components/trade/LiqEdgeChip";
import { DraggableChartBadges } from "@/components/trade/ChartBadges";
import { ChartDisplayMenu, displayMenuPosition } from "@/components/trade/ChartDisplayMenu";
import { DEFAULT_OVERLAY_PREFS } from "@/lib/chart-overlays";

const src = (rel: string) => readFileSync(resolve(__dirname, "../../..", rel), "utf8");

describe("LIQ edge chip placement", () => {
  it("renders LIQ up / down with the price, inline (not an absolute overlay)", () => {
    const { rerender } = render(<LiqEdgeChip edge="above" price={6.7459} />);
    const chip = screen.getByTestId("liq-edge-chip");
    expect(chip).toHaveTextContent("Liq");
    expect(chip).toHaveTextContent("↑");
    expect(chip.className).not.toMatch(/\babsolute\b|\bfixed\b/);
    rerender(<LiqEdgeChip edge="below" price={6.7459} />);
    expect(screen.getByTestId("liq-edge-chip")).toHaveTextContent("↓");
  });
  it("renders nothing when in view or without a price", () => {
    const { container } = render(<LiqEdgeChip edge={null} price={6.7} />);
    expect(container).toBeEmptyDOMElement();
    const r2 = render(<LiqEdgeChip edge="above" price={null} />);
    expect(r2.container).toBeEmptyDOMElement();
  });
  it("TvChart and PerpChart no longer draw the chip over the chart area (negative control: the old overlay classes are gone)", () => {
    for (const f of ["components/trade/tv/TvChart.tsx", "components/trade/perp/PerpChart.tsx"]) {
      const s = src(f);
      expect(s).not.toMatch(/liq-edge-chip/);
      expect(s).not.toMatch(/-translate-x-1\/2/);
    }
  });
  it("both chart panels mount the chip in their chrome strip", () => {
    expect(src("components/trade/tv/TvChartPanel.tsx")).toMatch(/<LiqEdgeChip/);
    expect(src("components/trade/perp/PerpChart.tsx")).toMatch(/<LiqEdgeChip/);
  });
});

describe("badges over the TradingView iframe", () => {
  it("are invisible and pointer-transparent while a TradingView popup is open, drawn otherwise", () => {
    const { rerender } = render(<DraggableChartBadges><span>b</span></DraggableChartBadges>);
    const el = () => screen.getByTestId("chart-badges");
    expect(el().className).not.toMatch(/invisible/);
    rerender(<DraggableChartBadges hidden><span>b</span></DraggableChartBadges>);
    expect(el().className).toMatch(/invisible/);
    expect(el().className).toMatch(/pointer-events-none/);
    expect(el()).toHaveTextContent("b"); // stays mounted: drag position survives
  });
  it("TvChartPanel wires the popup state into the badges", () => {
    expect(src("components/trade/tv/TvChartPanel.tsx")).toMatch(/<DraggableChartBadges hidden=\{tvPopup\}>/);
  });
});

describe("Display menu", () => {
  it("opens leftward: right edge of the popup lines up with the trigger's right edge", () => {
    const st = displayMenuPosition({ top: 100, bottom: 124, left: 700, right: 835 }, { width: 1080 }, 200);
    expect(st).toMatchObject({ position: "fixed", top: 128, left: 635 }); // 635 + 200 = 835
  });
  it("stays inside the viewport at both edges (negative controls: naive right-align goes off-screen)", () => {
    // phone: trigger near the left, naive left = 140 - 200 = -60
    const phone = displayMenuPosition({ top: 0, bottom: 20, left: 90, right: 140 }, { width: 390 }, 200);
    expect(phone.left).toBe(8);
    // trigger at the far right edge: popup ends 8px before the viewport edge
    const edge = displayMenuPosition({ top: 0, bottom: 20, left: 350, right: 392 }, { width: 390 }, 200);
    expect((edge.left as number) + 200).toBeLessThanOrEqual(390 - 8);
    expect(displayMenuPosition({ top: 0, bottom: 20, left: 0, right: 40 }, { width: 200 }, 300).maxWidth).toBe(184);
  });
  it("is portaled to document.body, outside clipping ancestors, above the chart but below modals", () => {
    const { container } = render(
      <div className="overflow-hidden [contain:paint]" data-testid="clip">
        <ChartDisplayMenu prefs={{ ...DEFAULT_OVERLAY_PREFS }} onToggle={() => {}} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Display/i }));
    const menu = screen.getByTestId("chart-display-menu");
    expect(container.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect(menu.className).toMatch(/z-\[70\]/);
    expect(menu.style.position).toBe("fixed");
  });
  it("closes on outside click but not on a click inside the portaled popup", () => {
    render(<ChartDisplayMenu prefs={{ ...DEFAULT_OVERLAY_PREFS }} onToggle={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Display/i }));
    fireEvent.mouseDown(screen.getByTestId("chart-display-menu"));
    expect(screen.queryByTestId("chart-display-menu")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("chart-display-menu")).not.toBeInTheDocument();
  });
});

describe("chart heights", () => {
  const minPx = (s: string, re: RegExp) => Number(s.match(re)?.[1]);
  it("desktop grid chart row is at least 560px (was 340px)", () => {
    const s = src("app/trade/[slab]/page.tsx");
    expect(minPx(s, /gridTemplateRows: "auto clamp\((\d+)px/)).toBeGreaterThanOrEqual(560);
    expect(s).not.toMatch(/clamp\(340px, 50dvh, 640px\)/);
  });
  it("mobile heights are raised on all three charts but stay below a 844px viewport", () => {
    expect(minPx(src("components/trade/tv/TvChartPanel.tsx"), /h-\[clamp\((\d+)px,62svh/)).toBeGreaterThanOrEqual(420);
    expect(minPx(src("components/trade/perp/PerpChart.tsx"), /h-\[clamp\((\d+)px,68svh/)).toBeGreaterThanOrEqual(460);
    expect(minPx(src("components/trade/TradingChart.tsx"), /h-\[clamp\((\d+)px,60svh/)).toBeGreaterThanOrEqual(400);
    expect(src("components/trade/tv/TvChartPanel.tsx")).not.toMatch(/clamp\(340px,50svh/);
  });
});
