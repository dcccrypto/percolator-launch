/**
 * The fee a trade is expected to be charged, in bps (product review 2026-10-28, T-1).
 *
 * The program charges the market's base fee PLUS, when the P2 fee channel is charged, the matcher's quote fee, PLUS on a growth open
 * the busy-side (utilisation) fee (percolator-prog v16_program.rs handle_trade_cpi). The ticket's "Fee" row and the confirm screen
 * used to show the base fee alone, so a JUP fill charged ~53 bps against 30 shown, and a PENGU open ~2% against 0.30%.
 *
 * This is an ESTIMATE for display: the quote and busy-side parts are the ticket's own pre-trade reads. The signed cap
 * (`ticketLimits.fee.signedFeeBps` / the send-time read) is unchanged and is still what bounds the charge.
 */
export function estimatedTotalFeeBps(
  baseFeeBps: bigint,
  fee: { charged: boolean; requestedBps: bigint; utilFeeBps?: bigint } | null | undefined,
): bigint {
  if (!fee) return baseFeeBps;
  const quote = fee.charged ? fee.requestedBps : 0n;
  return baseFeeBps + quote + (fee.utilFeeBps ?? 0n);
}

/** True when the estimate includes more than the base fee (the row then says "est." and names the parts). */
export function feeHasExtras(baseFeeBps: bigint, totalBps: bigint): boolean {
  return totalBps > baseFeeBps;
}
