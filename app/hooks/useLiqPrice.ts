"use client";

import { useMemo } from "react";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useSlabState } from "@/components/providers/SlabProvider";
import { computeLiqPrice, resolveEntryPrice } from "@/lib/trading";
import { getEntryPrice } from "@/lib/entry-price";
import { isSentinelValue } from "@/lib/health";
import { applyInvert, sanitizePriceE6 } from "@/lib/oraclePrice";

/**
 * Phase 2: Returns the liquidation price (as bigint e6) for the current user's
 * open position on the active slab. Returns null when no position exists or
 * when required data is not yet available.
 */
export function useLiqPrice(): bigint | null {
  const realUserAccount = useUserAccount();
  const { config, params, slabAddress } = useSlabState();

  return useMemo(() => {
    if (!realUserAccount) return null;

    const { account } = realUserAccount;
    if (account.positionSize === 0n) return null;

    const rawEntryPrice = account.entryPrice ?? 0n;

    const cachedEntryPrice =
      rawEntryPrice > 0n
        ? rawEntryPrice
        : getEntryPrice(
            slabAddress,
            realUserAccount.idx,
            account.owner.toBase58(),
          );

    // v17/v18 does not store entry_price on-chain. A browser-local cache miss
    // therefore must not automatically erase liquidation-risk information.
    //
    // Match the resolved-entry contract used by the other position surfaces:
    // display may treat source==="unknown" as an unknown Entry/PnL, while risk
    // math continues with resolvedEntry.entry.
    const oraclePriceE6 = config
      ? sanitizePriceE6(
          applyInvert(
            config.lastEffectivePriceE6,
            config.invert,
          ),
        )
      : 0n;

    const safePnl =
      account.pnl != null && !isSentinelValue(account.pnl)
        ? account.pnl
        : 0n;

    const resolvedEntry = resolveEntryPrice(
      account.positionSize,
      cachedEntryPrice,
      safePnl,
      oraclePriceE6,
    );

    if (resolvedEntry.entry <= 0n) return null;

    const maintenanceBps =
      params?.maintenanceMarginBps ?? 500n;

    const liq = computeLiqPrice(
      resolvedEntry.entry,
      account.capital,
      account.positionSize,
      maintenanceBps,
    );

    // Long-side clamp: liq at/below $0 means there is no real chart line.
    return liq > 0n ? liq : null;
  }, [realUserAccount, config, params, slabAddress]);
}
