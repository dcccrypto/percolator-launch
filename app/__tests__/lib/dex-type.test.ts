import { describe, it, expect } from "vitest";
import { normalizeDexType, KEEPER_DEX_TYPES } from "@/lib/dex-type";

describe("normalizeDexType", () => {
  it("passes through exact keeper vocabulary", () => {
    for (const t of KEEPER_DEX_TYPES) {
      expect(normalizeDexType(t)).toBe(t);
    }
  });

  it("maps DexScreener raw ids to keeper vocabulary", () => {
    // DexScreener reports these ids for pools the keeper names differently —
    // the exact mismatch that silently orphaned wizard-launched markets.
    expect(normalizeDexType("meteora")).toBe("meteora-dlmm");
    expect(normalizeDexType("raydium")).toBe("raydium-clmm");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(normalizeDexType(" Meteora ")).toBe("meteora-dlmm");
    expect(normalizeDexType("RAYDIUM-CLMM")).toBe("raydium-clmm");
  });

  it("returns null for PumpSwap — keeper pricing is broken for it (wrong byte offsets, no SOL→USD conversion)", () => {
    expect(normalizeDexType("pumpswap")).toBeNull();
    expect(normalizeDexType("PumpSwap")).toBeNull();
    expect(normalizeDexType("pump")).toBeNull();
    expect(normalizeDexType("pumpfun")).toBeNull();
    expect(normalizeDexType("pump-swap")).toBeNull();
  });

  it("returns null for unpriceable or unknown dexes", () => {
    expect(normalizeDexType("orca")).toBeNull();
    expect(normalizeDexType("whirlpool")).toBeNull();
    expect(normalizeDexType("")).toBeNull();
    expect(normalizeDexType(null)).toBeNull();
    expect(normalizeDexType(undefined)).toBeNull();
  });
});
