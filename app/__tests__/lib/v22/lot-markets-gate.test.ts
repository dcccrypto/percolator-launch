// @vitest-environment node
/**
 * Browser E2E 2026-10-16: the wizard could not create ANY lot market (token under $10): LOT_MARKETS_ENABLED was a
 * hard-coded false, left behind after QA L-1 attested the last lot surfaces. The gate now IS the coverage registry.
 */
import { describe, expect, it, vi, afterEach } from "vitest";

afterEach(() => { vi.resetModules(); vi.doUnmock("@/lib/v22/lot-coverage"); });

describe("lot markets gate = the lot-surface coverage registry", () => {
  it("every surface attested: the wizard may create lot markets", async () => {
    const { lotMarketsEnabled } = await import("@/lib/v22/lot");
    const { allLotSurfacesCovered } = await import("@/lib/v22/lot-coverage");
    expect(allLotSurfacesCovered()).toBe(true);
    expect(lotMarketsEnabled()).toBe(true);
  });
  it("NEGATIVE CONTROL: one surface un-attested closes the wizard again", async () => {
    vi.doMock("@/lib/v22/lot-coverage", () => ({ allLotSurfacesCovered: () => false }));
    const { lotMarketsEnabled } = await import("@/lib/v22/lot");
    expect(lotMarketsEnabled()).toBe(false);
  });
});
