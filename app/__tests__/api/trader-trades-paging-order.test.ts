// @vitest-environment node
/**
 * created_at is not unique (legs of one batch tx, webhook rows), so `ORDER BY created_at DESC`
 * alone lets Postgres order ties differently per request, and offset paging can show a trade on
 * two pages or none. Both paths (Supabase fallback + indexer SQL) must order by (created_at, id).
 * The fake PostgREST returns ties in a different order on every request unless `id` is a tie-break.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const WALLET = "AXa339sRttD8mdHUyDdGbGQyZNQnR17fFKzg9P5Ui5ym";
const SLAB = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  trades: [] as Row[],
  req: 0,
  sqlTexts: [] as string[],
}));

function table() {
  const orders: Array<{ col: string; asc: boolean }> = [];
  let range: [number, number] = [0, 1e9];
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = () => q;
  q.not = () => q;
  q.order = (col: string, o: { ascending: boolean }) => { orders.push({ col, asc: o.ascending }); return q; };
  q.range = (a: number, b: number) => { range = [a, b]; return q; };
  q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
    h.req++;
    // Rows start in a request-dependent (rotated) physical order, like an unstable heap scan.
    const rot = h.req % h.trades.length;
    let rows = [...h.trades.slice(rot), ...h.trades.slice(0, rot)];
    rows = rows.sort((a, b) => {
      for (const { col, asc } of orders) {
        const x = String(a[col]), y = String(b[col]);
        if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
      }
      return 0; // tie: keeps the rotated physical order
    });
    return Promise.resolve({ data: rows.slice(range[0], range[1] + 1), error: null, count: h.trades.length }).then(res, rej);
  };
  return q;
}
const client = { from: () => table() };

vi.mock("@/lib/supabase", () => ({
  getServiceClient: () => client,
  getServerNetwork: () => "devnet",
}));
vi.mock("@/lib/retired-slabs", () => ({ getRetiredSlabs: async () => [] }));
vi.mock("@/lib/indexer-db", async (orig) => ({
  ...(await orig<object>()),
  hasIndexerDb: () => false,
}));
vi.mock("@/lib/upstash-rate-limit", () => ({
  createUpstashRateLimiter: () => ({ check: async () => ({ allowed: true, remaining: 99 }) }),
}));
vi.mock("postgres", () => ({
  default: () => (strings: TemplateStringsArray) => {
    h.sqlTexts.push(strings.join("$?"));
    return Promise.resolve([{ cnt: "0" }]);
  },
}));

import { GET } from "@/app/api/trader/[wallet]/trades/route";
import { queryTraderTradesPage } from "@/lib/indexer-db";

async function page(offset: number, limit: number): Promise<string[]> {
  const req = new NextRequest(`http://localhost/api/trader/${WALLET}/trades?limit=${limit}&offset=${offset}`);
  const res = await GET(req, { params: Promise.resolve({ wallet: WALLET }) });
  const body = await res.json();
  return body.trades.map((t: { id: string }) => t.id);
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service");
  vi.stubEnv("INDEXER_DATABASE_URL", "postgres://u:p@localhost:5432/db");
  h.req = 0;
  h.sqlTexts = [];
  // 6 legs of one batch tx share a timestamp, plus 2 distinct ones.
  h.trades = [
    ...[1, 2, 3, 4, 5, 6].map((i) => ({
      id: String(i), slab_address: SLAB, trader: WALLET, side: "long", size: "1", price: 1, fee: 0,
      tx_signature: "sig", created_at: "2026-11-01T00:00:00.000Z",
    })),
    { id: "7", slab_address: SLAB, trader: WALLET, side: "long", size: "1", price: 1, fee: 0, tx_signature: "s7", created_at: "2026-11-02T00:00:00.000Z" },
    { id: "8", slab_address: SLAB, trader: WALLET, side: "long", size: "1", price: 1, fee: 0, tx_signature: "s8", created_at: "2026-10-30T00:00:00.000Z" },
  ];
});

describe("trader trades paging order", () => {
  it("supabase path: pages 1 and 2 cover every id exactly once", async () => {
    const p1 = await page(0, 4);
    const p2 = await page(4, 4);
    const all = [...p1, ...p2];
    expect(new Set(all).size).toBe(all.length); // no duplicate
    expect([...all].sort()).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]); // none missing
  });

  it("indexer SQL orders by created_at DESC, id DESC in both the slab and no-slab queries", async () => {
    await queryTraderTradesPage(WALLET, 10, 0);
    await queryTraderTradesPage(WALLET, 10, 0, SLAB);
    const pageQueries = h.sqlTexts.filter((t) => /ORDER BY/.test(t));
    expect(pageQueries).toHaveLength(2);
    for (const t of pageQueries) expect(t).toMatch(/ORDER BY created_at DESC, id DESC/);
  });
});
