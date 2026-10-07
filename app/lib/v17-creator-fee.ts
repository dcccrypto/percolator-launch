/**
 * Creator fee claim — READ PATH ONLY.
 *
 * WHY THIS EXISTS
 * ---------------
 * Before the 2026-07-23 wrapper change the creator's fee leg was credited into
 * the market's **insurance domain budget** — i.e. the loss backstop the engine
 * draws down to cover negative trader PnL. There was therefore no on-chain
 * figure for "the creator earned X": creator revenue was commingled with the
 * backstop, and the only withdraw path (tag 57 `WithdrawInsuranceAsset`) drained
 * the backstop itself. Any "claimable" number a UI showed would have been a lie.
 *
 * The wrapper accrued the creator leg into a dedicated market-wide counter,
 * `WrapperConfigV16.creator_fee_claimable_atoms`, withdrawn by its own
 * instruction (`WithdrawCreatorFee`, tag 90).
 *
 * ⚠ SUPERSEDED BY GH#420 (percolator-prog `a327b4b0`): the creator leg now
 * accrues **PER ASSET**, into `AssetOracleProfileV16.creator_fee_claimable_atoms`
 * (offset 400 inside each asset's profile — see
 * {@link AssetOracleProfileV17.creatorFeeClaimableAtoms} in the SDK). The
 * market-wide config counter this module used to read exclusively is now a
 * LEGACY pot: it stopped receiving new accruals the moment GH#420 shipped, and
 * only holds whatever had accrued before that (still real, still claimable —
 * see below). A read that only looks at the config counter therefore shows
 * ~0 on every market seeded after GH#420, even when real per-asset fees are
 * sitting unclaimed (dcccrypto/percolator-prog#507). Verified against a live
 * devnet market (`Azagguvr…`, captured in
 * `__tests__/fixtures/Azagguvr.market.json`): legacy pot = 0, per-asset
 * counter = 4,358,743 atoms.
 *
 * WHAT `WithdrawCreatorFee` (tag 90) ACTUALLY PAYS (percolator-prog
 * `handle_withdraw_creator_fee`, verified against deployed `a9318945`):
 * `claimable = profile[asset_index].creator_fee_claimable_atoms` PLUS, **for
 * asset 0 only**, the legacy `cfg.creator_fee_claimable_atoms` pot (asset 0's
 * admin inherited the legacy pot so nothing already accrued was stranded when
 * GH#420 shipped; assets 1..N draw only from their own counter). This module
 * mirrors that sum exactly, for asset 0 (the only asset the UI's claim flow
 * ever targets — see `lib/creator-fee-claim-ix.ts`).
 *
 * See docs/superpowers/specs/2026-07-23-creator-fee-claim-design.md in
 * percolator-prog for the original design (still accurate for the legacy pot
 * and the claim mechanics; the accrual site is what GH#420 moved).
 *
 * SCOPE: reads only. No instruction building, no claim UI — deliberately.
 *
 * OFFSETS — why nothing here is hand-rolled
 * -----------------------------------------
 * The legacy counter was carved out of the existing 10-byte `_padding_split`
 * tail of `WrapperConfigV16` at its only 8-aligned slot, so it is **additive in
 * place**:
 *
 *   560  creator_share_bps      u16   ─┐
 *   562  lp_share_bps           u16    │ unchanged
 *   564  insurance_share_bps    u16   ─┘
 *   566  _padding_split        [u8;2]       (was [u8;10])
 *   568  creator_fee_claimable_atoms  u64   ← legacy pot, frozen post-GH#420
 *   576  = V17_WRAPPER_CONFIG_LEN            (UNCHANGED)
 *
 * Because the config length did not move, neither did `V17_MARKET_GROUP_OFF`
 * (592), the embedded engine config (`V17_ENGINE_CONFIG_OFF` = 624) or the
 * per-asset profiles (1350 + n·2325). The per-asset counter lives at profile-
 * relative offset 400 (absolute 1750 for asset 0), also purely additive at the
 * tail of `AssetOracleProfileV16`. Both decodes are delegated to the SDK
 * (`parseWrapperConfigV17` / `parseAssetOracleProfileV17`) so neither offset is
 * a hand-rolled literal in this repo — the 496→576 incident was caused by
 * app-local copies of layout constants going stale.
 *
 * BACKWARD COMPATIBILITY: markets created before the 2026-07-23 upgrade have
 * the legacy-pot bytes zeroed (they were padding), and markets created before
 * GH#420 start their per-asset counter at zero too, so the sum reads `0n` and
 * accrues fresh. A `0n` here is a legitimate "nothing claimable yet", not a
 * parse failure.
 */

