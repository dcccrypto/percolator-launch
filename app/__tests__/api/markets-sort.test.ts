// @vitest-environment node
/**
 * GH#1524: /api/markets sort parameter non-functional.
 *
 * Previously SORTABLE_FIELDS only included: symbol, last_price, volume_24h,
 * total_open_interest_usd, funding_rate.
 * Callers requesting sort=total_open_interest, sort=mark_price, sort=created_at
 * all silently fell through to "no sort", making asc == desc == unsorted.
 *
 * This test verifies the sort logic directly (extracted from the route handler)
 * for both the previously-broken fields and the originally-supported fields.
 */
import { describe, it, expect } from "vitest";

// ---- Minimal inline reproduction of the route's sort logic ----

const SORTABLE_FIELDS = new Set([
  "symbol",
  "last_price",
  "mark_price",
  "index_price",
  "volume_24h",
  "volume_24h_usd",
  "total_open_interest",
  "total_open_interest_usd",
  "funding_rate",
  "created_at",
  "stats_updated_at",
  "trade_count_24h",
  "insurance_fund",
  "insurance_balance",
  "total_accounts",
]);

function applySort(
  markets: Record<string, unknown>[],
  sortParam: string | null,
  orderParam: string,
): Record<string, unknown>[] {
  const sortDir = orderParam === "desc" ? -1 : 1;
  return sortParam && SORTABLE_FIELDS.has(sortParam)
    ? [...markets].sort((a, b) => {
        const av = a[sortParam] ?? null;
        const bv = b[sortParam] ?? null;
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        if (typeof av === "string" && typeof bv === "string") {
          return sortDir * av.localeCompare(bv);
        }
        return sortDir * ((av as number) - (bv as number));
      })
    : markets;
}

// ---- Test fixtures ----

const MARKETS = [
  { symbol: "WENDYS", total_open_interest: 0, mark_price: 1.5, created_at: "2026-02-23T00:00:00Z" },
  { symbol: "B43W", total_open_interest: 2_000_000_000_000, mark_price: 50.0, created_at: "2026-01-10T00:00:00Z" },
  { symbol: "FWqf", total_open_interest: 9_000_000, mark_price: null, created_at: "2026-02-13T00:00:00Z" },
  { symbol: "2VqY", total_open_interest: 0, mark_price: 3.0, created_at: "2026-03-01T00:00:00Z" },
];

describe("GH#1524 /api/markets sort", () => {
  // Previously broken fields
  describe("sort=total_open_interest", () => {
    it("asc: 0, 0, 9M, 2T", () => {
      const result = applySort(MARKETS, "total_open_interest", "asc");
      const ois = result.map((m) => m.total_open_interest);
      expect(ois).toEqual([0, 0, 9_000_000, 2_000_000_000_000]);
    });

    it("desc: 2T, 9M, 0, 0", () => {
      const result = applySort(MARKETS, "total_open_interest", "desc");
      const ois = result.map((m) => m.total_open_interest);
      expect(ois).toEqual([2_000_000_000_000, 9_000_000, 0, 0]);
    });

    it("asc !== desc", () => {
      const asc = applySort(MARKETS, "total_open_interest", "asc");
      const desc = applySort(MARKETS, "total_open_interest", "desc");
      expect(asc.map((m) => m.symbol)).not.toEqual(desc.map((m) => m.symbol));
    });
  });

  describe("sort=mark_price", () => {
    it("asc: nulls last, then 1.5, 3.0, 50.0", () => {
      const result = applySort(MARKETS, "mark_price", "asc");
      const prices = result.map((m) => m.mark_price);
      // Non-null prices ascending, null last
      const nonNull = prices.filter((p) => p !== null);
      expect(nonNull).toEqual([1.5, 3.0, 50.0]);
      expect(prices[prices.length - 1]).toBeNull();
    });

    it("desc: nulls last, then 50.0, 3.0, 1.5", () => {
      const result = applySort(MARKETS, "mark_price", "desc");
      const prices = result.map((m) => m.mark_price);
      const nonNull = prices.filter((p) => p !== null);
      expect(nonNull).toEqual([50.0, 3.0, 1.5]);
      expect(prices[prices.length - 1]).toBeNull();
    });

    it("asc !== desc", () => {
      const asc = applySort(MARKETS, "mark_price", "asc");
      const desc = applySort(MARKETS, "mark_price", "desc");
      expect(asc.map((m) => m.symbol)).not.toEqual(desc.map((m) => m.symbol));
    });
  });

  describe("sort=created_at", () => {
    it("asc: oldest first", () => {
      const result = applySort(MARKETS, "created_at", "asc");
      const dates = result.map((m) => m.created_at);
      expect(dates[0]).toBe("2026-01-10T00:00:00Z");
      expect(dates[dates.length - 1]).toBe("2026-03-01T00:00:00Z");
    });

    it("desc: newest first", () => {
      const result = applySort(MARKETS, "created_at", "desc");
      const dates = result.map((m) => m.created_at);
      expect(dates[0]).toBe("2026-03-01T00:00:00Z");
      expect(dates[dates.length - 1]).toBe("2026-01-10T00:00:00Z");
    });

    it("asc !== desc", () => {
      const asc = applySort(MARKETS, "created_at", "asc");
      const desc = applySort(MARKETS, "created_at", "desc");
      expect(asc.map((m) => m.created_at)).not.toEqual(desc.map((m) => m.created_at));
    });
  });

  // Previously-supported fields (regression guard)
  describe("sort=symbol (was working)", () => {
    it("asc: alphabetical", () => {
      const result = applySort(MARKETS, "symbol", "asc");
      const syms = result.map((m) => m.symbol);
      expect(syms).toEqual(["2VqY", "B43W", "FWqf", "WENDYS"]);
    });

    it("desc: reverse alphabetical", () => {
      const result = applySort(MARKETS, "symbol", "desc");
      const syms = result.map((m) => m.symbol);
      expect(syms).toEqual(["WENDYS", "FWqf", "B43W", "2VqY"]);
    });
  });

  describe("unsupported sort field", () => {
    it("falls through to original order", () => {
      const original = MARKETS.map((m) => m.symbol);
      const result = applySort(MARKETS, "bogus_field", "desc");
      expect(result.map((m) => m.symbol)).toEqual(original);
    });
  });

  describe("null sort param", () => {
    it("returns original order unchanged", () => {
      const original = MARKETS.map((m) => m.symbol);
      const result = applySort(MARKETS, null, "asc");
      expect(result.map((m) => m.symbol)).toEqual(original);
    });
  });
});
