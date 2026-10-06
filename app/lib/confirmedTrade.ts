export interface ConfirmedTradeParams {
  lpIdx: number;
  userIdx: number;
  size: bigint;
  limitPriceE6?: bigint;
  /** P2 fee channel: taker-signed fee cap (lib/limits/fee-channel.ts). */
  feeBps?: bigint;
  /** UX WP-2: the app is waiting for the market before any prompt (useTrade -> sendTxWaiting). */
  onWaiting?: (waiting: boolean) => void;
  /** UX WP-3: "Stop" on a long wait; keep waiting past the schedule; told after ~30 s. */
  abortSignal?: AbortSignal;
  keepWaiting?: boolean;
  onWaitingLong?: () => void;
  /** Devnet v2.1: a Custom(121) order waits to be resent ("Refreshing positions…"). */
  onRefreshingPositions?: (refreshing: boolean) => void;
}

/**
 * Binds the protected fill-price reviewed in the confirmation modal
 * to the submitted trade payload.
 *
 * Undefined or non-positive values preserve the existing useTrade
 * fallback, which derives a limit from the latest live mark.
 */
export function bindConfirmedLimitPrice(
  params: Omit<ConfirmedTradeParams, "limitPriceE6">,
  confirmedLimitPriceE6?: bigint,
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
  };
}
