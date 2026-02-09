import { Connection, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  getAccount,
  Account,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { TOKEN_2022_PROGRAM_ID } from "./token-program.js";

/**
 * Get the associated token address for an owner and mint.
 * Supports both standard SPL Token and Token2022 via optional tokenProgramId.
 */
export async function getAta(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID,
): Promise<PublicKey> {
  return getAssociatedTokenAddress(mint, owner, false, tokenProgramId);
}

/**
 * Synchronous version of getAta.
 * Supports both standard SPL Token and Token2022 via optional tokenProgramId.
 */
export function getAtaSync(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID,
): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, false, tokenProgramId);
}

/**
 * Fetch token account info.
 * Supports both standard SPL Token and Token2022 via optional tokenProgramId.
 * Throws if account doesn't exist.
 */
export async function fetchTokenAccount(
  connection: Connection,
  address: PublicKey,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID,
): Promise<Account> {
  return getAccount(connection, address, undefined, tokenProgramId);
}
