import { describe, expect, it } from "vitest";
import { DEFAULT_SUCCESSORS, loadSuccessors, parseSuccessors, successorFor } from "@/lib/v21/move/successors";
import { pk } from "./fixtures";

describe("successor map (data)", () => {
  it("seeds the six markets, none with a slab until the seed exists", () => {
    expect(DEFAULT_SUCCESSORS.map((e) => e.symbol)).toEqual(["SOL", "JUP", "TRUMP", "PENGU", "BURNIE", "Percolator"]);
    expect(DEFAULT_SUCCESSORS.every((e) => e.v21Slab === null)).toBe(true);
  });
  it("override fills a slab by symbol; malformed entries are dropped, never guessed", () => {
    const slab = pk();
    const m = loadSuccessors(JSON.stringify([{ symbol: "sol", v21Slab: slab, v21Earn: true }, { symbol: "BAD", v21Slab: "nope" }, 5]));
    expect(successorFor(m, null, "SOL-PERP")?.v21Slab).toBe(slab);
    expect(m.find((e) => e.symbol === "BAD")).toBeUndefined();
    expect(parseSuccessors("{not json")).toEqual([]);
    expect(parseSuccessors(JSON.stringify([{ symbol: "", v21Slab: slab }]))).toEqual([]);
  });
  it("a token with no entry has no successor", () => {
    expect(successorFor(loadSuccessors(undefined), null, "WIF")).toBeNull();
  });
});
