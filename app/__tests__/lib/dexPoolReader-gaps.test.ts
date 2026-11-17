// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

const decimalsFetch = vi.hoisted(() => vi.fn());

vi.mock("@percolatorct/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@percolatorct/sdk")>();
  return { ...actual, fetchMintDecimals: decimalsFetch };
});

import {
  METEORA_DLMM_PROGRAM_ID,
  PUMPSWAP_PROGRAM_ID,
  RAYDIUM_CLMM_PROGRAM_ID,
  WSOL_MINT,
} from "@percolatorct/sdk";
import {
  priceFromAccounts,
  readPoolPriceE6,
  withRpcBackoff,
  type AccountData,
  type DecimalsCache,
  type PoolReadEntry,
} from "@/lib/priceStore/dexPoolReader";

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SOL_E6 = 150_000_000n;
const conn = {} as never;

type Reader = (pk: PublicKey) => Promise<AccountData | null>;

function readerFor(accounts: Map<string, AccountData>): Reader {
  return async (pk) => accounts.get(pk.toBase58()) ?? null;
}

function entryFor(poolAddress: string, dexType: PoolReadEntry["dexType"]): PoolReadEntry {
  return { poolAddress, dexType, label: "T" };
}

function vault(amount: bigint, len = 165): AccountData {
  const data = Buffer.alloc(len);
  if (len >= 72) data.writeBigUInt64LE(amount, 64);
  return { owner: PUMPSWAP_PROGRAM_ID, data };
}

function pumpPool(quoteMint: PublicKey) {
  const pool = Keypair.generate().publicKey.toBase58();
  const bv = Keypair.generate().publicKey;
  const qv = Keypair.generate().publicKey;
  const data = Buffer.alloc(203);
  Keypair.generate().publicKey.toBuffer().copy(data, 43);
  quoteMint.toBuffer().copy(data, 75);
  bv.toBuffer().copy(data, 139);
  qv.toBuffer().copy(data, 171);
  return { pool, bv, qv, acc: { owner: PUMPSWAP_PROGRAM_ID, data } as AccountData };
}

function meteoraPool(quoteMint: PublicKey, binStep = 20) {
  const pool = Keypair.generate().publicKey.toBase58();
  const data = Buffer.alloc(256);
  data.writeInt32LE(-2304, 76);
  data.writeUInt16LE(binStep, 80);
  Keypair.generate().publicKey.toBuffer().copy(data, 88);
  quoteMint.toBuffer().copy(data, 120);
  return { pool, acc: { owner: METEORA_DLMM_PROGRAM_ID, data } as AccountData };
}

function raydiumPool(sqrt: bigint) {
  const pool = Keypair.generate().publicKey.toBase58();
  const data = Buffer.alloc(300);
  WSOL_MINT.toBuffer().copy(data, 73);
  USDC.toBuffer().copy(data, 105);
  data[233] = 9;
  data[234] = 6;
  data.writeBigUInt64LE(sqrt & ((1n << 64n) - 1n), 253);
  data.writeBigUInt64LE(sqrt >> 64n, 261);
  return { pool, acc: { owner: RAYDIUM_CLMM_PROGRAM_ID, data } as AccountData };
}

