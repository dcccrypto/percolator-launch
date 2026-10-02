import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { NextRequest } from "next/server";
import { type PoolAccount, CARDS, METEORA, MM, PUMPSWAP, WSOL, USDC, meteoraPool, pumpswapPool } from "./pool-quote-gate-fixtures";

/**
 * Both places the create wizard gets its pool from (the pool picker and /api/oracle/resolve) must
 * not offer a pool quoted in a token that isn't WSOL/USDC/USDT. Pools are classified by the real
 * /api/dex/classify-pools + dex-pool-owner on mocked mainnet bytes; only the RPC and DexScreener
 * are faked. COLLECT's deepest pool is quoted in CARDS; its next one is quoted in SOL.
 */
const h = vi.hoisted(() => ({ accounts: new Map<string, PoolAccount>() }));

vi.mock("@solana/web3.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("@solana/web3.js")>();
  class Connection {
    async getMultipleAccountsInfo(keys: { toBase58(): string }[]) {
      return keys.map((k) => {
        const a = h.accounts.get(k.toBase58());
        return a ? { owner: new real.PublicKey(a.owner), data: Buffer.from(a.data) } : null;
      });
    }
  }
  return { ...real, Connection };
});

import { GET } from "@/app/api/oracle/resolve/[ca]/route";
import { POST as classifyPools } from "@/app/api/dex/classify-pools/route";
import { useDexPoolSearch } from "@/hooks/useDexPoolSearch";
import { NON_USD_QUOTE_REASON } from "@/lib/dex-constants";

const COLLECT = "nDZknLvfFRp5rgUHdzTrQsmSY5NKzoavqdLjSHVpump";
const SI = "DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP";
// Real pool addresses (any valid pubkeys work; the accounts below are synthetic).
const CARDS_POOL = "99C6TUp7WgTvnwQVVhAbD8HbxPdo5LJCXr7VFCvTmJf1";
const SOL_POOL = "9GD7vaaocPe8sQFriG4iMhLL6mWxmevTVnjpSbCHRBqc";
const SI_POOL = "9GkbbuLJzy5QNeVoNUfSYsqJkAsLCcSgimfkN2zzCMhG";

const pair = (pairAddress: string, dexId: string, base: string, quote: string, usd: number) => ({
  chainId: "solana",
  dexId,
  pairAddress,
  baseToken: { address: base, symbol: "TOKEN" },
  quoteToken: { address: quote, symbol: "Q" },
  liquidity: { usd },
  priceUsd: "0.0038",
});

function mockNetwork(pairs: unknown[]) {
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("dexscreener")) return new Response(JSON.stringify({ pairs }), { status: 200 });
    if (u.includes("/api/dex/classify-pools")) {
      return classifyPools(new NextRequest("http://localhost/api/dex/classify-pools", { method: "POST", headers: { "content-type": "application/json" }, body: init?.body as string }));
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

beforeEach(() => {
  h.accounts.clear();
  h.accounts.set(CARDS_POOL, { owner: PUMPSWAP, data: pumpswapPool(CARDS) });
  h.accounts.set(SOL_POOL, { owner: METEORA, data: meteoraPool(WSOL) });
  h.accounts.set(SI_POOL, { owner: METEORA, data: meteoraPool(MM) });
});
afterEach(() => vi.restoreAllMocks());

async function resolve(ca: string) {
  const res = await GET(new NextRequest(`http://localhost/api/oracle/resolve/${ca}`), { params: Promise.resolve({ ca }) });
  return (await res.json()) as { dexPoolAddress: string | null; dexType: string | null; oracleMode: string };
}

describe("/api/oracle/resolve picks a USD-priceable pool", () => {
  it("COLLECT resolves to its SOL-quoted Meteora pool, not the deeper CARDS pool", async () => {
    mockNetwork([pair(CARDS_POOL, "pumpswap", COLLECT, CARDS, 268_405), pair(SOL_POOL, "meteora", COLLECT, WSOL, 227_431)]);
    const r = await resolve(COLLECT);
    expect(r.dexPoolAddress).toBe(SOL_POOL);
    expect(r.dexType).toBe("meteora-dlmm");
  });

  it("SI (only pool 9Gkbbu..., quoted in MM) gets no pool", async () => {
    mockNetwork([pair(SI_POOL, "meteora", SI, MM, 1_900)]);
    const r = await resolve(SI);
    expect(r.dexPoolAddress).toBeNull();
    expect(r.oracleMode).toBe("admin");
  });
});

describe("useDexPoolSearch skips pools quoted in a non-USD token", () => {
  it("COLLECT: only the SOL-quoted pool is offered", async () => {
    mockNetwork([pair(CARDS_POOL, "pumpswap", COLLECT, CARDS, 268_405), pair(SOL_POOL, "meteora", COLLECT, WSOL, 227_431)]);
    const { result } = renderHook(() => useDexPoolSearch(COLLECT));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pools.map((p) => p.poolAddress)).toEqual([SOL_POOL]);
    expect(result.current.blockedReason).toBeNull();
  });

  it("SI: no pool is offered and the reason names the quote", async () => {
    mockNetwork([pair(SI_POOL, "meteora", SI, MM, 1_900)]);
    const { result } = renderHook(() => useDexPoolSearch(SI));
    await waitFor(() => expect(result.current.blockedReason).not.toBeNull());
    expect(result.current.pools).toEqual([]);
    expect(result.current.blockedReason).toBe(NON_USD_QUOTE_REASON);
  });

  it("a USDC-quoted pool is offered", async () => {
    h.accounts.set(SOL_POOL, { owner: METEORA, data: meteoraPool(USDC) });
    mockNetwork([pair(SOL_POOL, "meteora", COLLECT, USDC, 227_431)]);
    const { result } = renderHook(() => useDexPoolSearch(COLLECT));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pools.map((p) => p.poolAddress)).toEqual([SOL_POOL]);
  });
});
