import { humanizeError } from "@/lib/errorMessages";

/**
 * Error mapping for WithdrawInsuranceAsset (tag 57) — the creator fee-claim flow.
 *
 * The tag-57 handler in the deployed v17 wrapper (percolator-prog v16_program.rs,
 * `handle_withdraw_insurance_asset`) can fail with these codes. Ordinals are read
 * directly from the v17 PercolatorError enum (CI-asserted `custom_code` tests):
 *
 *   Custom(8)  Unauthorized                     — signer is neither the asset's
 *                                                  insurance_operator nor marketauth
 *   Custom(9)  InvalidInstruction               — amount == 0 (or asset out of range)
 *   Custom(21) EngineLockActive                  — requested amount exceeds the
 *                                                  currently-withdrawable capacity
 *                                                  (health/insurance/vault caps), or the
 *                                                  market is not in Live mode
 *   Custom(47) InsuranceWithdrawCooldownActive   — F-1: the market-wide withdrawal
 *                                                  cooldown has not elapsed
 *   Custom(48) InsuranceWithdrawCeilingExceeded  — F-2: deposits-only ceiling exceeded
 *                                                  (terminal-path only in the deployed
 *                                                  wrapper, but mapped defensively so a
 *                                                  future cutover surfaces it clearly)
 *
 * NOTE: the app-wide `ERROR_CODE_MAP` in errorMessages.ts is now the v17 table
 * (the playground cutover updated it — 8→"Unauthorized", 21→"engine lock stuck",
 * plus 47/48 and the fee-split ordinals 50-61), so it is no longer wrong for
 * these codes. We still map tag-57 locally for two reasons: (a) the claim flow
 * wants creator-specific, actionable phrasing ("connect the creator wallet",
 * "wait for the cooldown"); and (b) code 21's shared message prescribes a
 * TRADE-flow remedy ("the market needs a fresh re-seed") that is wrong here —
 * for a tag-57 claim, 21 means the requested amount exceeds what is currently
 * withdrawable, so "claim less / try later" is the correct guidance. There is no
 * double mapping: `mapCreatorClaimError` checks these tag-57 codes first and
 * defers everything else to `humanizeError` (the shared v17 map).
 */

const CLAIM_ERROR_MESSAGES: Record<number, string> = {
  8: "Not authorized — only this market's insurance operator (the creator) can claim its fees. Connect the creator wallet.",
  9: "Nothing to claim — there is no accrued fee revenue for this market yet.",
  21: "Claim exceeds the amount currently withdrawable from the insurance pool. Some fees may be temporarily reserved to back open positions — try again later or claim a smaller amount.",
  47: "Withdrawal cooldown is still active. Creator fees can only be claimed once per cooldown window — please wait for it to elapse and try again.",
  48: "Claim exceeds the deposits-only withdrawal ceiling configured for this market.",
};

function extractCustomCode(msg: string): number | null {
  // JSON form from getSignatureStatuses: {"Custom":47}
  const j = msg.match(/"Custom"\s*:\s*(\d+)/);
  if (j) return parseInt(j[1], 10);
  // Enum form: Custom(47)
  const e = msg.match(/Custom\((\d+)\)/);
  if (e) return parseInt(e[1], 10);
  // Hex form: custom program error: 0x2f
  const h = msg.match(/custom program error:\s*0x([0-9a-fA-F]+)/i);
  if (h) return parseInt(h[1], 16);
  return null;
}

/**
 * Turn a raw claim-tx error into a specific, actionable message. Returns a
 * precise sentence for the tag-57 codes above; otherwise defers to the shared
 * humanizeError (blockhash expiry, user-rejected, insufficient SOL, etc.).
 */
export function mapCreatorClaimError(rawMsg: string): string {
  const code = extractCustomCode(rawMsg);
  if (code !== null && CLAIM_ERROR_MESSAGES[code]) {
    return CLAIM_ERROR_MESSAGES[code];
  }
  return humanizeError(rawMsg);
}
