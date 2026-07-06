/**
 * GH#2097 — VRAM vs Oracle Phase layout collision guards.
 *
 * https://github.com/dcccrypto/percolator-launch/issues/2097
 *
 * The on-chain fix lands in percolator-prog; these tests pin the byte-layout
 * contract so future padding packing cannot reintroduce silent aliasing.
 */

import { describe, it, expect } from "vitest";
import {
  GH2097_COLLIDING_PACKED_LAYOUT,
  GH2097_DISJOINT_PADDING_LAYOUT,
  GH2097_ORACLE_PHASE_RANGES,
  GH2097_VRAM_RANGES,
  assertDisjointRanges,
  byteRangesOverlap,
} from "@/lib/market-config-padding-layout";

describe("GH#2097 packed layout (documented bug)", () => {
  it("cumul_vol overlaps ewmv", () => {
    const cumul = GH2097_COLLIDING_PACKED_LAYOUT.find((r) => r.label === "cumul_vol")!;
    const ewmv = GH2097_COLLIDING_PACKED_LAYOUT.find((r) => r.label === "ewmv")!;
    expect(byteRangesOverlap(cumul, ewmv)).toBe(true);
  });

  it("phase2_delta overlaps vol_margin_scale", () => {
    const phase2 = GH2097_COLLIDING_PACKED_LAYOUT.find((r) => r.label === "phase2_delta")!;
    const vram = GH2097_COLLIDING_PACKED_LAYOUT.find((r) => r.label === "vol_margin_scale")!;
    expect(byteRangesOverlap(phase2, vram)).toBe(true);
  });

  it("last_vol_price overlaps both cumul_vol and ewmv", () => {
    const price = GH2097_COLLIDING_PACKED_LAYOUT.find((r) => r.label === "last_vol_price")!;
    const cumul = GH2097_COLLIDING_PACKED_LAYOUT.find((r) => r.label === "cumul_vol")!;
    const ewmv = GH2097_COLLIDING_PACKED_LAYOUT.find((r) => r.label === "ewmv")!;
    expect(byteRangesOverlap(price, cumul)).toBe(true);
    expect(byteRangesOverlap(price, ewmv)).toBe(true);
  });
});

describe("GH#2097 disjoint layout (recommended fix)", () => {
  it("all recommended ranges are pairwise disjoint", () => {
    expect(assertDisjointRanges(GH2097_DISJOINT_PADDING_LAYOUT)).toBe(true);
  });

  it("oracle phase block does not overlap VRAM block", () => {
    for (const oracle of GH2097_ORACLE_PHASE_RANGES) {
      for (const vram of GH2097_VRAM_RANGES) {
        expect(byteRangesOverlap(oracle, vram)).toBe(false);
      }
    }
  });

  it("cumulative_volume and phase2_delta_slots are in separate ranges", () => {
    const cumul = GH2097_DISJOINT_PADDING_LAYOUT.find((r) => r.label === "cumulative_volume_usd_e6")!;
    const phase2 = GH2097_DISJOINT_PADDING_LAYOUT.find((r) => r.label === "phase2_delta_slots")!;
    expect(byteRangesOverlap(cumul, phase2)).toBe(false);
  });
});
