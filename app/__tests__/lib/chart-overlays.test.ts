import { describe, it, expect } from "vitest";
import {
  isOverlayKey,
  mergeOverlayPrefs,
  OVERLAY_LABELS,
  OVERLAY_DISPLAY_ORDER,
  DEFAULT_OVERLAY_PREFS,
  type OverlayKey,
  type OverlayPrefs,
} from "../../lib/chart-overlays";

describe("isOverlayKey", () => {
  it("accepts every member of the OverlayKey union", () => {
    const all: OverlayKey[] = ["position", "entry", "liq", "pnl"];
    for (const k of all) expect(isOverlayKey(k)).toBe(true);
  });

  it("rejects unknown strings, including case-mismatches", () => {
    for (const v of ["", "Entry", "ENTRY", "mark", "volume", "fee", "Position"]) {
      expect(isOverlayKey(v)).toBe(false);
    }
  });

  it("rejects non-string inputs", () => {
    for (const v of [null, undefined, 0, 1, {}, [], true, false]) {
      expect(isOverlayKey(v)).toBe(false);
    }
  });
});

describe("mergeOverlayPrefs", () => {
  it("returns DEFAULT_OVERLAY_PREFS for null / non-object input", () => {
    for (const v of [null, undefined, 42, "x", []]) {
      expect(mergeOverlayPrefs(v)).toEqual(DEFAULT_OVERLAY_PREFS);
    }
  });

  it("returns a fresh object — does not mutate DEFAULT_OVERLAY_PREFS", () => {
    const result = mergeOverlayPrefs(null);
    result.entry = false;
    expect(DEFAULT_OVERLAY_PREFS.entry).toBe(true);
  });

  it("falls back to defaults for missing keys (older deploy wrote a smaller set)", () => {
    expect(mergeOverlayPrefs({ entry: false })).toEqual({
      position: true,
      entry: false,
      liq: true,
      pnl: true,
    });
  });

  it("ignores unknown keys (forward-compat: downgraded build sees a future key)", () => {
    const result = mergeOverlayPrefs({ position: true, entry: false, liq: true, pnl: true, future: true });
    expect(result).toEqual({ position: true, entry: false, liq: true, pnl: true });
    expect("future" in result).toBe(false);
  });

  it("ignores keys whose values are not boolean", () => {
    const result = mergeOverlayPrefs({ position: "yes", entry: "no", liq: 0, pnl: true });
    expect(result).toEqual({ position: true, entry: true, liq: true, pnl: true });
  });
});

describe("DEFAULT_OVERLAY_PREFS", () => {
  it("enables every overlay by default — Display menu is opt-OUT not opt-in", () => {
    for (const key of OVERLAY_DISPLAY_ORDER) {
      expect(DEFAULT_OVERLAY_PREFS[key]).toBe(true);
    }
  });
});

describe("OVERLAY_LABELS", () => {
  it("provides a non-empty label for every OverlayKey", () => {
    for (const key of OVERLAY_DISPLAY_ORDER) {
      expect(OVERLAY_LABELS[key]).toBeTruthy();
      expect(OVERLAY_LABELS[key].length).toBeGreaterThan(0);
    }
  });

  it("labels are unique", () => {
    const seen = new Set<string>();
    for (const key of OVERLAY_DISPLAY_ORDER) {
      expect(seen.has(OVERLAY_LABELS[key])).toBe(false);
      seen.add(OVERLAY_LABELS[key]);
    }
  });
});

describe("OVERLAY_DISPLAY_ORDER", () => {
  it("includes every OverlayKey exactly once", () => {
    const all: OverlayKey[] = ["position", "entry", "liq", "pnl"];
    expect(OVERLAY_DISPLAY_ORDER.length).toBe(all.length);
    for (const key of all) {
      expect(OVERLAY_DISPLAY_ORDER).toContain(key);
    }
  });

  it("orders position → entry → liq → pnl (the order a trader thinks about an open position)", () => {
    expect(OVERLAY_DISPLAY_ORDER[0]).toBe("position");
    expect(OVERLAY_DISPLAY_ORDER[1]).toBe("entry");
    expect(OVERLAY_DISPLAY_ORDER[2]).toBe("liq");
    expect(OVERLAY_DISPLAY_ORDER[3]).toBe("pnl");
  });
});

describe("type integrity", () => {
  it("OverlayPrefs accepts every OverlayKey as a key", () => {
    // Compile-time check — body just satisfies the Record contract at runtime.
    const prefs: OverlayPrefs = { position: true, entry: true, liq: false, pnl: true };
    expect(Object.keys(prefs).sort()).toEqual([...OVERLAY_DISPLAY_ORDER].sort());
  });
});
