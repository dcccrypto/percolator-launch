import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { NextRequest } from "next/server";
import { Keypair } from "@solana/web3.js";
import {
  type PoolAccount, METEORA, RAYDIUM, SOL_REF_POOL, USDC, WSOL,
  meteoraPool, pumpswapWithDepth, solRefPool, tokenAccount,
} from "./pool-quote-gate-fixtures";

/**
 * Liquidity-floor gate (2026-10-02: BOME on PumpSwap pool GmoZsr3G..., ~$1.64 deep; the keeper
 * refuses to price a pool under MIN_POOL_LIQUIDITY_USD, default $1,000). Real classifyPoolsByOwner,
 * /api/dex/classify-pools, /api/oracle/resolve and useDexPoolSearch over mocked mainnet bytes.
 * Only the RPC and DexScreener are faked.
 */
const h = vi.hoisted(() => ({ accounts: new Map<string, PoolAccount>(), calls: 0, failFrom: Infinity }));

vi.mock("@solana/web3.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("@solana/web3.js")>();
  class Connection {
    async getMultipleAccountsInfo(keys: { toBase58(): string }[]) {
      h.calls++;
      if (h.calls >= h.failFrom) throw new Error("rpc down");
      return keys.map((k) => {
        const a = h.accounts.get(k.toBase58());
        return a ? { owner: new real.PublicKey(a.owner), data: Buffer.from(a.data) } : null;
      });
    }
  }
  return { ...real, Connection };
});

import { classifyPoolsByOwner } from "@/lib/dex-pool-owner";
import { isBelowFloor, minPoolLiquidityUsdE6, parseUsdToE6, pumpswapQuoteDepthUsdE6 } from "@/lib/pool-liquidity";
import { GET } from "@/app/api/oracle/resolve/[ca]/route";
import { POST as classifyPools } from "@/app/api/dex/classify-pools/route";
import { useDexPoolSearch } from "@/hooks/useDexPoolSearch";
import { BELOW_LIQUIDITY_FLOOR_REASON } from "@/lib/dex-constants";

const pk = () => Keypair.generate().publicKey.toBase58();
const put = (entries: Array<[string, PoolAccount]>) => entries.forEach(([k, v]) => h.accounts.set(k, v));

