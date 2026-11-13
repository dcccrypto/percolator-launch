// @vitest-environment node
/**
 * GH#1566: /api/markets sort=oi / sort=volume / sort=health return markets in random order.
 *
 * Root cause: "oi", "volume", and "health" are named SortKey aliases used by the frontend,
 * but the API's SORTABLE_FIELDS set did not include them. They fell through to no-sort,
 * returning DB insertion order. sort=recent had the same bug (fixed in PR#1557).
 *
 * Fix (GH#1566): NAMED_SORT_ALIASES map handles:
 *   - "oi"     → total_open_interest_usd DESC NULLS LAST
 *   - "volume" → volume_24h DESC
 *   - "health" → computeMarketHealthFromStats rank ASC (healthy=0, caution=1, warning=2, empty=3)
 *
 * GH#1582: sort=oi previously used total_open_interest (raw atoms), causing no-price markets
 * with large atom counts (e.g. 2.66T atoms, null USD OI) to rank above priced markets.
 * Fix: alias changed to total_open_interest_usd; null values sort last via existing null-last logic.
 *
 * This test validates the sort logic inline (same pattern as markets-sort.test.ts).
 */
import { describe, it, expect } from "vitest";
import { computeMarketHealthFromStats } from "@/lib/health";

// ---- Inline reproduction of the GH#1566 fix logic ----

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

const NAMED_SORT_ALIASES: Record<string, { field: string; dir: number } | "health"> = {
  recent: { field: "created_at", dir: -1 },
  oi: { field: "total_open_interest_usd", dir: -1 }, // GH#1582: was total_open_interest (raw atoms)
  volume: { field: "volume_24h", dir: -1 },
  health: "health",
};

const HEALTH_ORDER: Record<string, number> = { healthy: 0, caution: 1, warning: 2, empty: 3 };
const healthRank = (m: Record<string, unknown>): number => {
  const h = computeMarketHealthFromStats({
    total_open_interest: m.total_open_interest as number | null,
    open_interest_long: m.open_interest_long as number | null,
    open_interest_short: m.open_interest_short as number | null,
    insurance_balance: m.insurance_balance as number | null,
    insurance_fund: m.insurance_fund as number | null,
    c_tot: m.c_tot as number | null,
    vault_balance: m.vault_balance as number | null,
    total_accounts: m.total_accounts as number | null,
  });
  return HEALTH_ORDER[h.level] ?? 5;
};

function applySort(
  markets: Record<string, unknown>[],
  sortParam: string | null,
  orderParam = "asc",
): Record<string, unknown>[] {
  const sortDir = orderParam === "desc" ? -1 : 1;
  const namedAlias = sortParam ? NAMED_SORT_ALIASES[sortParam] : undefined;
  const effectiveSortParam =
    namedAlias && namedAlias !== "health"
      ? namedAlias.field
      : sortParam === "recent" ? "created_at" : sortParam;
  const effectiveSortDir =
    namedAlias && namedAlias !== "health"
      ? namedAlias.dir
      : sortParam === "recent" ? -1 : sortDir;

  if (namedAlias === "health") {
    return [...markets].sort((a, b) => sortDir * (healthRank(a) - healthRank(b)));
  }
  if (effectiveSortParam && SORTABLE_FIELDS.has(effectiveSortParam)) {
    return [...markets].sort((a, b) => {
      const av = a[effectiveSortParam] ?? null;
      const bv = b[effectiveSortParam] ?? null;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (typeof av === "string" && typeof bv === "string") return effectiveSortDir * av.localeCompare(bv);
      return effectiveSortDir * ((av as number) - (bv as number));
    });
  }
  return markets;
}

// ---- Fixtures ----

const MARKETS: Record<string, unknown>[] = [
  {
    symbol: "AAA",
    total_open_interest: 2_660_054_000_000, // highest raw atoms — but NO price → null USD OI
    total_open_interest_usd: null,           // GH#1582: no-price market; must rank LAST in sort=oi
    volume_24h: 1_000,
    vault_balance: 5_000_000,
    total_accounts: 3,
    c_tot: 100,
    insurance_balance: 100,
    open_interest_long: 1_330_027_000_000,
    open_interest_short: 1_330_027_000_000,
  },
  {
    symbol: "BBB",
    total_open_interest: 0,
    total_open_interest_usd: null,
    volume_24h: 999_999_999,  // highest volume
    vault_balance: 0,          // empty (zombie)
    total_accounts: 0,
    c_tot: 0,
    insurance_balance: 0,
    open_interest_long: 0,
    open_interest_short: 0,
  },
  {
    symbol: "CCC",
    total_open_interest: 9_000_000,
    total_open_interest_usd: 4_620,          // GH#1582: MOLTBOT-like priced market ($4,620 OI)
    volume_24h: 500,
    vault_balance: 5_000_000,
    total_accounts: 2,
    c_tot: 0,              // no capital → warning
    insurance_balance: 0,
    open_interest_long: 4_500_000,
    open_interest_short: 4_500_000,
  },
  {
    symbol: "DDD",
    total_open_interest: 54_000_000,
    total_open_interest_usd: 59_994,         // GH#1582: usdEkK5G-like market ($59,994 OI)
    volume_24h: 0,
    vault_balance: 5_000_000,
    total_accounts: 1,
    c_tot: 100,
    insurance_balance: 100,
    open_interest_long: 27_000_000,
    open_interest_short: 27_000_000,
  },
];

// ---- Tests ----

