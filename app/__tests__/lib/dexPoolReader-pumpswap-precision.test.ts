// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { PUMPSWAP_PROGRAM_ID, WSOL_MINT } from "@percolatorct/sdk";
import { readPoolPriceE6, type DecimalsCache } from "@/lib/priceStore/dexPoolReader";

/**
 * The SDK floors PumpSwap quote-per-base to whole micro-units (1e-6 SOL for a
 * WSOL pool) BEFORE the SOL/USD multiply. A token at 1.8e-6 SOL read as exactly
 * 1 x SOL/USD (-45%), and one under 1e-6 SOL read 0 (skipped). The reader must
 * keep full precision through the multiply, like its Meteora branch does.
 */
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

async function readPumpswap(opts: {
  baseAmount: bigint;
  quoteAmount: bigint;
  decimals: { base: number; quote: number };
  quoteMint?: PublicKey;
  solPriceE6?: bigint;
}) {
  const baseVault = Keypair.generate().publicKey;
  const quoteVault = Keypair.generate().publicKey;
  const pool = Buffer.alloc(203);
  Keypair.generate().publicKey.toBuffer().copy(pool, 43); // base mint
  (opts.quoteMint ?? WSOL_MINT).toBuffer().copy(pool, 75); // quote mint
  baseVault.toBuffer().copy(pool, 139);
  quoteVault.toBuffer().copy(pool, 171);
  const vault = (amount: bigint) => {
    const b = Buffer.alloc(165);
    b.writeBigUInt64LE(amount, 64);
    return b;
  };
  const poolAddress = Keypair.generate().publicKey.toBase58();
  const accounts = new Map<string, Buffer>([
    [poolAddress, pool],
    [baseVault.toBase58(), vault(opts.baseAmount)],
    [quoteVault.toBase58(), vault(opts.quoteAmount)],
  ]);
  const conn = {
    getAccountInfo: async (pk: PublicKey) => {
      const data = accounts.get(pk.toBase58());
      return data ? { owner: PUMPSWAP_PROGRAM_ID, data } : null;
    },
  };
  const cache: DecimalsCache = new Map([[poolAddress, opts.decimals]]);
  return readPoolPriceE6(conn as never, { poolAddress, dexType: "pumpswap", label: "TEST" }, cache, opts.solPriceE6);
}

describe("PumpSwap display price keeps full precision through the SOL/USD multiply", () => {
  it("SOLCAT-like pool at ~1.79e-6 SOL reads 211 (e6), not 117", async () => {
    const res = await readPumpswap({
      baseAmount: 136_238_579_688_963n,
      quoteAmount: 244_350_638_748n,
      decimals: { base: 6, quote: 9 },
      solPriceE6: 117_753_929n,
    });
    expect(res.skipReason).toBeUndefined();
    expect(res.priceE6).toBe(211n);
  });

  it("BURNIE-like pool at 7.305e-6 SOL reads 1461 (e6), not 1400", async () => {
    const res = await readPumpswap({
      baseAmount: 1_000_000_000_000_000n, // 1e9 tokens @ 6dp
      quoteAmount: 7_305_000_000_000n, // 7305 SOL
      decimals: { base: 6, quote: 9 },
      solPriceE6: 200_000_000n,
    });
    expect(res.skipReason).toBeUndefined();
    expect(res.priceE6).toBe(1461n);
  });

  it("pool under 1e-6 SOL reads its real price instead of 0/skipped", async () => {
    const res = await readPumpswap({
      baseAmount: 1_000_000_000_000_000n,
      quoteAmount: 500_000_000_000n, // 500 SOL -> 5e-7 SOL/token
      decimals: { base: 6, quote: 9 },
      solPriceE6: 200_000_000n,
    });
    expect(res.skipReason).toBeUndefined();
    expect(res.priceE6).toBe(100n);
  });

  it("USD-stable-quoted pool stays at e6 scale", async () => {
    const res = await readPumpswap({
      baseAmount: 1_000_000_000_000_000n,
      quoteAmount: 1_234_567_891_234n, // 1,234,567.891234 USDC @ 6dp
      decimals: { base: 6, quote: 6 },
      quoteMint: USDC_MINT,
    });
    expect(res.skipReason).toBeUndefined();
    expect(res.priceE6).toBe(1234n);
  });

  it("base mint with >18 decimals still prices (SDK caps decimals at 24)", async () => {
    const res = await readPumpswap({
      baseAmount: 10n ** 19n, // 0.1 token @ 20dp (u64 vault caps reserves)
      quoteAmount: 1n, // 1 lamport -> 1e-8 SOL/token -> $0.000002
      decimals: { base: 20, quote: 9 },
      solPriceE6: 200_000_000n,
    });
    expect(res.skipReason).toBeUndefined();
    expect(res.priceE6).toBe(2n);
  });
});
