import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  METEORA_DLMM_PROGRAM_ID,
  PUMPSWAP_PROGRAM_ID,
  RAYDIUM_CLMM_PROGRAM_ID,
  WSOL_MINT,
} from "@percolatorct/sdk";
import { readPoolPriceE6, type DecimalsCache, type PoolReadEntry } from "@/lib/priceStore/dexPoolReader";
import {
  createBatchPoolReader,
  MAX_ACCOUNTS_PER_CALL,
  RETRY_UNRESOLVED_MS,
  STATIC_TTL_MS,
} from "@/lib/priceStore/dexPoolBatchReader";

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SOL_E6 = 150_000_000n;

type Acc = { owner: PublicKey; data: Buffer };

/** A mutable fake chain that counts every RPC it serves. */
class FakeChain {
  accounts = new Map<string, Acc>();
  singles: string[] = [];
  multis: string[][] = [];
  failMulti: ((keys: string[]) => boolean) | null = null;
  readonly conn = {
    getAccountInfo: async (pk: PublicKey) => {
      this.singles.push(pk.toBase58());
      return this.accounts.get(pk.toBase58()) ?? null;
    },
    getMultipleAccountsInfo: async (pks: PublicKey[]) => {
      const keys = pks.map((p) => p.toBase58());
      this.multis.push(keys);
      if (this.failMulti?.(keys)) throw new Error("rpc exploded");
      return keys.map((k) => this.accounts.get(k) ?? null);
    },
  };
  reset() {
    this.singles = [];
    this.multis = [];
  }
}

function vaultAcc(amount: bigint): Acc {
  const data = Buffer.alloc(165);
  data.writeBigUInt64LE(amount, 64);
  return { owner: PUMPSWAP_PROGRAM_ID, data };
}

interface Market {
  entry: PoolReadEntry;
  baseVault?: string;
  quoteVault?: string;
  dec?: { base: number; quote: number };
}

function addPumpswap(chain: FakeChain, base: bigint, quote: bigint, quoteMint: PublicKey = WSOL_MINT): Market {
  const pool = Keypair.generate().publicKey;
  const bv = Keypair.generate().publicKey;
  const qv = Keypair.generate().publicKey;
  const data = Buffer.alloc(203);
  Keypair.generate().publicKey.toBuffer().copy(data, 43);
  quoteMint.toBuffer().copy(data, 75);
  bv.toBuffer().copy(data, 139);
  qv.toBuffer().copy(data, 171);
  chain.accounts.set(pool.toBase58(), { owner: PUMPSWAP_PROGRAM_ID, data });
  chain.accounts.set(bv.toBase58(), vaultAcc(base));
  chain.accounts.set(qv.toBase58(), vaultAcc(quote));
  return {
    entry: { poolAddress: pool.toBase58(), dexType: "pumpswap", label: "PUMP" },
    baseVault: bv.toBase58(),
    quoteVault: qv.toBase58(),
    dec: { base: 6, quote: 9 },
  };
}

function setMeteoraActiveId(chain: FakeChain, pool: string, activeId: number) {
  chain.accounts.get(pool)!.data.writeInt32LE(activeId, 76);
}

function addMeteora(chain: FakeChain, activeId = -2304, label = "DLMM"): Market {
  const pool = Keypair.generate().publicKey.toBase58();
  const data = Buffer.alloc(256);
  data.writeInt32LE(activeId, 76);
  data.writeUInt16LE(20, 80);
  Keypair.generate().publicKey.toBuffer().copy(data, 88);
  USDC.toBuffer().copy(data, 120);
  chain.accounts.set(pool, { owner: METEORA_DLMM_PROGRAM_ID, data });
  return { entry: { poolAddress: pool, dexType: "meteora-dlmm", label }, dec: { base: 6, quote: 6 } };
}

function addRaydium(chain: FakeChain): Market {
  const pool = Keypair.generate().publicKey.toBase58();
  const data = Buffer.alloc(300);
  WSOL_MINT.toBuffer().copy(data, 73);
  USDC.toBuffer().copy(data, 105);
  data[233] = 9;
  data[234] = 6;
  const target = (SOL_E6 << 128n) / 1_000_000_000n;
  let x = target;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + target / x) / 2n;
  }
  data.writeBigUInt64LE(x & ((1n << 64n) - 1n), 253);
  data.writeBigUInt64LE(x >> 64n, 261);
  chain.accounts.set(pool, { owner: RAYDIUM_CLMM_PROGRAM_ID, data });
  return { entry: { poolAddress: pool, dexType: "raydium-clmm", label: "CLMM" } };
}

function cacheFor(markets: Market[]): DecimalsCache {
  return new Map(markets.filter((m) => m.dec).map((m) => [m.entry.poolAddress, m.dec!]));
}

/** What the unbatched reader says about the same chain state. */
async function reference(chain: FakeChain, m: Market, cache: DecimalsCache) {
  return readPoolPriceE6(chain.conn as never, m.entry, cache, SOL_E6);
}

