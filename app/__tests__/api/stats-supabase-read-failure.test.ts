/**
 * /api/stats Supabase path: a failed `markets_with_stats` read must answer with
 * the degraded zeroStats() (live: false), not 0 / $0 / $0 marked live: true.
 *
 * The earlier sources (markets API, on-chain discovery, indexer) are mocked to
 * yield nothing so the request reaches the Supabase path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

type Res = { data: unknown; error: { message: string } | null };

const mocks = vi.hoisted(() => ({ results: {} as Record<string, Res[]> }));

/** Minimal PostgREST builder: every filter chains, awaiting pops the next queued result for the table. */
function fakeClient() {
  return {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "or", "limit", "in", "gte", "order"]) q[m] = () => q;
      q.then = (ok: (r: Res) => unknown) => ok(mocks.results[table]?.shift() ?? { data: [], error: null });
      return q;
    },
  };
}

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/market-registry", () => ({ loadMergedMarketRows: async () => null, MARKET_SELECT_FIELDS: "" }));
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ network: "mainnet", rpcUrl: "", programId: "11111111111111111111111111111112" }),
}));
vi.mock("@/lib/indexer-db", () => ({ hasIndexerDb: () => false, queryStatsAggregate: vi.fn(), queryKnownSlabs: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ getServerNetwork: () => "devnet", getServiceClient: () => fakeClient() }));
vi.mock("@/lib/upstash-rate-limit", () => ({
  createUpstashRateLimiter: () => ({ check: async () => ({ allowed: true }) }),
}));

import { GET } from "@/app/api/stats/route";

async function callStats(): Promise<Record<string, unknown>> {
  const res = await GET(new NextRequest("http://localhost/api/stats"));
  return (await res.json()) as Record<string, unknown>;
}

const ROW = { slab_address: "3t67LQPdgiSqGvXsYff3Pzv2uHtM1zZ7f29HsnEzb6vJ", volume_24h: 0, trade_count_24h: 0, last_price: 1, decimals: 6, network: "devnet" };

describe("/api/stats Supabase path: a failed market read is not live data", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.results = {};
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("an unrecognised markets_with_stats error answers live: false", async () => {
    mocks.results.markets_with_stats = [{ data: null, error: { message: "canceling statement due to statement timeout" } }];
    const body = await callStats();
    expect(body.live).toBe(false);
    expect(body.totalMarkets).toBe(0);
  });

  it("Tier 3 (indexer_excluded and network columns both missing) answers live: false", async () => {
    mocks.results.markets_with_stats = [
      { data: null, error: { message: 'column "indexer_excluded" does not exist' } },
      { data: null, error: { message: 'column "network" does not exist' } },
    ];
    expect((await callStats()).live).toBe(false);
  });

  it("CONTROL: a successful read with no rows is still live (a real empty protocol)", async () => {
    mocks.results.markets_with_stats = [{ data: [], error: null }];
    expect((await callStats()).live).toBe(true);
  });

  it("CONTROL: a successful read with rows is live", async () => {
    mocks.results.markets_with_stats = [{ data: [ROW], error: null }];
    expect((await callStats()).live).toBe(true);
  });
});
