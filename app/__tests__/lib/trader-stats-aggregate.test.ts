/**
 * GH#2510 — `queryTraderStatsAggregate` maps a single aggregated DB row onto the
 * stats contract.
 *
 * The previous implementation fetched up to 10 000 rows and reduced them in
 * JavaScript, so any wallet past that cap had partial history returned under
 * names like `totalTrades`. Because the cap ordered by `created_at ASC` it kept
 * the OLDEST rows, which made `lastTradeAt` the 10 000th trade's timestamp
 * rather than the most recent one.
 *
 * These tests pin the mapping — the shape and types the route depends on, and
 * the zero-row case, which is the one most likely to regress into `NaN`/`null`
 * confusion since Postgres returns a row of nulls rather than no row.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSql = vi.hoisted(() => vi.fn());

vi.mock("postgres", () => ({ default: vi.fn(() => mockSql) }));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INDEXER_DATABASE_URL = "postgres://user:pass@localhost:5432/db";
});

async function load() {
  vi.resetModules();
  return import("@/lib/indexer-db");
}

describe("queryTraderStatsAggregate", () => {
  it("maps an aggregated row onto the stats contract", async () => {
    const first = new Date("2026-01-01T00:00:00.000Z");
    const last = new Date("2026-08-01T00:00:00.000Z");
    mockSql.mockResolvedValueOnce([
      {
        total_trades: "12345",
        long_trades: "7000",
        short_trades: "5345",
        total_volume: "123456789012345678",
        total_fees: "4242",
        unique_markets: "9",
        first_trade_at: first,
        last_trade_at: last,
      },
    ]);

    const { queryTraderStatsAggregate } = await load();
    const stats = await queryTraderStatsAggregate("WALLET");

    // Counts arrive as text (::text on bigint, so they survive > 2^53) and are
    // surfaced as numbers, matching the response contract.
    expect(stats.totalTrades).toBe(12345);
    expect(stats.longTrades).toBe(7000);
    expect(stats.shortTrades).toBe(5345);
    expect(stats.uniqueMarkets).toBe(9);

    // Money stays a string end-to-end — it must not round-trip through a float.
    //
    // The value is deliberately above Number.MAX_SAFE_INTEGER: a smaller one
    // survives Number() intact, so the assertion would pass even against an
    // implementation that parsed it as a float. Verified by mutating the
    // mapping to String(Number(...)) — with 987654321 the test still passed,
    // with this value it fails.
    expect(Number("123456789012345678") > Number.MAX_SAFE_INTEGER).toBe(true);
    expect(stats.totalVolume).toBe("123456789012345678");
    expect(stats.totalFees).toBe("4242");
    expect(typeof stats.totalVolume).toBe("string");

    // The whole point of GH#2510: lastTradeAt is max(created_at) over the full
    // history, not the timestamp of the 10 000th oldest trade.
    expect(stats.firstTradeAt).toBe(first.toISOString());
    expect(stats.lastTradeAt).toBe(last.toISOString());
  });

  it("returns zeros and nulls for a wallet with no trades", async () => {
    // Postgres returns ONE row of nulls for an aggregate over an empty set, not
    // zero rows — so COALESCE covers the sums and the date fields arrive null.
    mockSql.mockResolvedValueOnce([
      {
        total_trades: "0",
        long_trades: "0",
        short_trades: "0",
        total_volume: "0",
        total_fees: "0",
        unique_markets: "0",
        first_trade_at: null,
        last_trade_at: null,
      },
    ]);

    const { queryTraderStatsAggregate } = await load();
    const stats = await queryTraderStatsAggregate("WALLET");

    expect(stats.totalTrades).toBe(0);
    expect(stats.totalVolume).toBe("0");
    expect(stats.totalFees).toBe("0");
    expect(stats.firstTradeAt).toBeNull();
    expect(stats.lastTradeAt).toBeNull();
  });

  it("survives an empty result set without producing NaN", async () => {
    // Defensive: if the driver ever yields no row at all, the caller must still
    // get a well-formed response rather than NaN totals.
    mockSql.mockResolvedValueOnce([]);

    const { queryTraderStatsAggregate } = await load();
    const stats = await queryTraderStatsAggregate("WALLET");

    expect(stats.totalTrades).toBe(0);
    expect(Number.isNaN(stats.totalTrades)).toBe(false);
    expect(stats.totalVolume).toBe("0");
    expect(stats.lastTradeAt).toBeNull();
  });
});
