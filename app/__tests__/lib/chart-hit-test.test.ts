import { describe, it, expect } from "vitest";
import type { Time, UTCTimestamp } from "lightweight-charts";
import {
  distanceToSegment,
  hitTestTrend,
  hitTestHorizontal,
  hitTestRectangle,
  findHitDrawingId,
  HIT_THRESHOLD_PX,
} from "@/lib/chart-hit-test";
import type { Drawing } from "@/lib/chart-drawings";
import type {
  PriceConverter,
  TimeConverter,
} from "@/lib/chart-coords";

/** Identity-like converters: map price/time-in-seconds 1:1 to pixels.
 *  Lets tests reason in pixel space directly. */
const idSeries: PriceConverter = {
  priceToCoordinate: (price) => price,
  coordinateToPrice: (coord) => coord,
};
const idTime: TimeConverter = {
  timeToCoordinate: (time) => time as number,
  coordinateToTime: (coord) => coord as Time,
};

/** Off-scale converter: every projection returns null. */
const nullSeries: PriceConverter = {
  priceToCoordinate: () => null,
  coordinateToPrice: () => null,
};
const nullTime: TimeConverter = {
  timeToCoordinate: () => null,
  coordinateToTime: () => null,
};

describe("distanceToSegment", () => {
  it("returns 0 for a point on the segment", () => {
    expect(distanceToSegment(5, 0, 0, 0, 10, 0)).toBe(0);
  });

  it("returns perpendicular distance for a point above the midpoint", () => {
    expect(distanceToSegment(5, 3, 0, 0, 10, 0)).toBe(3);
  });

  it("returns endpoint distance when projection clamps to start", () => {
    // Point is to the LEFT of the segment — projection clamps to (0,0).
    expect(distanceToSegment(-3, 4, 0, 0, 10, 0)).toBe(5); // 3-4-5 triangle
  });

  it("returns endpoint distance when projection clamps to end", () => {
    expect(distanceToSegment(13, 4, 0, 0, 10, 0)).toBe(5);
  });

  it("handles a degenerate (zero-length) segment as point-to-point", () => {
    expect(distanceToSegment(3, 4, 5, 5, 5, 5)).toBeCloseTo(
      Math.sqrt(4 + 1),
    );
  });

  it("works for diagonal segments", () => {
    // Segment from (0,0) to (10,10). Point (5,0) projects to (2.5, 2.5).
    // Distance = sqrt(2.5^2 + 2.5^2) ≈ 3.535.
    expect(distanceToSegment(5, 0, 0, 0, 10, 10)).toBeCloseTo(
      Math.sqrt(2 * 2.5 * 2.5),
    );
  });
});

describe("hitTestTrend", () => {
  // With identity converters, time-in-seconds maps to x-pixel and price
  // maps to y-pixel. So a trend from (time=0s, price=0) to (time=10s,
  // price=10) is a diagonal line from pixel (0,0) to pixel (10,10).
  // BUT — our pricePointToPixel does Math.trunc(timeMs / 1000) before
  // hitting timeToCoordinate, so test inputs use ms.
  const trend: Extract<Drawing, { kind: "trend" }> = {
    id: "t1",
    kind: "trend",
    p1: { time: 0, price: 0 },
    p2: { time: 10_000, price: 10 }, // 10 seconds → x=10
  };

  it("hits a click ON the line", () => {
    expect(hitTestTrend(trend, 5, 5, idSeries, idTime)).toBe(true);
  });

  it("hits a click WITHIN threshold of the line", () => {
    // perpendicular offset of 3px from the diagonal at midpoint
    expect(
      hitTestTrend(
        { ...trend, p1: { time: 0, price: 0 }, p2: { time: 10_000, price: 0 } },
        5,
        HIT_THRESHOLD_PX - 1,
        idSeries,
        idTime,
      ),
    ).toBe(true);
  });

  it("misses a click BEYOND threshold", () => {
    expect(
      hitTestTrend(
        { ...trend, p1: { time: 0, price: 0 }, p2: { time: 10_000, price: 0 } },
        5,
        HIT_THRESHOLD_PX + 2,
        idSeries,
        idTime,
      ),
    ).toBe(false);
  });

  it("misses when an endpoint is off-scale (null projection)", () => {
    expect(hitTestTrend(trend, 5, 5, nullSeries, idTime)).toBe(false);
    expect(hitTestTrend(trend, 5, 5, idSeries, nullTime)).toBe(false);
  });

  it("hits at exactly the threshold (inclusive bound)", () => {
    const horiz: Extract<Drawing, { kind: "trend" }> = {
      id: "t",
      kind: "trend",
      p1: { time: 0, price: 0 },
      p2: { time: 10_000, price: 0 },
    };
    expect(
      hitTestTrend(horiz, 5, HIT_THRESHOLD_PX, idSeries, idTime),
    ).toBe(true);
  });
});

