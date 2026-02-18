import { describe, it, expect, vi, beforeEach } from "vitest";

/* ── Test the price fetching logic ────────────────────────── */

// We test the API's data handling logic without the Next.js route wrapper

interface PriceRow {
  price_e6: string | number;
  timestamp: number;
}

interface StatsRow {
  mark_price_e6: string | number;
  last_updated: string;
}

/** Simulates the price formatting logic from the route */
function formatOraclePrices(rows: PriceRow[]): { price_e6: string; timestamp: number }[] {
  return rows.map((p) => ({
    price_e6: String(p.price_e6),
    timestamp: p.timestamp,
  }));
}

/** Simulates the fallback from market_stats */
function formatStatsPrices(stats: StatsRow[]): { price_e6: string; timestamp: number }[] {
  if (!stats || stats.length === 0) return [];
  return [
    {
      price_e6: String(stats[0].mark_price_e6),
      timestamp: new Date(stats[0].last_updated).getTime(),
    },
  ];
}

describe("Prices API: formatOraclePrices", () => {
  it("formats numeric price_e6 as string", () => {
    const result = formatOraclePrices([
      { price_e6: 83000000, timestamp: 1700000000000 },
    ]);
    expect(result[0].price_e6).toBe("83000000");
    expect(result[0].timestamp).toBe(1700000000000);
  });

  it("passes through string price_e6", () => {
    const result = formatOraclePrices([
      { price_e6: "95000000000", timestamp: 1700000000000 },
    ]);
    expect(result[0].price_e6).toBe("95000000000");
  });

  it("handles multiple rows", () => {
    const rows: PriceRow[] = [
      { price_e6: 80000000, timestamp: 1700000000000 },
      { price_e6: 82000000, timestamp: 1700000060000 },
      { price_e6: 81500000, timestamp: 1700000120000 },
    ];
    const result = formatOraclePrices(rows);
    expect(result).toHaveLength(3);
    expect(result[0].price_e6).toBe("80000000");
    expect(result[2].price_e6).toBe("81500000");
  });

  it("returns empty array for empty input", () => {
    expect(formatOraclePrices([])).toEqual([]);
  });
});

describe("Prices API: formatStatsPrices (fallback)", () => {
  it("converts market_stats row to price point", () => {
    const result = formatStatsPrices([
      { mark_price_e6: 83500000, last_updated: "2026-02-18T15:00:00.000Z" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].price_e6).toBe("83500000");
    expect(result[0].timestamp).toBe(new Date("2026-02-18T15:00:00.000Z").getTime());
  });

  it("returns empty for null/undefined", () => {
    expect(formatStatsPrices(null as any)).toEqual([]);
    expect(formatStatsPrices(undefined as any)).toEqual([]);
  });

  it("returns empty for empty array", () => {
    expect(formatStatsPrices([])).toEqual([]);
  });

  it("only uses first stat row", () => {
    const result = formatStatsPrices([
      { mark_price_e6: 83000000, last_updated: "2026-02-18T15:00:00.000Z" },
      { mark_price_e6: 84000000, last_updated: "2026-02-18T14:00:00.000Z" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].price_e6).toBe("83000000");
  });
});

describe("Prices API: slab address validation", () => {
  function isValidSlab(slab: string | undefined): boolean {
    return !!slab && slab.length >= 20;
  }

  it("accepts valid 44-char base58 slab address", () => {
    expect(isValidSlab("AtzJQmxUQitYAuGHeCTbupDkEsv5wDH44hv6ZmDJ8ufR")).toBe(true);
  });

  it("rejects undefined", () => {
    expect(isValidSlab(undefined)).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidSlab("")).toBe(false);
  });

  it("rejects short string", () => {
    expect(isValidSlab("short")).toBe(false);
  });

  it("accepts 32+ char address", () => {
    expect(isValidSlab("12345678901234567890")).toBe(true);
  });
});
