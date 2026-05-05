import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { useRef, type FC } from "react";
import type { IChartApi } from "lightweight-charts";
import { ChartDrawingOverlay } from "@/components/trade/ChartDrawingOverlay";

/** Minimal IChartApi stand-in: only the surface the overlay uses
 *  (timeScale().subscribeVisibleTimeRangeChange + unsubscribe). */
function fakeChart() {
  const subscribe = vi.fn();
  const unsubscribe = vi.fn();
  const timeScale = () => ({
    subscribeVisibleTimeRangeChange: subscribe,
    unsubscribeVisibleTimeRangeChange: unsubscribe,
  });
  return {
    chart: { timeScale } as unknown as IChartApi,
    subscribe,
    unsubscribe,
  };
}

/** ResizeObserver isn't implemented by jsdom. Stub it just enough to
 *  let the component construct one and call observe / disconnect. */
class FakeResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
}

/** Stub the 2D canvas context. jsdom's real canvas returns null from
 *  getContext("2d") without node-canvas. */
function stubCanvasContext() {
  const setTransform = vi.fn();
  const clearRect = vi.fn();
  const ctxStub = { setTransform, clearRect } as unknown as CanvasRenderingContext2D;
  HTMLCanvasElement.prototype.getContext = vi
    .fn()
    .mockReturnValue(ctxStub) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  return { setTransform, clearRect };
}

beforeEach(() => {
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
    const { chart, subscribe } = fakeChart();
    render(<Harness chart={chart} ready={false} />);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("subscribes to visibleTimeRangeChange when chartReady flips true", () => {
    stubCanvasContext();
    const { chart, subscribe } = fakeChart();
    const { rerender } = render(<Harness chart={chart} ready={false} />);
    expect(subscribe).not.toHaveBeenCalled();
    rerender(<Harness chart={chart} ready={true} />);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes when the component unmounts", () => {
    stubCanvasContext();
    const { chart, subscribe, unsubscribe } = fakeChart();
    const { unmount } = render(<Harness chart={chart} ready={true} />);
    expect(subscribe).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    // Same handler reference passed to both subscribe and unsubscribe.
    expect(unsubscribe).toHaveBeenCalledWith(subscribe.mock.calls[0][0]);
  });

  it("swallows errors from unsubscribe (chart already destroyed)", () => {
    stubCanvasContext();
    const { chart, unsubscribe } = fakeChart();
    unsubscribe.mockImplementation(() => {
      throw new Error("chart destroyed in parallel");
    });
    const { unmount } = render(<Harness chart={chart} ready={true} />);
    // Should not throw — the cleanup catches & swallows.
    expect(() => unmount()).not.toThrow();
  });
});
