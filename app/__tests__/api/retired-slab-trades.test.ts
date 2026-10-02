// @vitest-environment node
/**
 * GH#2795: after the 2026-10-01 relaunch /api/markets stopped listing markets owned by the
 * abandoned wrapper (#2714), but the leaderboard and a trader's history and stats still counted
 * fills on them. These tests run the real routes, the real lib/retired-slabs and the real
 * lib/indexer-db; only the edges are stubbed (Supabase client, RPC connection, postgres driver).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { NextRequest } from "next/server";

const WRAPPER = "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB";
const OLD_WRAPPER = "GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ";
const FRESH_SLAB = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const OLD_SLAB = "ENdXK8k6iiWCAx4Z9XfoKLg9oXsEbPL4hEtmEmUqozDZ";
const CLOSED_SLAB = "7h3wNxjzPo6pTfWQ7uiTjDSsprGEeMNh696efmYrpAX2";
const WALLET = "AXa339sRttD8mdHUyDdGbGQyZNQnR17fFKzg9P5Ui5ym";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  registry: [] as Row[],
  registryError: null as null | { message: string },
  owners: new Map<string, string | null>(),
  rpcFails: false,
  rpcCalls: [] as Array<{ keys: string[]; config: unknown }>,
  trades: [] as Row[],
  sqlCalls: [] as Array<{ text: string; values: unknown[] }>,
  sqlResult: [] as unknown[],
  hasIndexer: false,
}));

/**
 * Minimal PostgREST stand-in: applies eq / gte / not-in / range / limit to an in-memory table,
 * so the route's real filter calls decide what comes back.
 */
function table(name: string) {
  const preds: Array<(r: Row) => boolean> = [];
  let range: [number, number] | null = null;
  let cap: number | null = null;
  let wantCount = false;
  const q: Record<string, unknown> = {};
  q.select = (_cols: string, opts?: { count?: string }) => { wantCount = opts?.count === "exact"; return q; };
  q.eq = (c: string, v: unknown) => { preds.push((r) => r[c] === v); return q; };
  q.gte = (c: string, v: string) => { preds.push((r) => String(r[c]) >= v); return q; };
  q.order = () => q;
  q.not = (c: string, op: string, v: unknown) => {
    if (op === "is") preds.push((r) => r[c] !== null && r[c] !== undefined);
    else if (op === "in") {
      const set = new Set(String(v).replace(/^\(|\)$/g, "").split(","));
      preds.push((r) => !set.has(String(r[c])));
    } else throw new Error(`unsupported not.${op}`);
    return q;
  };
  q.range = (a: number, b: number) => { range = [a, b]; return q; };
  q.limit = (n: number) => { cap = n; return q; };
  q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
    if (name === "markets" && h.registryError) return Promise.resolve({ data: null, error: h.registryError }).then(res, rej);
    const src = name === "markets" ? h.registry : h.trades;
    const all = src.filter((r) => preds.every((p) => p(r)));
    let data = all;
    if (range) data = data.slice(range[0], range[1] + 1);
    if (cap !== null) data = data.slice(0, cap);
    return Promise.resolve({ data, error: null, count: wantCount ? all.length : null }).then(res, rej);
  };
  return q;
}
const client = { from: (name: string) => table(name) };

vi.mock("@/lib/supabase", () => ({
  getSupabase: () => client,
  getServiceClient: () => client,
  getServerNetwork: () => "devnet",
}));
vi.mock("@/lib/config", async (orig) => ({
  ...(await orig<object>()),
  getConfig: () => ({ network: "devnet", programId: WRAPPER }),
}));
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({
    getMultipleAccountsInfo: async (keys: PublicKey[], config: unknown) => {
      h.rpcCalls.push({ keys: keys.map((k) => k.toBase58()), config });
      if (h.rpcFails) throw new Error("429");
      return keys.map((k) => {
        const owner = h.owners.get(k.toBase58());
        return owner ? { owner: new PublicKey(owner), data: Buffer.alloc(0), lamports: 1, executable: false } : null;
      });
    },
  }),
}));
vi.mock("@/lib/indexer-db", async (orig) => ({
  ...(await orig<object>()),
  hasIndexerDb: () => h.hasIndexer,
}));
vi.mock("postgres", () => ({
  default: () => (strings: TemplateStringsArray, ...values: unknown[]) => {
    h.sqlCalls.push({ text: strings.join("$?"), values });
    return Promise.resolve(h.sqlResult);
  },
}));
vi.mock("@/lib/upstash-rate-limit", () => ({
  createUpstashRateLimiter: () => ({ check: async () => ({ allowed: true, remaining: 99 }) }),
}));

import { getRetiredSlabs, resetRetiredSlabCache } from "@/lib/retired-slabs";
import { GET as leaderboardGET } from "@/app/api/leaderboard/route";
import { GET as tradesGET } from "@/app/api/trader/[wallet]/trades/route";
import { GET as statsGET } from "@/app/api/trader/[wallet]/stats/route";

const trade = (slab: string, trader: string, size: string, created_at: string, i: number) => ({
  id: String(i), slab_address: slab, trader, side: "long", size, price: 1, fee: 0,
  tx_signature: `sig${i}`, created_at, network: "devnet",
});

