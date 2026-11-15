/**
 * Retired markets: the SAME list the app uses (lib/blocklist.ts isBlockedSlab, hardcoded + NEXT_PUBLIC_BLOCKED_MARKET_ADDRESSES),
 * with the app's rule (hooks/useDeposit.ts): no new money and no new risk into a retired market, because it can strand funds;
 * money and risk may always LEAVE. So on /api/v1:
 *   POST /v1/deposits                       refused (market_retired)
 *   POST /v1/orders that add risk           refused (market_retired)
 *   reduce-only / reducing orders, POST /v1/positions/close, POST /v1/withdrawals   allowed
 *   GET /v1/markets                         retired markets are left out of the list (counted in `retired`)
 *   GET /v1/markets/{market} (and quote, depth, funding, accounts)   still answer, with `retired: true` on the market
 */
import { isBlockedSlab } from "@/lib/blocklist";
import { ApiError } from "../errors";

export function isRetiredMarket(market: string): boolean {
  return isBlockedSlab(market);
}

export function retiredMarket(what: string): ApiError {
  return new ApiError("market_retired", `this market is retired: ${what}. Closes, reduce-only orders and withdrawals still work so funds can leave`);
}
