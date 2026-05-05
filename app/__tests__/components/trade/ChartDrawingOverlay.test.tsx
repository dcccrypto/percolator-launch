import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";
import { useRef, type FC } from "react";
import type { IChartApi, MouseEventParams, Time } from "lightweight-charts";
import { ChartDrawingOverlay } from "@/components/trade/ChartDrawingOverlay";
import type { Drawing, DrawingTool } from "@/lib/chart-drawings";
import type { PriceConverter } from "@/lib/chart-coords";

const SLAB_A = "So11111111111111111111111111111111111111112";
const SLAB_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Minimal IChartApi stand-in. Captures all subscription channels the
 *  overlay uses (visibleLogicalRangeChange + sizeChange + click) plus
 *  their unsubscribe pairs, so tests can assert balanced lifecycle. */
function fakeChart() {
  const subscribeRange = vi.fn();
  const unsubscribeRange = vi.fn();
  const subscribeSize = vi.fn();
  const unsubscribeSize = vi.fn();
  const subscribeClick = vi.fn();
  const unsubscribeClick = vi.fn();
  const subscribeCrosshair = vi.fn();
  const unsubscribeCrosshair = vi.fn();
  const applyOptions = vi.fn();
  // Granular object-form scroll/scale to match what TradingChart's
  // chart-init configures. The pan-suppression effect's snapshot/
  // restore reads these via chart.options(); a coarse boolean here
  // would let a buggy restore (booleans-only) silently pass tests.
  const initialScroll = {
    mouseWheel: true,
    pressedMouseMove: true,
    horzTouchDrag: true,
    vertTouchDrag: true,
  };
  const initialScale = {
    axisPressedMouseMove: true,
    mouseWheel: true,
    pinch: true,
  };
  const options = vi.fn(() => ({
    handleScroll: initialScroll,
    handleScale: initialScale,
  }));
  // Identity-ish time scale: time-in-seconds maps to x-pixel directly.
  const timeScale = () => ({
    subscribeVisibleLogicalRangeChange: subscribeRange,
    unsubscribeVisibleLogicalRangeChange: unsubscribeRange,
    subscribeSizeChange: subscribeSize,
    unsubscribeSizeChange: unsubscribeSize,
    timeToCoordinate: (t: number) => t,
    coordinateToTime: (c: number) => c as Time,
  });
  // Real DOM element so the rectangle drag's mousedown listener can
  // attach via chart.chartElement(). 800×600 bounding rect anchors
  // the click → chart-canvas-coord conversion in the drag handlers.
  const chartElement = document.createElement("div");
  chartElement.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      toJSON() {
        return this;
      },
    }) as DOMRect;
  const chart = {
    timeScale,
    subscribeClick,
    unsubscribeClick,
    subscribeCrosshairMove: subscribeCrosshair,
    unsubscribeCrosshairMove: unsubscribeCrosshair,
    chartElement: () => chartElement,
    applyOptions,
    options,
  } as unknown as IChartApi;
  return {
    chart,
    chartElement,
    applyOptions,
    options,
    initialScroll,
    initialScale,
    subscribeRange,
    unsubscribeRange,
    subscribeSize,
    unsubscribeSize,
    subscribeClick,
    unsubscribeClick,
    subscribeCrosshair,
    unsubscribeCrosshair,
  };
}

/** Identity-ish series: price maps to y-pixel directly. */
const idSeries: PriceConverter = {
  priceToCoordinate: (price) => price,
  coordinateToPrice: (coord) => coord,
};

/** ResizeObserver stub. */
let lastResizeObserver: FakeResizeObserver | null = null;
class FakeResizeObserver {
  callback: ResizeObserverCallback;
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
  constructor(cb: ResizeObserverCallback) {
    this.callback = cb;
    lastResizeObserver = this;
  }
  fire(): void {
    this.callback([] as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver);
  }
}

/** Stub the 2D canvas context. jsdom's real canvas returns null from
 *  getContext("2d") without node-canvas. */
function stubCanvasContext() {
  const setTransform = vi.fn();
  const clearRect = vi.fn();
  const beginPath = vi.fn();
  const moveTo = vi.fn();
  const lineTo = vi.fn();
  const stroke = vi.fn();
  const fill = vi.fn();
  const fillRect = vi.fn();
  const strokeRect = vi.fn();
  const arc = vi.fn();
  const save = vi.fn();
  const restore = vi.fn();
  const setLineDash = vi.fn();
  const ctxStub = {
    setTransform,
    clearRect,
    beginPath,
    moveTo,
    lineTo,
    stroke,
    fill,
    fillRect,
    strokeRect,
    arc,
    save,
    restore,
    setLineDash,
    set strokeStyle(_v: string) {},
    set fillStyle(_v: string) {},
    set lineWidth(_v: number) {},
    set globalAlpha(_v: number) {},
  } as unknown as CanvasRenderingContext2D;
  HTMLCanvasElement.prototype.getContext = vi
    .fn()
    .mockReturnValue(ctxStub) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  return { setTransform, clearRect, beginPath, moveTo, lineTo, stroke, fillRect, strokeRect, arc, save, restore };
}

