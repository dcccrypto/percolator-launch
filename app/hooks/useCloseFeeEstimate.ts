"use client";

import { useCallback, useMemo } from "react";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useMarketLimits } from "@/hooks/useMarketLimits";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { closeFeeBps } from "@/lib/limits/estimated-fee";
import type { MarketLimits } from "@/hooks/useMarketLimits";
import type { TicketLimitsInput } from "@/lib/limits/ticket";
import { marketMayChargeBusyFee } from "@/lib/v22/busy-fee";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab } from "@/lib/mock-trade-data";

/** The order a close of `closeAbs` from `positionSize` sends: the OPPOSITE side, reducing the position. */
export function closeOrderInput(
  limits: MarketLimits,
  positionSize: bigint,
  closeAbs: bigint,
  takerOwner: Uint8Array | null,
  markE6: bigint,
): TicketLimitsInput {
  return {
    limits,
    direction: positionSize > 0n ? "short" : "long",
    sizeQ: closeAbs,
    takerPosQ: positionSize,
    takerOwner,
    leverage: 1,
    limitPriceE6: 0n,
    markE6: markE6 > 0n ? markE6 : undefined,
    // Round 10: the deployed matcher prices the close on the wrapper's capital-derived depth (growth view) as a REDUCE; without the view the
    // close fee would be priced on the context's depth (~23 bps at every size).
    growth: limits?.growth ?? null,
  };
}

/**
 * #3726: the close previews' fee estimate for the market of the surrounding SlabProvider. Every close surface sits inside its market's
 * provider (the trade page's, or the on-demand one /portfolio and the other-market rows mount for the close), so this reads THAT market.
 *
 * Returns `(closeAbs) => bps` for a close of `closeAbs` from `positionSize`: base + the matcher's requested fee where the fee channel
 * charges it. Mock markets, and any read that is not available yet, give the base fee, as before.
 *
 * `limits`: the market's limits when the caller already reads them (the trade page's ticket and dock). Then no second read is started;
 * only the on-demand closes (/portfolio, other-market rows, the at-risk flows) read them here, while the modal is open.
 */
export function useCloseFeeEstimate(
  positionSize: bigint,
  baseFeeBps: bigint,
  markE6: bigint,
  limits?: MarketLimits | null,
): ((closeAbs: bigint) => bigint) & { busyFeeMayApply: boolean } {
  const { slabAddress } = useSlabState();
  const { publicKey } = useWalletCompat();
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  const own = useMarketLimits(mockMode || limits ? null : slabAddress);
  const marketLimits = limits ?? own;
  const fn = useCallback(
    (closeAbs: bigint) => {
      if (mockMode || positionSize === 0n) return baseFeeBps;
      return closeFeeBps(baseFeeBps, closeOrderInput(marketLimits, positionSize, closeAbs, publicKey ? publicKey.toBytes() : null, markE6));
    },
    [mockMode, positionSize, baseFeeBps, markE6, marketLimits, publicKey],
  );
  // r9: can the position being closed have paid a growth busy-side fee when it was opened? (the close dialog's net result needs to know)
  const busyFeeMayApply = !mockMode && marketMayChargeBusyFee(marketLimits);
  return useMemo(() => Object.assign((closeAbs: bigint) => fn(closeAbs), { busyFeeMayApply }), [fn, busyFeeMayApply]);
}
