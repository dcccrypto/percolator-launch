/** Hit-test helpers for chart drawings. Pure math — given a Drawing
 *  plus a click point in CSS-pixel space and the converters that
 *  project price/time to pixels, return whether the click "hit" the
 *  drawing within the threshold.
 *
 *  Threshold: 5 CSS pixels. Wide enough that a user clicking near a
 *  thin line lands on it (the line itself is 1.5px wide; users miss
 *  by 2-3px reliably with mouse precision and 5+ on touch — though
 *  touch is out of scope for v1). Narrow enough that overlapping
 *  drawings remain individually selectable.
 *
 *  Selection priority: top-level findHitDrawingId iterates in REVERSE
 *  array order. The most recently drawn drawing wins on overlap,
 *  which matches user expectation ("the one I just put down is the
 *  one I want to grab"). The drawings array is creation-order, so
 *  reverse-iterate to land on the visually-on-top drawing.
 */

import type { Drawing } from "@/lib/chart-drawings";
import {
  pricePointToPixel,
  type PriceConverter,
  type TimeConverter,
} from "@/lib/chart-coords";
import { assertNever } from "@/lib/exhaustive";

/** Hit-test threshold in CSS pixels. Tuned for mouse precision; if
 *  touch lands as a v2 follow-up, the threshold should grow to ~10. */
export const HIT_THRESHOLD_PX = 5;

/** Distance from point (px,py) to a line segment from (x1,y1) to
 *  (x2,y2). Standard projection-with-clamp algorithm:
 *  - Project the point onto the infinite line.
 *  - Clamp the projection parameter `t` to [0, 1] to stay on the
 *    segment (instead of running off either end).
 *  - Distance from the clamped projection to the point.
 *
 *  Degenerate-segment guard: if the two endpoints coincide
 *  (lenSq === 0), the "segment" is just a point and we fall back
 *  to point-to-point distance — without this, the formula divides
 *  by zero and returns NaN. */
export function distanceToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = px - x1;
    const ey = py - y1;
    return Math.sqrt(ex * ex + ey * ey);
  }
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return Math.sqrt(ex * ex + ey * ey);
}

/** Hit-test a trend line: project both endpoints to pixels, then
 *  distance-to-segment. If either endpoint is off-scale (returns null
 *  from pricePointToPixel) we treat the drawing as not hittable for
 *  this frame — half-on-screen trends are render-only, not selectable.
 *  Selecting them would require a click on a pixel we never painted. */
export function hitTestTrend(
  drawing: Extract<Drawing, { kind: "trend" }>,
  px: number,
  py: number,
  series: PriceConverter,
  timeScale: TimeConverter,
): boolean {
  const p1 = pricePointToPixel(series, timeScale, drawing.p1);
  const p2 = pricePointToPixel(series, timeScale, drawing.p2);
  if (p1 === null || p2 === null) return false;
  return distanceToSegment(px, py, p1.x, p1.y, p2.x, p2.y) <= HIT_THRESHOLD_PX;
}

/** Hit-test a horizontal line: project the price to a y-pixel, then
 *  vertical distance only (the line spans the entire x range). */
export function hitTestHorizontal(
  drawing: Extract<Drawing, { kind: "horizontal" }>,
  py: number,
  series: PriceConverter,
): boolean {
  const lineY = series.priceToCoordinate(drawing.price);
  if (lineY === null) return false;
  return Math.abs(py - lineY) <= HIT_THRESHOLD_PX;
}

/** Hit-test a rectangle: distance to any of the four EDGES (not
 *  inside-fill). Clicking inside the rect should NOT select it —
 *  users want to interact with the chart visible through the
 *  rectangle. Selecting requires clicking near an edge. */
export function hitTestRectangle(
  drawing: Extract<Drawing, { kind: "rectangle" }>,
  px: number,
  py: number,
  series: PriceConverter,
  timeScale: TimeConverter,
): boolean {
  const p1 = pricePointToPixel(series, timeScale, drawing.p1);
  const p2 = pricePointToPixel(series, timeScale, drawing.p2);
  if (p1 === null || p2 === null) return false;
  // Normalise to a canonical (top-left, bottom-right) so the user can
  // anchor the rect from any corner.
  const minX = Math.min(p1.x, p2.x);
  const maxX = Math.max(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const maxY = Math.max(p1.y, p2.y);
  const distTop = distanceToSegment(px, py, minX, minY, maxX, minY);
  const distBottom = distanceToSegment(px, py, minX, maxY, maxX, maxY);
  const distLeft = distanceToSegment(px, py, minX, minY, minX, maxY);
  const distRight = distanceToSegment(px, py, maxX, minY, maxX, maxY);
  const minDist = Math.min(distTop, distBottom, distLeft, distRight);
  return minDist <= HIT_THRESHOLD_PX;
}

/** Top-level hit-test dispatcher. Iterates drawings in REVERSE order
 *  (last-drawn first wins on overlap — matches user expectation
 *  "select what's on top") and returns the id of the first hit, or
 *  `null` if no drawing was within threshold. */
export function findHitDrawingId(
  drawings: readonly Drawing[],
  px: number,
  py: number,
  series: PriceConverter,
  timeScale: TimeConverter,
): string | null {
  for (let i = drawings.length - 1; i >= 0; i--) {
    const d = drawings[i];
    let hit = false;
    switch (d.kind) {
      case "trend":
        hit = hitTestTrend(d, px, py, series, timeScale);
        break;
      case "horizontal":
        hit = hitTestHorizontal(d, py, series);
        break;
      case "rectangle":
        hit = hitTestRectangle(d, px, py, series, timeScale);
        break;
      default:
        return assertNever(d);
    }
    if (hit) return d.id;
  }
  return null;
}
