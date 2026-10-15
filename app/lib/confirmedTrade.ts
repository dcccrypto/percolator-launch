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
  /** v2.2 QA Q-3: false = surface a waitable refusal now (lib/limits/price-stall.ts waitPolicy). */
  shouldWait?: (e: import("@/lib/tx").SimulationRefusal) => boolean;
  /** v2.2 QA Q-7: total wait budget (ms) before a refusal that never clears is surfaced. */
  maxWaitMs?: number;
  /** Devnet v2.1: a Custom(121) order waits to be resent ("Refreshing positions…"). */
  onRefreshingPositions?: (refreshing: boolean) => void;
  /** Multi-asset market: the order needs its refresh cranks as their own transaction first (the wallet may open twice). */
  onTwoTx?: (txCount: number) => void;
  /** #49: broadcast, waiting for confirmation (useTrade -> sendTx onProgress). */
  onConfirming?: () => void;
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
