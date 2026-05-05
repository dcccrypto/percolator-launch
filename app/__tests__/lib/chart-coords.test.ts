import { describe, it, expect, vi } from "vitest";
import type { Time, UTCTimestamp } from "lightweight-charts";
import {
  pricePointToPixel,
  pixelToPricePoint,
  type PriceConverter,
  type TimeConverter,
} from "@/lib/chart-coords";

/** Build a PriceConverter mock that linearly maps price → coordinate
 *  with `coord = (price - priceAtZero) * pixelsPerPrice`, and the
 *  inverse for the other direction. `null` returns are simulated by
 *  passing `pixelsPerPrice = null`. */
function priceConverter(
  pricePerPixel = 1,
  priceAtY0 = 0,
  forceNull: "to" | "from" | null = null,
): PriceConverter {
  return {
    priceToCoordinate: (price) =>
      forceNull === "to" ? null : (price - priceAtY0) / pricePerPixel,
    coordinateToPrice: (coord) =>
      forceNull === "from" ? null : priceAtY0 + coord * pricePerPixel,
  };
}

/** Build a TimeConverter mock. Maps time-in-seconds → coordinate
 *  linearly: `coord = (timeS - timeAtX0) * pixelsPerSecond`. `null`
 *  returns are simulated by `forceNull`. */
function timeConverter(
  pixelsPerSecond = 1,
  timeAtX0 = 0,
  forceNull: "to" | "from" | null = null,
  returnsBusinessDay = false,
): TimeConverter {
  return {
    timeToCoordinate: (time) =>
      forceNull === "to" ? null : (time - timeAtX0) * pixelsPerSecond,
    coordinateToTime: (coord) => {
      if (forceNull === "from") return null;
      if (returnsBusinessDay) {
        return { year: 2024, month: 1, day: 1 } as unknown as Time;
      }
      return (timeAtX0 + coord / pixelsPerSecond) as Time;
    },
  };
}

describe("pricePointToPixel", () => {
  it("maps price/time to pixel via the converters", () => {
    const series = priceConverter(0.1, 100); // each price unit = 10 px, y=0 at price 100
    const ts = timeConverter(2, 1_700_000_000); // 2 px per second, x=0 at this timestamp
    const result = pricePointToPixel(series, ts, {
      time: 1_700_000_010_000, // 10 s past the origin
      price: 105,
    });
    expect(result).toEqual({ x: 20, y: 50 }); // 10s * 2px = 20; (105-100)/0.1 = 50
  });

  it("converts ms to seconds at the lightweight-charts boundary", () => {
    const series = priceConverter();
    const spy = vi.fn().mockReturnValue(42);
    const ts: TimeConverter = {
      timeToCoordinate: spy,
      coordinateToTime: () => null,
    };
    pricePointToPixel(series, ts, {
      time: 1_700_000_000_000, // ms
      price: 100,
    });
    // Spy was called with seconds (ms / 1000), not raw ms.
    expect(spy).toHaveBeenCalledWith(1_700_000_000);
  });

  it("floors sub-second time inputs (lightweight-charts is second-resolution)", () => {
    const series = priceConverter();
    const spy = vi.fn().mockReturnValue(0);
    const ts: TimeConverter = {
      timeToCoordinate: spy,
      coordinateToTime: () => null,
    };
    pricePointToPixel(series, ts, {
      time: 1_700_000_000_999, // 999 ms past a whole second
      price: 100,
    });
    // Floored to whole seconds — sub-second precision is dropped.
    expect(spy).toHaveBeenCalledWith(1_700_000_000);
  });

  it("returns null when the time axis maps off-scale", () => {
    const series = priceConverter();
    const ts = timeConverter(1, 0, "to"); // time→coord returns null
    expect(
      pricePointToPixel(series, ts, { time: 1_700_000_000_000, price: 100 }),
    ).toBeNull();
  });

  it("returns null when the price axis maps off-scale", () => {
    const series = priceConverter(1, 0, "to"); // price→coord returns null
    const ts = timeConverter();
    expect(
      pricePointToPixel(series, ts, { time: 1_700_000_000_000, price: 100 }),
    ).toBeNull();
  });

  it("returns null when both axes map off-scale", () => {
    const series = priceConverter(1, 0, "to");
    const ts = timeConverter(1, 0, "to");
    expect(
      pricePointToPixel(series, ts, { time: 1_700_000_000_000, price: 100 }),
    ).toBeNull();
  });

  it.each([
    ["NaN time", { time: NaN, price: 100 }],
    ["Infinity time", { time: Infinity, price: 100 }],
    ["NaN price", { time: 1_700_000_000_000, price: NaN }],
    ["Infinity price", { time: 1_700_000_000_000, price: Infinity }],
  ])("returns null for non-finite input (%s)", (_label, point) => {
    const series = priceConverter();
    const ts = timeConverter();
    expect(pricePointToPixel(series, ts, point)).toBeNull();
  });
});

