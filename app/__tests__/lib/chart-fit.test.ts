// @vitest-environment node
import { describe, it, expect } from "vitest";
import { shouldFitViewport } from "../../lib/chart-fit";

/**
 * Models the trading chart's auto-fit decision (shouldFitViewport). The bug
 * this guards against: after a 1d → 4h → 1d timeframe round-trip the chart drew
 * its bars squished into a fraction of the canvas, because the viewport was
 * fit to a transitional render still holding the previous timeframe's data and
 * then never re-fit once the correct data landed.
 *
 * These are the same data arrays across renders modelled as distinct object
 * references — what React hands the effect. A "transitional render" reuses the
 * previous frame's array (same reference); a render carrying fresh data has a
 * new reference.
 */

// Distinct array references standing in for candleData/lineData per frame.
const DATA_1D = [{ t: 1 }];
const DATA_4H = [{ t: 2 }];
const DATA_1D_AGAIN = [{ t: 3 }];
const DATA_1D_POLL = [{ t: 4 }];
const EMPTY: never[] = [];

describe("shouldFitViewport", () => {
  it("fits on the first render for a fresh combo (initial mount)", () => {
    expect(
      shouldFitViewport({
        prevFitKey: "",
        nextFitKey: "single:1d:dex",
        built: true,
        prevFitData: null,
        nextFitData: DATA_1D,
      }),
    ).toBe(true);
  });

  it("does NOT re-fit on a same-combo poll (preserves the user's pan/zoom)", () => {
    // Same fitKey, new data reference (fetchData rebuilds the array each poll).
    expect(
      shouldFitViewport({
        prevFitKey: "single:1d:dex",
        nextFitKey: "single:1d:dex",
        built: true,
        prevFitData: DATA_1D,
        nextFitData: DATA_1D_POLL,
      }),
    ).toBe(false);
  });

  it("does NOT fit on the transitional render (new timeframe, stale data ref)", () => {
    // Clicking 1d re-renders synchronously; the candle hook still serves the
    // 4h array (same reference) until its post-render fetch effect runs.
    expect(
      shouldFitViewport({
        prevFitKey: "single:4h:dex",
        nextFitKey: "single:1d:dex",
        built: true,
        prevFitData: DATA_4H,
        nextFitData: DATA_4H, // still the previous frame's array
      }),
    ).toBe(false);
  });

  it("fits once the new timeframe's data actually lands", () => {
    // The render AFTER the transitional one: fitKey still new (never committed
    // on the transitional render), data reference has advanced.
    expect(
      shouldFitViewport({
        prevFitKey: "single:4h:dex",
        nextFitKey: "single:1d:dex",
        built: true,
        prevFitData: DATA_4H,
        nextFitData: DATA_1D_AGAIN,
      }),
    ).toBe(true);
  });

  it("does NOT fit (or commit) on a cleared/empty render for the new combo", () => {
    // Some sources clear to [] during a switch: a new array reference but no
    // series is built. Fitting here would commit the combo and deny the later
    // real-data render its fit.
    expect(
      shouldFitViewport({
        prevFitKey: "single:4h:dex",
        nextFitKey: "single:1d:dex",
        built: false, // hasRenderableData(...).ready === false
        prevFitData: DATA_4H,
        nextFitData: EMPTY,
      }),
    ).toBe(false);
  });

  it("refits when the chart kind changes (line -> candle: single -> ohlc)", () => {
    expect(
      shouldFitViewport({
        prevFitKey: "single:1d:dex",
        nextFitKey: "ohlc:1d:dex",
        built: true,
        prevFitData: DATA_1D, // lineData
        nextFitData: DATA_4H, // candleData is a different array
      }),
    ).toBe(true);
  });

  it("does NOT refit when styles share a data kind (line -> area: single -> single)", () => {
    // chartDataKind is unchanged, so the fitKey is unchanged — the block is a
    // no-op and pan/zoom is preserved.
    expect(
      shouldFitViewport({
        prevFitKey: "single:1d:dex",
        nextFitKey: "single:1d:dex",
        built: true,
        prevFitData: DATA_1D,
        nextFitData: DATA_1D, // same lineData reference
      }),
    ).toBe(false);
  });

  it("fits on the fresh-data render after a data-source switch (dex -> percolator)", () => {
    // Transitional (stale dex data) does not fit; the percolator data render does.
    expect(
      shouldFitViewport({
        prevFitKey: "single:1d:dex",
        nextFitKey: "single:1d:percolator",
        built: true,
        prevFitData: DATA_1D,
        nextFitData: DATA_1D, // transitional: still the dex array
      }),
    ).toBe(false);
    expect(
      shouldFitViewport({
        prevFitKey: "single:1d:dex",
        nextFitKey: "single:1d:percolator",
        built: true,
        prevFitData: DATA_1D,
        nextFitData: DATA_4H, // percolator data landed (new reference)
      }),
    ).toBe(true);
  });
});
