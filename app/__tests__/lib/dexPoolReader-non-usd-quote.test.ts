// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  METEORA_DLMM_PROGRAM_ID,
  PUMPSWAP_PROGRAM_ID,
  RAYDIUM_CLMM_PROGRAM_ID,
  WSOL_MINT,
} from "@percolatorct/sdk";
import { readPoolPriceE6, type DecimalsCache } from "@/lib/priceStore/dexPoolReader";

/**
 * A pool quoted in a token that is neither WSOL nor a USD stable (COLLECT/CARDS,
 * Murphy/DOGE) prices in quote-token units, and only WSOL is converted. The
 * reader must refuse it instead of serving that number as USD, like the
 * keeper's price-reader does, and must not move any WSOL/USDC/USDT price.
 */
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDT = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
const CARDS = new PublicKey("CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp");
const DOGE = new PublicKey("DoGEV7LASBkQbibMc5k5vKnTZoMg423GpJ5QtJEGfm7R");
const SOL_E6 = 150_000_000n;

type Acc = { owner: PublicKey; data: Buffer };

function vault(amount: bigint): Acc {
  const data = Buffer.alloc(165);
  data.writeBigUInt64LE(amount, 64);
  return { owner: PUMPSWAP_PROGRAM_ID, data };
}

async function read(
  dexType: "pumpswap" | "meteora-dlmm" | "raydium-clmm",
  accounts: Map<string, Acc>,
  pool: string,
  dec?: { base: number; quote: number },
) {
  const fetched: string[] = [];
  const conn = {
    getAccountInfo: async (pk: PublicKey) => {
      fetched.push(pk.toBase58());
      return accounts.get(pk.toBase58()) ?? null;
    },
  };
  const cache: DecimalsCache = new Map(dec ? [[pool, dec]] : []);
  const res = await readPoolPriceE6(conn as never, { poolAddress: pool, dexType, label: "TEST" }, cache, SOL_E6);
  return { res, fetched };
}

/** 1,000,000 base (6dp) vs 250 quote units. */
function pumpswap(quoteMint: PublicKey, quoteDec: number) {
  const pool = Keypair.generate().publicKey.toBase58();
  const bv = Keypair.generate().publicKey;
  const qv = Keypair.generate().publicKey;
  const data = Buffer.alloc(203);
  Keypair.generate().publicKey.toBuffer().copy(data, 43);
  quoteMint.toBuffer().copy(data, 75);
  bv.toBuffer().copy(data, 139);
  qv.toBuffer().copy(data, 171);
  const accounts = new Map<string, Acc>([
    [pool, { owner: PUMPSWAP_PROGRAM_ID, data }],
    [bv.toBase58(), vault(1_000_000_000_000n)],
    [qv.toBase58(), vault(250n * 10n ** BigInt(quoteDec))],
  ]);
  return read("pumpswap", accounts, pool, { base: 6, quote: quoteDec });
}

/** activeId i32 @76, binStep u16 @80, mints @88/@120. */
function meteora(quoteMint: PublicKey, quoteDec: number) {
  const pool = Keypair.generate().publicKey.toBase58();
  const data = Buffer.alloc(256);
  data.writeInt32LE(-2304, 76);
  data.writeUInt16LE(20, 80);
  Keypair.generate().publicKey.toBuffer().copy(data, 88);
  quoteMint.toBuffer().copy(data, 120);
  return read("meteora-dlmm", new Map([[pool, { owner: METEORA_DLMM_PROGRAM_ID, data }]]), pool, {
    base: 6,
    quote: quoteDec,
  });
}

/** mint0 (9dp) / mint1 (6dp) at 150 mint1 per mint0. */
function raydium(mint1: PublicKey) {
  const pool = Keypair.generate().publicKey.toBase58();
  const data = Buffer.alloc(300);
  WSOL_MINT.toBuffer().copy(data, 73);
  mint1.toBuffer().copy(data, 105);
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
  return read("raydium-clmm", new Map([[pool, { owner: RAYDIUM_CLMM_PROGRAM_ID, data }]]), pool);
}

describe("dexPoolReader refuses pools that are not priced in USD", () => {
  it.each([
    ["CARDS", CARDS, 6],
    ["DOGE", DOGE, 8],
  ])("PumpSwap pool quoted in %s is skipped before any vault read", async (_name, mint, dec) => {
    const { res, fetched } = await pumpswap(mint, dec);
    expect(res.priceE6).toBe(0n);
    expect(res.skipped).toBe(true);
    expect(res.skipReason).toContain(mint.toBase58());
    expect(fetched).toHaveLength(1);
  });

  it.each([
    ["CARDS", CARDS, 6],
    ["DOGE", DOGE, 8],
  ])("Meteora pool quoted in %s is skipped", async (_name, mint, dec) => {
    const { res } = await meteora(mint, dec);
    expect(res.priceE6).toBe(0n);
    expect(res.skipped).toBe(true);
    expect(res.skipReason).toContain(mint.toBase58());
  });

  it("Raydium pool with a non-USD mint1 is skipped", async () => {
    const { res } = await raydium(CARDS);
    expect(res.priceE6).toBe(0n);
    expect(res.skipped).toBe(true);
  });

  it.each([
    ["PumpSwap WSOL", () => pumpswap(WSOL_MINT, 9), 37_500n],
    ["PumpSwap USDC", () => pumpswap(USDC, 6), 250n],
    ["PumpSwap USDT", () => pumpswap(USDT, 6), 250n],
    ["Meteora WSOL", () => meteora(WSOL_MINT, 9), 1_502n],
    ["Meteora USDC", () => meteora(USDC, 6), 10_017n],
    ["Raydium SOL/USDC", () => raydium(USDC), 149_999_999n],
  ])("%s price is unchanged", async (_name, run, expected) => {
    const { res } = await run();
    expect(res.skipReason).toBeUndefined();
    expect(res.priceE6).toBe(expected);
  });
});