function stubNullCanvasContext() {
  HTMLCanvasElement.prototype.getContext = vi
    .fn()
    .mockReturnValue(null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

beforeEach(() => {
  lastResizeObserver = null;
  // @ts-expect-error: stubbing the global for tests.
  globalThis.ResizeObserver = FakeResizeObserver;
  // Synchronous rAF for tests so the rAF-coalesced crosshair preview
  // and rectangle drag mousemove redraws fire inline. Production runs
  // the real rAF (one redraw per vsync); tests assert against the
  // post-coalesce frame state, not against the schedule mechanism.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(performance.now());
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface HarnessProps {
  chart: IChartApi | null;
  ready: boolean;
  drawings?: readonly Drawing[];
  addDrawing?: (input: import("@/lib/chart-drawings").DrawingInput) => void;
  deleteDrawing?: (id: string) => void;
  tool?: DrawingTool;
  setTool?: (next: DrawingTool) => void;
  slabAddress?: string;
  series?: PriceConverter | null;
}

const Harness: FC<HarnessProps> = ({
  chart,
  ready,
  drawings = [],
  addDrawing = () => {},
  deleteDrawing = () => {},
  tool = "pointer",
  setTool = () => {},
  slabAddress = SLAB_A,
  series = idSeries,
}) => {
  const chartRef = useRef<IChartApi | null>(null);
  chartRef.current = chart;
  const seriesRef = useRef<PriceConverter | null>(null);
  seriesRef.current = series;
  const containerRef = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={containerRef} style={{ width: 800, height: 600 }}>
      <ChartDrawingOverlay
        chartRef={chartRef}
        seriesRef={seriesRef}
        containerRef={containerRef}
        chartReady={ready}
        drawings={drawings}
        addDrawing={addDrawing}
        deleteDrawing={deleteDrawing}
        tool={tool}
        setTool={setTool}
        slabAddress={slabAddress}
      />
    </div>
  );
};

const horiz = (id: string, price: number): Drawing => ({
  id,
  kind: "horizontal",
  price,
});

/** Helper: dispatch a click through the captured chart.subscribeClick
 *  handler, wrapped in act() so React flushes the setSelectedId /
 *  setPendingP1 state update before the next assertion / keyDown.
 *  The handler is invoked outside React's synthetic-event system (via
 *  the lightweight-charts subscription), so manual act() is required.
 *
 *  Two name aliases for readability: selectVia reads cleaner for
 *  pointer-mode selection tests; fireClick reads cleaner for
 *  creation-flow tests. Same implementation. */
function fireClick(
  ch: ReturnType<typeof fakeChart>,
  x: number,
  y: number,
): void {
  const onClick = ch.subscribeClick.mock.calls[0][0] as (
    p: MouseEventParams<Time>,
  ) => void;
  act(() => {
    onClick({ point: { x, y } } as unknown as MouseEventParams<Time>);
  });
}
const selectVia = fireClick;

describe("ChartDrawingOverlay", () => {
  describe("rendering", () => {
    it("renders an aria-hidden, pointer-events-none canvas", () => {
      stubCanvasContext();
      const { chart } = fakeChart();
      const { container } = render(<Harness chart={chart} ready={false} />);
      const canvas = container.querySelector("canvas");
      expect(canvas).not.toBeNull();
      expect(canvas?.getAttribute("aria-hidden")).toBe("true");
      expect(canvas?.className).toContain("pointer-events-none");
      expect(canvas?.className).toContain("absolute");
    });

    it("bails cleanly when getContext('2d') returns null", () => {
      stubNullCanvasContext();
      const { chart, subscribeRange } = fakeChart();
      expect(() =>
        render(<Harness chart={chart} ready={true} />),
      ).not.toThrow();
      expect(subscribeRange).not.toHaveBeenCalled();
    });
  });

  describe("subscription lifecycle", () => {
    it("does NOT subscribe when chartReady is false", () => {
      stubCanvasContext();
      const ch = fakeChart();
      render(<Harness chart={ch.chart} ready={false} />);
      expect(ch.subscribeRange).not.toHaveBeenCalled();
      expect(ch.subscribeSize).not.toHaveBeenCalled();
      expect(ch.subscribeClick).not.toHaveBeenCalled();
      expect(ch.subscribeCrosshair).not.toHaveBeenCalled();
    });

    it("subscribes to range, size, click, and crosshair when chartReady flips true", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const { rerender } = render(<Harness chart={ch.chart} ready={false} />);
      rerender(<Harness chart={ch.chart} ready={true} />);
      expect(ch.subscribeRange).toHaveBeenCalledTimes(1);
      expect(ch.subscribeSize).toHaveBeenCalledTimes(1);
      expect(ch.subscribeClick).toHaveBeenCalledTimes(1);
      expect(ch.subscribeCrosshair).toHaveBeenCalledTimes(1);
    });

    it("unsubscribes all four channels on unmount with matching handlers", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const { unmount } = render(<Harness chart={ch.chart} ready={true} />);
      unmount();
      expect(ch.unsubscribeRange).toHaveBeenCalledTimes(1);
      expect(ch.unsubscribeSize).toHaveBeenCalledTimes(1);
      expect(ch.unsubscribeClick).toHaveBeenCalledTimes(1);
      expect(ch.unsubscribeCrosshair).toHaveBeenCalledTimes(1);
      expect(ch.unsubscribeRange).toHaveBeenCalledWith(
        ch.subscribeRange.mock.calls[0][0],
      );
      expect(ch.unsubscribeClick).toHaveBeenCalledWith(
        ch.subscribeClick.mock.calls[0][0],
      );
      expect(ch.unsubscribeCrosshair).toHaveBeenCalledWith(
        ch.subscribeCrosshair.mock.calls[0][0],
      );
    });

    it("balances subscribe / unsubscribe across a chartReady toggle cycle", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const { rerender } = render(<Harness chart={ch.chart} ready={false} />);
      rerender(<Harness chart={ch.chart} ready={true} />);
      rerender(<Harness chart={ch.chart} ready={false} />);
      rerender(<Harness chart={ch.chart} ready={true} />);
      expect(ch.subscribeRange).toHaveBeenCalledTimes(2);
      expect(ch.unsubscribeRange).toHaveBeenCalledTimes(1);
      expect(ch.subscribeClick).toHaveBeenCalledTimes(2);
      expect(ch.unsubscribeClick).toHaveBeenCalledTimes(1);
    });

    it("swallows errors from unsubscribe (chart already destroyed)", () => {
      stubCanvasContext();
      const ch = fakeChart();
      ch.unsubscribeRange.mockImplementation(() => {
        throw new Error("chart destroyed in parallel");
      });
      const { unmount } = render(<Harness chart={ch.chart} ready={true} />);
      expect(() => unmount()).not.toThrow();
    });

    it("observes the container element via ResizeObserver", () => {
      stubCanvasContext();
      const { chart } = fakeChart();
      const { container } = render(<Harness chart={chart} ready={true} />);
      expect(lastResizeObserver).not.toBeNull();
      expect(lastResizeObserver!.observe).toHaveBeenCalledTimes(1);
      const observed = lastResizeObserver!.observe.mock.calls[0][0];
      expect(observed).toBe(container.querySelector("div"));
    });

    it("clears the canvas on each redraw trigger (resize, range change, size change)", () => {
      const { clearRect } = stubCanvasContext();
      const ch = fakeChart();
      render(<Harness chart={ch.chart} ready={true} />);
      const initial = clearRect.mock.calls.length;
      expect(initial).toBeGreaterThan(0);
      lastResizeObserver!.fire();
      expect(clearRect.mock.calls.length).toBe(initial + 1);
      const rangeHandler = ch.subscribeRange.mock.calls[0][0];
      rangeHandler(null);
      expect(clearRect.mock.calls.length).toBe(initial + 2);
      const sizeHandler = ch.subscribeSize.mock.calls[0][0];
      sizeHandler();
      expect(clearRect.mock.calls.length).toBe(initial + 3);
    });
  });

  describe("click dispatch — pointer mode hit-testing", () => {
    // fireClick is hoisted to top level so the trend / horizontal
    // describe blocks below can use it too.

    it("ignores clicks when chartReady=false (no subscription registered)", () => {
      stubCanvasContext();
      const ch = fakeChart();
      render(<Harness chart={ch.chart} ready={false} />);
      expect(ch.subscribeClick).not.toHaveBeenCalled();
    });

    it("non-pointer tool clicks do NOT change selection (clicks dispatch to creation flow)", () => {
      // With a creation tool active, clicking does NOT hit-test —
      // the click is consumed by the creation dispatch. A drawing
      // already in the list shouldn't be selectable until the user
      // switches back to pointer.
      stubCanvasContext();
      const ch = fakeChart();
      const deleteDrawing = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          drawings={[horiz("h1", 100)]}
          deleteDrawing={deleteDrawing}
          tool="trend"
        />,
      );
      // Click directly on the line in trend mode — should NOT select.
      fireClick(ch, 50, 100);
      // Backspace must NOT delete since nothing was selected.
      fireEvent.keyDown(document, { key: "Backspace" });
      expect(deleteDrawing).not.toHaveBeenCalled();
    });

    it("ignores clicks with no point info (off-canvas)", () => {
      stubCanvasContext();
      const ch = fakeChart();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          drawings={[horiz("h1", 100)]}
          tool="pointer"
        />,
      );
      const onClick = ch.subscribeClick.mock.calls[0][0] as (
        p: MouseEventParams<Time>,
      ) => void;
      // No `point` in MouseEventParams — handler must early-return.
      expect(() =>
        onClick({} as unknown as MouseEventParams<Time>),
      ).not.toThrow();
    });

    it("ignores clicks when seriesRef is null (chart not ready for hit-test)", () => {
      stubCanvasContext();
      const ch = fakeChart();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          drawings={[horiz("h1", 100)]}
          tool="pointer"
          series={null}
        />,
      );
      expect(() => fireClick(ch, 50, 100)).not.toThrow();
    });

    it("clicking empty space DESELECTS a previously-selected drawing", () => {
      // Pin the deselect contract: setSelectedId(hitId) is called
      // even when hitId is null. A refactor like
      // `if (hitId) setSelectedId(hitId)` would skip the null-set
      // and leave the previous selection stuck — Backspace would
      // then keep deleting whatever was selected long after the
      // user clicked away.
      stubCanvasContext();
      const ch = fakeChart();
      const deleteDrawing = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          drawings={[horiz("h1", 100)]}
          deleteDrawing={deleteDrawing}
          tool="pointer"
        />,
      );
      // Select via click on the line.
      selectVia(ch, 50, 100);
      // Click well off the line (empty space).
      selectVia(ch, 50, 500);
      // Backspace must NOT delete — selection was cleared.
      fireEvent.keyDown(document, { key: "Backspace" });
      expect(deleteDrawing).not.toHaveBeenCalled();
    });

    it("clicking a different drawing SWITCHES the selection", () => {
      // Two horizontals at different prices. Click first → select.
      // Click second → should switch selection to the second.
      // Backspace should remove the SECOND, proving switch.
      stubCanvasContext();
      const ch = fakeChart();
      const deleteDrawing = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          drawings={[horiz("h1", 100), horiz("h2", 200)]}
          deleteDrawing={deleteDrawing}
          tool="pointer"
        />,
      );
      selectVia(ch, 50, 100); // hits h1
      selectVia(ch, 50, 200); // hits h2 — switch
      fireEvent.keyDown(document, { key: "Delete" });
      expect(deleteDrawing).toHaveBeenCalledWith("h2");
      expect(deleteDrawing).not.toHaveBeenCalledWith("h1");
    });
  });

  describe("horizontal tool — single-click creation", () => {
    it("commits a horizontal-line drawing at the clicked price", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="horizontal"
          addDrawing={addDrawing}
        />,
      );
      // Click at y=150 — with the identity converter, price=150.
      fireClick(ch, 50, 150);
      expect(addDrawing).toHaveBeenCalledTimes(1);
      expect(addDrawing).toHaveBeenCalledWith({
        kind: "horizontal",
        price: 150,
      });
    });

    it("ignores a click when coordinateToPrice returns null (off-scale)", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      const nullSeries: PriceConverter = {
        priceToCoordinate: () => null,
        coordinateToPrice: () => null,
      };
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="horizontal"
          addDrawing={addDrawing}
          series={nullSeries}
        />,
      );
      fireClick(ch, 50, 150);
      expect(addDrawing).not.toHaveBeenCalled();
    });

    it("stays in horizontal mode after committing (TradingView convention)", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      const setTool = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="horizontal"
          addDrawing={addDrawing}
          setTool={setTool}
        />,
      );
      // Mount fires the slab/chart-init effect once which seeds tool
      // back to "pointer" — clear the mock so the assertion reflects
      // post-mount behaviour only. (The mount call is a separate
      // contract verified elsewhere; here we test that committing a
      // horizontal does NOT change tools.)
      setTool.mockClear();
      fireClick(ch, 50, 150);
      // Tool should NOT have been reset — user keeps drawing
      // horizontals until they explicitly switch tools.
      expect(setTool).not.toHaveBeenCalled();
      // A second click commits another horizontal.
      fireClick(ch, 50, 200);
      expect(addDrawing).toHaveBeenCalledTimes(2);
    });
  });

  describe("trend tool — two-click creation", () => {
    it("first click locks in p1 without committing yet", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="trend"
          addDrawing={addDrawing}
        />,
      );
      fireClick(ch, 50, 100);
      // Click 1 alone must NOT commit a drawing.
      expect(addDrawing).not.toHaveBeenCalled();
    });

    it("second click commits a trend with p1 from click 1 and p2 from click 2", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="trend"
          addDrawing={addDrawing}
        />,
      );
      // Click 1 at (10s, price=100). Identity time-scale: x=10 → time=10s.
      // pixelToPricePoint converts: time=10 sec → 10000 ms; price=100.
      fireClick(ch, 10, 100);
      // Click 2 at (20s, price=200).
      fireClick(ch, 20, 200);
      expect(addDrawing).toHaveBeenCalledTimes(1);
      expect(addDrawing).toHaveBeenCalledWith({
        kind: "trend",
        p1: { time: 10000, price: 100 },
        p2: { time: 20000, price: 200 },
      });
    });

    it("stays in trend mode after committing — third click starts a new trend", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      const setTool = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="trend"
          addDrawing={addDrawing}
          setTool={setTool}
        />,
      );
      // Clear the mount-time setTool("pointer") seed; we're testing
      // post-mount behaviour.
      setTool.mockClear();
      fireClick(ch, 10, 100); // p1 of trend 1
      fireClick(ch, 20, 200); // p2 of trend 1 → commit
      expect(setTool).not.toHaveBeenCalled();
      fireClick(ch, 30, 300); // p1 of trend 2 (NOT a third anchor of trend 1)
      // Still only one commit — trend 2 isn't done yet.
      expect(addDrawing).toHaveBeenCalledTimes(1);
      fireClick(ch, 40, 400); // p2 of trend 2
      expect(addDrawing).toHaveBeenCalledTimes(2);
      expect(addDrawing).toHaveBeenLastCalledWith({
        kind: "trend",
        p1: { time: 30000, price: 300 },
        p2: { time: 40000, price: 400 },
      });
    });

    it("Escape cancels a pending trend (p1 set, no p2 yet) without changing tool", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      const setTool = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="trend"
          addDrawing={addDrawing}
          setTool={setTool}
        />,
      );
      setTool.mockClear(); // drop the mount-time seed call
      fireClick(ch, 10, 100); // p1 set
      fireEvent.keyDown(document, { key: "Escape" });
      // Tool stays in trend (Escape cancelled the pending anchor,
      // not the tool selection).
      expect(setTool).not.toHaveBeenCalled();
      // A subsequent click is treated as p1 of a NEW trend, not p2
      // of the cancelled one.
      fireClick(ch, 20, 200);
      expect(addDrawing).not.toHaveBeenCalled();
      fireClick(ch, 30, 300);
      expect(addDrawing).toHaveBeenCalledTimes(1);
      expect(addDrawing).toHaveBeenCalledWith({
        kind: "trend",
        p1: { time: 20000, price: 200 },
        p2: { time: 30000, price: 300 },
      });
    });

    it("Escape with no pending trend AND no selection resets tool to pointer", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const setTool = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="trend"
          setTool={setTool}
        />,
      );
      fireEvent.keyDown(document, { key: "Escape" });
      expect(setTool).toHaveBeenCalledWith("pointer");
    });

    it("changing tool mid-trend cancels the pending anchor", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      const { rerender } = render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="trend"
          addDrawing={addDrawing}
        />,
      );
      fireClick(ch, 10, 100); // p1 set
      // User switches to horizontal mid-trend.
      rerender(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="horizontal"
          addDrawing={addDrawing}
        />,
      );
      // Click in horizontal mode — should commit a HORIZONTAL, not
      // close out the cancelled trend.
      fireClick(ch, 20, 200);
      expect(addDrawing).toHaveBeenCalledTimes(1);
      expect(addDrawing).toHaveBeenCalledWith({
        kind: "horizontal",
        price: 200,
      });
    });

    it("changing slab mid-trend cancels the pending anchor", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      const { rerender } = render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="trend"
          addDrawing={addDrawing}
          slabAddress={SLAB_A}
        />,
      );
      fireClick(ch, 10, 100); // p1 set on slab A
      rerender(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="trend"
          addDrawing={addDrawing}
          slabAddress={SLAB_B}
        />,
      );
      // First click on slab B is a fresh p1, not p2 of the cancelled
      // slab-A trend. So it shouldn't commit.
      fireClick(ch, 20, 200);
      expect(addDrawing).not.toHaveBeenCalled();
    });
  });

  describe("trend tool — Escape, off-scale, and missing-point preserve pendingP1", () => {
    it("a click with no point info during pendingP1 does not commit and keeps pendingP1", () => {
      // The shared `if (!param.point) return` early-return at the top
      // of the click handler is critical: an axis-gutter click (which
      // lightweight-charts emits with point=undefined) must not
      // commit the trend AND must not clear pendingP1 — the user's
      // first anchor is preserved so they can complete with another
      // valid click. A refactor that moved the early-return inside
      // the pointer case would break this for trend.
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="trend"
          addDrawing={addDrawing}
        />,
      );
      fireClick(ch, 10, 100); // p1 set
      // Fire a click with no point (axis gutter / off-canvas).
      const onClick = ch.subscribeClick.mock.calls[0][0] as (
        p: MouseEventParams<Time>,
      ) => void;
      act(() => {
        onClick({} as unknown as MouseEventParams<Time>);
      });
      // Must not have committed a trend.
      expect(addDrawing).not.toHaveBeenCalled();
      // pendingP1 still set: a follow-up valid click commits the trend
      // with p1 == the original first click, NOT a fresh p1.
      fireClick(ch, 20, 200);
      expect(addDrawing).toHaveBeenCalledWith({
        kind: "trend",
        p1: { time: 10000, price: 100 },
        p2: { time: 20000, price: 200 },
      });
    });

    it("an off-scale click 2 (null projection) does not commit and keeps pendingP1", () => {
      // Symmetrical to the horizontal off-scale test. If the user's
      // second click projects null, we must not commit garbage AND
      // we must not clear pendingP1 — the user can pan the chart
      // back into a valid range and complete the trend.
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      // First click goes through normally with the identity series.
      // Then we swap the series to one whose coordinateToPrice
      // returns null (off-scale) BEFORE click 2.
      let projectsNull = false;
      const series: PriceConverter = {
        priceToCoordinate: (p) => p,
        coordinateToPrice: (c) => (projectsNull ? null : c),
      };
      const { rerender } = render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="trend"
          addDrawing={addDrawing}
          series={series}
        />,
      );
      fireClick(ch, 10, 100); // p1 set (series projects fine)
      // Now make subsequent projections fail.
      projectsNull = true;
      // Force a re-render so the seriesRef.current refresh is observed
      // (in production, the parent would do this on chart pan/zoom).
      rerender(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="trend"
          addDrawing={addDrawing}
          series={series}
        />,
      );
      fireClick(ch, 20, 200); // off-scale — should NOT commit
      expect(addDrawing).not.toHaveBeenCalled();
      // Restore projection and complete with a valid click.
      projectsNull = false;
      rerender(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="trend"
          addDrawing={addDrawing}
          series={series}
        />,
      );
      fireClick(ch, 30, 300);
      expect(addDrawing).toHaveBeenCalledWith({
        kind: "trend",
        p1: { time: 10000, price: 100 },
        p2: { time: 30000, price: 300 },
      });
    });

    it("a zero-length trend (click 2 at exact same coords as click 1) is rejected", () => {
      // A double-click at the same pixel would produce p1 === p2,
      // which renders as a degenerate dot (hit-tested via the
      // distance-to-point fallback) and pollutes persisted drawings.
      // The handler rejects the commit; pendingP1 stays set so the
      // user can move the cursor and click somewhere else.
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="trend"
          addDrawing={addDrawing}
        />,
      );
      fireClick(ch, 10, 100); // p1
      fireClick(ch, 10, 100); // same coords — must NOT commit
      expect(addDrawing).not.toHaveBeenCalled();
      // pendingP1 still set — a follow-up at different coords commits
      // with the original p1, proving rejection didn't clear state.
      fireClick(ch, 20, 200);
      expect(addDrawing).toHaveBeenCalledWith({
        kind: "trend",
        p1: { time: 10000, price: 100 },
        p2: { time: 20000, price: 200 },
      });
    });
  });

  describe("crosshair handler — preview path", () => {
    function fireCrosshair(
      ch: ReturnType<typeof fakeChart>,
      pointOrUndefined: { x: number; y: number } | undefined,
    ): void {
      const handler = ch.subscribeCrosshair.mock.calls[0][0] as (
        p: MouseEventParams<Time>,
      ) => void;
      act(() => {
        handler({
          point: pointOrUndefined,
        } as unknown as MouseEventParams<Time>);
      });
    }

    it("does NOT redraw when tool is not trend", () => {
      const { clearRect } = stubCanvasContext();
      const ch = fakeChart();
      render(<Harness chart={ch.chart} ready={true} tool="pointer" />);
      const initial = clearRect.mock.calls.length;
      fireCrosshair(ch, { x: 50, y: 50 });
      // Pointer mode → handler short-circuits, no redraw fires.
      expect(clearRect.mock.calls.length).toBe(initial);
    });

    it("does NOT redraw in trend mode when pendingP1 is null (no preview to update)", () => {
      const { clearRect } = stubCanvasContext();
      const ch = fakeChart();
      render(<Harness chart={ch.chart} ready={true} tool="trend" />);
      const initial = clearRect.mock.calls.length;
      fireCrosshair(ch, { x: 50, y: 50 });
      expect(clearRect.mock.calls.length).toBe(initial);
    });

    it("redraws on crosshair move when tool=trend AND pendingP1 is set (live preview)", () => {
      const { clearRect } = stubCanvasContext();
      const ch = fakeChart();
      render(<Harness chart={ch.chart} ready={true} tool="trend" />);
      // Click 1 sets pendingP1 + triggers a redraw via the data-change
      // effect. Capture clearRect count AFTER the click settles.
      fireClick(ch, 10, 100);
      const afterClick = clearRect.mock.calls.length;
      // Now simulate a cursor move — should trigger another redraw
      // (the imperative redrawRef.current() call).
      fireCrosshair(ch, { x: 30, y: 200 });
      expect(clearRect.mock.calls.length).toBeGreaterThan(afterClick);
    });

    it("clears the preview ref and redraws when the cursor leaves the chart", () => {
      const { clearRect } = stubCanvasContext();
      const ch = fakeChart();
      render(<Harness chart={ch.chart} ready={true} tool="trend" />);
      fireClick(ch, 10, 100);
      // Move into the chart — preview is set.
      fireCrosshair(ch, { x: 30, y: 200 });
      const beforeLeave = clearRect.mock.calls.length;
      // Cursor leaves — handler clears previewP2Ref AND calls redraw.
      fireCrosshair(ch, undefined);
      expect(clearRect.mock.calls.length).toBeGreaterThan(beforeLeave);
    });
  });

  describe("rectangle tool — drag-driven creation", () => {
    it("a chart.subscribeClick click does NOT add a drawing (rectangle uses raw mouse events)", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="rectangle"
          addDrawing={addDrawing}
        />,
      );
      fireClick(ch, 10, 100);
      fireClick(ch, 20, 200);
      expect(addDrawing).not.toHaveBeenCalled();
    });

    it("a drag (mousedown → mousemove → mouseup with size ≥ 10×10) commits a rectangle", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="rectangle"
          addDrawing={addDrawing}
        />,
      );
      // Mouse-down at (10, 100) — locks pendingP1.
      fireEvent.mouseDown(ch.chartElement, {
        clientX: 10,
        clientY: 100,
        button: 0,
      });
      // Mouse-move during drag (just to update preview, not strictly
      // required for commit).
      fireEvent.mouseMove(document, { clientX: 50, clientY: 200 });
      // Mouse-up at (50, 200) — drag is 40×100 px, well over the
      // 10×10 minimum.
      fireEvent.mouseUp(document, { clientX: 50, clientY: 200 });
      expect(addDrawing).toHaveBeenCalledTimes(1);
      expect(addDrawing).toHaveBeenCalledWith({
        kind: "rectangle",
        p1: { time: 10000, price: 100 },
        p2: { time: 50000, price: 200 },
      });
    });

    it("a tiny drag (< 10×10 in BOTH dimensions) is rejected as click jitter", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="rectangle"
          addDrawing={addDrawing}
        />,
      );
      fireEvent.mouseDown(ch.chartElement, {
        clientX: 10,
        clientY: 100,
        button: 0,
      });
      // Drag of 5px × 5px — under both thresholds. Reject.
      fireEvent.mouseUp(document, { clientX: 15, clientY: 105 });
      expect(addDrawing).not.toHaveBeenCalled();
    });

    it("a drag that's wide but very short (only x dim ≥ 10) commits", () => {
      // Plan threshold: dx < 10 AND dy < 10 → reject. EITHER ≥ 10 → commit.
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="rectangle"
          addDrawing={addDrawing}
        />,
      );
      fireEvent.mouseDown(ch.chartElement, {
        clientX: 10,
        clientY: 100,
        button: 0,
      });
      // 50px wide, 2px tall — wider than the threshold so commits.
      fireEvent.mouseUp(document, { clientX: 60, clientY: 102 });
      expect(addDrawing).toHaveBeenCalledTimes(1);
    });

    it("ignores right-click (button !== 0)", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="rectangle"
          addDrawing={addDrawing}
        />,
      );
      fireEvent.mouseDown(ch.chartElement, {
        clientX: 10,
        clientY: 100,
        button: 2, // right-click
      });
      fireEvent.mouseUp(document, { clientX: 50, clientY: 200 });
      expect(addDrawing).not.toHaveBeenCalled();
    });

    it("Escape mid-drag cancels the pending anchor without committing", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      const setTool = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="rectangle"
          addDrawing={addDrawing}
          setTool={setTool}
        />,
      );
      setTool.mockClear(); // drop mount-time seed call
      fireEvent.mouseDown(ch.chartElement, {
        clientX: 10,
        clientY: 100,
        button: 0,
      });
      // Escape — priority chain: pendingP1 is set, so cancel it.
      // Tool stays in rectangle mode (not reset to pointer).
      fireEvent.keyDown(document, { key: "Escape" });
      expect(setTool).not.toHaveBeenCalled();
      // Subsequent mouseup must NOT commit (pendingP1 was cleared).
      fireEvent.mouseUp(document, { clientX: 50, clientY: 200 });
      expect(addDrawing).not.toHaveBeenCalled();
    });

    it("suppresses chart pan/zoom during drag and restores the SNAPSHOT on commit", () => {
      // Restore must use the snapshot (object form from chart.options())
      // — NOT coarse boolean true. The fake chart's options() returns
      // granular objects (handleScroll: { mouseWheel, ... }); the
      // restore should write those exact objects back so any sub-flag
      // a parent disabled isn't silently re-enabled.
      stubCanvasContext();
      const ch = fakeChart();
      render(
        <Harness chart={ch.chart} ready={true} tool="rectangle" />,
      );
      const beforeMouseDown = ch.applyOptions.mock.calls.length;
      fireEvent.mouseDown(ch.chartElement, {
        clientX: 10,
        clientY: 100,
        button: 0,
      });
      // Disable: writes coarse false (drag suppress is all-off).
      expect(ch.applyOptions.mock.calls.length).toBeGreaterThan(
        beforeMouseDown,
      );
      const disableCall = ch.applyOptions.mock.calls.at(-1);
      expect(disableCall?.[0]).toMatchObject({
        handleScroll: false,
        handleScale: false,
      });
      // Commit triggers cleanup → restore.
      fireEvent.mouseUp(document, { clientX: 50, clientY: 200 });
      const restoreCall = ch.applyOptions.mock.calls.at(-1);
      // Restore writes the OBJECT-FORM snapshot, not boolean true.
      expect(restoreCall?.[0]).toEqual({
        handleScroll: ch.initialScroll,
        handleScale: ch.initialScale,
      });
    });

    it("restores the SNAPSHOT on Escape cancel (preserves granular config)", () => {
      stubCanvasContext();
      const ch = fakeChart();
      render(
        <Harness chart={ch.chart} ready={true} tool="rectangle" />,
      );
      fireEvent.mouseDown(ch.chartElement, {
        clientX: 10,
        clientY: 100,
        button: 0,
      });
      fireEvent.keyDown(document, { key: "Escape" });
      const restoreCall = ch.applyOptions.mock.calls.at(-1);
      expect(restoreCall?.[0]).toEqual({
        handleScroll: ch.initialScroll,
        handleScale: ch.initialScale,
      });
    });

    it("stays in rectangle mode after committing — second drag works the same", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      const setTool = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="rectangle"
          addDrawing={addDrawing}
          setTool={setTool}
        />,
      );
      setTool.mockClear(); // drop mount-time seed
      fireEvent.mouseDown(ch.chartElement, {
        clientX: 10,
        clientY: 100,
        button: 0,
      });
      fireEvent.mouseUp(document, { clientX: 50, clientY: 200 });
      fireEvent.mouseDown(ch.chartElement, {
        clientX: 100,
        clientY: 300,
        button: 0,
      });
      fireEvent.mouseUp(document, { clientX: 200, clientY: 400 });
      expect(addDrawing).toHaveBeenCalledTimes(2);
      expect(setTool).not.toHaveBeenCalled();
    });

    it("mousedown is suppressed on mobile viewport (matchMedia)", () => {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = vi.fn().mockReturnValue({
        matches: true,
      } as MediaQueryList);
      try {
        stubCanvasContext();
        const ch = fakeChart();
        const addDrawing = vi.fn();
        render(
          <Harness
            chart={ch.chart}
            ready={true}
            tool="rectangle"
            addDrawing={addDrawing}
          />,
        );
        fireEvent.mouseDown(ch.chartElement, {
          clientX: 10,
          clientY: 100,
          button: 0,
        });
        fireEvent.mouseUp(document, { clientX: 50, clientY: 200 });
        // Mobile guard short-circuited before pendingP1 was set;
        // mouseUp had no pending state to commit.
        expect(addDrawing).not.toHaveBeenCalled();
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    });

    it("mousemove during drag triggers a redraw (preview path is wired)", () => {
      // The drag's mousemove handler updates previewP2Ref AND calls
      // redrawRef.current() imperatively. Without this assertion, a
      // refactor that dropped the redraw call would leave the user
      // with no live preview during drag, but commit would still
      // work — current tests would all pass.
      const { clearRect } = stubCanvasContext();
      const ch = fakeChart();
      render(
        <Harness chart={ch.chart} ready={true} tool="rectangle" />,
      );
      fireEvent.mouseDown(ch.chartElement, {
        clientX: 10,
        clientY: 100,
        button: 0,
      });
      const afterDown = clearRect.mock.calls.length;
      fireEvent.mouseMove(document, { clientX: 50, clientY: 200 });
      expect(clearRect.mock.calls.length).toBeGreaterThan(afterDown);
    });

    it("mouseup that projects null (off-scale) cancels rather than committing", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      // Series whose projections start working but flip to null
      // for the mouseup. We toggle the flip via a closure flag.
      let projectsNull = false;
      const series: PriceConverter = {
        priceToCoordinate: (p) => (projectsNull ? null : p),
        coordinateToPrice: (c) => (projectsNull ? null : c),
      };
      const { rerender } = render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="rectangle"
          addDrawing={addDrawing}
          series={series}
        />,
      );
      fireEvent.mouseDown(ch.chartElement, {
        clientX: 10,
        clientY: 100,
        button: 0,
      });
      // Flip projection to null AND re-render so seriesRef refreshes.
      projectsNull = true;
      rerender(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="rectangle"
          addDrawing={addDrawing}
          series={series}
        />,
      );
      fireEvent.mouseUp(document, { clientX: 50, clientY: 200 });
      expect(addDrawing).not.toHaveBeenCalled();
    });

    it("mouseup with a null seriesRef cancels rather than committing", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      const { rerender } = render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="rectangle"
          addDrawing={addDrawing}
        />,
      );
      fireEvent.mouseDown(ch.chartElement, {
        clientX: 10,
        clientY: 100,
        button: 0,
      });
      // Drop the series mid-drag (chart re-init / slab swap could
      // produce this).
      rerender(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="rectangle"
          addDrawing={addDrawing}
          series={null}
        />,
      );
      expect(() =>
        fireEvent.mouseUp(document, { clientX: 50, clientY: 200 }),
      ).not.toThrow();
      expect(addDrawing).not.toHaveBeenCalled();
    });

    it("tool change mid-drag cancels the pending anchor without committing", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      const { rerender } = render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="rectangle"
          addDrawing={addDrawing}
        />,
      );
      fireEvent.mouseDown(ch.chartElement, {
        clientX: 10,
        clientY: 100,
        button: 0,
      });
      // User switches to pointer mid-drag (toolbar click somewhere).
      rerender(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="pointer"
          addDrawing={addDrawing}
        />,
      );
      fireEvent.mouseUp(document, { clientX: 50, clientY: 200 });
      expect(addDrawing).not.toHaveBeenCalled();
      // And pan was restored (cleanup ran).
      const lastCall = ch.applyOptions.mock.calls.at(-1);
      expect(lastCall?.[0]).toEqual({
        handleScroll: ch.initialScroll,
        handleScale: ch.initialScale,
      });
    });

    it("slab change mid-drag cancels the pending anchor without committing", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      const { rerender } = render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="rectangle"
          addDrawing={addDrawing}
          slabAddress={SLAB_A}
        />,
      );
      fireEvent.mouseDown(ch.chartElement, {
        clientX: 10,
        clientY: 100,
        button: 0,
      });
      rerender(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="rectangle"
          addDrawing={addDrawing}
          slabAddress={SLAB_B}
        />,
      );
      fireEvent.mouseUp(document, { clientX: 50, clientY: 200 });
      expect(addDrawing).not.toHaveBeenCalled();
    });

    it("right-click (contextmenu) during drag cancels the pending anchor", () => {
      // Right-click opens the OS context menu; Firefox skips the
      // mouseup that would normally end the drag. Without an
      // explicit contextmenu cancel, pendingP1 sticks and the
      // chart's pan stays suppressed indefinitely.
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="rectangle"
          addDrawing={addDrawing}
        />,
      );
      fireEvent.mouseDown(ch.chartElement, {
        clientX: 10,
        clientY: 100,
        button: 0,
      });
      // contextmenu fires before mouseup in real browsers when the
      // user right-clicks during a drag.
      fireEvent.contextMenu(document);
      // Pan should be RESTORED (cleanup ran).
      const lastCall = ch.applyOptions.mock.calls.at(-1);
      expect(lastCall?.[0]).toEqual({
        handleScroll: ch.initialScroll,
        handleScale: ch.initialScale,
      });
      // A subsequent mouseup must NOT commit — pendingP1 was cleared.
      fireEvent.mouseUp(document, { clientX: 50, clientY: 200 });
      expect(addDrawing).not.toHaveBeenCalled();
    });

    it("window blur during drag cancels the pending anchor", () => {
      // alt-tab / OS focus theft / drag into another window all
      // produce a window blur. The mouseup never reaches our
      // document listener; we'd be left with stuck state.
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="rectangle"
          addDrawing={addDrawing}
        />,
      );
      fireEvent.mouseDown(ch.chartElement, {
        clientX: 10,
        clientY: 100,
        button: 0,
      });
      // jsdom dispatches blur on window directly. Wrap in act() so
      // the setPendingP1(null) state update flushes before we assert
      // (window events aren't auto-wrapped by RTL's fireEvent).
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });
      // Pan restored.
      const lastCall = ch.applyOptions.mock.calls.at(-1);
      expect(lastCall?.[0]).toEqual({
        handleScroll: ch.initialScroll,
        handleScale: ch.initialScale,
      });
      // Subsequent mouseup must not commit.
      fireEvent.mouseUp(document, { clientX: 50, clientY: 200 });
      expect(addDrawing).not.toHaveBeenCalled();
    });

    it("does NOT attach mousedown listener when tool is not rectangle", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const addDrawing = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="pointer"
          addDrawing={addDrawing}
        />,
      );
      // Mousedown on the chart element when pointer mode is active —
      // no drag handler should fire, no pendingP1 set.
      fireEvent.mouseDown(ch.chartElement, {
        clientX: 10,
        clientY: 100,
        button: 0,
      });
      fireEvent.mouseUp(document, { clientX: 50, clientY: 200 });
      expect(addDrawing).not.toHaveBeenCalled();
    });
  });

  describe("keyboard handler", () => {
    it("Delete key removes the selected drawing", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const deleteDrawing = vi.fn();
      const drawings: Drawing[] = [horiz("h1", 100)];
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          drawings={drawings}
          deleteDrawing={deleteDrawing}
          tool="pointer"
        />,
      );
      // First, select via click on the horizontal line at price=100.
      selectVia(ch, 50, 100);
      // Now press Delete.
      fireEvent.keyDown(document, { key: "Delete" });
      expect(deleteDrawing).toHaveBeenCalledWith("h1");
    });

    it("Backspace key removes the selected drawing", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const deleteDrawing = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          drawings={[horiz("h1", 100)]}
          deleteDrawing={deleteDrawing}
          tool="pointer"
        />,
      );
      selectVia(ch, 50, 100);
      fireEvent.keyDown(document, { key: "Backspace" });
      expect(deleteDrawing).toHaveBeenCalledWith("h1");
    });

    it("Delete is a no-op when no drawing is selected", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const deleteDrawing = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          drawings={[horiz("h1", 100)]}
          deleteDrawing={deleteDrawing}
        />,
      );
      fireEvent.keyDown(document, { key: "Delete" });
      expect(deleteDrawing).not.toHaveBeenCalled();
    });

    it("Backspace is suppressed when focus is in a TEXTAREA", () => {
      // Mirrors the INPUT guard test below. The order form / notes UI
      // commonly uses textareas for memos; a refactor that dropped
      // TEXTAREA from the predicate would silently delete drawings
      // while users edit text. Pin the contract.
      stubCanvasContext();
      const ch = fakeChart();
      const deleteDrawing = vi.fn();
      render(
        <>
          <textarea data-testid="form-textarea" />
          <Harness
            chart={ch.chart}
            ready={true}
            drawings={[horiz("h1", 100)]}
            deleteDrawing={deleteDrawing}
            tool="pointer"
          />
        </>,
      );
      selectVia(ch, 50, 100);
      const ta = screen.getByTestId("form-textarea") as HTMLTextAreaElement;
      ta.focus();
      fireEvent.keyDown(document, { key: "Backspace" });
      expect(deleteDrawing).not.toHaveBeenCalled();
    });

    it("Delete is suppressed when focus is in an INPUT", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const deleteDrawing = vi.fn();
      render(
        <>
          <input data-testid="form-input" />
          <Harness
            chart={ch.chart}
            ready={true}
            drawings={[horiz("h1", 100)]}
            deleteDrawing={deleteDrawing}
            tool="pointer"
          />
        </>,
      );
      // Select first.
      selectVia(ch, 50, 100);
      // Focus the input, then press Backspace — should NOT delete the drawing.
      const input = screen.getByTestId("form-input") as HTMLInputElement;
      input.focus();
      fireEvent.keyDown(document, { key: "Backspace" });
      expect(deleteDrawing).not.toHaveBeenCalled();
    });

    it("Escape with a selection clears the selection (does not change tool)", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const setTool = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          drawings={[horiz("h1", 100)]}
          setTool={setTool}
          tool="pointer"
        />,
      );
      setTool.mockClear(); // drop mount-time seed
      // Select first.
      selectVia(ch, 50, 100);
      // Escape should clear selection (verify tool was NOT changed).
      fireEvent.keyDown(document, { key: "Escape" });
      expect(setTool).not.toHaveBeenCalled();
    });

    it("Escape with no selection and a non-pointer tool resets to pointer", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const setTool = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="trend"
          setTool={setTool}
        />,
      );
      fireEvent.keyDown(document, { key: "Escape" });
      expect(setTool).toHaveBeenCalledWith("pointer");
    });

    it("Escape is a no-op when nothing is selected and tool is pointer", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const setTool = vi.fn();
      const deleteDrawing = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="pointer"
          setTool={setTool}
          deleteDrawing={deleteDrawing}
        />,
      );
      setTool.mockClear(); // drop mount-time seed
      fireEvent.keyDown(document, { key: "Escape" });
      expect(setTool).not.toHaveBeenCalled();
      expect(deleteDrawing).not.toHaveBeenCalled();
    });

    it("Escape is suppressed when focus is in an INPUT", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const setTool = vi.fn();
      render(
        <>
          <input data-testid="form-input" />
          <Harness
            chart={ch.chart}
            ready={true}
            tool="trend"
            setTool={setTool}
          />
        </>,
      );
      const input = screen.getByTestId("form-input") as HTMLInputElement;
      input.focus();
      setTool.mockClear(); // drop mount-time seed
      fireEvent.keyDown(document, { key: "Escape" });
      expect(setTool).not.toHaveBeenCalled();
    });

    it("non-Escape / non-Delete keys are ignored", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const setTool = vi.fn();
      const deleteDrawing = vi.fn();
      render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="trend"
          setTool={setTool}
          deleteDrawing={deleteDrawing}
        />,
      );
      setTool.mockClear(); // drop mount-time seed
      fireEvent.keyDown(document, { key: "Enter" });
      fireEvent.keyDown(document, { key: " " });
      fireEvent.keyDown(document, { key: "p" });
      expect(setTool).not.toHaveBeenCalled();
      expect(deleteDrawing).not.toHaveBeenCalled();
    });

    it("removes the keydown listener on unmount", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const setTool = vi.fn();
      const { unmount } = render(
        <Harness
          chart={ch.chart}
          ready={true}
          tool="trend"
          setTool={setTool}
        />,
      );
      // Mount fired the slab/chart-init seed; clear so the post-
      // unmount Escape assertion only tests listener removal.
      setTool.mockClear();
      unmount();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(setTool).not.toHaveBeenCalled();
    });
  });

  describe("selection lifecycle", () => {
    it("clears selection when slabAddress changes", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const setTool = vi.fn();
      const { rerender } = render(
        <Harness
          chart={ch.chart}
          ready={true}
          drawings={[horiz("h1", 100)]}
          tool="pointer"
          setTool={setTool}
          slabAddress={SLAB_A}
        />,
      );
      // Select via click.
      selectVia(ch, 50, 100);
      // Switch slab.
      rerender(
        <Harness
          chart={ch.chart}
          ready={true}
          drawings={[horiz("h1", 100)]}
          tool="pointer"
          setTool={setTool}
          slabAddress={SLAB_B}
        />,
      );
      // Slab change re-fires the reset effect → setTool("pointer")
      // gets called again as part of the seed contract. Clear those
      // expected calls before asserting that the subsequent Escape
      // is a no-op for setTool.
      setTool.mockClear();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(setTool).not.toHaveBeenCalled();
    });

    it("clears selection when tool changes", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const setTool = vi.fn();
      const deleteDrawing = vi.fn();
      const { rerender } = render(
        <Harness
          chart={ch.chart}
          ready={true}
          drawings={[horiz("h1", 100)]}
          tool="pointer"
          setTool={setTool}
          deleteDrawing={deleteDrawing}
        />,
      );
      // Select.
      selectVia(ch, 50, 100);
      // Switch tool away from pointer.
      rerender(
        <Harness
          chart={ch.chart}
          ready={true}
          drawings={[horiz("h1", 100)]}
          tool="trend"
          setTool={setTool}
          deleteDrawing={deleteDrawing}
        />,
      );
      // Backspace should NOT delete (selection was cleared).
      fireEvent.keyDown(document, { key: "Backspace" });
      expect(deleteDrawing).not.toHaveBeenCalled();
    });

    it("clears selection when the selected drawing is removed from the list", () => {
      stubCanvasContext();
      const ch = fakeChart();
      const deleteDrawing = vi.fn();
      const { rerender } = render(
        <Harness
          chart={ch.chart}
          ready={true}
          drawings={[horiz("h1", 100)]}
          tool="pointer"
          deleteDrawing={deleteDrawing}
        />,
      );
      // Select.
      selectVia(ch, 50, 100);
      // Remove the drawing externally (e.g. clearAll).
      rerender(
        <Harness
          chart={ch.chart}
          ready={true}
          drawings={[]}
          tool="pointer"
          deleteDrawing={deleteDrawing}
        />,
      );
      // Backspace must NOT delete — selection cleared.
      fireEvent.keyDown(document, { key: "Backspace" });
      expect(deleteDrawing).not.toHaveBeenCalled();
    });
  });
});
