import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { useRef, type FC } from "react";
import type { IChartApi } from "lightweight-charts";
import { ChartDrawingOverlay } from "@/components/trade/ChartDrawingOverlay";

/** Minimal IChartApi stand-in. Captures both subscription channels the
 *  overlay uses (visibleLogicalRangeChange + sizeChange) plus their
 *  unsubscribe pairs, so tests can assert balanced lifecycle. */
function fakeChart() {
  const subscribeRange = vi.fn();
  const unsubscribeRange = vi.fn();
  const subscribeSize = vi.fn();
  const unsubscribeSize = vi.fn();
  const timeScale = () => ({
    subscribeVisibleLogicalRangeChange: subscribeRange,
    unsubscribeVisibleLogicalRangeChange: unsubscribeRange,
    subscribeSizeChange: subscribeSize,
    unsubscribeSizeChange: unsubscribeSize,
  });
  return {
    chart: { timeScale } as unknown as IChartApi,
    subscribeRange,
    unsubscribeRange,
    subscribeSize,
    unsubscribeSize,
  };
}

/** ResizeObserver isn't implemented by jsdom. Stub it just enough to
 *  let the component construct one and call observe / disconnect, AND
 *  capture the callback so tests can fire a synthetic size change. */
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
  /** Test-only: invoke the callback as if the browser observed a size
   *  change. Real RO callbacks receive entries; we don't use them. */
  fire(): void {
    this.callback([] as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver);
  }
}

/** Stub the 2D canvas context. jsdom's real canvas returns null from
 *  getContext("2d") without node-canvas. Returns the captured stub
 *  functions so tests can assert calls. */
function stubCanvasContext() {
  const setTransform = vi.fn();
  const clearRect = vi.fn();
  const ctxStub = { setTransform, clearRect } as unknown as CanvasRenderingContext2D;
  HTMLCanvasElement.prototype.getContext = vi
    .fn()
    .mockReturnValue(ctxStub) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  return { setTransform, clearRect };
}

