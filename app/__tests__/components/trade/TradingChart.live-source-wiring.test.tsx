import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const priceLine = {
    applyOptions: vi.fn(),
  };

  const seriesPriceScale = {
    applyOptions: vi.fn(),
  };

  const series = {
    setData: vi.fn(),
    update: vi.fn(),
    applyOptions: vi.fn(),
    createPriceLine: vi.fn(() => priceLine),
    priceScale: vi.fn(() => seriesPriceScale),
    dataByIndex: vi.fn(),
    coordinateToPrice: vi.fn(),
  };

  const chartPriceScale = {
    applyOptions: vi.fn(),
  };

  const timeScale = {
    fitContent: vi.fn(),
    // #2581: the range-change subscription used for scroll-back paging.
    subscribeVisibleLogicalRangeChange: vi.fn(),
    unsubscribeVisibleLogicalRangeChange: vi.fn(),
    // Chart zoom (useChartZoomControls): +/-/reset buttons and box-zoom
    // drag read/write the visible logical range and project drag pixels
    // to logical indices.
    getVisibleLogicalRange: vi.fn(() => null as { from: number; to: number } | null),
    setVisibleLogicalRange: vi.fn(),
    coordinateToLogical: vi.fn(() => null as number | null),
  };

  const pane = {
    setPreserveEmptyPane: vi.fn(),
  };

  // A real (jsdom) element — useChartZoomControls attaches native
  // addEventListener/removeEventListener + reads/writes tabIndex on
  // whatever chart.chartElement() returns, same as ChartDrawingOverlay's
  // chart.chartElement() usage elsewhere in this component.
  const chartElementDiv = document.createElement('div');

  const chart = {
    panes: vi.fn(() => [pane]),
    applyOptions: vi.fn(),
    remove: vi.fn(),
    removeSeries: vi.fn(),
    addSeries: vi.fn(() => series),
    priceScale: vi.fn(() => chartPriceScale),
    timeScale: vi.fn(() => timeScale),
    subscribeCrosshairMove: vi.fn(),
    unsubscribeCrosshairMove: vi.fn(),
    subscribeClick: vi.fn(),
    unsubscribeClick: vi.fn(),
    chartElement: vi.fn(() => chartElementDiv),
    options: vi.fn(() => ({
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: true, pinch: true },
    })),
  };

  const percolatorCandles = Array.from({ length: 10 }, (_, index) => ({
    time: 1_720_000_000 + index * 60,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 0,
  }));

  // Stable identities are required. TradingChart's structural series effect
  // depends on chartTheme and source arrays; returning fresh objects from mocks
  // on every render would repeatedly call setSeriesEpoch() and loop forever.
  const emptyCandles: never[] = [];

  // Mutable per-source state. The file previously hardcoded these in the
  // vi.mock factories, so no test could vary them — which is why three wrong
  // component implementations passed the whole suite.
  const sources = {
    percolatorStatus: 'success' as string,
    percolatorCandlesOverride: null as unknown[] | null,
    dexStatus: 'idle' as string,
    dexCandles: [] as unknown[],
  };

  const chartTheme = {
    bg: '#000000',
    textColor: '#ffffff',
    gridColor: '#222222',
    borderColor: '#333333',
    neutralLine: '#999999',
    upColor: '#00ff00',
    downColor: '#ff0000',
    entryLine: '#00ffff',
    volUpColor: '#00ff00',
    volDownColor: '#ff0000',
  };

  return {
    chart,
    series,
    priceLine,
    percolatorCandles,
    emptyCandles,
    sources,
    chartTheme,
  };
});

const positionHarness = vi.hoisted(() => ({
  slab: 'Eacc111111111111111111111111111111111111111',
  wallet: 'DYvC111111111111111111111111111111111111111',

  userAccount: {
    idx: 0,
    account: {
      positionSize: -10_000_000n,
      capital: 500_000_000n,
      entryPrice: 0n,
      pnl: 0n,
      owner: {
        toBase58: () =>
          'DYvC111111111111111111111111111111111111111',
      },
    },
  },

  overlayPrefs: {
    position: true,
    entry: true,
    liq: true,
    pnl: false,
  },
}));

