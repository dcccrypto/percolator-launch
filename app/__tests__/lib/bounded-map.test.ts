import { describe, it, expect } from "vitest";
import { boundedSet } from "@/lib/bounded-map";

/**
 * boundedSet caps in-process caches whose keys are attacker-influenced (the
 * chart route's GeckoTerminal pool/candle caches), so a flood of distinct
 * keys can't grow the Map without bound.
 */
describe("boundedSet", () => {
  it("never exceeds the cap no matter how many distinct keys are inserted", () => {
    const m = new Map<string, number>();
    for (let i = 0; i < 10_000; i++) boundedSet(m, `k${i}`, i, 100);
    expect(m.size).toBe(100);
  });

  it("evicts the OLDEST entry first (FIFO on fresh keys)", () => {
    const m = new Map<string, number>();
    for (let i = 0; i < 5; i++) boundedSet(m, `k${i}`, i, 3);
    // Cap 3 → only the last three keys survive.
    expect([...m.keys()]).toEqual(["k2", "k3", "k4"]);
  });

  it("re-writing an existing key refreshes it to newest (hot keys survive)", () => {
    const m = new Map<string, number>();
    boundedSet(m, "a", 1, 3);
    boundedSet(m, "b", 1, 3);
    boundedSet(m, "c", 1, 3);
    boundedSet(m, "a", 99, 3); // touch 'a' → now newest; 'b' is oldest
    boundedSet(m, "d", 1, 3); // evicts 'b', not 'a'
    expect(m.has("a")).toBe(true);
    expect(m.get("a")).toBe(99); // value updated
    expect(m.has("b")).toBe(false); // evicted
    expect([...m.keys()]).toEqual(["c", "a", "d"]);
  });

  it("updating an existing key does not grow the map", () => {
    const m = new Map<string, number>();
    boundedSet(m, "x", 1, 10);
    boundedSet(m, "x", 2, 10);
    boundedSet(m, "x", 3, 10);
    expect(m.size).toBe(1);
    expect(m.get("x")).toBe(3);
  });

  it("cap of 1 keeps only the most recent entry", () => {
    const m = new Map<string, number>();
    boundedSet(m, "a", 1, 1);
    boundedSet(m, "b", 2, 1);
    expect([...m.keys()]).toEqual(["b"]);
    expect(m.size).toBe(1);
  });
});
