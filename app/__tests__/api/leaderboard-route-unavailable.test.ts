/**
 * GH#2709: a DB failure must not masquerade as an empty leaderboard. The route
 * returned 200 { leaderboard: [] } with public CDN cache headers, so the page
 * rendered "No trades this period" and its error UI could never fire.
 * With no data source configured at all (PLAYGROUND.md §6), empty stays 200.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  hasIndexer: false,
  queryLeaderboard: vi.fn(),
  getSupabase: vi.fn(),
}));

vi.mock("@/lib/indexer-db", () => ({
  hasIndexerDb: () => h.hasIndexer,
  queryLeaderboard: h.queryLeaderboard,
}));
vi.mock("@/lib/supabase", () => ({
  getSupabase: h.getSupabase,
  getServerNetwork: () => "devnet",
}));

import { GET } from "@/app/api/leaderboard/route";

/** Thenable stand-in for the Supabase query builder. */
function query(result: unknown) {
  const q: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "gte", "limit"]) q[m] = () => q;
  q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return q;
}

function supabaseEnv(on: boolean) {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", on ? "https://x.supabase.co" : "");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", on ? "anon" : "");
}

const PUBLIC_CACHE = "public, s-maxage=30, stale-while-revalidate=60";
const get = () => GET(new Request("http://localhost/api/leaderboard?period=7d"));

async function expectUnavailable(res: Response) {
  expect(res.status).toBe(503);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = await res.json();
  expect(body.unavailable).toBe(true);
  expect(body.leaderboard).toEqual([]);
  expect(body.period).toBe("7d");
}

describe("GET /api/leaderboard: DB failure is surfaced, not cached as empty (GH#2709)", () => {
  beforeEach(() => {
    h.hasIndexer = false;
    h.queryLeaderboard.mockReset();
    h.getSupabase.mockReset();
    supabaseEnv(true);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("503 + no-store when the configured Supabase client throws", async () => {
    h.getSupabase.mockImplementation(() => { throw new Error("createClient failed"); });
    await expectUnavailable(await get());
  });

  it("503 + no-store when the query returns an error", async () => {
    h.getSupabase.mockReturnValue(query({ data: null, error: { message: "connection refused" } }));
    await expectUnavailable(await get());
  });

  it("503 + no-store when the query rejects", async () => {
    h.getSupabase.mockReturnValue(query(Promise.reject(new TypeError("fetch failed"))));
    await expectUnavailable(await get());
  });

  it("503 + no-store when the indexer fails and Supabase is not configured", async () => {
    supabaseEnv(false);
    h.hasIndexer = true;
    h.queryLeaderboard.mockRejectedValue(new Error("ECONNREFUSED"));
    h.getSupabase.mockImplementation(() => { throw new Error("Supabase env vars not set"); });
    await expectUnavailable(await get());
  });

  it("no data source configured (local playground) stays 200 empty, Supabase never touched", async () => {
    supabaseEnv(false);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(PUBLIC_CACHE);
    const body = await res.json();
    expect(body.leaderboard).toEqual([]);
    expect(body.unavailable).toBeUndefined();
    expect(h.getSupabase).not.toHaveBeenCalled();
  });

  it("genuinely empty result stays 200 with the public cache header", async () => {
    h.getSupabase.mockReturnValue(query({ data: [], error: null }));
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(PUBLIC_CACHE);
    const body = await res.json();
    expect(body.leaderboard).toEqual([]);
    expect(body.unavailable).toBeUndefined();
  });

  it("indexer failure falling back to a healthy Supabase stays 200", async () => {
    h.hasIndexer = true;
    h.queryLeaderboard.mockRejectedValue(new Error("ECONNREFUSED"));
    h.getSupabase.mockReturnValue(query({
      data: [{ trader: "alice", size: "1000000", price: 10, created_at: "2026-09-01T00:00:00Z" }],
      error: null,
    }));
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).leaderboard[0]).toMatchObject({ trader: "alice", totalVolume: 10 });
  });
});
