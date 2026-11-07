/**
 * E2E B21: /api/oracle/resolve must hand the quick-launch path a pool the keeper can price,
 * chosen by mainnet OWNER. DexScreener ranked WIF's Meteora DAMM v1 pool first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";

const cache = vi.hoisted(() => ({ set: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/bounded-ttl-cache", () => ({
  BoundedTtlCache: class {
    get(k: string) { return cache.get(k); }
    set(k: string, v: unknown) { cache.set(k, v); }
  },
}));
const owner = vi.hoisted(() => ({ classify: vi.fn() }));
vi.mock("@/lib/dex-pool-owner", async (orig) => ({
  ...(await orig<typeof import("@/lib/dex-pool-owner")>()),
  classifyPoolsByOwner: owner.classify,
}));

import { GET } from "@/app/api/oracle/resolve/[ca]/route";

const key = (i: number) => { const b = new Uint8Array(32); b[0] = 9; b[31] = i; return new PublicKey(b).toBase58(); };
const MINT = key(0);
const DAMM = key(1);
const DLMM = key(2);
const ctx = { params: Promise.resolve({ ca: MINT }) };
const req = () => new NextRequest(`http://localhost/api/oracle/resolve/${MINT}`);
const pairs = {
  pairs: [
    // DexScreener pairs carry the base token's mint; /api/oracle/resolve only prices `mint` from pairs where it is the
    // BASE (lib/dex-pair-side.ts, #3740). These fixtures predate that filter and lacked the address.
    { chainId: "solana", dexId: "meteora", pairAddress: DAMM, priceUsd: "1.5", liquidity: { usd: 9e6 }, baseToken: { symbol: "WIF", address: MINT } },
    { chainId: "solana", dexId: "meteora", pairAddress: DLMM, priceUsd: "1.5", liquidity: { usd: 1e6 }, baseToken: { symbol: "WIF", address: MINT } },
  ],
};

beforeEach(() => {
  cache.get.mockReturnValue(undefined);
  cache.set.mockReset();
  owner.classify.mockReset();
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    url.includes("dexscreener") ? new Response(JSON.stringify(pairs), { status: 200 }) : new Response("{}", { status: 404 })));
});
afterEach(() => vi.unstubAllGlobals());

describe("GET /api/oracle/resolve: pool by owner", () => {
  it("skips the more-liquid DAMM pool and returns the DLMM pool typed meteora-dlmm", async () => {
    owner.classify.mockResolvedValue({ [DAMM]: "unsupported", [DLMM]: "meteora-dlmm" });
    const r = await GET(req(), ctx);
    const j = await r.json();
    expect(owner.classify).toHaveBeenCalledWith([DAMM, DLMM]);
    expect(j.dexPoolAddress).toBe(DLMM);
    expect(j.dexType).toBe("meteora-dlmm");
    expect(j.oracleMode).toBe("hyperp");
  });
  it("only unsupported pools: no pool is offered", async () => {
    owner.classify.mockResolvedValue({ [DAMM]: "unsupported", [DLMM]: "unsupported" });
    const j = await (await GET(req(), { params: Promise.resolve({ ca: MINT }) })).json();
    expect(j.dexPoolAddress).toBeNull();
    expect(j.oracleMode).toBe("admin");
  });
  it("NEGATIVE CONTROL: a pool where the mint is only the QUOTE side is never offered or classified", async () => {
    const QUOTE_POOL = key(3);
    const OTHER = key(4);
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("dexscreener")
        ? new Response(JSON.stringify({ pairs: [{ chainId: "solana", dexId: "meteora", pairAddress: QUOTE_POOL, priceUsd: "0.004", liquidity: { usd: 5e7 }, baseToken: { symbol: "PUMP", address: OTHER }, quoteToken: { symbol: "WIF", address: MINT } }] }), { status: 200 })
        : new Response("{}", { status: 404 })));
    owner.classify.mockResolvedValue({ [QUOTE_POOL]: "meteora-dlmm" });
    const j = await (await GET(req(), { params: Promise.resolve({ ca: MINT }) })).json();
    expect(owner.classify).not.toHaveBeenCalledWith(expect.arrayContaining([QUOTE_POOL]));
    expect(j.dexPoolAddress ?? null).not.toBe(QUOTE_POOL);
    expect(j.price ?? null).not.toBe(0.004);
  });
  it("mainnet unreachable: 503, and the failure is NOT cached", async () => {
    owner.classify.mockResolvedValue(null);
    const r = await GET(req(), { params: Promise.resolve({ ca: MINT }) });
    expect(r.status).toBe(503);
    expect(cache.set).not.toHaveBeenCalled();
  });
});