import { PublicKey } from "@solana/web3.js";
import {
  parseAssetOracleProfileV17,
  parseWrapperConfigV17,
  V17_ASSET_ORACLE_PROFILE_LEN,
  V17_CREATOR_FEE_CLAIMABLE_OFF,
  V17_HEADER_LEN,
  V17_WRAPPER_CONFIG_LEN,
} from "@percolatorct/sdk";
import { marketGeometry, isUnsupportedLayout, isWrapperMarketAccount } from "@/lib/v22/layout";

/**
 * Absolute byte offset of the LEGACY market-wide `creator_fee_claimable_atoms`
 * inside a v17 market account = header (16) + config-relative 568 = **584**.
 * This is only HALF of what `readCreatorFeeClaimable` returns — see the
 * per-asset counter at {@link V17_ASSET_PROFILE_OFF} + 400 (absolute 1750 for
 * asset 0), which GH#420 made the primary accrual site. Derived, never
 * hardcoded. Exported for documentation and for the layout guard in tests —
 * the parse below goes through the SDK, not through this constant.
 */
export const V17_CREATOR_FEE_CLAIMABLE_ABS_OFF =
  V17_HEADER_LEN + V17_CREATOR_FEE_CLAIMABLE_OFF; // 584

/**
 * True while the counter occupies the FINAL 8 bytes of the wrapper config, i.e.
 * while the field is additive-in-place and every downstream offset
 * (`V17_MARKET_GROUP_OFF`, engine config @624, asset profiles @1350) is
 * unmoved. If a future SDK grows `V17_WRAPPER_CONFIG_LEN` for this field, this
 * flips to `false` and the offset-migration work that implies has NOT been
 * done here. Asserted in `__tests__/lib/v17-creator-fee.test.ts`.
 */
export const V17_CREATOR_FEE_CLAIMABLE_IS_CONFIG_TAIL =
  V17_CREATOR_FEE_CLAIMABLE_OFF + 8 === V17_WRAPPER_CONFIG_LEN;

/** Byte offset of the first asset's `AssetOracleProfileV16` in a v17 market. */

/** The creator's unclaimed fee revenue on one v17 market. */
export interface CreatorFeeClaimable {
  /**
   * Raw counter value in collateral atoms (`u64`). Always a `bigint` — atoms
   * exceed `Number.MAX_SAFE_INTEGER` long before they become an implausible
   * balance, so this must never be narrowed to `number` before formatting.
   * `0n` means "nothing accrued yet" (including on pre-upgrade markets).
   */
  atoms: bigint;
  /** Mint the payout is denominated in — use its decimals to format `atoms`. */
  collateralMint: PublicKey;
  /**
   * The wallet allowed to call `WithdrawCreatorFee` (tag 90): asset 0's
   * `asset_admin`, which defaults to the creator at InitMarket.
   *
   * Deliberately NOT `insurance_operator` (nor `marketauth`): the launch wizard's
   * full create flow (`StakeInitPool` + `BindInsuranceAuthority`) rotates
   * `marketauth`, `insurance_authority` AND `insurance_operator` to program PDAs,
   * so on a real staked market none of those is the creator any more — a gate on
   * `insurance_operator` would hide the claim button from EVERY wallet, because no
   * wallet holds a PDA key. `asset_admin` is the one field that stays the
   * creator's wallet through staking, and it is what the on-chain tag-90 handler
   * now checks (re-gated 2026-07-23 from `insurance_operator` to `asset_admin`).
   * Verified on the live staked market `7FBXdrm1…`: `insurance_operator` is a PDA
   * `6a3tiSd2…` while `asset_admin` is the creator wallet `7JVQvrAf…`.
   *
   * `null` when the account is too short to carry an asset profile.
   */
  claimAuthority: PublicKey | null;
}

