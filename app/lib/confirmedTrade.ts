export interface ConfirmedTradeParams {
  lpIdx: number;
  userIdx: number;
  size: bigint;
  limitPriceE6?: bigint;
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
