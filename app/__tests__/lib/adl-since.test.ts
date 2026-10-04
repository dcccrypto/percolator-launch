// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  adlSinceChanged,
  closeOnlyDurationLine,
  formatDuration,
  formatSinceUtc,
  reconcileAdlSince,
} from "@/lib/adl-since";

const T0 = Date.UTC(2026, 9, 3, 15, 18, 0); // 3 Oct 2026 15:18Z, Percolator's first ADL

describe("reconcileAdlSince", () => {
  it("starts the clock the first time a slab is seen reduce-only", () => {
    expect(reconcileAdlSince({}, [{ slab: "A", reduceOnly: true }], T0)).toEqual({ A: T0 });
  });

  it("never moves an existing start later (a lower bound only grows)", () => {
    expect(reconcileAdlSince({ A: T0 }, [{ slab: "A", reduceOnly: true }], T0 + 3_600_000)).toEqual({ A: T0 });
  });

  it("ends the episode when the market is no longer reduce-only; a later episode starts fresh", () => {
    const ended = reconcileAdlSince({ A: T0 }, [{ slab: "A", reduceOnly: false }], T0 + 1000);
    expect(ended).toEqual({});
    expect(reconcileAdlSince(ended, [{ slab: "A", reduceOnly: true }], T0 + 9000)).toEqual({ A: T0 + 9000 });
  });

  it("NEGATIVE CONTROL: an unknown read (null) neither starts nor ends an episode", () => {
    expect(reconcileAdlSince({ A: T0 }, [{ slab: "A", reduceOnly: null }], T0 + 5000)).toEqual({ A: T0 });
    expect(reconcileAdlSince({}, [{ slab: "B", reduceOnly: null }], T0)).toEqual({});
  });

  it("other slabs are untouched, and a corrupt future timestamp is replaced by now", () => {
    expect(reconcileAdlSince({ X: 1 }, [{ slab: "A", reduceOnly: true }], T0)).toEqual({ X: 1, A: T0 });
    expect(reconcileAdlSince({ A: T0 + 10_000_000 }, [{ slab: "A", reduceOnly: true }], T0)).toEqual({ A: T0 });
  });

  it("adlSinceChanged compares by content", () => {
    expect(adlSinceChanged({ A: 1 }, { A: 1 })).toBe(false);
    expect(adlSinceChanged({ A: 1 }, { A: 2 })).toBe(true);
    expect(adlSinceChanged({}, { A: 1 })).toBe(true);
  });
});

describe("close-only duration wording", () => {
  it("formats durations", () => {
    expect(formatDuration(10_000)).toBe("under a minute");
    expect(formatDuration(35 * 60_000)).toBe("35 min");
    expect(formatDuration(13 * 3_600_000 + 5 * 60_000)).toBe("13 h");
    expect(formatDuration(57.6 * 3_600_000)).toBe("2 d 9 h");
    expect(formatDuration(48 * 3_600_000)).toBe("2 d");
    expect(formatDuration(Number.NaN)).toBe("under a minute");
  });

  it("formats the start in UTC", () => {
    expect(formatSinceUtc(T0)).toBe("3 Oct, 15:18 UTC");
  });

  it("one calm line, and it says 'at least' because the start is when the app first saw it", () => {
    const line = closeOnlyDurationLine(T0, T0 + 12.8 * 3_600_000);
    expect(line).toBe("Close-only for at least 12 h (since 3 Oct, 15:18 UTC).");
  });

  it("no line when the start is unknown or in the future", () => {
    expect(closeOnlyDurationLine(null, T0)).toBeNull();
    expect(closeOnlyDurationLine(undefined, T0)).toBeNull();
    expect(closeOnlyDurationLine(T0 + 1, T0)).toBeNull();
  });
});
