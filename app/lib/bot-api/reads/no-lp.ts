/**
 * "No usable LP" for a market, told apart from the cases a retry can never fix.
 *
 * The LP lookup fails the same way for a market that has no LP yet and for one that cannot be traded at all (a dormant market whose
 * oracle has been stale for days, or one whose collateral the API cannot value). Reporting all of them as `no_lp` (retryable) sends a bot
 * into a retry loop on a market it can never trade through the API. So the market is looked at first: if its oracle is stale or its
 * collateral unsupported, the answer is `market_unsupported` (not retryable) with the reason; only a market that looks healthy keeps
 * `no_lp` (an LP may appear). Reducing orders and closes are not blocked by staleness where the chain allows them: they need an LP,
 * and without one nothing can be built, which this says plainly.
 */
import type { PublicKey } from "@solana/web3.js";
import { ApiError } from "../errors";
import { decodeMarket } from "./market";

export function explainNoLp(marketRaw: Uint8Array, at: { market: PublicKey; programId: PublicKey; slot: number }): ApiError {
  let view: ReturnType<typeof decodeMarket>;
  try {
    view = decodeMarket(marketRaw, at);
  } catch (e) {
    return e instanceof ApiError ? e : new ApiError("no_lp");
  }
  const collateralUnsupported = view.collateralDecimals === null;
  if (!view.oracle.stale && !collateralUnsupported) return new ApiError("no_lp");
  const reasons: string[] = [];
  if (view.oracle.stale) reasons.push(`its oracle price is stale (${view.oracle.ageSecs === null ? "never pushed" : `${Math.round(view.oracle.ageSecs)} s old`}, bound ${view.oracle.staleBoundSecs} s)`);
  if (collateralUnsupported) reasons.push(`its collateral (mint ${view.collateralMint}) is not one the API supports`);
  return new ApiError("market_unsupported", `this market has no usable LP and ${reasons.join(" and ")}, so nothing can be quoted or built on it through the API; this will not change by retrying`, {
    details: {
      reason: "no_usable_lp",
      oracleStale: view.oracle.stale,
      ageSecs: view.oracle.ageSecs,
      staleBoundSecs: view.oracle.staleBoundSecs,
      collateralMint: view.collateralMint,
      collateralSupported: !collateralUnsupported,
    },
  });
}
