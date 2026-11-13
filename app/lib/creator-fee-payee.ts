/**
 * prog #587 (#644): the creator-fee PAYEE in the app's admin flows.
 *
 * A burned asset admin used to mean the creator fee was lost for good (tag 90 needed the admin's signature; CloseSlab re-booked
 * the pot to the protocol). While the admin key is still live it can now record a payee (wrapper tag 125); after the burn the payee
 * is frozen and anyone can send the fees to it (tag 90 payee route, `buildCreatorFeePayeeClaimIxs`).
 *
 * The app keeps that invisible: burning the admin key records the burning wallet as the payee in the SAME transaction, unless a
 * payee was recorded earlier (then it is left as it is; tag 125 refuses a no-op anyway).
 */
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { buildSetCreatorFeePayeeIxV22, hasCreatorFeePayeeFlagV22 } from "@/lib/v22/sdk/creator-fee-payee-v22";
import { LAYOUT_V22, readWrapperHeader } from "@/lib/v22/sdk/layout";

/** The wrapper VERSION of a market account (header u16 at byte 8). */
export function wrapperVersionOf(raw: Uint8Array): number {
  return readWrapperHeader(raw, "wrapperVersionOf").version;
}

export interface CreatorFeePayeeBeforeBurnArgs {
  programId: PublicKey;
  market: PublicKey;
  /** The live asset admin, which signs both the payee record and the burn. */
  assetAdmin: PublicKey;
  /** Asset 0's live generation (`engine.asset.market_id`). */
  marketId: bigint;
  /** Asset 0's live authority epoch, read from the same bytes. */
  authorityEpoch: bigint;
  /** Asset 0's `p4_flags` (bit 3 = a payee is already recorded). */
  p4Flags: number;
  /** Payee to record; default the asset admin itself. */
  payee?: PublicKey;
  /**
   * The market's wrapper VERSION (header bytes 8..9). Tag 125 exists only on the v2.2 wrapper (VERSION 19, rc23 + prog #644); on
   * any other market nothing is prepended and the burn is the pre-#587 one.
   */
  wrapperVersion: number;
}

/**
 * The instructions that must precede the asset-admin burn in the same transaction, and the authority epoch the burn must carry.
 * No payee yet: `[tag 125(payee, epoch)]` and `burnEpoch = epoch + 1` (tag 125 advances the epoch). Payee already recorded:
 * `[]` and `burnEpoch = epoch`.
 */
export function creatorFeePayeeBeforeBurn(a: CreatorFeePayeeBeforeBurnArgs): { ixs: TransactionInstruction[]; burnEpoch: bigint } {
  if (a.wrapperVersion !== LAYOUT_V22.version || hasCreatorFeePayeeFlagV22(a.p4Flags)) return { ixs: [], burnEpoch: a.authorityEpoch };
  const ix = buildSetCreatorFeePayeeIxV22({
    programId: a.programId,
    market: a.market,
    assetAdmin: a.assetAdmin,
    assetIndex: 0,
    marketId: a.marketId,
    payee: a.payee ?? a.assetAdmin,
    authorityEpoch: a.authorityEpoch,
  });
  return { ixs: [ix], burnEpoch: a.authorityEpoch + 1n };
}
