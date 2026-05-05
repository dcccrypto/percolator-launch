/** Coordinate transformer — bridges between internal price/time space
 *  (ms since epoch + price-in-quote-units) and lightweight-charts' pixel
 *  space (CSS pixels relative to the chart canvas).
 *
 *  This is the only file in the drawing-tools feature that knows about
 *  lightweight-charts' `UTCTimestamp` (seconds since epoch). Every other
 *  module — math, validation, hit testing, persistence — works in
 *  milliseconds, matching `Date.now()` and the existing chart code's
 *  internal format. Centralising the unit conversion in one file
 *  removes a class of seconds-vs-ms mistakes from the rest of the
 *  codebase.
 *
 *  Pure module — no React, no DOM, no chart instance. Both helpers
 *  accept narrow capability interfaces (PriceConverter, TimeConverter)
 *  that lightweight-charts' real `ISeriesApi` and `ITimeScaleApi`
 *  satisfy structurally; tests pass plain object mocks.
 */

import type { Time, UTCTimestamp } from "lightweight-charts";
import type { PricePoint } from "@/lib/chart-drawings";

/** Subset of `ISeriesApi` we need: convert between price (in quote
 *  units) and pixel y-coordinate. Both methods return `null` when the
 *  input maps off-screen or before the chart has finished sizing.
 *
 *  IMPORTANT: pass the PRICE-PANE candle/line series here, not an
 *  oscillator-pane series. lightweight-charts v5's native panes give
 *  each series its own price scale — feeding an RSI series (whose
 *  scale is pinned 0–100) would silently map a $84 chart click
 *  through the RSI scale and place the drawing at the wrong y. */
export interface PriceConverter {
  priceToCoordinate(price: number): number | null;
  coordinateToPrice(coord: number): number | null;
}

/** Subset of `ITimeScaleApi` we need: convert between time and pixel
 *  x-coordinate.
 *
 *  `timeToCoordinate` accepts the full `Time` union (UTCTimestamp |
 *  BusinessDay | string) — NOT just UTCTimestamp — so the real
 *  `ITimeScaleApi` is structurally assignable to this interface
 *  under `strictFunctionTypes`. (Function parameters are
 *  contravariant: narrowing the param here would mean a wider real
 *  signature can't fit, blocking direct production wiring of
 *  `chart.timeScale()` into `pricePointToPixel`.)
 *
 *  `coordinateToTime` returns `Time | null` — for our trade-page chart
 *  Time is always UTCTimestamp (a number). The defensive `typeof`
 *  check below collapses BusinessDay / string returns to `null` so
 *  callers don't have to. */
export interface TimeConverter {
  timeToCoordinate(time: Time): number | null;
  coordinateToTime(coord: number): Time | null;
}

/** Convert a price/time anchor into the pixel coordinate the chart
 *  would render it at. Returns `null` if either axis maps off-scale
 *  (e.g., the time is outside the visible range, or the chart hasn't
 *  laid out its price scale yet on first paint). Callers should
 *  treat `null` as "skip this drawing for this frame".
 *
 *  Time conversion: ms → seconds via `Math.trunc(timeMs / 1000)`. The
 *  truncation costs sub-second precision which lightweight-charts
 *  doesn't render anyway — bars are second-aligned at finer than
 *  pixel resolution on any realistic candle interval. trunc (toward
 *  zero) rather than floor (toward -∞) so negative ms inputs don't
 *  shift by a full second. */
export function pricePointToPixel(
  series: PriceConverter,
  timeScale: TimeConverter,
  point: PricePoint,
): { x: number; y: number } | null {
  if (!Number.isFinite(point.time) || !Number.isFinite(point.price)) {
    return null;
  }
  // Math.trunc (NOT Math.floor) so negative ms convert to seconds via
  // truncation toward zero. Math.floor(-1.5) === -2, which would shift
  // pre-epoch timestamps by a full second on each conversion. trunc is
  // the correct unit-conversion semantic.
  const timeS = Math.trunc(point.time / 1000) as UTCTimestamp;
  const x = timeScale.timeToCoordinate(timeS);
  const y = series.priceToCoordinate(point.price);
  if (x === null || y === null) return null;
  return { x, y };
}

/** Convert a pixel coordinate (e.g., the user's click position) into
 *  the price/time anchor that lives there. Returns `null` if either
 *  axis maps off-scale, OR if the time scale hands back a non-numeric
 *  Time (BusinessDay / string), which our chart never produces but
 *  the lightweight-charts type allows.
 *
 *  Time conversion: seconds → ms via `* 1000`. The result is exactly
 *  the boundary value (the second start) — sub-second precision was
 *  already discarded going the other way. Round-trips are stable
 *  modulo that floor on the input. */
export function pixelToPricePoint(
  series: PriceConverter,
  timeScale: TimeConverter,
  x: number,
  y: number,
): PricePoint | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const timeRaw = timeScale.coordinateToTime(x);
  const price = series.coordinateToPrice(y);
  if (timeRaw === null || price === null) return null;
  // The runtime Time can be UTCTimestamp (number), BusinessDay (object),
  // or a string. Our chart only ever uses UTCTimestamp, but defensively
  // reject the other shapes so the caller sees a clean PricePoint or
  // null — never a malformed object.
  if (typeof timeRaw !== "number") return null;
  return { time: timeRaw * 1000, price };
}