vi.mock('lightweight-charts', () => ({
  createChart: vi.fn(() => harness.chart),
  LineStyle: {
    Solid: 0,
    Dashed: 2,
  },
  ColorType: {
    Solid: 'solid',
  },
  CrosshairMode: {
    Normal: 0,
  },
  CandlestickSeries: 'CandlestickSeries',
  HistogramSeries: 'HistogramSeries',
  BarSeries: 'BarSeries',
  LineSeries: 'LineSeries',
  AreaSeries: 'AreaSeries',
}));

vi.mock('@/lib/chart-live-tick', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chart-live-tick')>();

  return {
    ...actual,
    resolveChartDataSource: vi.fn(actual.resolveChartDataSource),
  };
});

vi.mock('@/components/providers/SlabProvider', () => ({
  useSlabState: () => ({
    slabAddress: positionHarness.slab,
    config: {
      lastEffectivePriceE6: 100_000_000n,
      invert: 0,
    },
    params: {
      maintenanceMarginBps: 500n,
    },
  }),
}));

vi.mock('@/hooks/useLivePrice', () => ({
  useLivePrice: () => ({
    priceUsd: 100,
  }),
}));

vi.mock('@/lib/chart-source-select', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chart-source-select')>();
  return { ...actual, selectChartSource: vi.fn(actual.selectChartSource) };
});

vi.mock('@/hooks/usePercolatorCandles', () => ({
  usePercolatorCandles: () => ({
    candles: harness.sources.percolatorCandlesOverride ?? harness.percolatorCandles,
    status: harness.sources.percolatorStatus,
  }),
}));

vi.mock('@/hooks/useTokenChart', () => ({
  useTokenChart: () => ({
    candles: harness.sources.dexCandles,
    status: harness.sources.dexStatus,
    poolAddress: null,
    // #2581
    loadOlder: vi.fn(),
    isLoadingOlder: false,
    hasMoreHistory: true,
  }),
}));

vi.mock('@/hooks/useUserAccount', () => ({
  useUserAccount: () => positionHarness.userAccount,
}));

vi.mock('@/hooks/useMarketConfig', () => ({
  useMarketConfig: () => ({}),
}));

vi.mock('@/hooks/useMarketInfo', () => ({
  useMarketInfo: () => ({
    market: {
      symbol: 'SOL',
    },
  }),
}));

vi.mock('@/hooks/useChartTheme', () => ({
  useChartTheme: () => harness.chartTheme,
}));

vi.mock('@/hooks/useChartStylePref', () => ({
  useChartStylePref: () => ['candle-solid', vi.fn()],
}));

vi.mock('@/hooks/useChartOverlayPrefs', () => ({
  useChartOverlayPrefs: () => [
    positionHarness.overlayPrefs,
    vi.fn(),
  ],
}));

vi.mock('@/hooks/useChartIndicatorPrefs', () => ({
  useChartIndicatorPrefs: () => ({
    indicators: [],
    addIndicator: vi.fn(),
    removeIndicator: vi.fn(),
    updateIndicator: vi.fn(),
    clearAll: vi.fn(),
  }),
}));

vi.mock('@/hooks/useChartDrawingTool', () => ({
  useChartDrawingTool: () => ({
    tool: 'pointer',
    setTool: vi.fn(),
  }),
}));

vi.mock('@/hooks/useChartDrawings', () => ({
  useChartDrawings: () => ({
    drawings: [],
    addDrawing: vi.fn(),
    deleteDrawing: vi.fn(),
    clearAll: vi.fn(),
  }),
}));

vi.mock('@/components/trade/useIndicatorOverlays', () => ({
  useIndicatorOverlays: vi.fn(),
}));

vi.mock('@/components/trade/useIndicatorOscillatorPane', () => ({
  useIndicatorOscillatorPane: vi.fn(),
}));

vi.mock('@/lib/priceStore/priceStore', () => ({
  subscribeSlab: vi.fn(() => vi.fn()),
  getSnapshot: vi.fn(() => ({
    priceUsd: 100,
  })),
}));

vi.mock('@/lib/perf/perfTiming', () => ({
  startPerfSpan: vi.fn(() => vi.fn()),
}));

vi.mock('@/lib/pollWhenVisible', () => ({
  pollWhenVisible: vi.fn(() => vi.fn()),
}));

