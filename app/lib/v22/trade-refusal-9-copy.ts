/**
 * Copy for a v2.2 trade refused Custom(9) (Q-1 / Q-6). Kept import-free so lib/errorMessages.ts can
 * use it without pulling the decoders (lib/v22/trade-refusal-9.ts has the diagnosis).
 */
/** v2.2 wrapper `WRAPPER_MAX_PORTFOLIO_ASSETS` (cap 4; InitMarket with 5 refused 14 on devnet). */
export const V22_MAX_POSITIONS = 4;

export type V22Custom9Cause = "position-cap" | "price-limit" | "fee-cap" | "undetermined";

/**
 * THE one message for the position cap (wrapper 126, the classified Custom(9), and the ticket's own pre-check). `cap` is the market's
 * `max_portfolio_assets` (config); unknown (null / undefined / not a positive integer) drops the number instead of guessing one.
 * The app ticket trades asset 0 only, so the advice is "close one", never "try another asset".
 */
export function positionCapCopy(cap?: number | null): string {
  const n = typeof cap === "number" && Number.isInteger(cap) && cap > 0 ? cap : null;
  const limit = n === null ? "the most positions this market allows" : `the maximum of ${n} position${n === 1 ? "" : "s"} on this market`;
  // Only a close frees a slot: no deposit or wait cures it (review L-8).
  return `This account already holds ${limit}. Close one to open another. Nothing changed.`;
}

export const V22_CUSTOM9_COPY: Record<V22Custom9Cause, string> = {
  "position-cap": positionCapCopy(),
  "price-limit":
    "The market's fill price moved past your price limit, so the order was not placed and nothing changed. Try again, or try a smaller size.",
  "fee-cap": "The market's trading fee changed while the order was being sent, so it was not placed and nothing changed. Try again.",
  undetermined: "The program refused this order before it filled, so nothing changed. Try again in a moment.",
};

/** Immediate (pre-diagnosis) line for a v2.2 trade refused 9: no slippage guess, no jargon. */
export const V22_CUSTOM9_GENERIC = V22_CUSTOM9_COPY.undetermined;

/** Wrapper 93 (a crowd-side open when the market maker's room on that side is used up). Plain: no "capacity" mechanics. */
export const V22_SIDE_FULL_COPY = "New positions on this side are paused: the market is full on this side. Closing is always allowed. You can also open on the other side, or try again later.";

/** A bare Custom(9) that did NOT come from the trade ticket (deposit, withdraw, close...): nothing is claimed about the cause. */
export const V22_CUSTOM9_OFF_TICKET = "The program refused this request, so nothing changed. Try again in a moment.";

/**
 * Wrapper codes 126 / 127 (percolator-prog fix/v22-p1-position-cap-error): the named version of the position-cap refusal that
 * used to come back as a bare 9. 126 = the user's own account (same line the pre-check and the classified 9 show);
 * 127 = the counterparty / LP is at its cap, which is not the user's doing.
 */
export const V22_POSITION_CAP_REACHED_COPY = positionCapCopy();
export const V22_COUNTERPARTY_CAP_COPY = "The other side of this trade is at its limit right now, so the order was not placed and nothing changed. Try again later.";

/** Q-6: the ticket blocks a new asset up front when the account is at the market's cap (the program refuses it 49 or 9). */
export const V22_POSITION_CAP_COPY = positionCapCopy();

/** Pure: would an OPEN on `assetIndex` be a new asset for an account holding `heldAssets` that is already at `cap` (the market's `max_portfolio_assets`; default the program cap)? */
export function positionCapBlocksOpen(heldAssets: readonly number[], assetIndex: number, cap: number = V22_MAX_POSITIONS): boolean {
  return !heldAssets.includes(assetIndex) && new Set(heldAssets).size >= cap;
}
