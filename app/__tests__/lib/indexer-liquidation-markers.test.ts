// @vitest-environment node
/**
 * S17: the indexer writes a liquidation MARKER into `trades` for each liquidation, with
 * trader = the liquidated PORTFOLIO address and NULL side/size/price (percolator-indexer
 * db/v17_baseline.sql: markers "MUST be excluded ... WHERE is_liquidation = false"). The
 * leaderboard grouped them as traders: a marker-only group sums to NULL, Postgres sorts NULLs
 * first under DESC, so liquidated portfolio addresses took the top ranks at $0. /api/stats counted
 * them as unique traders and 24h trades. Every one of these aggregates now excludes markers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
const mockSql = vi.hoisted(() =>
  vi.fn((strings: TemplateStringsArray) => {
    calls.push(strings.join("?"));
    return Promise.resolve([]);
  }),
);
vi.mock("postgres", () => ({ default: vi.fn(() => mockSql) }));

beforeEach(() => {
  calls.length = 0;
  process.env.INDEXER_DATABASE_URL = "postgres://user:pass@localhost:5432/db";
});

async function load() {
  vi.resetModules();
  return import("@/lib/indexer-db");
}

describe("liquidation markers are excluded from trades aggregates", () => {
  it.each(["24h", "7d", "alltime"])("leaderboard (%s) excludes markers", async (period) => {
    const { queryLeaderboard } = await load();
    await queryLeaderboard(period, 50);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/AND is_liquidation IS NOT TRUE/);
    expect(calls[0]).toMatch(/network = \?/); // still network-scoped
  });

  it("the stats aggregate (unique traders, 24h trades) excludes markers", async () => {
    const { queryStatsAggregate } = await load();
    await queryStatsAggregate();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/WHERE network = \? AND is_liquidation IS NOT TRUE/);
  });
});
