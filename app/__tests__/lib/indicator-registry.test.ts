import { describe, it, expect } from "vitest";
import {
  ALL_INDICATOR_KINDS,
  INDICATOR_LABELS,
  INDICATOR_DEFAULTS,
  INDICATOR_DISPLAY_ORDER,
  INDICATORS_STORAGE_VERSION,
  MAX_INDICATORS_PER_SLAB,
  isOverlayKind,
  isPaneKind,
  isIndicatorKind,
  isIndicatorConfig,
  mergeIndicators,
  type IndicatorKind,
} from "@/lib/indicator-registry";

describe("ALL_INDICATOR_KINDS", () => {
  it("lists every kind we ship in v1: sma, ema, bollinger, rsi, macd", () => {
    const expected: IndicatorKind[] = ["sma", "ema", "bollinger", "rsi", "macd"];
    expect([...ALL_INDICATOR_KINDS]).toEqual(expected);
  });
});

describe("INDICATOR_LABELS", () => {
  it("provides a non-empty label for every indicator kind", () => {
    for (const kind of ALL_INDICATOR_KINDS) {
      expect(INDICATOR_LABELS[kind]).toBeTruthy();
      expect(INDICATOR_LABELS[kind].length).toBeGreaterThan(0);
    }
  });

  it("labels are unique — no two kinds collide in the menu", () => {
    const seen = new Set<string>();
    for (const kind of ALL_INDICATOR_KINDS) {
      expect(seen.has(INDICATOR_LABELS[kind])).toBe(false);
      seen.add(INDICATOR_LABELS[kind]);
    }
  });
});

describe("INDICATOR_DEFAULTS", () => {
  it("has TradingView's universal defaults pinned", () => {
    expect(INDICATOR_DEFAULTS.sma).toEqual({ kind: "sma", period: 20 });
    expect(INDICATOR_DEFAULTS.ema).toEqual({ kind: "ema", period: 21 });
    expect(INDICATOR_DEFAULTS.bollinger).toEqual({ kind: "bollinger", period: 20, stdDev: 2 });
    expect(INDICATOR_DEFAULTS.rsi).toEqual({ kind: "rsi", period: 14 });
    expect(INDICATOR_DEFAULTS.macd).toEqual({
      kind: "macd",
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
    });
  });

  it("provides defaults for every indicator kind", () => {
    for (const kind of ALL_INDICATOR_KINDS) {
      expect(INDICATOR_DEFAULTS[kind]).toBeDefined();
      expect((INDICATOR_DEFAULTS[kind] as { kind: IndicatorKind }).kind).toBe(kind);
    }
  });
});

describe("isOverlayKind / isPaneKind", () => {
  it("classifies sma, ema, bollinger as overlay (drawn on price scale)", () => {
    expect(isOverlayKind("sma")).toBe(true);
    expect(isOverlayKind("ema")).toBe(true);
    expect(isOverlayKind("bollinger")).toBe(true);
  });

  it("classifies rsi, macd as pane (drawn in their own pane)", () => {
    expect(isPaneKind("rsi")).toBe(true);
    expect(isPaneKind("macd")).toBe(true);
  });

  it("every kind is either overlay or pane (not both, not neither)", () => {
    for (const kind of ALL_INDICATOR_KINDS) {
      const overlay = isOverlayKind(kind);
      const pane = isPaneKind(kind);
      expect(overlay !== pane).toBe(true); // XOR — exactly one is true
    }
  });
});

describe("isIndicatorKind", () => {
  it("accepts every member of the union", () => {
    for (const kind of ALL_INDICATOR_KINDS) {
      expect(isIndicatorKind(kind)).toBe(true);
    }
  });

  it("rejects unknown strings, including case-mismatches", () => {
    for (const v of ["", "SMA", "Sma", "vwap", "stochastic", "ichimoku"]) {
      expect(isIndicatorKind(v)).toBe(false);
    }
  });

  it("rejects non-string inputs", () => {
    for (const v of [null, undefined, 0, 1, {}, [], true, false]) {
      expect(isIndicatorKind(v)).toBe(false);
    }
  });
});

