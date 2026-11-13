// @vitest-environment node
/**
 * GH#1555: sort=recent returns ascending order after first item (API regression)
 * GH#1556: ?q= param is completely ignored — returns all markets
 *
 * These tests verify the pure logic of the two fixes to /api/markets GET:
 *  1. "recent" sort alias maps to created_at DESC (newest first)
 *  2. ?q= is treated as an alias for ?search= (both must filter markets)
 */

import { describe, it, expect } from "vitest";

// ─── Helpers mirroring route.ts logic ────────────────────────────────────────

interface MarketRow {
  symbol: string;
  name?: string;
  created_at?: string | null;
  [key: string]: unknown;
}

/** Mirror of the effectiveSortParam/effectiveSortDir mapping in route.ts */
function resolveSortParams(
  sortParam: string | null,
  orderParam: string,
): { effectiveSortParam: string | null; effectiveSortDir: number } {
  const effectiveSortParam = sortParam === "recent" ? "created_at" : sortParam;
  const effectiveSortDir = sortParam === "recent" ? -1 : (orderParam === "desc" ? -1 : 1);
  return { effectiveSortParam, effectiveSortDir };
}

const SORTABLE_FIELDS = new Set([
  "symbol", "last_price", "mark_price", "index_price",
  "volume_24h", "volume_24h_usd", "total_open_interest",
  "total_open_interest_usd", "funding_rate", "created_at",
  "stats_updated_at", "trade_count_24h", "insurance_fund",
  "insurance_balance", "total_accounts",
]);

function applySort(markets: MarketRow[], sortParam: string | null, orderParam = "asc"): MarketRow[] {
  const { effectiveSortParam, effectiveSortDir } = resolveSortParams(sortParam, orderParam);
  if (!effectiveSortParam || !SORTABLE_FIELDS.has(effectiveSortParam)) return markets;
  return [...markets].sort((a, b) => {
    const av = a[effectiveSortParam] ?? null;
    const bv = b[effectiveSortParam] ?? null;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === "string" && typeof bv === "string") {
      return effectiveSortDir * av.localeCompare(bv);
    }
    return effectiveSortDir * ((av as number) - (bv as number));
  });
}

/** Mirror of the searchParam resolution in route.ts (search= wins over q=) */
function resolveSearchParam(
  search: string | null,
  q: string | null,
): string | null {
  return search ?? q ?? null;
}

function applySearch(markets: MarketRow[], searchParam: string | null): MarketRow[] {
  const trimmed = searchParam ? searchParam.trim() : null;
  if (!trimmed) return markets;
  const ql = trimmed.toLowerCase();
  return markets.filter((m) => {
    const sym = (m.symbol ?? "").toLowerCase();
    const name = ((m.name ?? "") as string).toLowerCase();
    return sym.includes(ql) || name.includes(ql);
  });
}

// ─── Test data ────────────────────────────────────────────────────────────────

const MARKETS: MarketRow[] = [
  { symbol: "WENDYS", name: "Wendy's Token",   created_at: "2026-03-14T02:55:35.000Z" },
  { symbol: "WAR2",   name: "WAR2 Market",      created_at: "2026-03-21T10:00:00.000Z" },
  { symbol: "ALPHA",  name: "Alpha Protocol",   created_at: "2026-02-01T00:00:00.000Z" },
  { symbol: "BETA",   name: "Beta Market",      created_at: "2026-02-13T19:49:22.000Z" },
  { symbol: "GAMMA",  name: "Gamma DAO",        created_at: "2026-02-13T19:49:20.000Z" },
  { symbol: "DELTA",  name: "Delta Exchange",   created_at: null },
  { symbol: "BTC",    name: "Bitcoin Perp",     created_at: "2026-01-01T00:00:00.000Z" },
  { symbol: "wBTC",   name: "Wrapped Bitcoin",  created_at: "2026-01-15T00:00:00.000Z" },
];

// ─── GH#1555: sort=recent ─────────────────────────────────────────────────────

