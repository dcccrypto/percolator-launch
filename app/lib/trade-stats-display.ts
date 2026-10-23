/**
 * Telling "we did not record this" apart from "this is zero".
 *
 * The trades panel reported **Fees Paid: 0**. The trader paid a fee on every
 * fill — 20 / 10 / 5 bps depending on the market — and the indexer simply does
 * not know the amount: `extractFeeFromTransfers` is deliberately neutered
 * (#153) because deriving the fee from the trader's SOL delta was recording
 * collateral movements as fees. `trades.fee` is 0 on every row, the panel
 * summed it, and presented the sum as a fact.
 *
 * Volume has the same shape and is quieter about it. `total_volume` is
 * `size × price`, and `price` is 0 wherever the slab's post-state was missing
 * from the payload (`extractPriceFromLogs` is neutered too, #150 — the log
 * scan was a price-poisoning vector). Those rows contribute nothing, so the
 * headline understates by whole trades rather than by a rounding error.
 *
 * This is the #2556 pattern again: an absent value rendered as a definite one.
 * The rule here is the same — say "unknown" when it is unknown, and let the
 * figure start reporting itself the moment a backfill populates the column.
 *
 * Deliberately NOT done: reconstructing the fee client-side. It is computable
 * in principle (`notional × fee_bps`), but `fee_bps` is not in the indexer's
 * ParsedFill on `main` or on `feat/v18-wire-migration`, and inventing a number
 * the indexer refused to invent would repeat the mistake #153 exists to stop.
 */

export type FeesPaidDisplay =
  /** A real recorded total. */
  | { kind: "known"; atoms: string }
  /** Trades exist, but no fee was recorded for any of them. */
  | { kind: "unrecorded" }
  /** No trades, so there is nothing to report. */
  | { kind: "no-trades" };

export function feesPaidDisplay(
  totalTrades: number,
  feesRecorded: number,
  totalFees: string,
): FeesPaidDisplay {
  if (totalTrades <= 0) return { kind: "no-trades" };
  // Not "totalFees === 0": a genuine zero-fee total and an unrecorded one are
  // the same string. Only the count of rows carrying a fee separates them.
  if (feesRecorded <= 0) return { kind: "unrecorded" };
  return { kind: "known", atoms: totalFees };
}

export type VolumeDisplay =
  /** Every trade had a price; the figure is complete. */
  | { kind: "complete"; atoms: string }
  /** Some trades had no price and contributed nothing. */
  | { kind: "partial"; atoms: string; missing: number; total: number }
  /** No trade had a price, so the figure is meaningless rather than small. */
  | { kind: "unknown"; missing: number }
  /** v2.2 QA L-1: no lot-aware v2.2 indexer is attested, so a lot market's size x price may be in the wrong unit. */
  | { kind: "unverified" }
  | { kind: "no-trades" };

export function volumeDisplay(
  totalTrades: number,
  tradesMissingPrice: number,
  totalVolume: string,
): VolumeDisplay {
  if (totalTrades <= 0) return { kind: "no-trades" };
  const missing = Math.max(0, Math.min(tradesMissingPrice, totalTrades));
  if (missing >= totalTrades) return { kind: "unknown", missing };
  if (missing > 0) {
    return { kind: "partial", atoms: totalVolume, missing, total: totalTrades };
  }
  return { kind: "complete", atoms: totalVolume };
}

/** Why a figure is missing, in words a trader can act on. */
export const FEES_UNRECORDED_NOTE =
  "Not recorded — the indexer does not capture the fee amount, so this is unknown rather than zero. The market's trading fee was still charged on every fill.";

/**
 * v2.2 QA L-1: on a v2.2 build the volume is shown only once a lot-aware v2.2 indexer is attested
 * (`NEXT_PUBLIC_V22_INDEXER_LOT_AWARE=1`). The v2.2 indexer draft (percolator-indexer #218 @ 827aa7f) has no lot
 * handling at all (`git grep -i lot` in src: nothing), so its size x price on a lot market is unproven; the figure is
 * withheld instead of risking a wrong-unit number. Trading is NOT gated on it. Flag off: unchanged.
 */
export function gateVolumeForV22(v: VolumeDisplay, v22: boolean, indexerLotAware: boolean): VolumeDisplay {
  if (!v22 || indexerLotAware || v.kind === "no-trades") return v;
  return { kind: "unverified" };
}

export const VOLUME_UNVERIFIED_NOTE = "Not shown on Devnet v2.2 yet: the v2.2 trade indexer is not verified for lot markets.";

export function volumeNote(v: VolumeDisplay): string | undefined {
  if (v.kind === "unverified") return VOLUME_UNVERIFIED_NOTE;
  if (v.kind === "partial") {
    return `${v.missing} of ${v.total} trades have no recorded price and are not included in this figure.`;
  }
  if (v.kind === "unknown") {
    return "No trade has a recorded price, so volume cannot be computed.";
  }
  return undefined;
}