describe("isIndicatorConfig", () => {
  it("accepts a fully-formed SMA config", () => {
    expect(isIndicatorConfig({ id: "abc", kind: "sma", period: 20, color: "#9945FF" })).toBe(true);
  });

  it("accepts a fully-formed Bollinger config", () => {
    expect(
      isIndicatorConfig({ id: "abc", kind: "bollinger", period: 20, stdDev: 2, color: "#9945FF" }),
    ).toBe(true);
  });

  it("accepts a fully-formed MACD config", () => {
    expect(
      isIndicatorConfig({
        id: "abc",
        kind: "macd",
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        color: "#9945FF",
      }),
    ).toBe(true);
  });

  it("rejects missing id or empty id", () => {
    expect(isIndicatorConfig({ kind: "sma", period: 20, color: "#9945FF" })).toBe(false);
    expect(isIndicatorConfig({ id: "", kind: "sma", period: 20, color: "#9945FF" })).toBe(false);
  });

  it("rejects missing or empty color", () => {
    expect(isIndicatorConfig({ id: "abc", kind: "sma", period: 20 })).toBe(false);
    expect(isIndicatorConfig({ id: "abc", kind: "sma", period: 20, color: "" })).toBe(false);
  });

  it("rejects unknown kind", () => {
    expect(isIndicatorConfig({ id: "abc", kind: "vwap", period: 20, color: "#9945FF" })).toBe(false);
  });

  it("rejects non-numeric or non-finite period", () => {
    expect(isIndicatorConfig({ id: "abc", kind: "sma", period: "20", color: "#9945FF" })).toBe(false);
    expect(isIndicatorConfig({ id: "abc", kind: "sma", period: NaN, color: "#9945FF" })).toBe(false);
    expect(isIndicatorConfig({ id: "abc", kind: "sma", period: Infinity, color: "#9945FF" })).toBe(
      false,
    );
    expect(isIndicatorConfig({ id: "abc", kind: "sma", period: 0, color: "#9945FF" })).toBe(false);
  });

  it("rejects MACD with missing or invalid period fields", () => {
    expect(
      isIndicatorConfig({ id: "abc", kind: "macd", fastPeriod: 12, slowPeriod: 26, color: "#9945FF" }),
    ).toBe(false); // missing signalPeriod
    expect(
      isIndicatorConfig({
        id: "abc",
        kind: "macd",
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: -1,
        color: "#9945FF",
      }),
    ).toBe(false); // negative signal
  });

  it("rejects null, arrays, primitives", () => {
    for (const v of [null, undefined, [], "x", 0, true]) {
      expect(isIndicatorConfig(v)).toBe(false);
    }
  });
});

describe("mergeIndicators", () => {
  const validSma = { id: "abc", kind: "sma" as const, period: 20, color: "#9945FF" };
  const validRsi = { id: "def", kind: "rsi" as const, period: 14, color: "#22D3EE" };

  it("returns [] for null / non-object input", () => {
    for (const v of [null, undefined, 42, "x", []]) {
      expect(mergeIndicators(v)).toEqual([]);
    }
  });

  it("returns [] when version is missing or wrong", () => {
    expect(mergeIndicators({ indicators: [validSma] })).toEqual([]);
    expect(mergeIndicators({ version: 2, indicators: [validSma] })).toEqual([]);
    expect(mergeIndicators({ version: "1", indicators: [validSma] })).toEqual([]);
  });

  it("returns [] when indicators field is missing or wrong type", () => {
    expect(mergeIndicators({ version: 1 })).toEqual([]);
    expect(mergeIndicators({ version: 1, indicators: "not-an-array" })).toEqual([]);
  });

  it("preserves valid entries from a properly-shaped envelope", () => {
    const result = mergeIndicators({ version: 1, indicators: [validSma, validRsi] });
    expect(result).toEqual([validSma, validRsi]);
  });

  it("drops malformed entries silently and keeps the valid ones", () => {
    const result = mergeIndicators({
      version: 1,
      indicators: [validSma, { kind: "garbage" }, validRsi, null, "string"],
    });
    expect(result).toEqual([validSma, validRsi]);
  });

  it("drops duplicate IDs (keeps the first occurrence)", () => {
    const dup = { id: "abc", kind: "ema" as const, period: 50, color: "#F59E0B" };
    const result = mergeIndicators({ version: 1, indicators: [validSma, dup] });
    expect(result).toEqual([validSma]); // dup dropped because id "abc" already seen
  });

  it("caps at MAX_INDICATORS_PER_SLAB even if storage has more", () => {
    const lots = Array.from({ length: MAX_INDICATORS_PER_SLAB + 5 }, (_, i) => ({
      id: `id-${i}`,
      kind: "sma" as const,
      period: 20,
      color: "#9945FF",
    }));
    const result = mergeIndicators({ version: 1, indicators: lots });
    expect(result).toHaveLength(MAX_INDICATORS_PER_SLAB);
  });
});

describe("INDICATORS_STORAGE_VERSION + MAX_INDICATORS_PER_SLAB", () => {
  it("storage version is 1 (initial release)", () => {
    expect(INDICATORS_STORAGE_VERSION).toBe(1);
  });

  it("max indicators per slab is finite and positive", () => {
    expect(MAX_INDICATORS_PER_SLAB).toBeGreaterThan(0);
    expect(Number.isFinite(MAX_INDICATORS_PER_SLAB)).toBe(true);
  });
});

describe("INDICATOR_DISPLAY_ORDER", () => {
  it("contains every indicator kind exactly once", () => {
    expect(INDICATOR_DISPLAY_ORDER.length).toBe(ALL_INDICATOR_KINDS.length);
    for (const kind of ALL_INDICATOR_KINDS) {
      expect(INDICATOR_DISPLAY_ORDER).toContain(kind);
    }
  });
});
