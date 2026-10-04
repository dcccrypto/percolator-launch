"use client";

import { useMemo } from "react";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useSlabState } from "@/components/providers/SlabProvider";
import { computeLiqPrice } from "@/lib/trading";
import { onChainMarkE6, terminalPositionPnl } from "@/lib/position-pnl";

/**
 * Phase 2: Returns the liquidation price (as bigint e6) for the current user's
 * open position on the active slab. Returns null when no position exists or
 * when required data is not yet available.
 */
export function useLiqPrice(): bigint | null {
  const realUserAccount = useUserAccount();
  const { config, params, slabAddress, adlFactors, wrapperConfigV17 } = useSlabState();

  return useMemo(() => {
    if (!realUserAccount) return null;

    const { account } = realUserAccount;
    if (account.positionSize === 0n) return null;

    // v17/v18 does not store entry_price on-chain. A browser-local cache miss
    // therefore must not automatically erase liquidation-risk information.
    // The entry comes from the SAME shared resolution as every PnL surface
    // (lib/position-pnl.ts: server > cache > back-solve over EFFECTIVE size), so
    // the chart's liq line, the dock and the badge cannot disagree. Risk math
    // keeps using `.entry` (the mark when unknown), like the other surfaces.
    // v17 `markEwmaE6` is already post-inversion: do NOT apply `invert` again.
    const oraclePriceE6 = onChainMarkE6(config, wrapperConfigV17 !== null) ?? 0n;

    const resolvedEntry = terminalPositionPnl({
      account,
      slabAddress,
      accountIdx: realUserAccount.idx,
      adlFactors,
      adlApplicable: wrapperConfigV17 !== null,
      markE6: oraclePriceE6,
      initialMarginBps: params?.initialMarginBps ?? 1000n,
      maintenanceMarginBps: params?.maintenanceMarginBps ?? 500n,
    });

    if (resolvedEntry.entry <= 0n) return null;

    // EFFECTIVE size (engine maintenance runs over effective_abs_q, v16.rs:13896-13912).
    // Unknown ADL state => no line at all, never one drawn from raw basis.
    const liq = resolvedEntry.liquidationPriceE6;
    if (liq === null) return null;

    // Long-side clamp: liq at/below $0 means there is no real chart line.
    return liq > 0n ? liq : null;
  }, [realUserAccount, config, params, slabAddress, adlFactors, wrapperConfigV17]);
}
