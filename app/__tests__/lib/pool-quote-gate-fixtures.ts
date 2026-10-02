import { Keypair, PublicKey } from "@solana/web3.js";

/** Shared byte-level pool fixtures for the quote-mint gate tests (2026-10-02 SI/MM incident). */
export const PUMPSWAP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const METEORA = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
export const RAYDIUM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
export const DAMM_V1 = "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB";
export const WSOL = "So11111111111111111111111111111111111111112";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
/** MM, the memecoin SI's pool 9Gkbbu... was quoted in. */
export const MM = "Ax8PSfCXxmxb8C8kYTzN5CPpTe6PyeZfFf8rrXNCjupx";
export const CARDS = "CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp";

/** PumpSwap pool: base mint @43, quote mint @75, vaults @139/@171. */
export function pumpswapPool(quote: string): Uint8Array {
  const d = Buffer.alloc(301);
  Keypair.generate().publicKey.toBuffer().copy(d, 43);
  new PublicKey(quote).toBuffer().copy(d, 75);
  Keypair.generate().publicKey.toBuffer().copy(d, 139);
  Keypair.generate().publicKey.toBuffer().copy(d, 171);
  return d;
}

/** Meteora DLMM pool: token X (base) @88, token Y (quote) @120. */
export function meteoraPool(quote: string): Uint8Array {
  const d = Buffer.alloc(904);
  Keypair.generate().publicKey.toBuffer().copy(d, 88);
  new PublicKey(quote).toBuffer().copy(d, 120);
  return d;
}

export type PoolAccount = { owner: string; data: Uint8Array };
