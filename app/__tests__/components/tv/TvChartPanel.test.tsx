import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ dex: false, err: null as string | null, retry: vi.fn(), props: [] as Array<{ series: string }> }));
vi.mock("@/components/trade/tv/TvChart", () => ({
  TvChart: (p: { series: string; onDexData?: () => void; onReady?: () => void; onDataError?: (m: string | null) => void; handleRef?: { current: unknown } }) => {
    m.props.push({ series: p.series });
    if (p.handleRef) p.handleRef.current = { setResolution: vi.fn(), retryData: m.retry };
    if (m.dex && p.onDexData) setTimeout(p.onDexData, 0);
    if (m.err !== null && p.onDataError) setTimeout(() => p.onDataError?.(m.err), 0);
    return <div data-testid="tv-chart" data-series={p.series} />;
  },
}));
vi.mock("@/hooks/useChartOverlayPrefs", () => ({ useChartOverlayPrefs: () => [{ liq: true, entry: true, position: false, pnl: false }, vi.fn()] }));
vi.mock("@/hooks/useIsLargeScreen", () => ({ useIsLargeScreen: () => true }));
vi.mock("@/hooks/usePerpHeaderStats", () => ({ usePerpHeaderStats: () => ({ change: null, volume24hUsd: 1_250_000, oiUsd: 42_300, funding: { hourlyPct: 0, enabled: false } }) }));
vi.mock("@/hooks/usePerpLiveStrip", () => ({ usePerpLiveStrip: () => ({ price: 0.003628, live: "live", ageSec: 0.4 }) }));
vi.mock("@/components/trade/ChartPnlBadge", () => ({ ChartPnlBadge: () => null }));
vi.mock("@/components/trade/ChartBadges", () => ({ DraggableChartBadges: () => null, PositionSummary: () => null }));
vi.mock("@/components/trade/ChartDisplayMenu", () => ({ ChartDisplayMenu: () => null }));
vi.mock("@/lib/tv/data", () => ({ perpChartEnabled: () => true }));

import { TvChartPanel } from "@/components/trade/tv/TvChartPanel";
import { getSeriesStore } from "@/lib/chart/perp-series";

beforeEach(() => { m.err = null; m.retry.mockReset(); m.dex = false; m.props = []; getSeriesStore().set("mark"); });

describe("TvChartPanel (perp)", () => {
  it("shows the perp header (price, volume, OI, funding) and the Mark/Oracle/Last toggle", () => {
    render(<TvChartPanel slabAddress="S" onFailure={() => {}} />);
    expect(screen.getByTestId("perp-price").textContent).toBe("0.003628");
    expect(screen.getByText("$1.25M")).toBeInTheDocument();
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Mark", "Oracle", "Last"]);
  });
  it("flipping the toggle remounts the widget on the new series", () => {
    render(<TvChartPanel slabAddress="S" onFailure={() => {}} />);
    expect(screen.getByTestId("tv-chart").getAttribute("data-series")).toBe("mark");
    fireEvent.click(screen.getByRole("radio", { name: "Oracle" }));
    expect(screen.getByTestId("tv-chart").getAttribute("data-series")).toBe("oracle");
  });
  it("shows 'Powered by CoinGecko' once the chart reports gecko-sourced bars, and not before (negative control)", async () => {
    m.dex = true;
    render(<TvChartPanel slabAddress="S" onFailure={() => {}} />);
    expect(screen.queryByTestId("coingecko-attribution")).toBeNull();
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const a = screen.getByTestId("coingecko-attribution");
    expect(a.getAttribute("href")).toMatch(/^https:\/\/www\.coingecko\.com\//);
    expect(a.getAttribute("rel")).toContain("noopener");
  });
  it("no attribution when no gecko bars are shown", async () => {
    render(<TvChartPanel slabAddress="S" onFailure={() => {}} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(screen.queryByTestId("coingecko-attribution")).toBeNull();
  });
  it("a datafeed history failure shows 'Chart data unavailable' with a Retry that refetches (never a silent blank canvas)", async () => {
    m.err = "perp-chart HTTP 504";
    render(<TvChartPanel slabAddress="S" onFailure={() => {}} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(screen.getByTestId("chart-data-error")).toHaveTextContent("Chart data unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(m.retry).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("chart-data-error")).toBeNull();
  });
  it("no error state when the datafeed is healthy (negative control)", async () => {
    render(<TvChartPanel slabAddress="S" onFailure={() => {}} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(screen.queryByTestId("chart-data-error")).toBeNull();
  });
});
