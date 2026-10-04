"use client";

import { useUserAccount } from "@/hooks/useUserAccount";
import { useLiqPrice } from "@/hooks/useLiqPrice";
import { useMarketConfig } from "@/hooks/useMarketConfig";
import { getEntryPrice } from "@/lib/entry-price";
import { displayEntryE6 } from "@/lib/entry-price-display";
import { isSentinelValue } from "@/lib/health";
import { applyInvert, sanitizePriceE6 } from "@/lib/oraclePrice";
import { resolveEntryPrice } from "@/lib/trading";

/**
 * Liquidation and entry prices (USD) for the connected wallet's position on
 * this market — what every chart engine's Liq and Entry lines draw.
 *
 * Entry goes through the SAME display contract as the other position surfaces
 * (#2990): v17/v18 does not persist entry_price on-chain, so prefer the exact
 * wallet-scoped cache, allow a PnL-derived entry when resolveEntryPrice can
 * establish one, and draw NOTHING when its source is "unknown" (that numeric
 * entry is a risk-math fallback, not a trader-visible Entry). An absent line
 * makes no claim; it never falls back to the mark.
 */
export function usePositionLinePrices(slabAddress: string): { liq: number | null; entry: number | null } {
  const ua = useUserAccount();
  const liqE6 = useLiqPrice();
  const config = useMarketConfig();

  let entry: number | null = null;
  if (ua && ua.account.positionSize !== 0n) {
    const { account } = ua;
    const rawEntryPrice = account.entryPrice ?? 0n;
    const cachedEntryPrice =
      rawEntryPrice > 0n ? rawEntryPrice : getEntryPrice(slabAddress, ua.idx, account.owner.toBase58());
    const oraclePriceE6 = config
      ? sanitizePriceE6(applyInvert(config.lastEffectivePriceE6, config.invert))
      : 0n;
    const safePnl = account.pnl != null && !isSentinelValue(account.pnl) ? account.pnl : 0n;
    const resolvedEntry = resolveEntryPrice(account.positionSize, cachedEntryPrice, safePnl, oraclePriceE6);
    const displayEntry = displayEntryE6(resolvedEntry.entry, resolvedEntry.source);
    entry = displayEntry > 0n ? Number(displayEntry) / 1e6 : null;
  }
  const liq = liqE6 != null && liqE6 > 0n ? Number(liqE6) / 1e6 : null;
  return { liq, entry };
}