describe("GH#1555 — sort=recent maps to created_at DESC", () => {
  it("maps 'recent' to created_at", () => {
    const { effectiveSortParam } = resolveSortParams("recent", "asc");
    expect(effectiveSortParam).toBe("created_at");
  });

  it("forces DESC direction regardless of order param", () => {
    expect(resolveSortParams("recent", "asc").effectiveSortDir).toBe(-1);
    expect(resolveSortParams("recent", "desc").effectiveSortDir).toBe(-1);
  });

  it("returns markets newest-first", () => {
    const sorted = applySort(MARKETS, "recent");
    const dates = sorted
      .filter((m) => m.created_at)
      .map((m) => m.created_at as string);
    // Each date must be >= the next (descending)
    for (let i = 0; i < dates.length - 1; i++) {
      expect(dates[i].localeCompare(dates[i + 1])).toBeGreaterThanOrEqual(0);
    }
  });

  it("WAR2 (2026-03-21) appears before WENDYS (2026-03-14)", () => {
    const sorted = applySort(MARKETS, "recent");
    const war2Idx = sorted.findIndex((m) => m.symbol === "WAR2");
    const wendysIdx = sorted.findIndex((m) => m.symbol === "WENDYS");
    expect(war2Idx).toBeLessThan(wendysIdx);
  });

  it("markets with null created_at appear last", () => {
    const sorted = applySort(MARKETS, "recent");
    const deltaIdx = sorted.findIndex((m) => m.symbol === "DELTA");
    expect(deltaIdx).toBe(sorted.length - 1);
  });

  it("ALPHA (2026-02-01) appears after BETA (2026-02-13)", () => {
    const sorted = applySort(MARKETS, "recent");
    const alphaIdx = sorted.findIndex((m) => m.symbol === "ALPHA");
    const betaIdx = sorted.findIndex((m) => m.symbol === "BETA");
    expect(betaIdx).toBeLessThan(alphaIdx);
  });

  it("sort=created_at&order=asc still works independently", () => {
    const sorted = applySort(MARKETS, "created_at", "asc");
    const datesWithData = sorted
      .filter((m) => m.created_at)
      .map((m) => m.created_at as string);
    for (let i = 0; i < datesWithData.length - 1; i++) {
      expect(datesWithData[i].localeCompare(datesWithData[i + 1])).toBeLessThanOrEqual(0);
    }
  });
});

// ─── GH#1556: ?q= search param alias ─────────────────────────────────────────

describe("GH#1556 — ?q= param is accepted as alias for ?search=", () => {
  it("resolves q= when search= is absent", () => {
    expect(resolveSearchParam(null, "WENDYS")).toBe("WENDYS");
  });

  it("resolves search= when both are present (search= wins)", () => {
    expect(resolveSearchParam("BTC", "WENDYS")).toBe("BTC");
  });

  it("returns null when both are absent", () => {
    expect(resolveSearchParam(null, null)).toBeNull();
  });

  it("q=WENDYS filters to 1 market", () => {
    const param = resolveSearchParam(null, "WENDYS");
    const result = applySearch(MARKETS, param);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("WENDYS");
  });

  it("q=BTC matches symbol case-insensitively (wBTC, BTC)", () => {
    const param = resolveSearchParam(null, "btc");
    const result = applySearch(MARKETS, param);
    const symbols = result.map((m) => m.symbol);
    expect(symbols).toContain("BTC");
    expect(symbols).toContain("wBTC");
    // Ensure exactly these two (WENDYS, ALPHA etc. are not returned)
    expect(result.length).toBe(2);
  });

  it("q=NONEXISTENT returns 0 results", () => {
    const param = resolveSearchParam(null, "NONEXISTENT");
    const result = applySearch(MARKETS, param);
    expect(result).toHaveLength(0);
  });

  it("q= empty string (after trim) returns all markets", () => {
    const param = resolveSearchParam(null, "  ");
    const result = applySearch(MARKETS, param);
    expect(result).toHaveLength(MARKETS.length);
  });

  it("search= still works when q= is absent", () => {
    const param = resolveSearchParam("ALPHA", null);
    const result = applySearch(MARKETS, param);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("ALPHA");
  });

  it("search= wins over q= — returns search= match, not q= match", () => {
    const param = resolveSearchParam("GAMMA", "WENDYS");
    const result = applySearch(MARKETS, param);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("GAMMA");
  });
});
