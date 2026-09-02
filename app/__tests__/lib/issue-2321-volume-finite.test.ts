import { describe, expect, it } from "vitest";

// #2321 — hasVolumeData gated the volume pane on `(c.volume ?? 0) > 0`.
// NaN > 0 is false so NaN was already excluded, but Infinity > 0 is TRUE, so a
// single corrupt candle enabled the pane and handed Infinity to the histogram
// series, which then scales the whole pane off that value.
//
// Mirrors the predicate rather than importing the component (TradingChart pulls
// in lightweight-charts + a canvas). The assertion that matters is the shape of
// the guard: finiteness first, then positivity.
const hasVolumeData = (candles: { volume?: number }[]) =>
  candles.some((c) => Number.isFinite(c.volume) && (c.volume ?? 0) > 0);

describe("#2321 volume pane requires FINITE volume", () => {
  it("rejects Infinity — the case `> 0` alone let through", () => {
    expect(hasVolumeData([{ volume: Infinity }])).toBe(false);
    expect(hasVolumeData([{ volume: -Infinity }])).toBe(false);
  });

  it("rejects NaN and missing volume", () => {
    expect(hasVolumeData([{ volume: NaN }])).toBe(false);
    expect(hasVolumeData([{}])).toBe(false);
  });

  it("still accepts a real positive volume", () => {
    expect(hasVolumeData([{ volume: 0 }, { volume: 1234 }])).toBe(true);
  });

  it("one corrupt candle does not enable the pane on its own", () => {
    expect(hasVolumeData([{ volume: 0 }, { volume: Infinity }])).toBe(false);
  });
});
