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
 * The wrapper now accrues the creator leg into a dedicated counter,
 * `creator_fee_claimable_atoms`, withdrawn by its own instruction
 * (`WithdrawCreatorFee`, tag 90). That counter is the ONLY honest source for a
 * claimable balance, and this module is the app's typed read path to it.
 *
 * See docs/superpowers/specs/2026-07-23-creator-fee-claim-design.md in
 * percolator-prog for the full design.
 *
 * SCOPE: reads only. No instruction building, no claim UI — deliberately.
 *
 * OFFSETS — why nothing here is hand-rolled
 * -----------------------------------------
 * The counter was carved out of the existing 10-byte `_padding_split` tail of
 * `WrapperConfigV16` at its only 8-aligned slot, so it is **additive in place**:
 *
 *   560  creator_share_bps      u16   ─┐
 *   562  lp_share_bps           u16    │ unchanged
 *   564  insurance_share_bps    u16   ─┘
 *   566  _padding_split        [u8;2]       (was [u8;10])
 *   568  creator_fee_claimable_atoms  u64   ← NEW, fills the config's tail
 *   576  = V17_WRAPPER_CONFIG_LEN            (UNCHANGED)
 *
 * Because the config length did not move, neither did `V17_MARKET_GROUP_OFF`
 * (592), the embedded engine config (`V17_ENGINE_CONFIG_OFF` = 624) or the
 * per-asset profiles (1350 + n·1797). No app offset needed migrating. The
 * decode itself is delegated to the SDK's `parseWrapperConfigV17` so the byte
 * offset has exactly one owner (`V17_CREATOR_FEE_CLAIMABLE_OFF`), never a
 * literal in this repo — the 496→576 incident was caused by app-local copies of
 * layout constants going stale.
 *
 * BACKWARD COMPATIBILITY: markets created before the wrapper upgrade have those
 * bytes zeroed (they were padding), so the counter reads `0n` and accrues fresh.
 * A `0n` here is a legitimate "nothing claimable yet", not a parse failure.
 */

import { PublicKey } from "@solana/web3.js";
import {
  isV17MarketAccount,
  parseAssetOracleProfileV17,
  parseWrapperConfigV17,
  V17_ASSET_ORACLE_PROFILE_LEN,
  V17_CREATOR_FEE_CLAIMABLE_OFF,
  V17_HEADER_LEN,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_GROUP_OFF,
  V17_WRAPPER_CONFIG_LEN,
} from "@percolatorct/sdk";

/**
 * Absolute byte offset of `creator_fee_claimable_atoms` inside a v17 market
 * account = header (16) + config-relative 568 = **584**. Derived, never
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
const V17_ASSET_PROFILE_OFF = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN; // 1350

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
   * `insurance_operator`, which defaults to the creator at InitMarket.
   *
   * Deliberately NOT `marketauth`: `StakeInitPool` rotates `marketauth` to the
   * stake-pool PDA but never touches `insurance_operator`, so on a staked market
   * `marketauth` is the pool — showing it as the claimant would tell the real
   * creator their revenue belongs to someone else (and a UI that gated the claim
   * button on `marketauth` would hide the button from the only wallet that can
   * actually claim).
   *
   * `null` when the account is too short to carry an asset profile.
   */
  claimAuthority: PublicKey | null;
}

/**
 * Read the creator's claimable fee balance from raw v17 market account bytes.
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
  if (!isV17MarketAccount(data)) return null;
  if (data.length < V17_MARKET_GROUP_OFF) return null;

  const cfg = parseWrapperConfigV17(data, V17_HEADER_LEN);

  let claimAuthority: PublicKey | null = null;
  if (data.length >= V17_ASSET_PROFILE_OFF + V17_ASSET_ORACLE_PROFILE_LEN) {
    claimAuthority = parseAssetOracleProfileV17(
      data,
      V17_ASSET_PROFILE_OFF,
    ).insuranceOperator;
  }

  return {
    atoms: cfg.creatorFeeClaimableAtoms,
    collateralMint: cfg.collateralMint,
    claimAuthority,
  };
}

/**
 * Whether `wallet` is the wallet that can claim `claim`.
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
