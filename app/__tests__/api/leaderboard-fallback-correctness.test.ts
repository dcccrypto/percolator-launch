// @vitest-environment node
/**
 * Supabase fallback of /api/leaderboard must agree with the indexer-DB path:
 *  - liquidation markers (is_liquidation = true, NULL size/price, portfolio address as trader) excluded
 *  - the read is paged, so PostgREST's max_rows cap (1000) never silently truncates it
 *  - unknown period / malformed limit -> 400
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  trades: [] as Array<Record<string, unknown>>,
  maxRows: 1000,
  calls: 0,
  missingLiq: false,
}));

function table() {
  const preds: Array<(r: Row) => boolean> = [];
  let range: [number, number] | null = null;
  let cap: number | null = null;
  let usesLiq = false;
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = (c: string, v: unknown) => { preds.push((r) => r[c] === v); return q; };
  q.gte = (c: string, v: string) => { preds.push((r) => String(r[c]) >= v); return q; };
  q.order = () => q;
  q.not = (c: string, op: string, v: unknown) => {
    if (op === "in") {
      const set = new Set(String(v).replace(/^\(|\)$/g, "").split(","));
      preds.push((r) => !set.has(String(r[c])));
    } else if (op === "is") {
      // not(is_liquidation, is, true) — treat NULL as "not true" like SQL IS NOT TRUE
      usesLiq = true;
      preds.push((r) => r[c] !== true);
    } else throw new Error(`unsupported not.${op}`);
    return q;
  };
  q.range = (a: number, b: number) => { range = [a, b]; return q; };
  q.limit = (n: number) => { cap = n; return q; };
  q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
    h.calls++;
    if (usesLiq && h.missingLiq) {
      return Promise.resolve({ data: null, error: { code: "42703", message: "column trades.is_liquidation does not exist" } }).then(res, rej);
    }
    let data = h.trades.filter((r) => preds.every((p) => p(r)));
    if (range) data = data.slice(range[0], range[1] + 1);
    if (cap !== null) data = data.slice(0, cap);
    data = data.slice(0, h.maxRows); // PostgREST max_rows
    return Promise.resolve({ data, error: null }).then(res, rej);
  };
  return q;
}

vi.mock("@/lib/supabase", () => ({
  getSupabase: () => ({ from: () => table() }),
  getServerNetwork: () => "devnet",
}));
vi.mock("@/lib/indexer-db", () => ({ hasIndexerDb: () => false, queryLeaderboard: vi.fn() }));
vi.mock("@/lib/retired-slabs", () => ({ getRetiredSlabs: async () => [] }));

import { GET } from "@/app/api/leaderboard/route";

const get = (qs = "") => GET(new Request(`http://localhost/api/leaderboard${qs}`));
const T = "2026-10-01T03:00:00.000Z";
const trade = (i: number, trader: string, size: string | null, price: number | null, is_liquidation: boolean | null = false) => ({
  id: String(i), slab_address: "slab", trader, size, price, created_at: T, network: "devnet", is_liquidation,
});

beforeEach(() => {
  h.trades = [];
  h.maxRows = 1000;
  h.calls = 0;
  h.missingLiq = false;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
});
afterEach(() => vi.unstubAllEnvs());

describe("fallback excludes liquidation markers", () => {
  it("marker rows (NULL size/price) do not rank or count", async () => {
    h.trades = [
      trade(1, "alice", "5000000", 2),
      trade(2, "PORTFOLIOaddr", null, null, true),
      trade(3, "PORTFOLIOaddr", null, null, true),
      trade(4, "bob", "1000000", 1, null),
    ];
    const body = await (await get("?period=alltime")).json();
    expect(body.leaderboard.map((e: { trader: string }) => e.trader)).toEqual(["alice", "bob"]);
    expect(body.leaderboard[0]).toMatchObject({ tradeCount: 1, totalVolume: 10 });
  });
});

describe("fallback tolerates a trades table without is_liquidation", () => {
  it("retries without the filter on a missing-column error and still skips NULL size/price rows", async () => {
    h.missingLiq = true;
    h.trades = [trade(1, "alice", "5000000", 2), trade(2, "PORTFOLIOaddr", null, null, null)];
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).leaderboard.map((e: { trader: string }) => e.trader)).toEqual(["alice"]);
  });
});

describe("fallback is not truncated by max_rows", () => {
  it("ranks across >1000 rows (2500 rows, top trader only in the tail)", async () => {
    h.trades = Array.from({ length: 2400 }, (_, i) => trade(i, `small${i % 50}`, "1000000", 1));
    for (let i = 0; i < 100; i++) h.trades.push(trade(5000 + i, "whale", "1000000000", 1));
    const body = await (await get("?limit=1")).json();
    expect(body.leaderboard[0]).toMatchObject({ trader: "whale", tradeCount: 100, totalVolume: 100_000 });
    const small = await (await get("?limit=200")).json();
    const total = small.leaderboard.reduce((s: number, e: { tradeCount: number }) => s + e.tradeCount, 0);
    expect(total).toBe(2500);
  });
});

describe("input validation", () => {
  it("unknown period -> 400, not echoed as alltime", async () => {
    const res = await get("?period=foo");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/period/i);
  });
  it("accepts 24h, 7d, alltime and default", async () => {
    for (const qs of ["?period=24h", "?period=7d", "?period=alltime", ""]) {
      expect((await get(qs)).status).toBe(200);
    }
  });
  it("malformed limit ('10abc') -> 400", async () => {
    expect((await get("?limit=10abc")).status).toBe(400);
    expect((await get("?limit=")).status).toBe(400);
  });
  it("numeric limit is still clamped to 1..200", async () => {
    h.trades = Array.from({ length: 300 }, (_, i) => trade(i, `t${i}`, "1000000", 1));
    expect((await (await get("?limit=9999")).json()).leaderboard).toHaveLength(200);
    expect((await (await get("?limit=0")).json()).leaderboard).toHaveLength(1);
  });
});
