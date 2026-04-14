/**
 * Centralized NFT program constants, PDA derivation, and account parser.
 *
 * The percolator-nft program is a standalone Solana program (separate from the
 * main Percolator program) that acts as the Token-2022 TransferHook and owns
 * the mint_authority PDA used for position NFT mints.
 *
 * PDA seeds (authoritative — matches percolator-prog src/percolator.rs §position_nft):
 *   PositionNft state : ["position_nft",      slab_key, user_idx_u16_LE]
 *   PositionNft mint  : ["position_nft_mint", slab_key, user_idx_u16_LE]
 *   Mint authority    : ["mint_authority"]  (NFT program only)
 *
 * PositionNftState on-chain layout (128 bytes, PERC-608):
 *   [0..8]    magic             u64
 *   [8..40]   mint              [u8; 32]
 *   [40..72]  slab              [u8; 32]
 *   [72..104] owner             [u8; 32]
 *   [104..106] user_idx         u16 LE
 *   [106]     pending_settlement u8
 *   [107]     bump              u8
 *   [108]     mint_bump         u8
 *   [109..128] _reserved        [u8; 19]
 */

import { PublicKey } from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Program ID
// ---------------------------------------------------------------------------

/** The standalone percolator-nft program (TransferHook + mint authority). */
export const PERCOLATOR_NFT_PROGRAM_ID = new PublicKey(
  "FqhKJT9gtScjrmfUuRMjeg7cXNpif1fqsy5Jh65tJmTS"
);

// ---------------------------------------------------------------------------
// Instruction tags (standalone NFT program)
// ---------------------------------------------------------------------------

/** Instruction tag for minting a position NFT (standalone NFT program). */
export const NFT_MINT_TAG = 0;

/** Instruction tag for burning a position NFT (standalone NFT program). */
export const NFT_BURN_TAG = 1;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const _textEncoder = new TextEncoder();

function _idxBuf(userIdx: number): Uint8Array {
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, userIdx, true); // little-endian u16
  return buf;
}

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

/**
 * Derive the `PositionNft` state PDA.
 * Seeds: ["position_nft", slab, user_idx_u16_LE]
 *
 * @param slab     - The slab account public key.
 * @param userIdx  - The user index (u16).
 * @param programId - Override program ID (defaults to PERCOLATOR_NFT_PROGRAM_ID).
 */
export function deriveNftPda(
  slab: PublicKey,
  userIdx: number,
  programId: PublicKey = PERCOLATOR_NFT_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [_textEncoder.encode("position_nft"), slab.toBytes(), _idxBuf(userIdx)],
    programId
  );
}

/**
 * Derive the `PositionNft` mint PDA.
 * Seeds: ["position_nft_mint", slab, user_idx_u16_LE]
 *
 * @param slab     - The slab account public key.
 * @param userIdx  - The user index (u16).
 * @param programId - Override program ID (defaults to PERCOLATOR_NFT_PROGRAM_ID).
 */
export function deriveNftMint(
  slab: PublicKey,
  userIdx: number,
  programId: PublicKey = PERCOLATOR_NFT_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      _textEncoder.encode("position_nft_mint"),
      slab.toBytes(),
      _idxBuf(userIdx),
    ],
    programId
  );
}

/**
 * Derive the `mint_authority` PDA for the NFT program.
 * Seeds: ["mint_authority"]
 *
 * This PDA is the CPI signer used by the TransferHook when calling
 * TransferOwnershipCpi on the main Percolator program.
 *
 * @param programId - Override program ID (defaults to PERCOLATOR_NFT_PROGRAM_ID).
 */
export function deriveMintAuthority(
  programId: PublicKey = PERCOLATOR_NFT_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [_textEncoder.encode("mint_authority")],
    programId
  );
}

// ---------------------------------------------------------------------------
// Account parser
// ---------------------------------------------------------------------------

/** Minimum byte length of a valid PositionNftState account (128 bytes). */
export const POSITION_NFT_STATE_LEN = 128;

/**
 * Parse a `PositionNftState` account buffer.
 *
 * Layout (128 bytes, PERC-608):
 *   [0..8]    magic              u64
 *   [8..40]   mint               [u8; 32]
 *   [40..72]  slab               [u8; 32]
 *   [72..104] owner              [u8; 32]
 *   [104..106] user_idx          u16 LE
 *   [106]     pending_settlement u8
 *   [107]     bump               u8
 *   [108]     mint_bump          u8
 *   [109..128] _reserved         [u8; 19]
 *
 * @throws if `data` is shorter than POSITION_NFT_STATE_LEN.
 */
export function parsePositionNftAccount(data: Buffer): {
  mint: PublicKey;
  slab: PublicKey;
  owner: PublicKey;
  userIdx: number;
  pendingSettlement: boolean;
  bump: number;
  mintBump: number;
} {
  if (data.length < POSITION_NFT_STATE_LEN) {
    throw new Error(
      `PositionNft account too small: ${data.length} < ${POSITION_NFT_STATE_LEN}`
    );
  }

  const mint = new PublicKey(data.subarray(8, 40));
  const slab = new PublicKey(data.subarray(40, 72));
  const owner = new PublicKey(data.subarray(72, 104));
  const userIdx = new DataView(data.buffer, data.byteOffset + 104, 2).getUint16(
    0,
    true
  );
  const pendingSettlement = data[106] !== 0;
  const bump = data[107];
  const mintBump = data[108];

  return { mint, slab, owner, userIdx, pendingSettlement, bump, mintBump };
}