vi.mock('@/lib/mock-mode', () => ({
  isMockMode: vi.fn(() => false),
}));

vi.mock('@/lib/mock-trade-data', () => ({
  isMockSlab: vi.fn(() => false),
  getMockUserAccount: vi.fn(() => null),
}));

vi.mock('@/components/ui/ShimmerSkeleton', () => ({
  ShimmerSkeleton: () => null,
}));

vi.mock('@/components/trade/ChartStyleMenu', () => ({
  ChartStyleMenu: () => null,
}));

vi.mock('@/components/trade/ChartDisplayMenu', () => ({
  ChartDisplayMenu: () => null,
}));

vi.mock('@/components/trade/ChartPnlBadge', () => ({
  ChartPnlBadge: () => null,
}));

vi.mock('@/components/trade/ChartIndicatorMenu', () => ({
  ChartIndicatorMenu: () => null,
}));

vi.mock('@/components/trade/ChartDrawingOverlay', () => ({
  ChartDrawingOverlay: () => null,
}));

vi.mock('@/components/trade/ChartDrawingToolbar', () => ({
  ChartDrawingToolbar: () => null,
}));

import { TradingChart } from '@/components/trade/TradingChart';
import { selectChartSource } from '@/lib/chart-source-select';
import { saveEntryPrice } from '@/lib/entry-price';

