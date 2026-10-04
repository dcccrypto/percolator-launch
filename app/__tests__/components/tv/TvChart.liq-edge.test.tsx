import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  range: { from: 0.003, to: 0.004 } as { from: number; to: number } | null,
  lines: { liq: 0.0021 as number | null, entry: 0.0034 as number | null, entryIsEstimate: false },
  prefs: { liq: true, entry: true },
  widgets: 0,
}));

vi.mock("@/hooks/usePositionLinePrices", () => ({ usePositionLinePrices: () => m.lines }));
vi.mock("@/hooks/useChartTheme", async () => {
  const a = await vi.importActual<typeof import("@/hooks/useChartTheme")>("@/hooks/useChartTheme");
  return { ...a, useChartTheme: () => a.DARK_THEME };
});
vi.mock("@/lib/priceStore/priceStore", () => ({ getSnapshot: () => ({ priceUsd: null }), subscribeSlab: () => () => {} }));
vi.mock("@/lib/perf/perfTiming", () => ({ startPerfSpan: () => () => {} }));
vi.mock("@/lib/tv/legacyImport", () => ({ importLegacyOnce: async () => {} }));
vi.mock("@/lib/tv/data", () => ({ getChartDataProvider: () => ({}), getLiveClient: () => null }));
vi.mock("@/lib/tv/datafeed", () => ({ createTvDatafeed: () => ({}) }));
vi.mock("@/lib/tv/positionLines", () => ({
  PositionLines: class { sync() {} dispose() {} },
  desiredLines: () => ({}),
}));
vi.mock("@/lib/tv/loadLibrary", () => {
  class FakeWidget {
    constructor() { m.widgets++; }
    chartReady() { return Promise.resolve(); }
    applyOverrides() {}
    changeTheme() { return Promise.resolve(); }
    subscribe() {}
    unsubscribe() {}
    save() { return Promise.resolve({}); }
    remove() {}
    activeChart() {
      return {
        symbol: () => "S", resolution: () => "15", setResolution: () => Promise.resolve(true), resetData() {},
        onIntervalChanged: () => ({ subscribe() {}, unsubscribe() {} }),
        onVisibleRangeChanged: () => ({ subscribe() {}, unsubscribe() {} }),
        getPanes: () => [{ getMainSourcePriceScale: () => ({ getVisiblePriceRange: () => m.range }) }],
        applyOverrides() {},
      };
    }
  }
  return { loadTradingView: async () => ({ widget: FakeWidget }), TvLoadError: class extends Error { reason = "x"; } };
});

import { TvChart } from "@/components/trade/tv/TvChart";

beforeEach(() => {
  m.range = { from: 0.003, to: 0.004 };
  m.lines = { liq: 0.0021, entry: 0.0034, entryIsEstimate: false };
  m.prefs = { liq: true, entry: true };
  m.widgets = 0;
});

const mount = () => render(<div style={{ position: "relative" }}><TvChart slabAddress="S" mode="desktop" overlayPrefs={m.prefs} onFailure={() => {}} /></div>);
const chip = () => screen.queryByTestId("liq-edge-chip");
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 450)); });

describe("TradingView off-screen liquidation chip", () => {
  it("liq below the visible price range -> down chip with the value", async () => {
    mount();
    await waitFor(() => expect(m.widgets).toBe(1));
    await waitFor(() => expect(chip()).not.toBeNull());
    expect(chip()!.textContent).toContain("↓");
    expect(chip()!.textContent).toContain("0.002100");
  });
  it("liq above the range -> up chip", async () => {
    m.lines.liq = 1.1583;
    mount();
    await waitFor(() => expect(chip()).not.toBeNull());
    expect(chip()!.textContent).toContain("↑");
    expect(chip()!.className).toContain("top-2");
  });
  it("NEGATIVE CONTROLS: liq in view, no liq, overlay off, or no price range yet -> no chip", async () => {
    m.lines.liq = 0.0035;
    const a = mount();
    await waitFor(() => expect(m.widgets).toBe(1)); await settle();
    expect(chip()).toBeNull();
    a.unmount();
    m.lines.liq = null; m.widgets = 0;
    const b = mount();
    await waitFor(() => expect(m.widgets).toBe(1)); await settle();
    expect(chip()).toBeNull();
    b.unmount();
    m.lines.liq = 0.0021; m.prefs = { liq: false, entry: true }; m.widgets = 0;
    const c = mount();
    await waitFor(() => expect(m.widgets).toBe(1)); await settle();
    expect(chip()).toBeNull();
    c.unmount();
    m.prefs = { liq: true, entry: true }; m.range = null; m.widgets = 0;
    mount();
    await waitFor(() => expect(m.widgets).toBe(1)); await settle();
    expect(chip()).toBeNull();
  });
  it("follows a vertical pan/zoom of the price scale (no library event: re-read on the timer), both ways", async () => {
    m.lines.liq = 0.0035; // in view
    mount();
    await waitFor(() => expect(m.widgets).toBe(1)); await settle();
    expect(chip()).toBeNull();
    m.range = { from: 0.01, to: 0.02 }; // user scrolled the axis: the liq is now below the range
    await settle();
    await waitFor(() => expect(chip()).not.toBeNull());
    m.range = { from: 0.003, to: 0.004 };
    await settle();
    await waitFor(() => expect(chip()).toBeNull());
  });
});
