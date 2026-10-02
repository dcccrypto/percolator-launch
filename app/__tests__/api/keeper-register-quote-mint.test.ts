// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { type PoolAccount, CARDS, METEORA, MM, PUMPSWAP, RAYDIUM, SOL_REF_POOL, USDC, USDT, WSOL, meteoraPool, pumpswapPool, solRefPool } from "../lib/pool-quote-gate-fixtures";

/**
 * keeper-register (the server-side write that makes the keeper price a market) must refuse a
 * PumpSwap / Meteora pool quoted in a token the keeper can't turn into USD, from the pool bytes
 * the owner classification already reads, and write nothing. WSOL/USDC/USDT-quoted pools pass.
 * Runs the admin path with the REAL classifyPoolsByOwner; only the mainnet read is mocked.
 */
const h = vi.hoisted(() => ({ pool: null as PoolAccount | null, extra: new Map<string, PoolAccount>(), rowWrites: 0, blobWrites: 0 }));

process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
process.env.ADMIN_API_SECRET = "quote-mint-test-secret";

vi.mock("@solana/web3.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("@solana/web3.js")>();
  class Connection {
    async getMultipleAccountsInfo(keys: unknown[]) {
      // keys[0] is the pool; a later read (liquidity floor) asks for vaults / the SOL-USD reference pool.
      return keys.map((k: { toBase58(): string }, i: number) => {
        const a = i === 0 && !h.extra.has(k.toBase58()) ? h.pool : h.extra.get(k.toBase58());
        return a ? { owner: new real.PublicKey(a.owner), data: Buffer.from(a.data) } : null;
      });
    }
  }
  return { ...real, Connection };
});
vi.mock("@/lib/market-registration", () => ({
  upsertRegisteredMarketRow: vi.fn(async () => {
    h.rowWrites++;
    return { ok: true, action: "inserted", keeperActive: true };
  }),
}));
vi.mock("@/lib/playground-registered-markets", () => ({
  upsertRegisteredMarket: vi.fn(async () => {
    h.blobWrites++;
  }),
}));
vi.mock("@/lib/token-logo", () => ({ resolveTokenLogo: async () => null }));
vi.mock("@/lib/supabase", () => ({ getServerNetwork: () => "devnet", getServiceClient: () => ({}) }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

const { POST } = await import("@/app/api/playground/keeper-register/route");
const { Keypair, PublicKey } = await import("@solana/web3.js");

async function register(owner: string, data: Uint8Array, quoteRawOverride?: bigint) {
  h.pool = { owner, data };
  h.extra.clear();
  // A healthy PumpSwap pool must clear the liquidity floor: give its quote vault $50k + a SOL/USD ref.
  if (owner === PUMPSWAP && data.length === 301) {
    const quote = new PublicKey(data.slice(75, 107)).toBase58();
    const qv = new PublicKey(data.slice(171, 203)).toBase58();
    const raw = quoteRawOverride ?? (quote === WSOL ? 500_000_000_000n : 50_000_000_000n); // 500 SOL @ $100 / 50,000 USDC
    h.extra.set(qv, { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: Buffer.concat([Buffer.alloc(64), Buffer.from(new BigUint64Array([raw]).buffer), Buffer.alloc(93)]) });
    h.extra.set(SOL_REF_POOL, { owner: RAYDIUM, data: solRefPool(100) });
  }
  const res = await POST(
    new NextRequest("http://localhost/api/playground/keeper-register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-secret": "quote-mint-test-secret" },
      body: JSON.stringify({
        slabAddress: Keypair.generate().publicKey.toBase58(),
        dexPoolAddress: Keypair.generate().publicKey.toBase58(),
        dexType: "pumpswap",
        symbol: "TEST",
        deployer: Keypair.generate().publicKey.toBase58(),
      }),
    }),
  );
  return { status: res.status, body: (await res.json()) as { error?: string } };
}

beforeEach(() => {
  h.rowWrites = 0;
  h.blobWrites = 0;
});

describe("keeper-register refuses pools the keeper can't price in USD", () => {
  it.each([
    ["PumpSwap / MM (the SI incident shape)", PUMPSWAP, pumpswapPool, MM],
    ["PumpSwap / CARDS", PUMPSWAP, pumpswapPool, CARDS],
    ["Meteora DLMM / MM (pool 9Gkbbu... shape)", METEORA, meteoraPool, MM],
    ["Meteora DLMM / CARDS", METEORA, meteoraPool, CARDS],
  ])("%s: 400, nothing written", async (_n, owner, build, quote) => {
    const { status, body } = await register(owner, build(quote));
    expect(status).toBe(400);
    expect(body.error).toMatch(/quoted in another token/);
    expect(h.rowWrites).toBe(0);
    expect(h.blobWrites).toBe(0);
  });

  it.each([
    ["PumpSwap / WSOL", PUMPSWAP, pumpswapPool, WSOL],
    ["PumpSwap / USDC", PUMPSWAP, pumpswapPool, USDC],
    ["PumpSwap / USDT", PUMPSWAP, pumpswapPool, USDT],
    ["Meteora DLMM / WSOL", METEORA, meteoraPool, WSOL],
    ["Meteora DLMM / USDC", METEORA, meteoraPool, USDC],
    ["Meteora DLMM / USDT", METEORA, meteoraPool, USDT],
  ])("%s pool is registered", async (_n, owner, build, quote) => {
    const { status } = await register(owner, build(quote));
    expect(status).toBe(200);
    expect(h.rowWrites).toBe(1);
    expect(h.blobWrites).toBe(1);
  });

  it.each([
    ["USDC-quoted, $1.64 deep (the BOME shape)", USDC, 1_640_000n],
    ["WSOL-quoted, 0.01 SOL (= $1)", WSOL, 10_000_000n],
    ["USDC-quoted, $999.99 (just under the $1,000 floor)", USDC, 999_990_000n],
    ["empty quote vault", USDC, 0n],
  ])("PumpSwap %s: 400 below-the-liquidity-floor, nothing written", async (_n, quote, raw) => {
    const { status, body } = await register(PUMPSWAP, pumpswapPool(quote), raw);
    expect(status).toBe(400);
    expect(body.error).toMatch(/too shallow to price safely/);
    expect(h.rowWrites).toBe(0);
    expect(h.blobWrites).toBe(0);
  });

  it("PumpSwap at exactly the $1,000 floor is registered; Meteora DLMM is not depth-floored (the keeper has no DLMM depth)", async () => {
    expect((await register(PUMPSWAP, pumpswapPool(USDC), 1_000_000_000n)).status).toBe(200);
    expect((await register(METEORA, meteoraPool(USDC))).status).toBe(200);
  });

  it("a truncated pool account is refused as unsupported, not waved through", async () => {
    const { status } = await register(PUMPSWAP, new Uint8Array(100));
    expect(status).toBe(400);
    expect(h.rowWrites).toBe(0);
  });

  it("Raydium keeps its own refusal message", async () => {
    const { status, body } = await register(RAYDIUM, new Uint8Array(1544));
    expect(status).toBe(400);
    expect(body.error).toMatch(/Raydium pools are not supported/);
  });
});
