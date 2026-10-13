export interface ConfirmedTradeParams {
  lpIdx: number;
  userIdx: number;
  size: bigint;
  limitPriceE6?: bigint;
  /** #3459: the feed price the confirmed limit was built from (useTrade checks it against the chain). */
  limitFeedE6?: bigint;
  /** P2 fee channel: taker-signed fee cap (lib/limits/fee-channel.ts). */
  feeBps?: bigint;
  /** UX WP-2: the app is waiting for the market before any prompt (useTrade -> sendTxWaiting). */
  onWaiting?: (waiting: boolean) => void;
  /** UX WP-3: "Stop" on a long wait; keep waiting past the schedule; told after ~30 s. */
  abortSignal?: AbortSignal;
  keepWaiting?: boolean;
  onWaitingLong?: () => void;
}

/**
 * Binds the protected fill-price reviewed in the confirmation modal
 * to the submitted trade payload.
 *
 * Undefined or non-positive values preserve the existing useTrade
 * fallback, which derives a limit from the latest live mark.
 */
export function bindConfirmedLimitPrice(
  params: Omit<ConfirmedTradeParams, "limitPriceE6" | "limitFeedE6">,
  confirmedLimitPriceE6?: bigint,
  confirmedFeedE6?: bigint,
): ConfirmedTradeParams {
  if (
    confirmedLimitPriceE6 === undefined ||
    confirmedLimitPriceE6 <= 0n
  ) {
    return params;
  }

  return {
    ...params,
    limitPriceE6: confirmedLimitPriceE6,
    ...(confirmedFeedE6 !== undefined && confirmedFeedE6 > 0n ? { limitFeedE6: confirmedFeedE6 } : {}),
  };
}