describe('TradingChart live-source wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();

    positionHarness.userAccount.account.entryPrice = 0n;
    positionHarness.userAccount.account.pnl = 0n;

    positionHarness.overlayPrefs = {
      position: true,
      entry: true,
      liq: true,
      pnl: false,
    };
    harness.sources.percolatorStatus = 'success';
    harness.sources.percolatorCandlesOverride = null;
    harness.sources.dexStatus = 'idle';
    harness.sources.dexCandles = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          prices: [],
        }),
      })),
    );
  });

  it("forwards each source's status and PRICED bar count to the selector", async () => {
    render(
      <TradingChart
        slabAddress="TestSlab1111111111111111111111111111111111"
        mintAddress="TestMint1111111111111111111111111111111111"
      />,
    );

    // The selector receives source STATE, not pre-collapsed booleans — the
    // booleans are what hid #2579, because the component decided precedence
    // before anything testable saw the inputs.
    await waitFor(() => {
      expect(vi.mocked(selectChartSource)).toHaveBeenLastCalledWith({
        percolator: { status: 'success', pricedBars: harness.percolatorCandles.length },
        // `applicable` tells the selector a source can never answer, as opposed
        // to not having answered yet. A mint is passed, so DEX applies here;
        // the distinction is exercised in __tests__/lib/chart-source-select.test.ts.
        // There is no `pyth` key: toHaveBeenLastCalledWith is exact, so a
        // resurrected Pyth tier fails this assertion.
        dex: { status: 'idle', pricedBars: 0, applicable: true },
      });
    });
  });

  it("renders the DEX badge when a 1-bar internal series loses to 1000 DEX bars", async () => {
    // #2579, end to end through the component. Asserting the ARGUMENTS to the
    // selector is not enough: restoring the old boolean chain, or swapping the
    // source derivations, leaves those arguments identical and changes only
    // what is rendered. This pins the RESULT.
    // One bar, the shape of the real stub: o=h=l=c=114.629292.
    harness.sources.percolatorCandlesOverride = [
      { time: 1_720_000_000, open: 114.629292, high: 114.629292, low: 114.629292, close: 114.629292, volume: 1 },
    ];
    harness.sources.dexStatus = 'success';
    // `timestamp`, not `time` — the DEX source is CandleData from
    // /api/chart/[mint], and finiteCandles reads that shape.
    harness.sources.dexCandles = Array.from({ length: 1000 }, (_, i) => ({
      timestamp: 1_720_000_000_000 + i * 300_000,
      open: 121, high: 121.6, low: 120.4, close: 121.5, volume: 1,
    }));

    render(
      <TradingChart
        slabAddress="TestSlab1111111111111111111111111111111111"
        mintAddress="TestMint1111111111111111111111111111111111"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('DEX')).toBeInTheDocument();
    });
    expect(screen.queryByText('PERC')).toBeNull();
    // No Pyth source badge exists any more.
    expect(screen.queryByText('PYTH')).toBeNull();
  });

  it("CONTROL: the internal source still wins once it has enough bars", async () => {
    // Guards against fixing the override by never choosing Percolator.
    harness.sources.dexStatus = 'success';
    harness.sources.dexCandles = Array.from({ length: 1000 }, (_, i) => ({
      timestamp: 1_720_000_000_000 + i * 300_000,
      open: 121, high: 121.6, low: 120.4, close: 121.5, volume: 1,
    }));

    render(
      <TradingChart
        slabAddress="TestSlab1111111111111111111111111111111111"
        mintAddress="TestMint1111111111111111111111111111111111"
      />,
    );

    // The default harness series is 10 positively-priced bars = the threshold.
    await waitFor(() => {
      expect(screen.getByText('PERC')).toBeInTheDocument();
    });
    expect(screen.queryByText('DEX')).toBeNull();
  });

  const drawnPriceLineTitles = () =>
    harness.series.createPriceLine.mock.calls.map(
      ([options]) => (options as { title?: string }).title,
    );

  it("CASE B: open SHORT with missing entry cache keeps Liq but does not invent Entry", async () => {
    render(
      <TradingChart
        slabAddress={positionHarness.slab}
        mintAddress="TestMint1111111111111111111111111111111111"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("SHORT")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(drawnPriceLineTitles()).toContain("Mark");
    });

    expect(drawnPriceLineTitles()).not.toContain("Entry");
    expect(drawnPriceLineTitles()).toContain("Liq");
  });

  it("CASE A: exact slab + idx + wallet entry cache restores Entry and Liq", async () => {
    saveEntryPrice(
      positionHarness.slab,
      positionHarness.userAccount.idx,
      100_000_000n,
      2,
      positionHarness.wallet,
    );

    render(
      <TradingChart
        slabAddress={positionHarness.slab}
        mintAddress="TestMint1111111111111111111111111111111111"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("SHORT")).toBeInTheDocument();
    });

    await waitFor(() => {
      const titles = drawnPriceLineTitles();

      expect(titles).toContain("Mark");
      expect(titles).toContain("Entry");
      expect(titles).toContain("Liq");
    });
  });

  it("CASE D: missing cache with derivable PnL restores a trusted derived Entry and Liq", async () => {
    // SHORT at a $100 mark with +10 collateral units of PnL:
    //
    // diff = pnl * 1e6 / abs(position)
    //      = 10_000_000 * 1_000_000 / 10_000_000
    //      = 1_000_000 e6
    //
    // SHORT entry = mark + diff = $101.
    positionHarness.userAccount.account.pnl = 10_000_000n;

    render(
      <TradingChart
        slabAddress={positionHarness.slab}
        mintAddress="TestMint1111111111111111111111111111111111"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("SHORT")).toBeInTheDocument();
    });

    await waitFor(() => {
      const lines = harness.series.createPriceLine.mock.calls.map(
        ([options]) =>
          options as {
            title?: string;
            price?: number;
          },
      );

      const entryLine = lines.find(
        (line) => line.title === "Entry",
      );

      expect(entryLine?.price).toBe(101);
      expect(lines.some((line) => line.title === "Mark")).toBe(true);
      expect(lines.some((line) => line.title === "Liq")).toBe(true);
    });
  });

  it("CASE C: Display preference OFF suppresses overlays globally unlike a missing per-market entry cache", async () => {
    saveEntryPrice(
      positionHarness.slab,
      positionHarness.userAccount.idx,
      100_000_000n,
      2,
      positionHarness.wallet,
    );

    positionHarness.overlayPrefs = {
      position: false,
      entry: false,
      liq: false,
      pnl: false,
    };

    render(
      <TradingChart
        slabAddress={positionHarness.slab}
        mintAddress="TestMint1111111111111111111111111111111111"
      />,
    );

    await waitFor(() => {
      expect(drawnPriceLineTitles()).toContain("Mark");
    });

    expect(screen.queryByText("SHORT")).toBeNull();
    expect(drawnPriceLineTitles()).not.toContain("Entry");
    expect(drawnPriceLineTitles()).not.toContain("Liq");
  });

});
