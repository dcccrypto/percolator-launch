"use client";

import { useUserAccount } from "@/hooks/useUserAccount";
import { useLiqPrice } from "@/hooks/useLiqPrice";
import { getEntryPrice } from "@/lib/entry-price";

/**
 * Liquidation and entry prices (USD) for the connected wallet's position on
 * this market — what the chart's Liq and Entry lines draw. Same sources as the
 * lightweight-charts chart: on-chain entry, else the locally saved entry for
 * this wallet; liq from useLiqPrice (null when the position is covered).
 */
export function usePositionLinePrices(slabAddress: string): { liq: number | null; entry: number | null } {
  const ua = useUserAccount();
  const liqE6 = useLiqPrice();
  let entry: number | null = null;
  if (ua) {
    const ep = ua.account.entryPrice;
    const resolved = ep != null && ep > 0n ? ep : getEntryPrice(slabAddress, ua.idx, ua.account.owner.toBase58());
    if (resolved > 0n) entry = Number(resolved) / 1e6;
  }
  const liq = liqE6 != null && liqE6 > 0n ? Number(liqE6) / 1e6 : null;
  return { liq, entry };
}
