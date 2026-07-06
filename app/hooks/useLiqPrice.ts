"use client";

import { useMemo } from "react";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useSlabState } from "@/components/providers/SlabProvider";
import { computeLiqPrice } from "@/lib/trading";

/**
 * Phase 2: Returns the liquidation price (as bigint e6) for the current user's
 * open position on the active slab. Returns null when no position exists or
 * when required data is not yet available.
 */
export function useLiqPrice(): bigint | null {
  const realUserAccount = useUserAccount();
  const { params } = useSlabState();

  return useMemo(() => {
    if (!realUserAccount) return null;
    const { account } = realUserAccount;
    if (account.positionSize === 0n) return null;

    // v17 (and NFT-wrapped v12) accounts do not store an entry price on-chain
    // (entryPrice === 0n). computeLiqPrice needs a non-zero entry to produce a
    // real number — without it, it returns 0n, which a consumer could otherwise
    // misread as "liquidation at $0.00". Surface it as null ("no liq price
    // available") instead. The position panels (PositionPanel / PositionsTable /
    // AccountRiskSidebar) resolve the entry from the live mark for a usable
    // figure; this hook only feeds the chart's liq overlay, which correctly
    // hides the line when the value is null.
    if (account.entryPrice === 0n) return null;

    const maintenanceBps = params?.maintenanceMarginBps ?? 500n;
    return computeLiqPrice(
      account.entryPrice,
      account.capital,
      account.positionSize,
      maintenanceBps,
    );
  }, [realUserAccount, params]);
}
