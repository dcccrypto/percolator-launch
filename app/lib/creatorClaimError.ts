import { humanizeError } from "@/lib/errorMessages";

/**
 * Error mapping for WithdrawCreatorFee (tag 90) — the creator fee-claim flow.
 *
 * Ordinals are the v17 PercolatorError enum (percolator-prog `src/v16_program.rs`,
 * CI-asserted `custom_code` tests). The set below is exactly what
 * `handle_withdraw_creator_fee` can return, read off the handler:
 *
 *   Custom(8)  Unauthorized          — signer is not asset 0's insurance_operator.
 *                                       marketauth is NOT an alternate gate here (on a
 *                                       staked market it is the stake-pool PDA), so the
 *                                       remedy is always "connect the creator wallet".
 *   Custom(9)  InvalidInstruction    — amount == 0. Tag 90 is an EXACT debit and
 *                                       deliberately does NOT use tag 84's "0 means
 *                                       withdraw everything" sentinel.
 *   Custom(21) EngineLockActive      — the market is not Live (nor a fully wound-down
 *                                       Resolved), or `withdraw_insurance_surplus_not_atomic`
 *                                       found the shared unbudgeted surplus momentarily
 *                                       too thin. Fails closed: nothing is debited.
 *   Custom(25) EngineCounterUnderflow— the handler's fail-closed `checked_sub`, which is
 *                                       unreachable behind the Custom(62) check. Reaching
 *                                       it means an internal invariant broke, so it is
 *                                       mapped as "report this", never as user error.
 *   Custom(62) CreatorFeeOverClaim   — amount > creator_fee_claimable_atoms. Rejected, never
 *                                       partial-filled; nothing is debited on rejection.
 *
 * DELIBERATELY ABSENT: 47 InsuranceWithdrawCooldownActive and 48
 * InsuranceWithdrawCeilingExceeded. Those gate tag 57 (WithdrawInsuranceAsset)
 * because it draws down the loss backstop. `handle_withdraw_creator_fee` applies
 * NEITHER — the creator counter is disjoint from the backstop — so mapping them
 * here would invent a rate limit the program does not enforce. If one ever
 * surfaces it falls through to the shared v17 table, which states plainly what
 * it is.
 *
 * Why map locally at all when `ERROR_CODE_MAP` in errorMessages.ts is already the
 * v17 table: (a) the claim flow wants creator-specific, actionable phrasing; and
 * (b) codes 9 and 21 have shared messages that are wrong for this path — 9's
 * mentions matcher config, and 21's prescribes a market re-seed, whereas for a
 * claim they mean "amount was zero" and "retry with less / later". There is no
 * double mapping: `mapCreatorClaimError` checks these codes first and defers
 * everything else to `humanizeError`.
 */

const CLAIM_ERROR_MESSAGES: Record<number, string> = {
  8: "Not authorized — only this market's insurance operator (the creator) can claim its fees. Connect the creator wallet.",
  9: "Nothing to claim — the claim amount was zero. This market has not accrued any creator fees yet.",
  21: "The market cannot pay the claim right now — it is not live, or the fees are momentarily reserved elsewhere. Nothing was deducted; try again later or claim a smaller amount.",
  25: "Creator fee accounting is inconsistent on-chain — nothing was claimed. Please report this to the team.",
  62: "Claim exceeds the creator fees this market has accrued. The claim is exact-amount and does not partial-fill — nothing was deducted. Refresh the balance and claim that exact amount or less.",
};

function extractCustomCode(msg: string): number | null {
  // JSON form from getSignatureStatuses: {"Custom":62}
  const j = msg.match(/"Custom"\s*:\s*(\d+)/);
  if (j) return parseInt(j[1], 10);
  // Enum form: Custom(62)
  const e = msg.match(/Custom\((\d+)\)/);
  if (e) return parseInt(e[1], 10);
  // Hex form: custom program error: 0x3e
  const h = msg.match(/custom program error:\s*0x([0-9a-fA-F]+)/i);
  if (h) return parseInt(h[1], 16);
  return null;
}

/**
 * Turn a raw claim-tx error into a specific, actionable message. Returns a
 * precise sentence for the tag-90 codes above; otherwise defers to the shared
 * humanizeError (blockhash expiry, user-rejected, insufficient SOL, etc.).
 */
export function mapCreatorClaimError(rawMsg: string): string {
  const code = extractCustomCode(rawMsg);
  if (code !== null && CLAIM_ERROR_MESSAGES[code]) {
    return CLAIM_ERROR_MESSAGES[code];
  }
  return humanizeError(rawMsg);
}
