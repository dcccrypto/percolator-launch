/**
 * Withdraw refusal copy (v2.2 QA P-2).
 *
 * The engine refuses ANY withdrawal while the account has an open leg: `withdraw_not_atomic` returns
 * Stale (Custom 19) whenever the active bitmap is non-empty, by design, whatever the price freshness.
 * That 19 is not a stale price, so the stale-price line is wrong for it. A 19 on an account that is
 * known to be flat is a real staleness case and keeps the catching-up line.
 */
export const WITHDRAW_OPEN_POSITIONS_MESSAGE = "Close your positions before withdrawing.";
export const WITHDRAW_STALE_MESSAGE = "The price is still catching up after a big move. This usually takes a few minutes; try again then.";

/**
 * The line for a Custom(19) on a withdrawal. `openLegs`: true / false when the portfolio was read before
 * sending, null when it could not be read (an open leg is then by far the likeliest cause: the engine
 * returns 19 for it unconditionally).
 */
export function engineStaleWithdrawMessage(openLegs: boolean | null): string {
  return openLegs === false ? WITHDRAW_STALE_MESSAGE : WITHDRAW_OPEN_POSITIONS_MESSAGE;
}