/** Stub getContext to return null — the overlay's bail path. */
function stubNullCanvasContext() {
  HTMLCanvasElement.prototype.getContext = vi
    .fn()
    .mockReturnValue(null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

beforeEach(() => {
  lastResizeObserver = null;
  // @ts-expect-error: stubbing the global for tests.
  globalThis.ResizeObserver = FakeResizeObserver;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Tiny harness that wires the overlay up the way TradingChart does:
 *  parent owns chartRef + containerRef + chartReady. The chartRef is
 *  assigned synchronously during render — the real TradingChart sets
 *  it inside its chart-init effect just before flipping chartReady,
 *  and child effects run after parent state commits. Mirroring that
 *  ordering with a render-time assignment is the simplest faithful
 *  test surface (a useEffect-based assignment fires AFTER the child's
 *  effect, leaving chartRef.current null when the overlay subscribes). */
const Harness: FC<{ chart: IChartApi | null; ready: boolean }> = ({
  chart,
  ready,
}) => {
  const chartRef = useRef<IChartApi | null>(null);
  chartRef.current = chart;
  const containerRef = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={containerRef} style={{ width: 800, height: 600 }}>
      <ChartDrawingOverlay
        chartRef={chartRef}
        containerRef={containerRef}
        chartReady={ready}
      />
    </div>
  );
};

describe("ChartDrawingOverlay", () => {
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

  it("does NOT subscribe when chartReady is false (chart not yet created)", () => {
    stubCanvasContext();
    const { chart, subscribeRange, subscribeSize } = fakeChart();
    render(<Harness chart={chart} ready={false} />);
    expect(subscribeRange).not.toHaveBeenCalled();
    expect(subscribeSize).not.toHaveBeenCalled();
  });

  it("subscribes to logical-range AND size changes when chartReady flips true", () => {
    stubCanvasContext();
    const { chart, subscribeRange, subscribeSize } = fakeChart();
    const { rerender } = render(<Harness chart={chart} ready={false} />);
    expect(subscribeRange).not.toHaveBeenCalled();
    rerender(<Harness chart={chart} ready={true} />);
    expect(subscribeRange).toHaveBeenCalledTimes(1);
    expect(subscribeSize).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes both channels when the component unmounts", () => {
    stubCanvasContext();
    const {
      chart,
      subscribeRange,
      unsubscribeRange,
      subscribeSize,
      unsubscribeSize,
    } = fakeChart();
    const { unmount } = render(<Harness chart={chart} ready={true} />);
    expect(subscribeRange).toHaveBeenCalledTimes(1);
    expect(subscribeSize).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubscribeRange).toHaveBeenCalledTimes(1);
    expect(unsubscribeSize).toHaveBeenCalledTimes(1);
    // Same handler reference passed to subscribe and unsubscribe on
    // both channels — required so lightweight-charts can find and
    // remove the registered handler.
    expect(unsubscribeRange).toHaveBeenCalledWith(subscribeRange.mock.calls[0][0]);
    expect(unsubscribeSize).toHaveBeenCalledWith(subscribeSize.mock.calls[0][0]);
  });

  it("balances subscribe / unsubscribe across a chartReady toggle cycle", () => {
    // false → true → false → true must produce exactly 2 subscribes and
    // 2 unsubscribes per channel, with each unsubscribe pairing the
    // matching subscribe (Strict Mode + hot-reload come through this
    // exact path).
    stubCanvasContext();
    const {
      chart,
      subscribeRange,
      unsubscribeRange,
      subscribeSize,
      unsubscribeSize,
    } = fakeChart();
    const { rerender } = render(<Harness chart={chart} ready={false} />);
    rerender(<Harness chart={chart} ready={true} />); // sub #1
    rerender(<Harness chart={chart} ready={false} />); // unsub #1
    rerender(<Harness chart={chart} ready={true} />); // sub #2

    expect(subscribeRange).toHaveBeenCalledTimes(2);
    expect(unsubscribeRange).toHaveBeenCalledTimes(1);
    expect(subscribeSize).toHaveBeenCalledTimes(2);
    expect(unsubscribeSize).toHaveBeenCalledTimes(1);

    // The handler from sub#1 is the same as the handler unsub#1 received.
    expect(unsubscribeRange.mock.calls[0][0]).toBe(
      subscribeRange.mock.calls[0][0],
    );
    expect(unsubscribeSize.mock.calls[0][0]).toBe(
      subscribeSize.mock.calls[0][0],
    );
  });

  it("swallows errors from unsubscribe (chart already destroyed)", () => {
    stubCanvasContext();
    const { chart, unsubscribeRange } = fakeChart();
    unsubscribeRange.mockImplementation(() => {
      throw new Error("chart destroyed in parallel");
    });
    const { unmount } = render(<Harness chart={chart} ready={true} />);
    // Should not throw — the cleanup catches & swallows.
    expect(() => unmount()).not.toThrow();
  });

  it("observes the container element via ResizeObserver", () => {
    stubCanvasContext();
    const { chart } = fakeChart();
    const { container } = render(<Harness chart={chart} ready={true} />);
    expect(lastResizeObserver).not.toBeNull();
    expect(lastResizeObserver!.observe).toHaveBeenCalledTimes(1);
    // The argument passed to observe must be the container div, NOT
    // the canvas — the canvas's size is derived from the container's.
    const observedTarget = lastResizeObserver!.observe.mock.calls[0][0];
    const containerDiv = container.querySelector("div");
    expect(observedTarget).toBe(containerDiv);
  });

  it("clears the canvas on each redraw trigger (resize observer + range change)", () => {
    // Pin the redraw seam BEFORE per-kind render branches drop in.
    // Without this assertion, a future refactor could subscribe to a
    // no-op closure and ship green.
    const { clearRect } = stubCanvasContext();
    const { chart, subscribeRange } = fakeChart();
    render(<Harness chart={chart} ready={true} />);
    // Initial mount calls resize() once -> redraw -> clearRect.
    const initialCalls = clearRect.mock.calls.length;
    expect(initialCalls).toBeGreaterThan(0);

    // Fire ResizeObserver: should call resize -> redraw -> clearRect.
    lastResizeObserver!.fire();
    expect(clearRect.mock.calls.length).toBe(initialCalls + 1);

    // Fire the range-change handler the overlay registered: should
    // call redraw -> clearRect.
    const rangeHandler = subscribeRange.mock.calls[0][0];
    rangeHandler(null);
    expect(clearRect.mock.calls.length).toBe(initialCalls + 2);
  });

  it("bails cleanly when getContext('2d') returns null (no throw, no subscribe)", () => {
    // A canvas where another consumer requested a non-2D context first
    // returns null on subsequent getContext("2d") calls. The overlay
    // must not throw and must not subscribe in that state.
    stubNullCanvasContext();
    const { chart, subscribeRange, subscribeSize } = fakeChart();
    expect(() =>
      render(<Harness chart={chart} ready={true} />),
    ).not.toThrow();
    expect(subscribeRange).not.toHaveBeenCalled();
    expect(subscribeSize).not.toHaveBeenCalled();
  });
});