/**
 * Read the creator's claimable fee balance from raw v17 market account bytes.
 *
 * Returns asset 0's per-asset counter (GH#420) PLUS the legacy market-wide
 * pot — exactly the sum `handle_withdraw_creator_fee` (tag 90) computes as
 * `claimable` for `assetIndex: 0` on chain (percolator-prog `a9318945`). Asset
 * 0 is the only asset the UI's claim flow ever targets
 * (`lib/creator-fee-claim-ix.ts` hardcodes `assetIndex: 0`), so this is the
 * exact number a "Claim" button backed by that instruction can pay out.
 *
 * @param data Raw account bytes of a v17 market (slab) account.
 * @returns the claimable balance, or `null` when `data` is not a v17 MARKET
 *          account (portfolio / ledger / registry accounts share the v17 magic
 *          and version, so the kind byte is what discriminates) or is too short
 *          to contain a full wrapper config.
 */
export function readCreatorFeeClaimable(
  data: Uint8Array,
): CreatorFeeClaimable | null {
  if (!isWrapperMarketAccount(data)) return null;
  let profileOff: number;
  try {
    const geo = marketGeometry(data, "readCreatorFeeClaimable");
    if (data.length < geo.groupOff) return null;
    profileOff = geo.slotsBase; // 1350 on v2.1, 1398 on v2.2
  } catch (e) {
    if (isUnsupportedLayout(e)) return null;
    throw e;
  }

  const cfg = parseWrapperConfigV17(data, V17_HEADER_LEN);

  let claimAuthority: PublicKey | null = null;
  // GH#420: asset 0's per-asset counter — 0n when the asset-profile region is
  // absent (account too short), never fabricated. The legacy pot below is
  // still returned in that case: it is real money that does not depend on the
  // profile being readable.
  let assetClaimableAtoms = 0n;
  if (data.length >= profileOff + V17_ASSET_ORACLE_PROFILE_LEN) {
    // Single parse serves both fields — asset_admin (profile-relative offset
    // 368, the field the on-chain tag-90 handler gates on) and
    // creator_fee_claimable_atoms (profile-relative offset 400, GH#420's
    // per-asset accrual). Read through the SDK's parser so neither byte offset
    // is a hand-rolled literal here. See `claimAuthority` above for why the
    // authority is asset_admin and not insurance_operator/marketauth.
    const profile = parseAssetOracleProfileV17(data, profileOff);
    claimAuthority = profile.assetAdmin;
    assetClaimableAtoms = profile.creatorFeeClaimableAtoms;
  }

  return {
    // Per-asset (asset 0) + legacy pot — matches what tag 90 would actually
    // pay for `assetIndex: 0`. See the module doc comment for the on-chain
    // arithmetic this mirrors.
    atoms: assetClaimableAtoms + cfg.creatorFeeClaimableAtoms,
    collateralMint: cfg.collateralMint,
    claimAuthority,
  };
}

/**
 * Whether `wallet` is the wallet that can claim `claim` — i.e. asset 0's
 * `asset_admin` (see {@link CreatorFeeClaimable.claimAuthority}), the field the
 * on-chain tag-90 handler gates on and the only one that survives the wizard's
 * PDA rotations on a staked market.
 *
 * Fails closed: an unknown claim authority (account too short to carry an asset
 * profile) or a disconnected wallet is `false`, never "probably yes".
 */
export function isCreatorFeeClaimAuthority(
  claim: CreatorFeeClaimable | null | undefined,
  wallet: PublicKey | null | undefined,
): boolean {
  if (!claim?.claimAuthority || !wallet) return false;
  return claim.claimAuthority.equals(wallet);
}
