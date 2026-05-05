/** Canvas helpers for the drawing-tools overlay. Pure side-effecting
 *  functions on a HTMLCanvasElement / CanvasRenderingContext2D pair —
 *  no React, no chart library. Extracted so the math and effect order
 *  are testable in isolation.
 */

/** Configure a canvas + 2D context for crisp rendering at the device's
 *  pixel ratio.
 *
 *  - Backing-store size scales by `dpr` so high-DPI screens (Retina,
 *    1.5×, 2×, 3×) get more actual pixels and lines render sharp.
 *  - CSS size stays at the logical (display) dimensions so the canvas
 *    occupies the same layout space regardless of DPR.
 *  - Context transform is set so subsequent draw calls work in CSS-
 *    pixel space — the caller passes integer-ish coordinates from
 *    `priceToCoordinate` etc. and the transform handles the DPR
 *    multiplication.
 *
 *  Backing-store dimensions are clamped to a minimum of 1 because a
 *  zero-sized canvas throws when you try to draw on it. ResizeObserver
 *  can briefly hand us 0×0 during layout transitions (drawer collapse,
 *  modal open, etc.) and we'd rather skip a frame than crash.
 *
 *  `setTransform` replaces the current transform rather than composing
 *  with it — that's correct here because we call this on every resize
 *  and want a clean baseline. */
export function sizeCanvasForDpr(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  displayW: number,
  displayH: number,
  dpr: number,
): void {
  canvas.width = Math.max(1, Math.round(displayW * dpr));
  canvas.height = Math.max(1, Math.round(displayH * dpr));
  canvas.style.width = `${displayW}px`;
  canvas.style.height = `${displayH}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
