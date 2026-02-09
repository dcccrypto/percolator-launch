import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

/**
 * Token2022 (Token Extensions) program ID.
 */
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);

/**
 * Detect which token program owns a given mint account.
 * Returns the owner program ID (TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID).
 * Throws if the mint account doesn't exist.
 */
export async function detectTokenProgram(
  connection: Connection,
  mint: PublicKey,
): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint account not found: ${mint.toBase58()}`);
  return info.owner;
}

/**
 * Check if a given token program ID is Token2022.
 */
export function isToken2022(tokenProgramId: PublicKey): boolean {
  return tokenProgramId.equals(TOKEN_2022_PROGRAM_ID);
}

/**
 * Check if a given token program ID is the standard SPL Token program.
 */
export function isStandardToken(tokenProgramId: PublicKey): boolean {
  return tokenProgramId.equals(TOKEN_PROGRAM_ID);
}