describe("GH#1566 / GH#1582 sort=oi", () => {
  it("GH#1582: sorts by total_open_interest_usd DESC — priced markets rank above no-price markets", () => {
    const result = applySort(MARKETS, "oi");
    const usdOis = result.map((m) => m.total_open_interest_usd);
    // DDD ($59,994 USD OI) must rank first — has the highest USD OI
    expect(result[0].symbol).toBe("DDD");
    expect(usdOis[0]).toBe(59_994);
    // CCC ($4,620 USD OI) must rank second
    expect(result[1].symbol).toBe("CCC");
    expect(usdOis[1]).toBe(4_620);
    // Null USD OI markets (AAA, BBB) must rank last (NULLS LAST)
    expect(usdOis[usdOis.length - 1]).toBeNull();
    expect(usdOis[usdOis.length - 2]).toBeNull();
  });

  it("GH#1582: no-price market with massive raw atom OI (2.66T) does NOT outrank priced markets", () => {
    const result = applySort(MARKETS, "oi");
    // AAA has the highest raw OI (2.66T atoms) but null USD OI — must NOT be first
    expect(result[0].symbol).not.toBe("AAA");
    // AAA must be in the null group at the end
    const aaaIndex = result.findIndex((m) => m.symbol === "AAA");
    const firstNullIndex = result.findIndex((m) => m.total_open_interest_usd === null);
    expect(aaaIndex).toBeGreaterThanOrEqual(firstNullIndex);
  });

  it("sort=oi result differs from DB order (regression guard)", () => {
    const original = MARKETS.map((m) => m.symbol);
    const sorted = applySort(MARKETS, "oi").map((m) => m.symbol);
    expect(sorted).not.toEqual(original);
  });

  it("sort=oi is always DESC regardless of ?order= param", () => {
    const asc = applySort(MARKETS, "oi", "asc");
    const desc = applySort(MARKETS, "oi", "desc");
    // Named alias forces DESC; ?order= param ignored for named aliases
    expect(asc.map((m) => m.total_open_interest_usd)).toEqual(desc.map((m) => m.total_open_interest_usd));
    // Highest USD OI market must be first
    expect(asc[0].total_open_interest_usd).toBe(59_994);
  });
});

describe("GH#1566 sort=volume", () => {
  it("sorts by volume_24h DESC (highest volume first)", () => {
    const result = applySort(MARKETS, "volume");
    const vols = result.map((m) => m.volume_24h);
    expect(vols[0]).toBe(999_999_999);
    expect(vols[1]).toBe(1_000);
    expect(vols[2]).toBe(500);
    expect(vols[3]).toBe(0);
  });

  it("sort=volume result differs from DB order (regression guard)", () => {
    const original = MARKETS.map((m) => m.symbol);
    const sorted = applySort(MARKETS, "volume").map((m) => m.symbol);
    expect(sorted).not.toEqual(original);
  });
});

describe("GH#1566 sort=health", () => {
  it("sorts by health level ascending: healthy < caution < warning < empty", () => {
    const result = applySort(MARKETS, "health");
    const levels = result.map((m) => {
      const h = computeMarketHealthFromStats({
        total_open_interest: m.total_open_interest as number | null,
        open_interest_long: m.open_interest_long as number | null,
        open_interest_short: m.open_interest_short as number | null,
        insurance_balance: m.insurance_balance as number | null,
        c_tot: m.c_tot as number | null,
        vault_balance: m.vault_balance as number | null,
        total_accounts: m.total_accounts as number | null,
      });
      return h.level;
    });
    // DDD: oi=0, capital>0 → healthy; AAA: oi>0, capital>0 → healthy
    // CCC: oi>0, capital=0 → warning; BBB: all 0 → empty
    const rankOrdered = levels.map((l) => HEALTH_ORDER[l] ?? 5);
    for (let i = 0; i < rankOrdered.length - 1; i++) {
      expect(rankOrdered[i]).toBeLessThanOrEqual(rankOrdered[i + 1]);
    }
  });

  it("sort=health DESC reverses order (worst health first)", () => {
    const asc = applySort(MARKETS, "health", "asc");
    const desc = applySort(MARKETS, "health", "desc");
    expect(asc.map((m) => m.symbol)).not.toEqual(desc.map((m) => m.symbol));
    // Last in asc == first in desc
    const ascSymbols = asc.map((m) => m.symbol);
    const descSymbols = desc.map((m) => m.symbol);
    expect(descSymbols[0]).toBe(ascSymbols[ascSymbols.length - 1]);
  });
});

describe("GH#1566 sort=recent (regression guard — was fixed in PR#1557)", () => {
  const DATED = [
    { symbol: "OLD", total_open_interest: 0, volume_24h: 0, vault_balance: 0, total_accounts: 0, c_tot: 0, insurance_balance: 0, created_at: "2026-01-01T00:00:00Z" },
    { symbol: "MID", total_open_interest: 0, volume_24h: 0, vault_balance: 0, total_accounts: 0, c_tot: 0, insurance_balance: 0, created_at: "2026-02-15T00:00:00Z" },
    { symbol: "NEW", total_open_interest: 0, volume_24h: 0, vault_balance: 0, total_accounts: 0, c_tot: 0, insurance_balance: 0, created_at: "2026-03-22T00:00:00Z" },
  ] as Record<string, unknown>[];

  it("sort=recent still returns newest-first", () => {
    const result = applySort(DATED, "recent");
    expect(result[0].symbol).toBe("NEW");
    expect(result[result.length - 1].symbol).toBe("OLD");
  });
});

describe("GH#1566 bogus sort param (no regression)", () => {
  it("unknown sort param returns original order unchanged", () => {
    const original = MARKETS.map((m) => m.symbol);
    const result = applySort(MARKETS, "bogus_field");
    expect(result.map((m) => m.symbol)).toEqual(original);
  });

  it("null sort param returns original order unchanged", () => {
    const original = MARKETS.map((m) => m.symbol);
    const result = applySort(MARKETS, null);
    expect(result.map((m) => m.symbol)).toEqual(original);
  });
});