function priced(out: Awaited<ReturnType<ReturnType<typeof createBatchPoolReader>["readAll"]>>, m: Market) {
  const o = out.get(m.entry.poolAddress);
  if (!o || o.kind !== "result") throw new Error(`no result for ${m.entry.label}: ${JSON.stringify(o)}`);
  return o.result;
}

describe("batched DEX price reader", () => {
  it("prices PumpSwap, Meteora DLMM and Raydium CLMM exactly like the per-market reader, in one batched call", async () => {
    const chain = new FakeChain();
    const markets = [addPumpswap(chain, 1_000_000_000_000n, 250_000_000_000n), addMeteora(chain), addRaydium(chain)];
    const cache = cacheFor(markets);
    const refs = await Promise.all(markets.map((m) => reference(chain, m, cache)));
    chain.reset();

    const reader = createBatchPoolReader(chain.conn as never, cache, { now: () => 0 });
    const out = await reader.readAll(markets.map((m) => m.entry), SOL_E6);

    markets.forEach((m, i) => {
      const r = priced(out, m);
      expect(r.skipped).toBeUndefined();
      expect(r.priceE6).toBe(refs[i].priceE6);
      expect(r.priceE6).toBeGreaterThan(0n);
    });
    expect(chain.singles).toEqual([]);
    // 1 resolve call (3 pools) + 1 cycle call (2 vaults + meteora pool + raydium pool = 4 accounts).
    expect(chain.multis.map((k) => k.length)).toEqual([3, 4]);
  });

  it("re-reads only the changing accounts each cycle and reflects their new values", async () => {
    const chain = new FakeChain();
    const pump = addPumpswap(chain, 1_000_000_000_000n, 250_000_000_000n);
    const dlmm = addMeteora(chain, -2304);
    const markets = [pump, dlmm];
    const cache = cacheFor(markets);
    let now = 0;
    const reader = createBatchPoolReader(chain.conn as never, cache, { now: () => now });
    const first = await reader.readAll(markets.map((m) => m.entry), SOL_E6);

    chain.accounts.set(pump.quoteVault!, vaultAcc(500_000_000_000n)); // pump quote reserve doubles
    setMeteoraActiveId(chain, dlmm.entry.poolAddress, -2000); // active bin moves
    chain.reset();
    now += 500;
    const second = await reader.readAll(markets.map((m) => m.entry), SOL_E6);

    expect(priced(second, pump).priceE6).toBeGreaterThan(priced(first, pump).priceE6);
    expect(priced(second, dlmm).priceE6).toBeGreaterThan(priced(first, dlmm).priceE6);
    expect(priced(second, pump).priceE6).toBe((await reference(chain, pump, cache)).priceE6);
    expect(priced(second, dlmm).priceE6).toBe((await reference(chain, dlmm, cache)).priceE6);
    // Within the static TTL: no pool re-resolve, and the PumpSwap pool account is NOT read again.
    const cycleKeys = chain.multis.slice(0, 1).flat();
    expect(chain.multis).toHaveLength(1);
    expect(cycleKeys).not.toContain(pump.entry.poolAddress);
    expect(cycleKeys.sort()).toEqual([pump.baseVault!, pump.quoteVault!, dlmm.entry.poolAddress].sort());
  });

  it("re-resolves static facts after the TTL", async () => {
    const chain = new FakeChain();
    const pump = addPumpswap(chain, 1_000_000_000_000n, 250_000_000_000n);
    const cache = cacheFor([pump]);
    let now = 0;
    const reader = createBatchPoolReader(chain.conn as never, cache, { now: () => now });
    await reader.readAll([pump.entry], SOL_E6);
    chain.reset();
    now += STATIC_TTL_MS + 1;
    await reader.readAll([pump.entry], SOL_E6);
    expect(chain.multis.map((k) => k.length)).toEqual([1, 2]); // pool resolve, then 2 vaults
    expect(chain.multis[0]).toEqual([pump.entry.poolAddress]);
  });

  it("isolates a missing vault, a missing pool and a non-USD pool to their own markets", async () => {
    const chain = new FakeChain();
    const good = addPumpswap(chain, 1_000_000_000_000n, 250_000_000_000n);
    const noVault = addPumpswap(chain, 1_000_000_000_000n, 250_000_000_000n);
    const nonUsd = addPumpswap(chain, 1_000_000_000_000n, 250_000_000_000n, Keypair.generate().publicKey);
    const dlmm = addMeteora(chain);
    const ghost: Market = {
      entry: { poolAddress: Keypair.generate().publicKey.toBase58(), dexType: "meteora-dlmm", label: "GHOST" },
    };
    chain.accounts.delete(noVault.quoteVault!);
    const markets = [good, noVault, nonUsd, dlmm, ghost];
    const reader = createBatchPoolReader(chain.conn as never, cacheFor(markets), { now: () => 0 });
    const out = await reader.readAll(markets.map((m) => m.entry), SOL_E6);

    expect(priced(out, good).skipped).toBeUndefined();
    expect(priced(out, dlmm).skipped).toBeUndefined();
    expect(priced(out, noVault).skipReason).toBe("PumpSwap: vault account(s) not found on mainnet");
    expect(priced(out, nonUsd).skipReason).toContain("is not WSOL or a USD stable");
    expect(priced(out, ghost).skipReason).toBe("pool account not found on mainnet");
    expect(priced(out, ghost).priceE6).toBe(0n);
    // The non-USD pool's vaults were never requested.
    expect(chain.multis.flat()).not.toContain(nonUsd.baseVault);
  });

  it("picks a pool up once it appears (retry sooner than the full TTL)", async () => {
    const chain = new FakeChain();
    const late = addMeteora(chain);
    const saved = chain.accounts.get(late.entry.poolAddress)!;
    chain.accounts.delete(late.entry.poolAddress);
    let now = 0;
    const reader = createBatchPoolReader(chain.conn as never, cacheFor([late]), { now: () => now });
    expect(priced(await reader.readAll([late.entry], SOL_E6), late).skipReason).toBe("pool account not found on mainnet");
    chain.accounts.set(late.entry.poolAddress, saved);
    now += RETRY_UNRESOLVED_MS + 1;
    expect(priced(await reader.readAll([late.entry], SOL_E6), late).skipped).toBeUndefined();
  });

  it("chunks above 100 accounts and keeps every call within the limit", async () => {
    const chain = new FakeChain();
    const markets = Array.from({ length: 130 }, (_, i) => addMeteora(chain, -2304 + i, `D${i}`));
    const reader = createBatchPoolReader(chain.conn as never, cacheFor(markets), { now: () => 0 });
    const out = await reader.readAll(markets.map((m) => m.entry), SOL_E6);
    expect(chain.multis.every((k) => k.length <= MAX_ACCOUNTS_PER_CALL)).toBe(true);
    expect(chain.multis.map((k) => k.length).sort((a, b) => a - b)).toEqual([30, 30, 100, 100]); // resolve + cycle
    expect(chain.singles).toEqual([]);
    for (const m of markets) expect(priced(out, m).skipped).toBeUndefined();
    // distinct active bins -> distinct prices, so no market was served another market's account
    expect(new Set(markets.map((m) => priced(out, m).priceE6)).size).toBeGreaterThan(100);
  });

  it("a failed RPC chunk fails only the markets whose accounts were in it", async () => {
    const chain = new FakeChain();
    const markets = Array.from({ length: 130 }, (_, i) => addMeteora(chain, -2304 + i, `D${i}`));
    const reader = createBatchPoolReader(chain.conn as never, cacheFor(markets), { now: () => 0 });
    await reader.readAll(markets.map((m) => m.entry), SOL_E6); // resolve while healthy
    const firstChunk = new Set(markets.slice(0, 100).map((m) => m.entry.poolAddress));
    chain.failMulti = (keys) => keys.some((k) => firstChunk.has(k));
    const out = await reader.readAll(markets.map((m) => m.entry), SOL_E6);
    const failed = markets.filter((m) => out.get(m.entry.poolAddress)!.kind === "error");
    expect(failed.map((m) => m.entry.label)).toEqual(markets.slice(0, 100).map((m) => m.entry.label));
    for (const m of markets.slice(100)) expect(priced(out, m).skipped).toBeUndefined();
  });

  it("picks up a market added mid-run, resolving only the new pool", async () => {
    const chain = new FakeChain();
    const a = addPumpswap(chain, 1_000_000_000_000n, 250_000_000_000n);
    const b = addMeteora(chain);
    const cache = cacheFor([a, b]);
    const reader = createBatchPoolReader(chain.conn as never, cache, { now: () => 0 });
    await reader.readAll([a.entry, b.entry], SOL_E6);

    const c = addPumpswap(chain, 2_000_000_000_000n, 250_000_000_000n);
    cache.set(c.entry.poolAddress, c.dec!);
    chain.reset();
    const out = await reader.readAll([a.entry, b.entry, c.entry], SOL_E6);
    expect(chain.multis[0]).toEqual([c.entry.poolAddress]); // resolve of the NEW pool only
    expect(priced(out, c).priceE6).toBe((await reference(chain, c, cache)).priceE6);
    expect(priced(out, a).skipped).toBeUndefined();

    // ...and a market removed from the list is forgotten (its accounts are no longer read).
    chain.reset();
    await reader.readAll([b.entry], SOL_E6);
    expect(chain.multis.flat()).toEqual([b.entry.poolAddress]);
  });

  it("serves two markets that share one pool from a single read", async () => {
    const chain = new FakeChain();
    const m = addMeteora(chain);
    const reader = createBatchPoolReader(chain.conn as never, cacheFor([m]), { now: () => 0 });
    chain.reset();
    const out = await reader.readAll([m.entry, { ...m.entry, label: "dup" }], SOL_E6);
    expect(out.size).toBe(1);
    expect(chain.multis.map((k) => k.length)).toEqual([1, 1]);
  });
});
