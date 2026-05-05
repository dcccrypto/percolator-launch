import { describe, it, expect, vi } from "vitest";
import { sizeCanvasForDpr } from "@/lib/chart-canvas";

/** Build a stand-in HTMLCanvasElement that exposes only the fields
 *  sizeCanvasForDpr touches. jsdom's real canvas doesn't return a 2D
 *  context without node-canvas; faking the surface keeps the test
 *  pure. */
function fakeCanvas(): HTMLCanvasElement {
  return {
    width: 0,
    height: 0,
    style: { width: "", height: "" } as CSSStyleDeclaration,
  } as unknown as HTMLCanvasElement;
}

function fakeCtx(): {
  ctx: CanvasRenderingContext2D;
  setTransform: ReturnType<typeof vi.fn>;
} {
  const setTransform = vi.fn();
  return {
    ctx: { setTransform } as unknown as CanvasRenderingContext2D,
    setTransform,
  };
}

describe("sizeCanvasForDpr", () => {
  it("scales backing-store dimensions by dpr", () => {
    const canvas = fakeCanvas();
    const { ctx } = fakeCtx();
    sizeCanvasForDpr(canvas, ctx, 800, 600, 2);
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(1200);
  });

  it("keeps CSS dimensions at the logical (display) size in px", () => {
    const canvas = fakeCanvas();
    const { ctx } = fakeCtx();
    sizeCanvasForDpr(canvas, ctx, 800, 600, 2);
    expect(canvas.style.width).toBe("800px");
    expect(canvas.style.height).toBe("600px");
  });

  it("sets the context transform to scale draw calls by dpr", () => {
    const canvas = fakeCanvas();
    const { ctx, setTransform } = fakeCtx();
    sizeCanvasForDpr(canvas, ctx, 800, 600, 2);
    expect(setTransform).toHaveBeenCalledTimes(1);
    expect(setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
  });

  it("rounds non-integer dpr backing dimensions (1.5x display)", () => {
    const canvas = fakeCanvas();
    const { ctx, setTransform } = fakeCtx();
    sizeCanvasForDpr(canvas, ctx, 800, 600, 1.5);
    expect(canvas.width).toBe(1200);
    expect(canvas.height).toBe(900);
    expect(setTransform).toHaveBeenCalledWith(1.5, 0, 0, 1.5, 0, 0);
  });

  it("handles dpr=1 (standard display)", () => {
    const canvas = fakeCanvas();
    const { ctx, setTransform } = fakeCtx();
    sizeCanvasForDpr(canvas, ctx, 800, 600, 1);
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
    expect(canvas.style.width).toBe("800px");
    expect(canvas.style.height).toBe("600px");
    expect(setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
  });

  it("handles dpr=3 (high-DPI mobile)", () => {
    const canvas = fakeCanvas();
    const { ctx } = fakeCtx();
    sizeCanvasForDpr(canvas, ctx, 400, 800, 3);
    expect(canvas.width).toBe(1200);
    expect(canvas.height).toBe(2400);
  });

  it("clamps backing dimensions to a minimum of 1 (avoids 0×0 canvas)", () => {
    // ResizeObserver can briefly hand us 0×0 during layout transitions
    // (drawer collapse, modal open). Drawing on a 0-sized canvas
    // throws; the clamp keeps the cleanup path silent.
    const canvas = fakeCanvas();
    const { ctx } = fakeCtx();
    sizeCanvasForDpr(canvas, ctx, 0, 0, 2);
    expect(canvas.width).toBe(1);
    expect(canvas.height).toBe(1);
    // CSS dims are still 0 — layout-empty matches the container's
    // actual size; only the backing store is clamped.
    expect(canvas.style.width).toBe("0px");
    expect(canvas.style.height).toBe("0px");
  });

  it("rounds half-pixel display sizes consistently", () => {
    // 800.4 × 1.5 = 1200.6 → rounds to 1201
    const canvas = fakeCanvas();
    const { ctx } = fakeCtx();
    sizeCanvasForDpr(canvas, ctx, 800.4, 600.4, 1.5);
    expect(canvas.width).toBe(1201); // round(1200.6)
    expect(canvas.height).toBe(901); // round(900.6)
  });
});
