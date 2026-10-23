/**
 * Position NFT layout v3 (S1-2 incarnation binding) - local port of the SDK's `abi/nft.ts` parse half.
 *
 * Source: percolator-sdk PR #414 (branch `fix/v22-sdk-nft-v3-incarnation`) @ 32b8942, against percolator-nft
 * `fix/v22-audit-1017-s1-2-nft-incarnation` @ 95dcece (layout 199 -> 239 B, version 2 -> 3). The installed
 * `@percolatorct/sdk` 8.0.0 parser accepts ONLY version 2 and would throw on every v3 account, so the app parses
 * with this port. When the SDK that carries #414 is the installed dependency, delete this file and import
 * `parsePositionNftAccountV3` / `isNftCurrentForPortfolio` from `@percolatorct/sdk`.
 *
 * Only the parser, the length constants and `isNftCurrentForPortfolio` are ported (the encoders, PDA derivation and
 * account lists are unchanged by S1-2 and keep coming from the installed SDK).
 */
import { PublicKey } from "@solana/web3.js";

/**
 * On-chain PositionNftV16 state (239 bytes at layout version 3, matches percolator-nft/src/state_v16.rs).
 *
 *   [0..8]     magic             u64 ("PERCNFT\0")
 *   [8]        version           u8   (3; the pre-S1-2 layout was 2)
 *   [9]        bump              u8
 *   [10..42]   portfolio_account [u8; 32]
 *   [42..74]   nft_mint          [u8; 32]
 *   [74..78]   asset_index       u32 LE
 *   [78]       side_at_mint      u8
 *   [79..95]   basis_pos_q_at_mint i128
 *   [95..111]  f_snap_at_mint    i128
 *   [111..119] market_id_at_mint u64
 *   [119..127] epoch_snap_at_mint u64
 *   [127..159] position_owner_at_mint [u8; 32]
 *   [159..167] minted_at         i64
 *   [167..199] last_holder       [u8; 32]
 *   [199..231] portfolio_market_group [u8; 32]   (S1-2, v3)
 *   [231..239] portfolio_id_at_mint   u64 LE     (S1-2, v3)
 *
 * NOTE: [167..199] is `last_holder`, not reserved space. #138 claimed those
 * bytes for the field the transfer hook rewrites on every transfer, and
 * `ReconcileBurnedNft` reads it to decide who receives the released escrow and
 * the rent — it is account 6 of that instruction and cannot be derived, only
 * read from here.
 *
 * S1-2: v3 appends the portfolio INCARNATION `(portfolio_market_group, portfolio_id_at_mint)`.
 * An NFT whose pair differs from the live portfolio's `(marketGroupId, portfolioId)` was minted
 * against an earlier incarnation of the same keypair and is rejected on-chain with
 * Custom(28) StalePortfolioIncarnation; see {@link isNftCurrentForPortfolio}.
 */
export const POSITION_NFT_STATE_LEN_V3 = 239;
/** Length of the pre-S1-2 (layout version 2) PositionNft account. Parsed as legacy, always stale. */
export const POSITION_NFT_LEGACY_V2_LEN = 199;
const POSITION_NFT_MAGIC = 0x5045_5243_4e46_5400n;
const POSITION_NFT_VERSION = 3;
const POSITION_NFT_LEGACY_VERSION = 2;

export interface PositionNftStateV3 {
  version: number;
  bump: number;
  portfolioAccount: PublicKey;
  nftMint: PublicKey;
  assetIndex: number;
  sideAtMint: number;
  basisPosQAtMint: bigint;
  fSnapAtMint: bigint;
  marketIdAtMint: bigint;
  epochSnapAtMint: bigint;
  positionOwnerAtMint: PublicKey;
  /** Backward-compatible alias for positionOwnerAtMint. */
  positionOwner: PublicKey;
  mintedAt: bigint;
  /**
   * The wallet the transfer hook last recorded as holding this NFT (#138).
   *
   * This is the sole authorisation for `ReconcileBurnedNft`: the program
   * releases the escrowed portfolio and all rent to whichever account matches
   * it, and refuses any other. Supply it as account 6 of
   * `ACCOUNTS_NFT_RECONCILE` — there is no way to derive it.
   */
  lastHolder: PublicKey;
  /**
   * S1-2: `market_group_id` of the portfolio at mint. `null` for a legacy v2 (199 B) account,
   * which carries no incarnation binding.
   */
  portfolioMarketGroup: PublicKey | null;
  /**
   * S1-2: the portfolio's permanent `portfolio_id` at mint. `null` for a legacy v2 account.
   */
  portfolioIdAtMint: bigint | null;
  /**
   * True for a pre-S1-2 layout-v2 (199 B) account. It has no incarnation binding, so it can never be
   * shown to match a live portfolio: treat it as stale ({@link isNftCurrentForPortfolio} returns false).
   */
  isLegacyV2: boolean;
}

