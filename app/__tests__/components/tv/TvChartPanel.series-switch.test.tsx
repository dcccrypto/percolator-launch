/**
 * A Mark/Oracle/Last switch remounts the TradingView widget (by design). While the new one loaded, the
 * panel still counted the OLD chart as ready: no skeleton, the resolution pills stayed enabled, and the
 * bare iframe showed its blank "…", a white first frame and the raw-address title. `ready` now belongs to
 * one chart instance, and the skeleton is opaque until that instance reports ready.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ autoReady: true }));
vi.mock("@/components/trade/tv/TvChart", async () => {
  const { useEffect } = await import("react");
  return {
    TvChart: (p: { series: string; onReady?: () => void }) => {
      useEffect(() => {
        if (!m.autoReady) return;
        const t = setTimeout(() => p.onReady?.(), 5);
        return () => clearTimeout(t);
      }, []); // eslint-disable-line react-hooks/exhaustive-deps
      return <div data-testid="tv-chart" data-series={p.series} />;
    },
  };
});
vi.mock("@/hooks/useChartOverlayPrefs", () => ({ useChartOverlayPrefs: () => [{ liq: true, entry: true, position: false, pnl: false }, vi.fn()] }));
vi.mock("@/hooks/useIsLargeScreen", () => ({ useIsLargeScreen: () => false })); // compact: the resolution pills render
vi.mock("@/hooks/usePerpHeaderStats", () => ({ usePerpHeaderStats: () => ({ change: null, volume24hUsd: 0, oiUsd: 0, funding: { hourlyPct: 0, enabled: false } }) }));
vi.mock("@/hooks/usePerpLiveStrip", () => ({ usePerpLiveStrip: () => ({ price: 1, live: "live", ageSec: 0 }) }));
vi.mock("@/components/trade/ChartPnlBadge", () => ({ ChartPnlBadge: () => null }));
vi.mock("@/components/trade/ChartBadges", () => ({ DraggableChartBadges: () => null, PositionSummary: () => null }));
vi.mock("@/components/trade/ChartDisplayMenu", () => ({ ChartDisplayMenu: () => null }));
vi.mock("@/lib/tv/data", () => ({ perpChartEnabled: () => true }));

import { TvChartPanel } from "@/components/trade/tv/TvChartPanel";
import { getSeriesStore } from "@/lib/chart/perp-series";

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const pill = () => screen.getByRole("button", { name: "5m" }) as HTMLButtonElement;

beforeEach(() => { m.autoReady = true; getSeriesStore().set("mark"); });

describe("series switch while the new widget loads", () => {
  it("covers the rebuild with the skeleton and disables the pills until the NEW chart is ready", async () => {
    render(<TvChartPanel slabAddress="S" onFailure={() => {}} />);
    await settle();
    expect(screen.queryByRole("status", { name: "Loading chart" })).toBeNull();
    expect(pill().disabled).toBe(false);

    fireEvent.click(screen.getByRole("radio", { name: "Oracle" }));
    // Same render as the switch: the old chart's ready no longer counts.
    expect(screen.getByRole("status", { name: "Loading chart" })).toBeInTheDocument();
    expect(pill().disabled).toBe(true);

    await settle();
    expect(screen.queryByRole("status", { name: "Loading chart" })).toBeNull();
    expect(pill().disabled).toBe(false);
  });

  it("closing the full-screen sheet covers the remounted embedded chart too", async () => {
    render(<TvChartPanel slabAddress="S" onFailure={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Open full-screen chart" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Close full-screen chart" }));
    expect(screen.getByRole("status", { name: "Loading chart" })).toBeInTheDocument();
    await settle();
    expect(screen.queryByRole("status", { name: "Loading chart" })).toBeNull();
  });

  it("the skeleton is opaque, so the loading iframe doesn't show through", () => {
    m.autoReady = false;
    render(<TvChartPanel slabAddress="S" onFailure={() => {}} />);
    expect(screen.getByRole("status", { name: "Loading chart" }).className).toContain("bg-[var(--panel-bg)]");
  });
});
