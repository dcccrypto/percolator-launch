/**
 * Centralized NFT program constants, PDA derivation, and account parser.
 *
 * The percolator-nft program is a standalone Solana program (separate from the
 * main Percolator program) that acts as the Token-2022 TransferHook and owns
 * the mint_authority PDA used for position NFT mints.
 *
 * PDA seeds (matches percolator-nft/src/state_v16.rs):
 *   PositionNft state : ["position_nft", portfolio_account, asset_index_u16_LE]
 *   Mint authority    : ["mint_authority"]
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

function _u16Buf(value: number, label: string): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`${label} must be a u16`);
  }
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, value, true);
  return buf;
}

function readI128(view: DataView, offset: number): bigint {
  const lo = view.getBigUint64(offset, true);
  const hi = view.getBigUint64(offset + 8, true);
  const unsigned = (hi << 64n) | lo;
  const signBit = 1n << 127n;
  return unsigned >= signBit ? unsigned - (1n << 128n) : unsigned;
}

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

/**
 * Derive the `PositionNft` state PDA.
 * Seeds: ["position_nft", portfolio_account, asset_index_u16_LE]
 */
export function deriveNftPda(
  portfolioAccount: PublicKey,
  assetIndex: number,
  programId: PublicKey = PERCOLATOR_NFT_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [_textEncoder.encode("position_nft"), portfolioAccount.toBytes(), _u16Buf(assetIndex, "assetIndex")],
    programId
  );
}

/**
 * @deprecated v16 Position NFT mints are fresh signer keypairs, not PDAs.
 */
export function deriveNftMint(
  _portfolioAccount: PublicKey,
  _assetIndex: number,
  _programId: PublicKey = PERCOLATOR_NFT_PROGRAM_ID
): [PublicKey, number] {
  throw new Error("deriveNftMint: v16 NFT mint is a fresh signer keypair, not a PDA");
}

/**
 * Derive the `mint_authority` PDA for the NFT program.
 * Seeds: ["mint_authority"]
 */
export function deriveMintAuthority(
  programId: PublicKey = PERCOLATOR_NFT_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [_textEncoder.encode("mint_authority")],
    programId
  );
}

/**
 * Derive the Token-2022 ExtraAccountMetaList PDA for a Position NFT mint.
 * Seeds: ["extra-account-metas", nft_mint]
 */
export function deriveExtraAccountMetas(
  nftMint: PublicKey,
  programId: PublicKey = PERCOLATOR_NFT_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [_textEncoder.encode("extra-account-metas"), nftMint.toBytes()],
    programId
  );
}

// ---------------------------------------------------------------------------
// Account parser
// ---------------------------------------------------------------------------

/** Byte length of a valid PositionNftV16 account. */
export const POSITION_NFT_STATE_LEN = 199;

const POSITION_NFT_MAGIC = 0x5045_5243_4e46_5400n;
const POSITION_NFT_VERSION = 2;

/**
 * Parse a `PositionNftV16` account buffer.
 *
 * Canonical layout (percolator-nft/src/state_v16.rs, 199 bytes):
 *   [0..8]     magic                  u64 ("PERCNFT\0")
 *   [8]        version                u8
 *   [9]        bump                   u8
 *   [10..42]   portfolio_account      [u8; 32]
 *   [42..74]   nft_mint               [u8; 32]
 *   [74..78]   asset_index            u32 LE
 *   [78]       side_at_mint           u8
 *   [79..95]   basis_pos_q_at_mint    i128
 *   [95..111]  f_snap_at_mint         i128
 *   [111..119] market_id_at_mint      u64
 *   [119..127] epoch_snap_at_mint     u64
 *   [127..159] position_owner_at_mint [u8; 32]
 *   [159..167] minted_at              i64
 *   [167..199] _reserved
 */
export function parsePositionNftAccount(data: Uint8Array): {
  version: number;
  mint: PublicKey;
  nftMint: PublicKey;
  portfolioAccount: PublicKey;
  assetIndex: number;
  bump: number;
  sideAtMint: number;
  isLong: boolean;
  positionSize: bigint;
  basisPosQAtMint: bigint;
  fSnapAtMint: bigint;
  marketIdAtMint: bigint;
  epochSnapAtMint: bigint;
  mintedAt: bigint;
  positionOwner: PublicKey;
  positionOwnerAtMint: PublicKey;
} {
  if (data.length < POSITION_NFT_STATE_LEN) {
    throw new Error(
      `PositionNft account too small: ${data.length} < ${POSITION_NFT_STATE_LEN}`
    );
  }

  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = dv.getBigUint64(0, true);
  if (magic !== POSITION_NFT_MAGIC) {
    throw new Error("PositionNft account has invalid magic");
  }
  if (data[8] !== POSITION_NFT_VERSION) {
    throw new Error(`PositionNft account has invalid version: ${data[8]}`);
  }

  const nftMint = new PublicKey(data.subarray(42, 74));
  const basisPosQAtMint = readI128(dv, 79);
  const positionOwnerAtMint = new PublicKey(data.subarray(127, 159));
  const positionSize = basisPosQAtMint < 0n ? -basisPosQAtMint : basisPosQAtMint;

  return {
    version: data[8],
    mint: nftMint,
    nftMint,
    portfolioAccount: new PublicKey(data.subarray(10, 42)),
    assetIndex: dv.getUint32(74, true),
    bump: data[9],
    sideAtMint: data[78],
    isLong: data[78] === 1,
    positionSize,
    basisPosQAtMint,
    fSnapAtMint: readI128(dv, 95),
    marketIdAtMint: dv.getBigUint64(111, true),
    epochSnapAtMint: dv.getBigUint64(119, true),
    mintedAt: dv.getBigInt64(159, true),
    positionOwner: positionOwnerAtMint,
    positionOwnerAtMint,
  };
}
