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

/**
 * Byte length of a valid PositionNft account (208 bytes).
 *
 * Matches `percolator-nft/src/state.rs::PositionNft`, which carries a
 * static size assert (`assert!(size_of::<PositionNft>() == 208)`). Any
 * other value means the parser and on-chain struct are out of sync —
 * this whole file was written against a long-superseded draft that put
 * the mint at offset 8, which caused the frontend to read a 32-byte
 * window spanning the header + padding + slab as a phony "mint"
 * pubkey (TokenAccountNotFoundError on every transfer / burn).
 */
export const POSITION_NFT_STATE_LEN = 208;

/**
 * Parse a `PositionNft` account buffer.
 *
 * Canonical layout (percolator-nft/src/state.rs, 208 bytes):
 *   [0..8]    magic              u64
 *   [8]       version            u8
 *   [9]       bump               u8
 *   [10..16]  _pad0
 *   [16..48]  slab               [u8; 32]
 *   [48..50]  user_idx           u16 LE
 *   [50..56]  _pad1
 *   [56..88]  nft_mint           [u8; 32]
 *   [88..96]  entry_price_e6     u64
 *   [96..104] position_size      u64
 *   [104]     is_long            u8 (1 = long, 0 = short)
 *   [105..112] _pad2
 *   [112..128] position_basis_q  i128
 *   [128..144] last_funding_index_e18 i128
 *   [144..152] minted_at          i64
 *   [152..160] account_id         u64
 *   [160..192] position_owner     [u8; 32]   (PERC-N1)
 *   [192..208] _reserved1
 *
 * `pendingSettlement` no longer exists as a field; the old parser
 * synthesised it from a byte that is now part of `_pad2`. Callers that
 * want to detect a closed-but-not-burned state should check
 * `positionSize === 0n` instead.
 *
 * `mintBump` likewise doesn't exist — the NFT mint is a caller-provided
 * keypair (not a PDA), so there is no bump. The field is dropped.
 *
 * @throws if `data` is shorter than POSITION_NFT_STATE_LEN.
 */
export function parsePositionNftAccount(data: Buffer): {
  mint: PublicKey;
  slab: PublicKey;
  userIdx: number;
  bump: number;
  isLong: boolean;
  positionSize: bigint;
  entryPriceE6: bigint;
  mintedAt: bigint;
  positionOwner: PublicKey;
} {
  if (data.length < POSITION_NFT_STATE_LEN) {
    throw new Error(
      `PositionNft account too small: ${data.length} < ${POSITION_NFT_STATE_LEN}`
    );
  }

  // DataView is scoped to the logical account-data slice so callers can
  // pass either a full Buffer or a subarray without offset drift.
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const bump = data[9];
  const slab = new PublicKey(data.subarray(16, 48));
  const userIdx = dv.getUint16(48, true);
  const mint = new PublicKey(data.subarray(56, 88));
  const entryPriceE6 = dv.getBigUint64(88, true);
  const positionSize = dv.getBigUint64(96, true);
  const isLong = data[104] === 1;
  const mintedAt = dv.getBigInt64(144, true);
  const positionOwner = new PublicKey(data.subarray(160, 192));

  return {
    mint,
    slab,
    userIdx,
    bump,
    isLong,
    positionSize,
    entryPriceE6,
    mintedAt,
    positionOwner,
  };
}