beforeEach(() => {
  h.accounts.clear();
  h.calls = 0;
  h.failFrom = Infinity;
  put([[SOL_REF_POOL, { owner: RAYDIUM, data: solRefPool(100) }]]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("pumpswapQuoteDepthUsdE6 (parity with the keeper's)", () => {
  it("USD quote 1:1, WSOL via SOL/USD, unknown is null, empty is 0", () => {
    expect(pumpswapQuoteDepthUsdE6(tokenAccount(1_500_000_000n), 6, false, undefined)).toBe(1_500_000_000n);
    expect(pumpswapQuoteDepthUsdE6(tokenAccount(10_000_000_000n), 9, true, 200_000_000n)).toBe(2_000_000_000n);
    expect(pumpswapQuoteDepthUsdE6(tokenAccount(10_000_000_000n), 9, true, undefined)).toBeNull();
    expect(pumpswapQuoteDepthUsdE6(tokenAccount(1n).slice(0, 40), 6, false, undefined)).toBeNull();
    expect(pumpswapQuoteDepthUsdE6(tokenAccount(0n), 6, false, undefined)).toBe(0n);
  });
  it("floor parsing: default $1000, decimal USD, 0 disables, garbage falls back to the default", () => {
    expect(minPoolLiquidityUsdE6(undefined)).toBe(1_000_000_000n);
    expect(minPoolLiquidityUsdE6("2500.5")).toBe(2_500_500_000n);
    expect(minPoolLiquidityUsdE6("0")).toBe(0n);
    expect(minPoolLiquidityUsdE6("abc")).toBe(1_000_000_000n);
    expect(parseUsdToE6("1.234567891")).toBe(1_234_567n);
    expect(isBelowFloor(null, 1_000_000_000n)).toBe(true);
    expect(isBelowFloor(0n, 0n)).toBe(false);
  });
});

describe("classifyPoolsByOwner: the liquidity floor", () => {
  it("PumpSwap USDC-quoted: $1.64 is refused, $5,000 passes, exactly $1,000 passes", async () => {
    const [a, b, c] = [pk(), pk(), pk()];
    put(pumpswapWithDepth(a, USDC, 1_640_000n));
    put(pumpswapWithDepth(b, USDC, 5_000_000_000n));
    put(pumpswapWithDepth(c, USDC, 1_000_000_000n));
    const { Connection } = await import("@solana/web3.js");
    const r = await classifyPoolsByOwner([a, b, c], new Connection("http://x"));
    expect(r).toEqual({ [a]: "below-liquidity-floor", [b]: "pumpswap", [c]: "pumpswap" });
    expect(h.calls).toBe(2); // owner read + ONE batched vault/SOL-USD read
  });

  it("PumpSwap WSOL-quoted: depth is priced through the SOL/USD reference pool", async () => {
    const [thin, deep] = [pk(), pk()];
    put(pumpswapWithDepth(thin, WSOL, 5_000_000_000n)); // 5 SOL  @ $100 = $500
    put(pumpswapWithDepth(deep, WSOL, 20_000_000_000n)); // 20 SOL @ $100 = $2,000
    const { Connection } = await import("@solana/web3.js");
    const r = await classifyPoolsByOwner([thin, deep], new Connection("http://x"));
    expect(r).toEqual({ [thin]: "below-liquidity-floor", [deep]: "pumpswap" });
  });

  it("WSOL-quoted with no usable SOL/USD is refused (unknown depth is not 'fine')", async () => {
    h.accounts.delete(SOL_REF_POOL);
    const a = pk();
    put(pumpswapWithDepth(a, WSOL, 20_000_000_000n));
    const { Connection } = await import("@solana/web3.js");
    expect(await classifyPoolsByOwner([a], new Connection("http://x"))).toEqual({ [a]: "below-liquidity-floor" });
  });

  it("a missing quote vault is refused", async () => {
    const a = pk();
    const [[, pool], [qv]] = pumpswapWithDepth(a, USDC, 5_000_000_000n);
    h.accounts.set(a, pool);
    h.accounts.delete(qv);
    const { Connection } = await import("@solana/web3.js");
    expect(await classifyPoolsByOwner([a], new Connection("http://x"))).toEqual({ [a]: "below-liquidity-floor" });
  });

  it("Meteora DLMM is not depth-floored (the keeper has no DLMM depth) and costs no extra RPC", async () => {
    const m = pk();
    put([[m, { owner: METEORA, data: meteoraPool(USDC) }]]);
    const { Connection } = await import("@solana/web3.js");
    expect(await classifyPoolsByOwner([m], new Connection("http://x"))).toEqual({ [m]: "meteora-dlmm" });
    expect(h.calls).toBe(1);
  });

  it("fails CLOSED: an RPC failure on the depth read returns null (callers refuse), not a pass", async () => {
    const a = pk();
    put(pumpswapWithDepth(a, USDC, 5_000_000_000n));
    h.failFrom = 2;
    const { Connection } = await import("@solana/web3.js");
    expect(await classifyPoolsByOwner([a], new Connection("http://x"))).toBeNull();
  });

  it("MIN_POOL_LIQUIDITY_USD=0 disables the floor and the extra read", async () => {
    vi.stubEnv("MIN_POOL_LIQUIDITY_USD", "0");
    const a = pk();
    put(pumpswapWithDepth(a, USDC, 1_640_000n));
    const { Connection } = await import("@solana/web3.js");
    expect(await classifyPoolsByOwner([a], new Connection("http://x"))).toEqual({ [a]: "pumpswap" });
    expect(h.calls).toBe(1);
  });

   it("MIN_POOL_LIQUIDITY_USD tracks the keeper env: $1.64 is refused at $5 and admitted at $1", async () => {
    const a = pk();
    put(pumpswapWithDepth(a, USDC, 1_640_000n));
    const { Connection } = await import("@solana/web3.js");
    vi.stubEnv("MIN_POOL_LIQUIDITY_USD", "5");
    expect(await classifyPoolsByOwner([a], new Connection("http://x"))).toEqual({ [a]: "below-liquidity-floor" });
    vi.stubEnv("MIN_POOL_LIQUIDITY_USD", "1");
    expect(await classifyPoolsByOwner([a], new Connection("http://x"))).toEqual({ [a]: "pumpswap" });
  });
});

// ---- the wizard's surfaces, over the real handlers -------------------------------------------
const BOME = "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82";
const BOME_POOL = "GmoZsr3G4aV5B4Uk6zsTN2KbXGagV3JM2RkDCgszr8Ls";
const DEEP_POOL = "9GD7vaaocPe8sQFriG4iMhLL6mWxmevTVnjpSbCHRBqc";
const pair = (pairAddress: string, dexId: string, usd: number) => ({
  chainId: "solana", dexId, pairAddress,
  baseToken: { address: BOME, symbol: "BOME" }, quoteToken: { address: WSOL, symbol: "SOL" },
  liquidity: { usd }, priceUsd: "0.0006",
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
async function resolve(ca: string) {
  const res = await GET(new NextRequest(`http://localhost/api/oracle/resolve/${ca}`), { params: Promise.resolve({ ca }) });
  return (await res.json()) as { dexPoolAddress: string | null; dexType: string | null; oracleMode: string; poolBlockedReason?: string };
}

describe("wizard surfaces refuse a below-floor pool", () => {
  it("/api/dex/classify-pools returns the class", async () => {
    put(pumpswapWithDepth(BOME_POOL, WSOL, 16_400n)); // 0.0000164 SOL = $0.00164 ... depth << floor
    const res = await classifyPools(new NextRequest("http://localhost/api/dex/classify-pools", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ addresses: [BOME_POOL] }) }));
    expect(res.status).toBe(200);
    expect((await res.json()).classes[BOME_POOL]).toBe("below-liquidity-floor");
  });

  it("/api/classify-pools: 503 when the depth read fails (never an unverified pass)", async () => {
    put(pumpswapWithDepth(BOME_POOL, USDC, 5_000_000_000n));
    h.failFrom = 2;
    const res = await classifyPools(new NextRequest("http://localhost/api/dex/classify-pools", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ addresses: [BOME_POOL] }) }));
    expect(res.status).toBe(503);
  });

  it("/api/oracle/resolve skips the shallow pool for the deeper one", async () => {
    put(pumpswapWithDepth(BOME_POOL, USDC, 1_640_000n));
    put([[DEEP_POOL, { owner: METEORA, data: meteoraPool(USDC) }]]);
    mockNetwork([pair(BOME_POOL, "pumpswap", 1_000_000), pair(DEEP_POOL, "meteora", 500_000)]);
    const r = await resolve(BOME);
    expect(r.dexPoolAddress).toBe(DEEP_POOL);
    expect(r.dexType).toBe("meteora-dlmm");
  });

  it("/api/oracle/resolve: only a shallow pool -> no pool, with the reason", async () => {
    put(pumpswapWithDepth(BOME_POOL, USDC, 1_640_000n));
    mockNetwork([pair(BOME_POOL, "pumpswap", 1_000_000)]);
    const r = await resolve("7mqDbApo4K3Ft7jQnGeAPBTsRYKXcQV3dFfN8nQMDNN4");
    expect(r.dexPoolAddress).toBeNull();
    expect(r.oracleMode).toBe("admin");
    expect(r.poolBlockedReason).toMatch(/too shallow to price safely/);
  });

  it("useDexPoolSearch: the shallow pool is not offered and the reason says why", async () => {
    put(pumpswapWithDepth(BOME_POOL, USDC, 1_640_000n));
    mockNetwork([pair(BOME_POOL, "pumpswap", 1_000_000)]);
    const { result } = renderHook(() => useDexPoolSearch(BOME));
    await waitFor(() => expect(result.current.blockedReason).not.toBeNull());
    expect(result.current.pools).toEqual([]);
    expect(result.current.blockedReason).toBe(BELOW_LIQUIDITY_FLOOR_REASON);
  });

  it("useDexPoolSearch: a deep pool is still offered", async () => {
    put(pumpswapWithDepth(BOME_POOL, USDC, 50_000_000_000n));
    mockNetwork([pair(BOME_POOL, "pumpswap", 1_000_000)]);
    const { result } = renderHook(() => useDexPoolSearch(BOME));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pools.map((p) => p.poolAddress)).toEqual([BOME_POOL]);
    expect(result.current.blockedReason).toBeNull();
  });
});
