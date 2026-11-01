/**
 * `WithdrawCreatorFee` (tag 90) instruction builder, shared by the single-market
 * claim panel and the dashboard's per-market / claim-all buttons.
 *
 * WHY THIS IS SEPARATE FROM THE HOOK
 *
 * `useCreatorClaim` builds this instruction inline, but it reads the market
 * bytes from `useSlabState()` — a SlabProvider bound to one market via the route
 * params. That is why the claim UI could only ever exist one-per-market, inside
 * each row's expand drawer: a creator with eight markets had to open eight
 * drawers and could see no total. Claiming across markets needs the same
 * instruction built from bytes fetched directly, with no provider.
 *
 * Every GUARD lives here rather than in either caller, so the two paths cannot
 * drift into disagreeing about what a valid claim is. All of them fail CLOSED:
 * an unreadable counter, a wallet that is not the claim authority, a zero
 * balance and an over-claim each throw rather than producing an instruction the
 * chain will reject.
 */

import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  ACCOUNTS_WITHDRAW_CREATOR_FEE,
  buildAccountMetas,
  buildIx,
  deriveVaultAuthority,
  encodeWithdrawCreatorFee,
  WELL_KNOWN,
} from "@percolatorct/sdk";
import { readAssetAdmin, readAssetControlSeqs, readAssetP4Flags } from "@/lib/v18-wire";
import {
  buildClaimCreatorFeeToPayeeIxsV22,
  creatorFeeClaimRouteV22,
  decodeCreatorFeePayeeV22,
  hasCreatorFeePayeeFlagV22,
  type CreatorFeeClaimRouteV22,
} from "@/lib/v22/sdk/creator-fee-payee-v22";
import { isCreatorFeeClaimAuthority, readCreatorFeeClaimable } from "@/lib/v17-creator-fee";

export interface BuildCreatorFeeClaimArgs {
  programId: PublicKey;
  /** The market (slab) account this claim debits. */
  market: PublicKey;
  /** Raw bytes of that market account, read at SEND time — see `amount` below. */
  raw: Uint8Array;
  /** Must be asset 0's `asset_admin`; anything else is rejected on chain. */
  claimant: PublicKey;
  /** Defaults to the full accrued balance. Tag 90 is exact-amount. */
  amount?: bigint;
}

export interface BuiltCreatorFeeClaim {
  instruction: TransactionInstruction;
  /** The exact amount encoded, so a caller can report what it submitted. */
  amount: bigint;
  collateralMint: PublicKey;
}

/** Thrown for every rejected claim, so callers can show the reason verbatim. */
export class CreatorFeeClaimError extends Error {}

/**
 * Build one tag-90 instruction.
 *
 * `raw` must be read at send time, not at render time: the amount on the wire
 * has to match the counter this instruction will debit, and tag 90 is
 * CAS-bound to asset 0's `authority_epoch` lane — a stale epoch fails the CAS.
 */
export async function buildCreatorFeeClaimIx(
  args: BuildCreatorFeeClaimArgs,
): Promise<BuiltCreatorFeeClaim> {
  const { programId, market, raw, claimant } = args;

  const current = readCreatorFeeClaimable(raw);
  if (!current) {
    throw new CreatorFeeClaimError("This market does not expose a creator fee counter.");
  }
  if (!isCreatorFeeClaimAuthority(current, claimant)) {
    throw new CreatorFeeClaimError(
      "Only this market's admin (the creator) can claim its fees. Connect the creator wallet.",
    );
  }

  const amount = args.amount ?? current.atoms;
  if (amount <= 0n) {
    throw new CreatorFeeClaimError(
      "Nothing to claim — this market has not accrued any creator fees yet.",
    );
  }
  if (amount > current.atoms) {
    throw new CreatorFeeClaimError(
      "Claim exceeds the accrued creator fees for this market. The claim is exact-amount — request no more than the accrued balance.",
    );
  }

  const collateralMint = current.collateralMint;
  const [vaultPda] = deriveVaultAuthority(programId, market);
  const destToken = await getAssociatedTokenAddress(collateralMint, claimant);
  const vaultToken = await getAssociatedTokenAddress(collateralMint, vaultPda, true);

  // LIVE authority_epoch, not +1 — read from the same bytes as the amount.
  const authorityEpoch = readAssetControlSeqs(raw, 0).authorityEpoch;
  const data = encodeWithdrawCreatorFee({ amount, assetIndex: 0, authorityEpoch });
  const keys = buildAccountMetas(ACCOUNTS_WITHDRAW_CREATOR_FEE, [
    claimant, // authority — asset 0's asset_admin
    market,
    destToken, // claimant's collateral ATA
    vaultToken, // market vault ATA (source)
    vaultPda, // vault authority PDA
    WELL_KNOWN.tokenProgram,
  ]);

  return { instruction: buildIx({ programId, keys, data }), amount, collateralMint };
}