describe("hitTestHorizontal", () => {
  const line: Extract<Drawing, { kind: "horizontal" }> = {
    id: "h1",
    kind: "horizontal",
    price: 100,
  };

  it("hits a click on the line's y-coordinate", () => {
    expect(hitTestHorizontal(line, 100, idSeries)).toBe(true);
  });

  it("hits a click within threshold above the line", () => {
    expect(
      hitTestHorizontal(line, 100 - HIT_THRESHOLD_PX + 1, idSeries),
    ).toBe(true);
  });

  it("hits a click within threshold below the line", () => {
    expect(
      hitTestHorizontal(line, 100 + HIT_THRESHOLD_PX - 1, idSeries),
    ).toBe(true);
  });

  it("misses a click beyond threshold", () => {
    expect(
      hitTestHorizontal(line, 100 + HIT_THRESHOLD_PX + 2, idSeries),
    ).toBe(false);
  });

  it("misses when the price is off-scale (null projection)", () => {
    expect(hitTestHorizontal(line, 100, nullSeries)).toBe(false);
  });

  it("hits at exactly threshold distance (inclusive)", () => {
    expect(
      hitTestHorizontal(line, 100 + HIT_THRESHOLD_PX, idSeries),
    ).toBe(true);
  });
});

describe("hitTestRectangle", () => {
  // Rectangle from (time=0s, price=0) to (time=20s, price=20). With
  // identity converters and time in ms → trunc to seconds:
  // p1 pixels: (0, 0). p2 pixels: (20, 20).
  const rect: Extract<Drawing, { kind: "rectangle" }> = {
    id: "r1",
    kind: "rectangle",
    p1: { time: 0, price: 0 },
    p2: { time: 20_000, price: 20 },
  };

  it("hits a click on the top edge", () => {
    expect(hitTestRectangle(rect, 10, 0, idSeries, idTime)).toBe(true);
  });

  it("hits a click on the bottom edge", () => {
    expect(hitTestRectangle(rect, 10, 20, idSeries, idTime)).toBe(true);
  });

  it("hits a click on the left edge", () => {
    expect(hitTestRectangle(rect, 0, 10, idSeries, idTime)).toBe(true);
  });

  it("hits a click on the right edge", () => {
    expect(hitTestRectangle(rect, 20, 10, idSeries, idTime)).toBe(true);
  });

  it("hits within threshold of an edge", () => {
    // 4px outside the right edge — within 5px threshold.
    expect(
      hitTestRectangle(rect, 20 + HIT_THRESHOLD_PX - 1, 10, idSeries, idTime),
    ).toBe(true);
  });

  it("MISSES a click in the rect's interior (edge-only hit-test)", () => {
    // Far from any edge — 10,10 is the center of a 20×20 rect.
    expect(hitTestRectangle(rect, 10, 10, idSeries, idTime)).toBe(false);
  });

  it("misses a click well outside the rect", () => {
    expect(hitTestRectangle(rect, 100, 100, idSeries, idTime)).toBe(false);
  });

  it("normalises corner order (anchor from any corner)", () => {
    // Same rectangle, anchored from (20, 20) → (0, 0) instead.
    const flipped: Extract<Drawing, { kind: "rectangle" }> = {
      ...rect,
      p1: { time: 20_000, price: 20 },
      p2: { time: 0, price: 0 },
    };
    expect(hitTestRectangle(flipped, 10, 0, idSeries, idTime)).toBe(true);
    expect(hitTestRectangle(flipped, 0, 10, idSeries, idTime)).toBe(true);
  });

  it("misses when an endpoint is off-scale", () => {
    expect(hitTestRectangle(rect, 10, 0, nullSeries, idTime)).toBe(false);
  });
});

describe("findHitDrawingId", () => {
  const trend: Drawing = {
    id: "trend-1",
    kind: "trend",
    p1: { time: 0, price: 0 },
    p2: { time: 10_000, price: 10 },
  };
  const horiz: Drawing = {
    id: "horiz-1",
    kind: "horizontal",
    price: 50,
  };
  const rect: Drawing = {
    id: "rect-1",
    kind: "rectangle",
    p1: { time: 0, price: 100 },
    p2: { time: 30_000, price: 130 },
  };

  it("returns null for an empty drawings list", () => {
    expect(findHitDrawingId([], 5, 5, idSeries, idTime)).toBeNull();
  });

  it("returns null when the click misses every drawing", () => {
    expect(
      findHitDrawingId([trend, horiz, rect], 500, 500, idSeries, idTime),
    ).toBeNull();
  });

  it("finds a single drawing by id", () => {
    expect(findHitDrawingId([trend], 5, 5, idSeries, idTime)).toBe("trend-1");
    expect(findHitDrawingId([horiz], 100, 50, idSeries, idTime)).toBe("horiz-1");
    expect(findHitDrawingId([rect], 0, 115, idSeries, idTime)).toBe("rect-1");
  });

  it("prefers the LAST drawing in the array on overlap (top-most wins)", () => {
    // Two horizontals at the same price — the second one is "on top"
    // visually because it was drawn last. Click should select it.
    const a: Drawing = { id: "a", kind: "horizontal", price: 50 };
    const b: Drawing = { id: "b", kind: "horizontal", price: 50 };
    expect(findHitDrawingId([a, b], 100, 50, idSeries, idTime)).toBe("b");
  });

  it("falls back to earlier drawing when later misses but earlier hits", () => {
    const farTrend: Drawing = {
      id: "far",
      kind: "trend",
      p1: { time: 1_000_000, price: 1000 },
      p2: { time: 2_000_000, price: 2000 },
    };
    expect(
      findHitDrawingId([trend, farTrend], 5, 5, idSeries, idTime),
    ).toBe("trend-1");
  });
});
