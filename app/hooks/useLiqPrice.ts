"use client";

import { useMemo } from "react";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useSlabState } from "@/components/providers/SlabProvider";
import { computeLiqPrice } from "@/lib/trading";
import { getEntryPrice } from "@/lib/entry-price";

/**
 * Phase 2: Returns the liquidation price (as bigint e6) for the current user's
 * open position on the active slab. Returns null when no position exists or
 * when required data is not yet available.
 */
export function useLiqPrice(): bigint | null {
  const realUserAccount = useUserAccount();
  const { params, slabAddress } = useSlabState();

  return useMemo(() => {
    if (!realUserAccount) return null;
    const { account } = realUserAccount;
    if (account.positionSize === 0n) return null;

    // v17 (and NFT-wrapped v12) accounts do not store an entry price on-chain
    // (entryPrice === 0n) — every v17 position used to bail out here, so the
    // chart's "Liquidation Price" display toggle never drew anything. Resolve
    // the entry the same way ChartPnlBadge does: fall back to the client-side
    // entry saved at trade-open time (lib/entry-price). Still null when
    // neither source has it (e.g. a transferred-in position NFT) — the chart
    // correctly hides the line for null.
    const rawEntryPrice = account.entryPrice ?? 0n;
    // The client-side entry is saved per-wallet (OrderTicket passes the connected
    // wallet). Read it with the SAME wallet key (account.owner === the connected
    // wallet) — omitting it hits the wallet-less legacy key and misses, so the
    // chart's Liq line silently never drew for v17 positions.
    const entryPrice =
      rawEntryPrice > 0n ? rawEntryPrice : getEntryPrice(slabAddress, realUserAccount.idx, account.owner.toBase58());
    if (entryPrice <= 0n) return null;

    const maintenanceBps = params?.maintenanceMarginBps ?? 500n;
    const liq = computeLiqPrice(
      entryPrice,
      account.capital,
      account.positionSize,
      maintenanceBps,
    );
    // Long-side clamp (liq at/below $0): the position cannot be liquidated by
    // price, so there is genuinely no line to draw.
    return liq > 0n ? liq : null;
  }, [realUserAccount, params, slabAddress]);
}
