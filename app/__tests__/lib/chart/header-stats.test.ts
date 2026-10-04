import { describe, expect, it } from "vitest";
import { change24h, formatCompactUsd, formatPct, marketRowStats, parseFunding } from "@/lib/chart/header-stats";

const NOW = 1_791_000_000;
const hours = (n: number, price: (i: number) => number) =>
  Array.from({ length: n }, (_, i) => ({ timeSec: NOW - (n - i) * 3600, open: price(i), close: price(i) }));

describe("change24h", () => {
  it("uses the close of the last bar at or before now-24h", () => {
    const bars = hours(30, (i) => 100 + i);
    // bar index 6 has timeSec NOW-24*3600 exactly: close 106
    const r = change24h(bars, 120, NOW)!;
    expect(r.partial).toBe(false);
    expect(r.pct).toBeCloseTo(((120 - 106) / 106) * 100, 6);
  });
  it("with under a day of history it is flagged partial and uses the first open", () => {
    const r = change24h(hours(5, () => 50), 55, NOW)!;
    expect(r).toEqual({ pct: 10, partial: true });
  });
  it("is null with no data or no price, never NaN", () => {
    expect(change24h([], 1, NOW)).toBeNull();
    expect(change24h(hours(3, () => 1), null, NOW)).toBeNull();
    expect(change24h(hours(3, () => 0), 5, NOW)).toBeNull();
  });
});

describe("formatters", () => {
  it("compact USD", () => {
    expect(formatCompactUsd(1_250_000)).toBe("$1.25M");
    expect(formatCompactUsd(42_300)).toBe("$42.3K");
    expect(formatCompactUsd(0)).toBe("$0");
    expect(formatCompactUsd(null)).toBe("—");
    expect(formatCompactUsd(NaN)).toBe("—");
  });
  it("percent keeps its sign", () => {
    expect(formatPct(3.456)).toBe("+3.46%");
    expect(formatPct(-0.5)).toBe("-0.50%");
    expect(formatPct(0)).toBe("0.00%");
    expect(formatPct(undefined)).toBe("—");
  });
});

describe("parseFunding / marketRowStats", () => {
  it("parses the funding route body", () => {
    expect(parseFunding({ hourlyRatePercent: 0, fundingEnabled: false })).toEqual({ hourlyPct: 0, enabled: false });
    expect(parseFunding({ hourlyRatePercent: 0.0123, fundingEnabled: true })).toEqual({ hourlyPct: 0.0123, enabled: true });
    expect(parseFunding({ error: "x" })).toBeNull();
    expect(parseFunding(null)).toBeNull();
  });
  it("picks the slab's row from the markets list", () => {
    const body = { markets: [{ slab_address: "A", volume_24h_usd: 5, total_open_interest_usd: 9 }, { slab_address: "B", volume_24h_usd: 7, total_open_interest_usd: 1 }] };
    expect(marketRowStats(body, "B")).toEqual({ volume24hUsd: 7, oiUsd: 1 });
    expect(marketRowStats(body, "C")).toBeNull();
    expect(marketRowStats({}, "A")).toBeNull();
  });
});
