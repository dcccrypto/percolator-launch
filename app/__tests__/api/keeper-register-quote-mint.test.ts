// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { type PoolAccount, CARDS, METEORA, MM, PUMPSWAP, RAYDIUM, USDC, USDT, WSOL, meteoraPool, pumpswapPool } from "../lib/pool-quote-gate-fixtures";

/**
 * keeper-register (the server-side write that makes the keeper price a market) must refuse a
 * PumpSwap / Meteora pool quoted in a token the keeper can't turn into USD, from the pool bytes
 * the owner classification already reads, and write nothing. WSOL/USDC/USDT-quoted pools pass.
 * Runs the admin path with the REAL classifyPoolsByOwner; only the mainnet read is mocked.
 */
const h = vi.hoisted(() => ({ pool: null as PoolAccount | null, rowWrites: 0, blobWrites: 0 }));

process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
process.env.ADMIN_API_SECRET = "quote-mint-test-secret";

vi.mock("@solana/web3.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("@solana/web3.js")>();
  class Connection {
    async getMultipleAccountsInfo(keys: unknown[]) {
      return keys.map(() => (h.pool ? { owner: new real.PublicKey(h.pool.owner), data: Buffer.from(h.pool.data) } : null));
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
const { Keypair } = await import("@solana/web3.js");

async function register(owner: string, data: Uint8Array) {
  h.pool = { owner, data };
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