beforeEach(() => {
  resetRetiredSlabCache();
  h.registry = [FRESH_SLAB, OLD_SLAB, CLOSED_SLAB].map((slab_address) => ({ slab_address, network: "devnet" }));
  h.registryError = null;
  h.owners = new Map([[FRESH_SLAB, WRAPPER], [OLD_SLAB, OLD_WRAPPER]]); // CLOSED_SLAB: no account
  h.rpcFails = false;
  h.rpcCalls = [];
  h.sqlCalls = [];
  h.sqlResult = [];
  h.hasIndexer = false;
  h.trades = [
    trade(FRESH_SLAB, WALLET, "1000000", "2026-10-01T03:00:00.000Z", 1),
    trade(OLD_SLAB, WALLET, "9000000", "2026-09-29T03:00:00.000Z", 2),
    trade(OLD_SLAB, "OLDonly1111111111111111111111111111111111111", "50000000", "2026-09-29T04:00:00.000Z", 3),
    trade(CLOSED_SLAB, WALLET, "2000000", "2026-09-29T05:00:00.000Z", 4),
  ];
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service");
  vi.stubEnv("INDEXER_DATABASE_URL", "postgres://u:p@localhost:5432/db");
});
afterEach(() => vi.unstubAllEnvs());

describe("getRetiredSlabs", () => {
  it("retires a registry slab owned by another program; keeps the current wrapper's and a missing account", async () => {
    expect(await getRetiredSlabs()).toEqual([OLD_SLAB]);
    // Owner only — a zero-length data slice, not whole slabs.
    expect(h.rpcCalls[0].config).toMatchObject({ dataSlice: { offset: 0, length: 0 } });
  });

  it("caches a complete answer", async () => {
    await getRetiredSlabs();
    await getRetiredSlabs();
    expect(h.rpcCalls).toHaveLength(1);
  });

  it("RPC failure: nothing is retired, and the partial answer is not cached", async () => {
    h.rpcFails = true;
    expect(await getRetiredSlabs()).toEqual([]);
    h.rpcFails = false;
    expect(await getRetiredSlabs()).toEqual([OLD_SLAB]);
  });

  it("registry failure: [] (no filter), never throws", async () => {
    h.registryError = { message: "connection refused" };
    expect(await getRetiredSlabs()).toEqual([]);
  });
});

describe("/api/leaderboard leaves out fills on retired markets", () => {
  it("Supabase path: a trader whose only fills are on a retired market is not ranked; volume excludes them", async () => {
    const res = await leaderboardGET(new Request("http://localhost/api/leaderboard?period=alltime"));
    const body = await res.json();
    expect(res.status).toBe(200);
    const byTrader = Object.fromEntries(body.leaderboard.map((e: { trader: string }) => [e.trader, e]));
    expect(Object.keys(byTrader)).toEqual([WALLET]);
    // FRESH (1e6) + CLOSED (2e6) at $1, not the 9e6 on OLD_SLAB.
    expect(byTrader[WALLET]).toMatchObject({ tradeCount: 2, totalVolume: 3 });
  });

  it("indexer path: the retired list reaches the SQL as a bound parameter", async () => {
    h.hasIndexer = true;
    await leaderboardGET(new Request("http://localhost/api/leaderboard?period=7d"));
    const call = h.sqlCalls.find((c) => c.text.includes("FROM trades"))!;
    expect(call.text).toContain("AND NOT (slab_address = ANY(");
    expect(call.values).toContainEqual([OLD_SLAB]);
  });
});

describe("/api/trader/:wallet/trades leaves out fills on retired markets", () => {
  const get = (qs = "") =>
    tradesGET(new NextRequest(`http://localhost/api/trader/${WALLET}/trades${qs}`), { params: Promise.resolve({ wallet: WALLET }) });

  it("Supabase path: rows and total exclude the retired market", async () => {
    const body = await (await get()).json();
    expect(body.trades.map((t: { slab_address: string }) => t.slab_address).sort()).toEqual([CLOSED_SLAB, FRESH_SLAB].sort());
    expect(body.total).toBe(2);
  });

  it("Supabase path: asking for a retired slab explicitly returns nothing", async () => {
    const body = await (await get(`?slab=${OLD_SLAB}`)).json();
    expect(body.trades).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("indexer path: both the count and the page carry the retired list", async () => {
    h.hasIndexer = true;
    h.sqlResult = [{ cnt: "0" }];
    await get();
    const tradeCalls = h.sqlCalls.filter((c) => c.text.includes("FROM trades"));
    expect(tradeCalls).toHaveLength(2);
    for (const c of tradeCalls) {
      expect(c.text).toContain("AND NOT (slab_address = ANY(");
      expect(c.values).toContainEqual([OLD_SLAB]);
    }
  });
});

describe("/api/trader/:wallet/stats leaves out fills on retired markets", () => {
  const get = () =>
    statsGET(new NextRequest(`http://localhost/api/trader/${WALLET}/stats`), { params: Promise.resolve({ wallet: WALLET }) });

  it("Supabase path: counts and markets exclude the retired market", async () => {
    const body = await (await get()).json();
    expect(body.totalTrades).toBe(2);
    expect(body.uniqueMarkets).toBe(2);
  });

  it("indexer path: the aggregate carries the retired list", async () => {
    h.hasIndexer = true;
    h.sqlResult = [{}];
    await get();
    const call = h.sqlCalls.find((c) => c.text.includes("FROM trades"))!;
    expect(call.text).toContain("AND NOT (slab_address = ANY(");
    expect(call.values).toContainEqual([OLD_SLAB]);
  });
});

describe("degraded: when the retired set is unknown the routes behave as before", () => {
  it("RPC down: the leaderboard still ranks every trader", async () => {
    h.rpcFails = true;
    const body = await (await leaderboardGET(new Request("http://localhost/api/leaderboard?period=alltime"))).json();
    expect(body.leaderboard).toHaveLength(2);
  });
});