describe("pixelToPricePoint", () => {
  it("maps pixel coords to price/time via the converters", () => {
    const series = priceConverter(0.1, 100); // y=0 at price 100, 0.1 price per pixel
    const ts = timeConverter(2, 1_700_000_000); // x=0 at this timestamp, 2 px per second
    const result = pixelToPricePoint(series, ts, 20, 50);
    expect(result).toEqual({
      time: 1_700_000_010_000, // 20 / 2 = 10 s past origin → ms
      price: 105,
    });
  });

  it("converts seconds to ms at the lightweight-charts boundary", () => {
    const series = priceConverter();
    const ts: TimeConverter = {
      timeToCoordinate: () => null,
      coordinateToTime: () => 1_700_000_000 as Time,
    };
    const result = pixelToPricePoint(series, ts, 0, 0);
    // Result.time is ms (× 1000), not raw seconds.
    expect(result?.time).toBe(1_700_000_000_000);
  });

  it("returns null when coordinateToTime returns null (off-scale)", () => {
    const series = priceConverter();
    const ts = timeConverter(1, 0, "from");
    expect(pixelToPricePoint(series, ts, 0, 0)).toBeNull();
  });

  it("returns null when coordinateToPrice returns null (off-scale)", () => {
    const series = priceConverter(1, 0, "from");
    const ts = timeConverter();
    expect(pixelToPricePoint(series, ts, 0, 0)).toBeNull();
  });

  it("returns null when timeScale hands back a BusinessDay (defensive)", () => {
    const series = priceConverter();
    const ts = timeConverter(1, 0, null, /* returnsBusinessDay */ true);
    expect(pixelToPricePoint(series, ts, 0, 0)).toBeNull();
  });

  it("returns null when timeScale hands back a string Time (defensive)", () => {
    const series = priceConverter();
    const ts: TimeConverter = {
      timeToCoordinate: () => null,
      coordinateToTime: () => "2024-01-01" as Time,
    };
    expect(pixelToPricePoint(series, ts, 0, 0)).toBeNull();
  });

  it.each([
    ["NaN x", NaN, 50],
    ["NaN y", 50, NaN],
    ["Infinity x", Infinity, 50],
    ["Infinity y", 50, Infinity],
  ])("returns null for non-finite pixel input (%s)", (_label, x, y) => {
    const series = priceConverter();
    const ts = timeConverter();
    expect(pixelToPricePoint(series, ts, x, y)).toBeNull();
  });
});

describe("round-trip", () => {
  it("price → pixel → price returns the same value (identity at second-aligned input)", () => {
    const series = priceConverter(0.1, 100);
    const ts = timeConverter(2, 1_700_000_000);
    const original = { time: 1_700_000_010_000, price: 105 }; // ms is multiple of 1000
    const pixel = pricePointToPixel(series, ts, original);
    expect(pixel).not.toBeNull();
    const back = pixelToPricePoint(series, ts, pixel!.x, pixel!.y);
    expect(back).toEqual(original);
  });

  it("price → pixel → price drops sub-second precision", () => {
    const series = priceConverter(0.1, 100);
    const ts = timeConverter(2, 1_700_000_000);
    // Sub-second input gets floored on the way to seconds; round-trip
    // returns the second-aligned value.
    const original = { time: 1_700_000_010_999, price: 105 };
    const pixel = pricePointToPixel(series, ts, original);
    const back = pixelToPricePoint(series, ts, pixel!.x, pixel!.y);
    expect(back).toEqual({ time: 1_700_000_010_000, price: 105 });
  });
});