beforeEach(() => {
  decimalsFetch.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("withRpcBackoff", () => {
  it("returns immediately on success", async () => {
    const fn = vi.fn().mockResolvedValue(7);
    await expect(withRpcBackoff(fn)).resolves.toBe(7);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries 429 errors with backoff and then succeeds", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockRejectedValueOnce("too many requests (string)")
      .mockResolvedValue("ok");
    const p = withRpcBackoff(fn);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("gives up with the original error after 4 attempts of 429", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const err = new Error("HTTP 429");
    const fn = vi.fn().mockRejectedValue(err);
    const p = withRpcBackoff(fn);
    const assertion = expect(p).rejects.toBe(err);
    await vi.advanceTimersByTimeAsync(500 + 1000 + 2000);
    await assertion;
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("rethrows non-429 errors without retrying", async () => {
    const err = new Error("boom");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRpcBackoff(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("treats a non-Error rejection that is not a 429 as terminal", async () => {
    const fn = vi.fn().mockRejectedValue("nope");
    await expect(withRpcBackoff(fn)).rejects.toBe("nope");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("readPoolPriceE6 (RPC wrapper)", () => {
  it("reads the pool with confirmed commitment and surfaces a missing account as a skip", async () => {
    const getAccountInfo = vi.fn().mockResolvedValue(null);
    const pool = Keypair.generate().publicKey.toBase58();
    const res = await readPoolPriceE6({ getAccountInfo } as never, entryFor(pool, "pumpswap"), new Map());
    expect(getAccountInfo).toHaveBeenCalledWith(new PublicKey(pool), "confirmed");
    expect(res).toEqual({
      priceE6: 0n,
      source: `pumpswap:${pool.slice(0, 8)}…`,
      skipped: true,
      skipReason: "pool account not found on mainnet",
    });
  });

  it("propagates a non-429 RPC error", async () => {
    const getAccountInfo = vi.fn().mockRejectedValue(new Error("rpc down"));
    const pool = Keypair.generate().publicKey.toBase58();
    await expect(
      readPoolPriceE6({ getAccountInfo } as never, entryFor(pool, "pumpswap"), new Map()),
    ).rejects.toThrow("rpc down");
  });
});

describe("priceFromAccounts: pool-level guards", () => {
  it("skips an empty-data pool account", async () => {
    const pool = Keypair.generate().publicKey.toBase58();
    const res = await priceFromAccounts(
      conn,
      entryFor(pool, "pumpswap"),
      new Map(),
      undefined,
      async () => ({ owner: PUMPSWAP_PROGRAM_ID, data: Buffer.alloc(0) }),
    );
    expect(res.skipped).toBe(true);
    expect(res.skipReason).toBe("pool account has empty data");
    expect(res.priceE6).toBe(0n);
  });

  it("skips when the owner is an unknown program", async () => {
    const pool = Keypair.generate().publicKey.toBase58();
    const owner = Keypair.generate().publicKey;
    const res = await priceFromAccounts(conn, entryFor(pool, "pumpswap"), new Map(), undefined, async () => ({
      owner,
      data: Buffer.alloc(300),
    }));
    expect(res.skipped).toBe(true);
    expect(res.skipReason).toBe(
      `pool owner ${owner.toBase58()} does not match dexType=pumpswap (detected: unknown)`,
    );
  });

  it("skips when the owner belongs to a different supported DEX", async () => {
    const pool = Keypair.generate().publicKey.toBase58();
    const res = await priceFromAccounts(conn, entryFor(pool, "meteora-dlmm"), new Map(), undefined, async () => ({
      owner: RAYDIUM_CLMM_PROGRAM_ID,
      data: Buffer.alloc(300),
    }));
    expect(res.skipReason).toContain("dexType=meteora-dlmm (detected: raydium-clmm)");
  });

  it("an unknown entry dexType is caught by the owner check (the final unsupported-dexType return is unreachable)", async () => {
    const pool = Keypair.generate().publicKey.toBase58();
    const res = await priceFromAccounts(
      conn,
      entryFor(pool, "orca" as never),
      new Map(),
      undefined,
      async () => ({ owner: PUMPSWAP_PROGRAM_ID, data: Buffer.alloc(300) }),
    );
    // owner detects as pumpswap, entry says orca -> owner-mismatch skip (never reaches dispatch).
    expect(res.skipped).toBe(true);
    expect(res.skipReason).toContain("dexType=orca (detected: pumpswap)");
  });
});

describe("priceFromAccounts: raydium-clmm", () => {
  // SDK 8.x throws on sqrtPriceX64=0, so the reader's own `=== 0n` skip is dead code and the
  // error propagates to the caller. Pinned here so a change in either layer is noticed.
  it("rejects with the SDK error for a USD-quoted pool whose sqrtPriceX64 is 0", async () => {
    const { pool, acc } = raydiumPool(0n);
    await expect(
      priceFromAccounts(conn, entryFor(pool, "raydium-clmm"), new Map(), undefined, readerFor(new Map([[pool, acc]]))),
    ).rejects.toThrow(/sqrt_price_x64 = 0/);
  });
});

describe("priceFromAccounts: meteora-dlmm", () => {
  it("fetches and caches mint decimals on a cold cache, then prices", async () => {
    decimalsFetch.mockResolvedValueOnce(6).mockResolvedValueOnce(6);
    const { pool, acc } = meteoraPool(USDC);
    const cache: DecimalsCache = new Map();
    const res = await priceFromAccounts(conn, entryFor(pool, "meteora-dlmm"), cache, undefined, readerFor(new Map([[pool, acc]])));
    expect(decimalsFetch).toHaveBeenCalledTimes(2);
    expect(cache.get(pool)).toEqual({ base: 6, quote: 6 });
    expect(res.skipReason).toBeUndefined();
    expect(res.priceE6).toBe(10_017n);
    expect(res.source).toBe(`meteora-dlmm:${pool.slice(0, 8)}…`);
  });

  it("does not refetch decimals when cached", async () => {
    const { pool, acc } = meteoraPool(USDC);
    const cache: DecimalsCache = new Map([[pool, { base: 6, quote: 6 }]]);
    await priceFromAccounts(conn, entryFor(pool, "meteora-dlmm"), cache, undefined, readerFor(new Map([[pool, acc]])));
    expect(decimalsFetch).not.toHaveBeenCalled();
  });

  it("propagates a decimals RPC failure", async () => {
    decimalsFetch.mockRejectedValue(new Error("mint rpc down"));
    const { pool, acc } = meteoraPool(USDC);
    await expect(
      priceFromAccounts(conn, entryFor(pool, "meteora-dlmm"), new Map(), undefined, readerFor(new Map([[pool, acc]]))),
    ).rejects.toThrow("mint rpc down");
  });

  it("skips a WSOL-quoted pool when no SOL/USD price is available", async () => {
    const { pool, acc } = meteoraPool(WSOL_MINT);
    const res = await priceFromAccounts(
      conn,
      entryFor(pool, "meteora-dlmm"),
      new Map([[pool, { base: 6, quote: 9 }]]),
      undefined,
      readerFor(new Map([[pool, acc]])),
    );
    expect(res.priceE6).toBe(0n);
    expect(res.skipReason).toBe("Meteora DLMM: pool is WSOL-quoted but no SOL/USD price was available");
  });

  it("prices a WSOL-quoted pool via the e12 path", async () => {
    const { pool, acc } = meteoraPool(WSOL_MINT);
    const res = await priceFromAccounts(
      conn,
      entryFor(pool, "meteora-dlmm"),
      new Map([[pool, { base: 6, quote: 9 }]]),
      SOL_E6,
      readerFor(new Map([[pool, acc]])),
    );
    expect(res.priceE6).toBe(1_502n);
  });

  it("rejects with the SDK error for a WSOL-quoted pool with binStep=0", async () => {
    const { pool, acc } = meteoraPool(WSOL_MINT, 0);
    await expect(priceFromAccounts(
      conn,
      entryFor(pool, "meteora-dlmm"),
      new Map([[pool, { base: 6, quote: 9 }]]),
      SOL_E6,
      readerFor(new Map([[pool, acc]])),
    )).rejects.toThrow(/binStep = 0/);
  });

  it("rejects with the SDK error for a USD-quoted pool with binStep=0", async () => {
    const { pool, acc } = meteoraPool(USDC, 0);
    await expect(priceFromAccounts(
      conn,
      entryFor(pool, "meteora-dlmm"),
      new Map([[pool, { base: 6, quote: 6 }]]),
      undefined,
      readerFor(new Map([[pool, acc]])),
    )).rejects.toThrow(/binStep = 0/);
  });
});

describe("priceFromAccounts: pumpswap", () => {
  const dec6 = { base: 6, quote: 6 };

  function run(
    p: ReturnType<typeof pumpPool>,
    vaults: Array<[PublicKey, AccountData]>,
    cache: DecimalsCache,
    solPrice?: bigint,
  ) {
    const accounts = new Map<string, AccountData>([[p.pool, p.acc]]);
    for (const [k, v] of vaults) accounts.set(k.toBase58(), v);
    return priceFromAccounts(conn, entryFor(p.pool, "pumpswap"), cache, solPrice, readerFor(accounts));
  }

  it("prices a USDC pool and caches fetched decimals on a cold cache", async () => {
    decimalsFetch.mockResolvedValueOnce(6).mockResolvedValueOnce(6);
    const p = pumpPool(USDC);
    const cache: DecimalsCache = new Map();
    const res = await run(p, [[p.bv, vault(1_000_000_000_000n)], [p.qv, vault(250_000_000n)]], cache);
    expect(cache.get(p.pool)).toEqual({ base: 6, quote: 6 });
    expect(res.skipReason).toBeUndefined();
    expect(res.priceE6).toBe(250n);
  });

  it("skips when a vault account is missing", async () => {
    const p = pumpPool(USDC);
    const res = await run(p, [[p.bv, vault(1n)]], new Map([[p.pool, dec6]]));
    expect(res.priceE6).toBe(0n);
    expect(res.skipReason).toBe("PumpSwap: vault account(s) not found on mainnet");
  });

  it("skips when a vault is shorter than 72 bytes", async () => {
    const p = pumpPool(USDC);
    const res = await run(p, [[p.bv, vault(1n, 71)], [p.qv, vault(1n)]], new Map([[p.pool, dec6]]));
    expect(res.skipReason).toBe("PumpSwap: vault data too short (base=71, quote=165)");
  });

  it("skips when the base vault amount is 0", async () => {
    const p = pumpPool(USDC);
    const res = await run(p, [[p.bv, vault(0n)], [p.qv, vault(5n)]], new Map([[p.pool, dec6]]));
    expect(res.skipReason).toBe("PumpSwap: base vault amount=0 (pool not seeded / not live)");
  });

  it("skips a WSOL-quoted pool without a SOL/USD price", async () => {
    const p = pumpPool(WSOL_MINT);
    const res = await run(
      p,
      [[p.bv, vault(1_000_000_000_000n)], [p.qv, vault(250_000_000_000n)]],
      new Map([[p.pool, { base: 6, quote: 9 }]]),
    );
    expect(res.priceE6).toBe(0n);
    expect(res.skipReason).toBe("PumpSwap: pool is WSOL-quoted but no SOL/USD price was available this cycle");
  });

  it("converts a WSOL-quoted pool with the SOL/USD price", async () => {
    const p = pumpPool(WSOL_MINT);
    const res = await run(
      p,
      [[p.bv, vault(1_000_000_000_000n)], [p.qv, vault(250_000_000_000n)]],
      new Map([[p.pool, { base: 6, quote: 9 }]]),
      SOL_E6,
    );
    expect(res.priceE6).toBe(37_500n);
  });

  it("turns an SDK throw (base decimals beyond the SDK limit) into a skip", async () => {
    const p = pumpPool(USDC);
    const res = await run(
      p,
      [[p.bv, vault(1_000_000n)], [p.qv, vault(1_000_000n)]],
      new Map([[p.pool, { base: 30, quote: 6 }]]),
    );
    expect(res.priceE6).toBe(0n);
    expect(res.skipped).toBe(true);
    expect(res.skipReason).toMatch(/^PumpSwap: /);
  });

  it("skips when the computed price rounds to 0", async () => {
    const p = pumpPool(USDC);
    const res = await run(p, [[p.bv, vault(1_000_000_000_000n)], [p.qv, vault(0n)]], new Map([[p.pool, dec6]]));
    expect(res.priceE6).toBe(0n);
    expect(res.skipReason).toBe("PumpSwap: computed price=0n");
  });
});
