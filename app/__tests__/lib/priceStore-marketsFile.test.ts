import { describe, it, expect } from "vitest";
import { parseMarketsFile } from "../../lib/priceStore/marketsFile";

// A trimmed copy of the v2.2 devnet keeper registry shape (registry.v22fresh.json).
const REGISTRY = JSON.stringify({
  version: 1,
  markets: [
    { label: "SOL/USDC — meteora-dlmm", marketAddress: "BYFuWyuoUGhP1n8wpD8gXH2ciDsegyF1UJCQvBiVx7T5", poolAddress: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6", dexType: "meteora-dlmm", assetIndex: 0 },
    { label: "ANSEM/USDC — pumpswap", marketAddress: "3TbThULumCsxVwQHUu1kQyCG81EroyzHEDYE4SBw4MyB", poolAddress: "FnzKY6x7entQ1eR3D225dQyT7ybfka4PskBMQhb8L3CC", dexType: "pumpswap", assetIndex: 0 },
    { label: "cap4b multi-asset — 2xhs", marketAddress: "2xhsLP9NLkUMMsCsyzkHM9R1zsVU2V2vDo6v9WuPBzVw", assetIndex: 0, assets: [{ assetIndex: 0, poolAddress: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6", dexType: "meteora-dlmm" }] },
    { label: "unknown dex", marketAddress: "3vW8VARnfB4y3QdJaWYebSv5WQvChnAHFL3MNLSH4JAy", poolAddress: "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj", dexType: "orca-whirlpool" },
  ],
});

describe("parseMarketsFile (PRICE_WS_MARKETS_FILE)", () => {
  it("takes the single-pool rows with a supported dexType, slab = the market address", () => {
    expect(parseMarketsFile(REGISTRY)).toEqual([
      { slab: "BYFuWyuoUGhP1n8wpD8gXH2ciDsegyF1UJCQvBiVx7T5", poolAddress: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6", dexType: "meteora-dlmm", label: "SOL/USDC — meteora-dlmm" },
      { slab: "3TbThULumCsxVwQHUu1kQyCG81EroyzHEDYE4SBw4MyB", poolAddress: "FnzKY6x7entQ1eR3D225dQyT7ybfka4PskBMQhb8L3CC", dexType: "pumpswap", label: "ANSEM/USDC — pumpswap" },
    ]);
  });
  it("skips multi-asset rows (no single pool) and unsupported dex types instead of guessing", () => {
    const slabs = parseMarketsFile(REGISTRY).map((m) => m.slab);
    expect(slabs).not.toContain("2xhsLP9NLkUMMsCsyzkHM9R1zsVU2V2vDo6v9WuPBzVw");
    expect(slabs).not.toContain("3vW8VARnfB4y3QdJaWYebSv5WQvChnAHFL3MNLSH4JAy");
  });
  it("an empty / market-less file yields no markets; malformed JSON throws", () => {
    expect(parseMarketsFile("{}")).toEqual([]);
    expect(() => parseMarketsFile("{not json")).toThrow();
  });
});
