/**
 * Growth BUSY-SIDE (utilisation) fee helpers shared by the ticket and the close dialogs (Council r9).
 * The fee is charged on an OPEN only, on growth markets only, and is not part of the Entry (#3810).
 */

/** Structural subset of `MarketLimits` (avoids a lib -> hook import). */
export interface BusyFeeMarketView {
  growth?: unknown;
  growthRoom?: "known" | "none" | "loading" | "error";
}

/**
 * Can an open on this market have paid a busy-side fee? A growth record exists (`growth` is built) or is present but not readable yet
 * (`growthRoom` loading / error / known). Unknown market limits (null / undefined, mock) = not a growth market: nothing changes there.
 */
export function marketMayChargeBusyFee(l: BusyFeeMarketView | null | undefined): boolean {
  if (!l) return false;
  if (l.growth != null) return true;
  return l.growthRoom !== undefined && l.growthRoom !== "none";
}

/** The closed part's share of a whole-position amount (atoms), rounded to nearest. */
export function busyFeeShareAtoms(totalAtoms: bigint, closeAbs: bigint, positionAbs: bigint): bigint {
  if (totalAtoms <= 0n || positionAbs <= 0n || closeAbs <= 0n) return 0n;
  if (closeAbs >= positionAbs) return totalAtoms;
  return (totalAtoms * closeAbs + positionAbs / 2n) / positionAbs;
}

/**
 * Council r9 review MED-1: the fee cap an order that went through the confirm screen signs, built from the REVIEWED terms whatever the P2
 * flag: the total fee the confirm showed (base + the matcher's quote + the busy-side fee) plus the usual slippage margin
 * (`defaultFeeCapMarginBps`, signedFeeForQuote's constant), never above the market's maximum trading fee. Signed exactly (never the chain read).
 */
export function confirmedFeeCapBps(reviewedTotalBps: bigint, marginBps: number, maxTradingFeeBps?: bigint | null): bigint {
  const cap = reviewedTotalBps + BigInt(Math.max(0, Math.floor(marginBps)));
  return maxTradingFeeBps != null && maxTradingFeeBps > 0n && cap > maxTradingFeeBps ? maxTradingFeeBps : cap;
}

/** What the confirm screen showed (and what is signed). */
export interface ConfirmedTerms {
  direction: "long" | "short";
  leverage: number;
  /**
   * Snapshot: the fee cap signed (bps, `confirmedFeeCapBps`). Live: the total fee (base + quote + busy-side) the order would be charged now,
   * which must still fit under the snapshot's cap (its margin absorbs a small move of the quote).
   */
  signedFeeBps: bigint;
  busyFeeBps: bigint;
}

/**
 * Council r9 Attacker A / B: the order must be signed with the terms the trader reviewed. Returns the refusal line (nothing was sent) when
 * the live ticket no longer matches the confirm snapshot, else null. A LOWER busy-side fee or cap is not a refusal (the snapshot cap still
 * covers it and only the fee actually charged is paid).
 */
export function confirmDriftRefusal(snapshot: ConfirmedTerms, live: ConfirmedTerms): string | null {
  if (live.direction !== snapshot.direction) {
    return "The side changed while you were reviewing. Review it again. Nothing was sent.";
  }
  if (live.leverage !== snapshot.leverage) {
    return "The leverage changed while you were reviewing. Review it again. Nothing was sent.";
  }
  // What moved decides the words: the growth busy-side rate rose, else (the total no longer fits the signed cap) the market maker's fee.
  if (live.busyFeeBps > snapshot.busyFeeBps) {
    return "The busy-side fee changed while you were reviewing: it is now higher than the one you saw. Review it again. Nothing was sent.";
  }
  if (live.signedFeeBps > snapshot.signedFeeBps) {
    return "The market maker's fee changed while you were reviewing: it is now higher than the one you saw. Review it again. Nothing was sent.";
  }
  return null;
}
