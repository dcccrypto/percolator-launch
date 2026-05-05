import { describe, it, expect } from "vitest";
import {
  type Drawing,
  type PricePoint,
  DRAWINGS_STORAGE_VERSION,
  MAX_DRAWINGS_PER_SLAB,
  isDrawing,
  mergeDrawings,
} from "@/lib/chart-drawings";

const validP1: PricePoint = { time: 1_700_000_000_000, price: 100 };
const validP2: PricePoint = { time: 1_700_000_060_000, price: 110 };

const validTrend: Drawing = {
  id: "trend-1",
  kind: "trend",
  p1: validP1,
  p2: validP2,
};
const validHorizontal: Drawing = {
  id: "horiz-1",
  kind: "horizontal",
  price: 105,
};
const validRectangle: Drawing = {
  id: "rect-1",
  kind: "rectangle",
  p1: validP1,
  p2: validP2,
};

describe("isDrawing", () => {
  it("accepts a well-formed trend line", () => {
    expect(isDrawing(validTrend)).toBe(true);
  });

  it("accepts a well-formed horizontal line", () => {
    expect(isDrawing(validHorizontal)).toBe(true);
  });

  it("accepts a well-formed rectangle", () => {
    expect(isDrawing(validRectangle)).toBe(true);
  });

  it.each([null, undefined, 0, "", "string", true, []])(
    "rejects non-object value %p",
    (value) => {
      expect(isDrawing(value)).toBe(false);
    },
  );

  it("rejects a drawing with missing id", () => {
    const { id: _id, ...rest } = validTrend;
    expect(isDrawing(rest)).toBe(false);
  });

  it("rejects a drawing with empty-string id", () => {
    expect(isDrawing({ ...validTrend, id: "" })).toBe(false);
  });

  it("rejects unknown kind values", () => {
    expect(isDrawing({ ...validTrend, kind: "ellipse" })).toBe(false);
  });

  it("rejects a trend line with a missing endpoint", () => {
    const { p2: _p2, ...rest } = validTrend;
    expect(isDrawing(rest)).toBe(false);
  });

  it("rejects a horizontal line with non-finite price", () => {
    expect(isDrawing({ ...validHorizontal, price: NaN })).toBe(false);
    expect(isDrawing({ ...validHorizontal, price: Infinity })).toBe(false);
  });

  it("rejects a price-point with non-finite time", () => {
    expect(
      isDrawing({ ...validTrend, p1: { time: NaN, price: 100 } }),
    ).toBe(false);
    expect(
      isDrawing({ ...validTrend, p1: { time: Infinity, price: 100 } }),
    ).toBe(false);
  });

  it("rejects a price-point with non-finite price", () => {
    expect(
      isDrawing({ ...validTrend, p1: { time: 1_700_000_000_000, price: NaN } }),
    ).toBe(false);
  });
});