/**
 * Read a little-endian signed i128 from a DataView at `offset`.
 *
 * Both 64-bit halves are read as UNSIGNED to avoid the sign-extension that
 * `getBigInt64` applies to the low half. If bit 127 of the combined 128-bit
 * value is set the result is negative and two's-complement sign extension is
 * applied explicitly.
 *
 * Bug fixed (S-3): the prior code used `getBigInt64` for the low half, which
 * returns a *signed* BigInt. When bit 63 of the low half is set the value is
 * negative (e.g. -1 rather than 0xffffffffffffffff), so OR-ing it with the
 * shifted high half collapses the sign bit into all high bits and corrupts the
 * result.
 *
 * @param view   DataView wrapping the raw account bytes
 * @param offset Byte offset of the i128 field (little-endian)
 * @returns      Signed BigInt in the range [-2^127, 2^127)
 */
function readI128FromView(view: DataView, offset: number): bigint {
  const lo = view.getBigUint64(offset, true);
  const hi = view.getBigUint64(offset + 8, true);
  const unsigned = (hi << 64n) | lo;
  const SIGN_BIT = 1n << 127n;
  if (unsigned >= SIGN_BIT) {
    return unsigned - (1n << 128n);
  }
  return unsigned;
}

/**
 * Parse a PositionNft account from raw bytes.
 *
 * Accepts layout version 3 (239 B) and, as a LEGACY read, version 2 (199 B). A v2 account predates the
 * S1-2 incarnation binding: it is returned with `isLegacyV2 = true` and `portfolioMarketGroup` /
 * `portfolioIdAtMint` set to `null`. Legacy is parsed rather than rejected so a holder's old NFT stays
 * visible (to offer EmergencyBurn rent reclaim) instead of silently vanishing, but it is never
 * "current": {@link isNftCurrentForPortfolio} returns false for it, because nothing proves it belongs to
 * the live portfolio incarnation.
 *
 * @param data Raw account data.
 * @returns The decoded state.
 * @throws if data is shorter than 199 bytes, the magic is wrong, the version is not 2 or 3, or a v3 account is shorter than 239 bytes.
 * @example
 * const nft = parsePositionNftAccountV3(info.data);
 * if (!isNftCurrentForPortfolio(nft, portfolio)) {
 *   // stale: hide it as a position, offer EmergencyBurn, refuse send
 * }
 */
