import { PublicKey } from "@solana/web3.js";

export function isValidBase58Pubkey(s: string): boolean {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

export function isValidHex64(s: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(s);
}
