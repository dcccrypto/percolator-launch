// @vitest-environment node
/**
 * 2026-10-01 SI mismatch: SI (8WC8…) is registered on pool 21bzHy… (the keeper prices it from
 * there), but the chart used GeckoTerminal's top pool for the mint (7Nj7m…) and resolve used
 * DexScreener's most liquid pair. For a registered market both must use the REGISTERED pool.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const SLAB = "8WC8vALsDJhNCUVRmqZBDSg5xgFAhDrgy7zWqF512pDx";
const MINT = "9aqmJjCnnMQv42TXLk921ceUkN35nea2QP969n1caqjj";
const REGISTERED = "21bzHy2kRoVKgtYZ8hFoetki2134MG2jyWGC49UV5pyi";
const BEST = "7Nj7mBE7oGPRWCEoUzfbNVPgq12w3V5egHkfd4nvGkr6";

const h = vi.hoisted(() => ({
  row: null as null | { slab_address: string; dex_pool_address: string; mainnet_ca: string },
  /** Next N queries return supabase-js's {data:null, error} shape (it does not throw). */
  failNext: 0,
  calls: 0,
}));

vi.mock("@/lib/supabase", () => {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  Object.assign(q, {
    select: chain, eq: chain, order: chain, abortSignal: chain,
    maybeSingle: async () => {
      h.calls += 1;
      if (h.failNext > 0) { h.failNext -= 1; return { data: null, error: { message: "timeout" } }; }
      return { data: h.row, error: null };
    },
    limit: async () => {
      h.calls += 1;
      if (h.failNext > 0) { h.failNext -= 1; return { data: null, error: { message: "timeout" } }; }
      return { data: h.row ? [h.row] : [], error: null };
    },
  });
  return { getServerNetwork: () => "devnet", getServiceClient: () => ({ from: () => q }) };
});
vi.mock("@/lib/playground-registered-markets", () => ({
  readRegisteredMarkets: async () => [{ slabAddress: SLAB, dexType: "meteora-dlmm" }],
}));
vi.mock("@/lib/dex-pool-owner", () => ({
  classifyPoolsByOwner: async (pools: string[]) => Object.fromEntries(pools.map((p) => [p, "meteora-dlmm"])),
  isOfferable: () => true,
  MAX_CLASSIFY_POOLS: 5,
}));
vi.mock("@/lib/jupiter-price", () => ({ fetchJupiterUsdPrice: async () => 0.0045 }));
vi.mock("@/lib/gecko-fetch", () => ({
  getGeckoConfig: () => ({ base: "https://gt" }),
  geckoFetch: async (url: string) => {
    if (url.includes("/tokens/")) {
      return new Response(JSON.stringify({ data: { relationships: { top_pools: { data: [{ id: `solana_${BEST}` }] } } }, included: [] }), { status: 200 });
    }
    const pool = url.split("/pools/")[1]?.split("/")[0];
    return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: [[1790000000, 1, 1, 1, 1, 1]] } }, meta: { pool } }), { status: 200 });
  },
}));

import { GET as chartGET } from "@/app/api/chart/[mint]/route";
import { GET as resolveGET } from "@/app/api/oracle/resolve/[ca]/route";
import { __clearRegisteredPoolCache, registeredPoolForSlab, registeredPoolForMint } from "@/lib/registered-pool";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  __clearRegisteredPoolCache();
  h.row = { slab_address: SLAB, dex_pool_address: REGISTERED, mainnet_ca: MINT };
  h.failNext = 0;
  h.calls = 0;
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ pairs: [
      { chainId: "solana", dexId: "meteora", pairAddress: BEST, priceUsd: "0.0050", liquidity: { usd: 900_000 }, baseToken: { symbol: "SI" } },
      { chainId: "solana", dexId: "meteora", pairAddress: REGISTERED, priceUsd: "0.0045", liquidity: { usd: 100_000 }, baseToken: { symbol: "SI" } },
    ] }), { status: 200 }),
  ) as typeof fetch;
});

const chart = async (qs: string) =>
  (await (await chartGET(new NextRequest(`http://x/api/chart/${MINT}?timeframe=hour&limit=5${qs}`), { params: Promise.resolve({ mint: MINT }) })).json()) as { poolAddress: string | null };

describe("registered market => registered pool", () => {
  it("chart for the market (slab given) uses the registered pool, not GeckoTerminal's top pool", async () => {
    expect((await chart(`&slab=${SLAB}`)).poolAddress).toBe(REGISTERED);
  });
  it("negative control: without a slab (no market context) the top pool is still used", async () => {
    expect((await chart("")).poolAddress).toBe(BEST);
  });
  it("a slab cannot vouch for another token's pool", async () => {
    h.row = { slab_address: SLAB, dex_pool_address: REGISTERED, mainnet_ca: "So11111111111111111111111111111111111111112" };
    expect((await chart(`&slab=${SLAB}`)).poolAddress).toBe(BEST);
  });
  it("resolve returns the registered pool and its price, not the most liquid pair", async () => {
    const r = (await (await resolveGET(new NextRequest(`http://x/api/oracle/resolve/${MINT}`), { params: Promise.resolve({ ca: MINT }) })).json()) as { dexPoolAddress: string; dexType: string; price: number };
    expect(r.dexPoolAddress).toBe(REGISTERED);
    expect(r.dexType).toBe("meteora-dlmm");
    expect(r.price).toBe(0.0045);
  });

  it("REVIEW #2735: a DB error is NOT cached as 'unregistered' (supabase-js returns errors)", async () => {
    h.failNext = 1;
    await expect(registeredPoolForSlab(SLAB, MINT)).rejects.toThrow(/lookup failed/);
    expect((await registeredPoolForSlab(SLAB, MINT))?.pool).toBe(REGISTERED);
    h.failNext = 1;
    await expect(registeredPoolForMint(MINT)).rejects.toThrow(/lookup failed/);
    expect((await registeredPoolForMint(MINT))?.pool).toBe(REGISTERED);
  });
  it("REVIEW #2735: chart with a slab answers 503 no-store on a failed lookup, never the top pool", async () => {
    h.failNext = 1;
    const res = await chartGET(new NextRequest(`http://x/api/chart/${MINT}?timeframe=hour&limit=5&slab=${SLAB}`), { params: Promise.resolve({ mint: MINT }) });
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(((await res.json()) as { poolAddress: string | null }).poolAddress).toBeNull();
  });

  it("REVIEW #2735: no Supabase configured = 'not registered' (top-pool chart, cacheable), not a failure", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    h.failNext = 5;
    expect(await registeredPoolForSlab(SLAB, MINT)).toBeNull();
    expect(await registeredPoolForMint(MINT)).toBeNull();
    expect(h.calls).toBe(0);
    expect((await chart(`&slab=${SLAB}`)).poolAddress).toBe(BEST);
  });
});