export function parsePositionNftAccountV3(data: Uint8Array): PositionNftStateV3 {
  if (data.length < POSITION_NFT_LEGACY_V2_LEN) {
    throw new Error(
      `PositionNft account too small: ${data.length} < ${POSITION_NFT_LEGACY_V2_LEN}`,
    );
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = view.getBigUint64(0, true);
  if (magic !== POSITION_NFT_MAGIC) {
    throw new Error("PositionNft account has invalid magic");
  }
  const version = data[8];
  if (version !== POSITION_NFT_VERSION && version !== POSITION_NFT_LEGACY_VERSION) {
    throw new Error(`PositionNft account has invalid version: ${version}`);
  }
  const isLegacyV2 = version === POSITION_NFT_LEGACY_VERSION;
  if (!isLegacyV2 && data.length < POSITION_NFT_STATE_LEN_V3) {
    throw new Error(
      `PositionNft v3 account too small: ${data.length} < ${POSITION_NFT_STATE_LEN_V3}`,
    );
  }

  const positionOwnerAtMint = new PublicKey(data.subarray(127, 159));

  return {
    version,
    bump: data[9],
    portfolioAccount: new PublicKey(data.subarray(10, 42)),
    nftMint: new PublicKey(data.subarray(42, 74)),
    assetIndex: view.getUint32(74, true),
    sideAtMint: data[78],
    basisPosQAtMint: readI128FromView(view, 79),
    fSnapAtMint: readI128FromView(view, 95),
    marketIdAtMint: view.getBigUint64(111, true),
    epochSnapAtMint: view.getBigUint64(119, true),
    positionOwnerAtMint,
    positionOwner: positionOwnerAtMint,
    mintedAt: view.getBigInt64(159, true),
    lastHolder: new PublicKey(data.subarray(167, 199)),
    portfolioMarketGroup: isLegacyV2 ? null : new PublicKey(data.subarray(199, 231)),
    portfolioIdAtMint: isLegacyV2 ? null : view.getBigUint64(231, true),
    isLegacyV2,
  };
}

/**
 * S1-2: does this NFT belong to the live incarnation of its portfolio?
 *
 * Mirrors the program's `verify_portfolio_incarnation`: true only when the live portfolio id is
 * non-zero and both `portfolioIdAtMint` and `portfolioMarketGroup` equal the live portfolio's
 * `portfolioId` / `marketGroupId`. A legacy v2 account (no binding) is never current. A stale NFT
 * confers no authority (the program answers Custom(28)); the client should not show it as a
 * position, should refuse to send it, and should offer EmergencyBurn to reclaim its rent.
 *
 * This does not compare `nft.portfolioAccount` to the portfolio's address; callers look the NFT up
 * by that key already.
 *
 * @param nft       A parsed PositionNft ({@link parsePositionNftAccountV3}).
 * @param portfolio The live decoded portfolio (`marketGroupId` and `portfolioId` are used).
 * @returns true if the NFT is bound to this exact portfolio incarnation.
 * @example
 * const current = isNftCurrentForPortfolio(parsePositionNftAccountV3(nftData), parsePortfolioV17(pfData));
 */
export function isNftCurrentForPortfolio(
  nft: Pick<PositionNftStateV3, "portfolioMarketGroup" | "portfolioIdAtMint">,
  portfolio: { marketGroupId: PublicKey; portfolioId: bigint },
): boolean {
  if (nft.portfolioMarketGroup === null || nft.portfolioIdAtMint === null) return false;
  return (
    portfolio.portfolioId !== 0n &&
    nft.portfolioIdAtMint === portfolio.portfolioId &&
    nft.portfolioMarketGroup.equals(portfolio.marketGroupId)
  );
}

/**
 * Classification of a held NFT against the live portfolio it names.
 *   - "current": v3, same (market group, portfolio id) as the live portfolio.
 *   - "stale":   v3, minted against an EARLIER incarnation of the portfolio keypair (the program answers Custom(28)).
 *   - "legacy":  pre-S1-2 v2 (199 B), carries no incarnation, so staleness cannot be shown from the account.
 */
export type NftIncarnationStatus = "current" | "stale" | "legacy";

/**
 * Classify a parsed NFT against the live portfolio.
 *
 * @param nft       Parsed NFT ({@link parsePositionNftAccountV3}).
 * @param portfolio The live decoded portfolio (`marketGroupId`, `portfolioId`).
 * @returns "current" | "stale" | "legacy".
 * @example
 * if (nftIncarnationStatus(parsed, pf) === "stale") offerEmergencyBurn();
 */
export function nftIncarnationStatus(
  nft: Pick<PositionNftStateV3, "portfolioMarketGroup" | "portfolioIdAtMint" | "isLegacyV2">,
  portfolio: { marketGroupId: PublicKey | null | undefined; portfolioId: bigint },
): NftIncarnationStatus {
  if (nft.isLegacyV2) return "legacy";
  if (!portfolio.marketGroupId) return "stale";
  return isNftCurrentForPortfolio(nft, { marketGroupId: portfolio.marketGroupId, portfolioId: portfolio.portfolioId })
    ? "current"
    : "stale";
}

/**
 * True when the NFT must not be shown as a position or sent.
 *
 * @param status        {@link nftIncarnationStatus} of the NFT.
 * @param legacyIsStale Whether the NFT program in use is the S1-2 build ({@link resolveNftLegacyIsStale}): that build
 *   rejects 199 B accounts, so a legacy NFT authorizes nothing. While the program is still pre-S1-2 a legacy NFT is the
 *   only layout and fully valid, so it stays visible (hiding it would blank every held position).
 * @returns true if the NFT is stale (v3 of an earlier incarnation, or legacy under the S1-2 program).
 */
export function isNftStale(status: NftIncarnationStatus, legacyIsStale: boolean): boolean {
  return status === "stale" || (status === "legacy" && legacyIsStale);
}

/**
 * What can be done about a stale NFT.
 *   - "burnable":      v3 of an earlier incarnation: EmergencyBurn reclaims its rent (the program answers Custom(28) to Burn).
 *   - "unrecoverable": legacy v2 under the S1-2 program: Burn, EmergencyBurn and Reconcile all reject accounts under
 *                      239 B (InvalidAccountData, NOT 28), so the app cannot recover it. Offer no burn button.
 */
export type StaleNftKind = "burnable" | "unrecoverable";

/** @param nft Parsed NFT. @returns The recovery kind for a stale NFT. */
export function staleNftKind(nft: Pick<PositionNftStateV3, "isLegacyV2">): StaleNftKind {
  return nft.isLegacyV2 ? "unrecoverable" : "burnable";
}
