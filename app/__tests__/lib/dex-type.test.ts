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

  it("maps PumpSwap aliases to 'pumpswap' — percolator-sdk@3.1.0+ fixed the byte offsets, decimals, and SOL→USD conversion", () => {
    expect(normalizeDexType("pumpswap")).toBe("pumpswap");
    expect(normalizeDexType("PumpSwap")).toBe("pumpswap");
    expect(normalizeDexType("pump")).toBe("pumpswap");
    expect(normalizeDexType("pumpfun")).toBe("pumpswap");
    expect(normalizeDexType("pump-swap")).toBe("pumpswap");
  });

  it("returns null for unpriceable or unknown dexes", () => {
    expect(normalizeDexType("orca")).toBeNull();
    expect(normalizeDexType("whirlpool")).toBeNull();
    expect(normalizeDexType("")).toBeNull();
    expect(normalizeDexType(null)).toBeNull();
    expect(normalizeDexType(undefined)).toBeNull();
  });
});