describe("mergeDrawings", () => {
  it("returns [] for non-object inputs", () => {
    expect(mergeDrawings(null)).toEqual([]);
    expect(mergeDrawings(undefined)).toEqual([]);
    expect(mergeDrawings("string")).toEqual([]);
    expect(mergeDrawings(42)).toEqual([]);
  });

  it("returns [] for an envelope with the wrong version", () => {
    expect(
      mergeDrawings({
        version: DRAWINGS_STORAGE_VERSION + 1,
        drawings: [validTrend],
      }),
    ).toEqual([]);
  });

  it.each([
    ["missing version field", { drawings: [] }],
    ["string-typed version", { version: "1", drawings: [] }],
    ["NaN version", { version: NaN, drawings: [] }],
    ["zero version", { version: 0, drawings: [] }],
    ["negative version", { version: -1, drawings: [] }],
    ["null version", { version: null, drawings: [] }],
  ])("returns [] for envelope with %s", (_label, envelope) => {
    // Strict equality on the version field means anything that isn't
    // exactly DRAWINGS_STORAGE_VERSION (a number) drops the whole list.
    // Pins each edge case so a future relaxation of the check fails a
    // specific test rather than silently accepting weird payloads.
    expect(mergeDrawings(envelope)).toEqual([]);
  });

  it("returns [] for an envelope where drawings is not an array", () => {
    expect(
      mergeDrawings({
        version: DRAWINGS_STORAGE_VERSION,
        drawings: "not an array",
      }),
    ).toEqual([]);
  });

  it.each([
    ["object", { version: DRAWINGS_STORAGE_VERSION, drawings: {} }],
    ["null", { version: DRAWINGS_STORAGE_VERSION, drawings: null }],
    ["undefined", { version: DRAWINGS_STORAGE_VERSION }],
    ["number", { version: DRAWINGS_STORAGE_VERSION, drawings: 42 }],
    ["boolean", { version: DRAWINGS_STORAGE_VERSION, drawings: true }],
  ])(
    "returns [] when envelope.drawings is non-array (%s)",
    (_label, envelope) => {
      expect(mergeDrawings(envelope)).toEqual([]);
    },
  );

  it("rejects entries carrying __proto__ as an own key (prototype-pollution defuse)", () => {
    // JSON.parse intentionally treats __proto__ as a string-key own
    // property, NOT a prototype slot. isDrawing rejects entries with
    // any prototype-related own key so future spread sites in the
    // rendering pipeline can't re-apply the pollution.
    const polluted = JSON.parse(
      `{"version":${DRAWINGS_STORAGE_VERSION},"drawings":[{"id":"x","kind":"horizontal","price":100,"__proto__":{"polluted":true}}]}`,
    );
    expect(mergeDrawings(polluted)).toEqual([]);
  });

  it("rejects entries carrying constructor or prototype as own keys", () => {
    expect(
      isDrawing({
        ...validHorizontal,
        constructor: { polluted: true },
      }),
    ).toBe(false);
    expect(
      isDrawing({
        ...validHorizontal,
        prototype: { polluted: true },
      }),
    ).toBe(false);
  });

  it("accepts a well-formed envelope and returns the drawings", () => {
    const result = mergeDrawings({
      version: DRAWINGS_STORAGE_VERSION,
      drawings: [validTrend, validHorizontal, validRectangle],
    });
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(validTrend);
    expect(result[2]).toEqual(validRectangle);
  });

  it("accepts a bare-array payload defensively (legacy / future read)", () => {
    expect(mergeDrawings([validTrend, validHorizontal])).toEqual([
      validTrend,
      validHorizontal,
    ]);
  });

  it("drops malformed entries without rejecting the whole list", () => {
    const result = mergeDrawings({
      version: DRAWINGS_STORAGE_VERSION,
      drawings: [
        validTrend,
        null,
        { id: "bad", kind: "ellipse" },
        { id: "", kind: "trend", p1: validP1, p2: validP2 },
        validHorizontal,
      ],
    });
    expect(result).toHaveLength(2);
    expect(result.map((d) => d.id)).toEqual([validTrend.id, validHorizontal.id]);
  });

  it("dedupes drawings sharing an id (first wins)", () => {
    const dup = { ...validHorizontal, id: validTrend.id, price: 200 };
    const result = mergeDrawings({
      version: DRAWINGS_STORAGE_VERSION,
      drawings: [validTrend, dup],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(validTrend);
  });

  it("trims at MAX_DRAWINGS_PER_SLAB on read", () => {
    const drawings = Array.from({ length: MAX_DRAWINGS_PER_SLAB + 25 }, (_, i) => ({
      id: `d-${i}`,
      kind: "horizontal" as const,
      price: i,
    }));
    const result = mergeDrawings({
      version: DRAWINGS_STORAGE_VERSION,
      drawings,
    });
    expect(result).toHaveLength(MAX_DRAWINGS_PER_SLAB);
    // First N kept (cap counts valid entries only).
    expect(result[0].id).toBe("d-0");
    expect(result[MAX_DRAWINGS_PER_SLAB - 1].id).toBe(
      `d-${MAX_DRAWINGS_PER_SLAB - 1}`,
    );
  });

  it("counts only valid entries against the cap (junk entries don't consume budget)", () => {
    const valid = Array.from({ length: MAX_DRAWINGS_PER_SLAB - 5 }, (_, i) => ({
      id: `v-${i}`,
      kind: "horizontal" as const,
      price: i,
    }));
    const junk = Array.from({ length: 50 }, () => ({
      id: "junk",
      kind: "ellipse",
    }));
    const trailing = Array.from({ length: 10 }, (_, i) => ({
      id: `t-${i}`,
      kind: "horizontal" as const,
      price: 1000 + i,
    }));
    const result = mergeDrawings({
      version: DRAWINGS_STORAGE_VERSION,
      drawings: [...valid, ...junk, ...trailing],
    });
    // 95 valid + 5 trailing = 100 (cap), 5 trailing left over dropped.
    expect(result).toHaveLength(MAX_DRAWINGS_PER_SLAB);
    expect(result[0].id).toBe("v-0");
    expect(result[MAX_DRAWINGS_PER_SLAB - 1].id).toBe("t-4");
  });

  it("ignores unknown envelope fields", () => {
    const result = mergeDrawings({
      version: DRAWINGS_STORAGE_VERSION,
      drawings: [validTrend],
      futureField: { something: 42 },
      anotherField: "ignored",
    });
    expect(result).toEqual([validTrend]);
  });
});
