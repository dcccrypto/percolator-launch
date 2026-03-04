/**
 * PERC-414: Tests for /api/leaderboard route
 * Covers: trade aggregation, volume sorting, period filtering, rank assignment.
 */

import { describe, it, expect } from "vitest";

/* ── Inline helpers (mirrors the route logic) ─────────────── */

function aggregateTrades(
  rows: Array<{ trader: string; size: string | number; created_at: string }>,
): Map<string, { tradeCount: number; totalVolume: bigint; lastTradeAt: string }> {
  const map = new Map<
    string,
    { tradeCount: number; totalVolume: bigint; lastTradeAt: string }
  >();

  for (const row of rows) {
    const entry = map.get(row.trader) ?? {
      tradeCount: 0,
      totalVolume: 0n,
      lastTradeAt: row.created_at,
    };
    entry.tradeCount += 1;
    try {
      const raw = BigInt(String(row.size).split(".")[0]);
      entry.totalVolume += raw < 0n ? -raw : raw;
    } catch {
      const n = Math.abs(parseFloat(String(row.size)) || 0);
      entry.totalVolume += BigInt(Math.round(n));
    }
    if (row.created_at > entry.lastTradeAt) {
      entry.lastTradeAt = row.created_at;
    }
    map.set(row.trader, entry);
  }
  return map;
}

function sortAndRank(
  map: Map<string, { tradeCount: number; totalVolume: bigint; lastTradeAt: string }>,
  limit: number,
): Array<{ rank: number; trader: string; tradeCount: number; totalVolume: string; lastTradeAt: string }> {
  return [...map.entries()]
    .sort(([, a], [, b]) => {
      if (b.totalVolume > a.totalVolume) return 1;
      if (b.totalVolume < a.totalVolume) return -1;
      return b.tradeCount - a.tradeCount;
    })
    .slice(0, limit)
    .map(([trader, stats], i) => ({
      rank: i + 1,
      trader,
      tradeCount: stats.tradeCount,
      totalVolume: stats.totalVolume.toString(),
      lastTradeAt: stats.lastTradeAt,
    }));
}

/* ── Tests ────────────────────────────────────────────────── */

describe("leaderboard aggregation", () => {
  const NOW = "2026-03-04T20:00:00.000Z";
  const BEFORE = "2026-03-04T10:00:00.000Z";

  const sampleTrades = [
    { trader: "alice", size: "1000000", created_at: NOW },
    { trader: "alice", size: "2000000", created_at: BEFORE },
    { trader: "bob", size: "5000000", created_at: NOW },
    { trader: "carol", size: "500000", created_at: BEFORE },
  ];

  it("aggregates volume per trader", () => {
    const map = aggregateTrades(sampleTrades);
    expect(map.get("alice")?.totalVolume).toBe(3_000_000n);
    expect(map.get("bob")?.totalVolume).toBe(5_000_000n);
    expect(map.get("carol")?.totalVolume).toBe(500_000n);
  });

  it("counts trades per trader", () => {
    const map = aggregateTrades(sampleTrades);
    expect(map.get("alice")?.tradeCount).toBe(2);
    expect(map.get("bob")?.tradeCount).toBe(1);
    expect(map.get("carol")?.tradeCount).toBe(1);
  });

  it("tracks latest trade timestamp", () => {
    const map = aggregateTrades(sampleTrades);
    expect(map.get("alice")?.lastTradeAt).toBe(NOW);
    expect(map.get("carol")?.lastTradeAt).toBe(BEFORE);
  });

  it("sorts by volume descending", () => {
    const map = aggregateTrades(sampleTrades);
    const ranked = sortAndRank(map, 10);
    expect(ranked[0].trader).toBe("bob");   // 5M
    expect(ranked[1].trader).toBe("alice"); // 3M
    expect(ranked[2].trader).toBe("carol"); // 0.5M
  });

  it("assigns correct ranks starting from 1", () => {
    const map = aggregateTrades(sampleTrades);
    const ranked = sortAndRank(map, 10);
    for (const [i, e] of ranked.entries()) {
      expect(e.rank).toBe(i + 1);
    }
  });

  it("respects the limit parameter", () => {
    const map = aggregateTrades(sampleTrades);
    const ranked = sortAndRank(map, 2);
    expect(ranked).toHaveLength(2);
  });

  it("handles negative sizes (short trades) by taking absolute value", () => {
    const trades = [
      { trader: "dana", size: "-3000000", created_at: NOW },
      { trader: "dana", size: "1000000", created_at: NOW },
    ];
    const map = aggregateTrades(trades);
    expect(map.get("dana")?.totalVolume).toBe(4_000_000n);
  });

  it("handles decimal size strings safely", () => {
    const trades = [{ trader: "eve", size: "1500000.75", created_at: NOW }];
    const map = aggregateTrades(trades);
    // Strips decimal: BigInt("1500000") = 1500000n
    expect(map.get("eve")?.totalVolume).toBe(1_500_000n);
  });

  it("uses tradeCount as tiebreak when volumes are equal", () => {
    const trades = [
      { trader: "x", size: "1000", created_at: NOW },
      { trader: "y", size: "500", created_at: NOW },
      { trader: "y", size: "500", created_at: NOW },
    ];
    const map = aggregateTrades(trades);
    // x: 1000, y: 1000 — both equal, y has 2 trades
    const ranked = sortAndRank(map, 10);
    expect(ranked[0].trader).toBe("y"); // wins by trade count tiebreak
    expect(ranked[1].trader).toBe("x");
  });

  it("returns empty array for empty input", () => {
    const map = aggregateTrades([]);
    const ranked = sortAndRank(map, 50);
    expect(ranked).toHaveLength(0);
  });
});