// ============================================================================
// prog #587 (#644): the PAYEE route. Once asset 0's asset_admin is burned AFTER a payee was recorded (tag 125, p4 bit 3), tag 90
// is permissionless: anyone may send it, it pays ONLY the payee's canonical ATA for the collateral mint, and it takes the payee
// record as account [6]. CloseSlab waits for this pot (it is no longer re-booked to the protocol).
// ============================================================================

/** Asset 0's creator-fee route read from the market bytes (`claim_route`), or null when the profile is unreadable. */
export function creatorFeeRouteOf(raw: Uint8Array): CreatorFeeClaimRouteV22 | null {
  try {
    return creatorFeeClaimRouteV22(readAssetAdmin(raw, 0), hasCreatorFeePayeeFlagV22(readAssetP4Flags(raw, 0)));
  } catch {
    return null;
  }
}

export interface BuildCreatorFeePayeeClaimArgs {
  programId: PublicKey;
  market: PublicKey;
  /** Raw market bytes, read at SEND time (amount + authority epoch). */
  raw: Uint8Array;
  /** The payee record account's data (`deriveCreatorFeePayeeV22(programId, market, 0)`). */
  payeeRecord: Uint8Array;
  /** Any connected wallet: it signs and pays the payee ATA rent if the ATA does not exist yet. */
  caller: PublicKey;
}

export interface BuiltCreatorFeePayeeClaim {
  instructions: TransactionInstruction[];
  amount: bigint;
  payee: PublicKey;
  collateralMint: PublicKey;
}

/**
 * Build the permissionless claim to the recorded payee: idempotent payee-ATA create + tag 90 (7 accounts) for the full balance.
 * Fails closed: not the payee route, nothing owed, or a payee record the program would refuse (136) each throw.
 */
export function buildCreatorFeePayeeClaimIxs(args: BuildCreatorFeePayeeClaimArgs): BuiltCreatorFeePayeeClaim {
  const { programId, market, raw, caller } = args;
  if (creatorFeeRouteOf(raw) !== "Payee") {
    throw new CreatorFeeClaimError("This market's creator fees are not paid to a recorded payee.");
  }
  const current = readCreatorFeeClaimable(raw);
  if (!current || current.atoms <= 0n) {
    throw new CreatorFeeClaimError("Nothing to send: no creator fees have accrued since the last payout.");
  }
  let payee: PublicKey;
  try {
    const rec = decodeCreatorFeePayeeV22(args.payeeRecord);
    if (!rec.market.equals(market) || rec.assetIndex !== 0) throw new Error("record of another market");
    payee = rec.payee;
  } catch {
    throw new CreatorFeeClaimError("This market's fee payee record could not be read. Try again in a moment.");
  }
  const authorityEpoch = readAssetControlSeqs(raw, 0).authorityEpoch;
  const [vaultPda] = deriveVaultAuthority(programId, market);
  const vaultToken = getAssociatedTokenAddressSync(current.collateralMint, vaultPda, true);
  const instructions = buildClaimCreatorFeeToPayeeIxsV22({
    programId, market, caller, assetIndex: 0, payee, vaultMint: current.collateralMint, vaultToken,
    amount: current.atoms, authorityEpoch,
  });
  return { instructions, amount: current.atoms, payee, collateralMint: current.collateralMint };
}
