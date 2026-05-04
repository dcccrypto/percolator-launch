"use client";

import { FC } from "react";
import { computeMarkPnl, computePnlPercent } from "@/lib/trading";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useLivePrice } from "@/hooks/useLivePrice";
import { useMarketConfig } from "@/hooks/useMarketConfig";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockUserAccount } from "@/lib/mock-trade-data";
import { getEntryPrice } from "@/lib/entry-price";
import { formatPnl } from "@/lib/chart-pnl-format";

interface ChartPnlBadgeProps {
  slabAddress: string;
}

/** Floating badge that displays unrealized PnL on the chart, refreshed on
 *  every live-price tick. Sits stacked below the PositionSummary badge in
 *  the top-right corner of the chart container.
 *
 *  Returns null when there's no open position, no entry price, or no valid
 *  mark — the badge should never render with placeholder zeroes since that
 *  reads as "your position is flat" which is misleading mid-fetch.
 *
 *  Math is delegated to `computeMarkPnl` + `computePnlPercent` from the
 *  trading SDK (already test-covered in phantom-position-pnl.test.ts);
 *  this component owns only the data plumbing + presentation. */
export const ChartPnlBadge: FC<ChartPnlBadgeProps> = ({ slabAddress }) => {
  const realUserAccount = useUserAccount();
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  const userAccount = realUserAccount ?? (mockMode ? getMockUserAccount(slabAddress) : null);
  const { priceE6: livePriceE6, priceUsd } = useLivePrice();
  const marketConfig = useMarketConfig();
  const tokenMeta = useTokenMeta(marketConfig?.collateralMint ?? null);
  const decimals = tokenMeta?.decimals ?? 6;

  if (!userAccount) return null;
  const { account } = userAccount;
  if (account.positionSize === 0n) return null;
  if (livePriceE6 == null || livePriceE6 <= 0n || priceUsd == null) return null;

  // V12_1: entry_price was removed from the on-chain account struct, so
  // accounts created via the position-NFT path have account.entryPrice == 0n.
  // Fall back to the locally-saved entry from when the position was opened —
  // mirrors the resolution PositionPanel does for the same reason.
  const rawEntryPrice = account.entryPrice ?? 0n;
  const resolvedEntryPrice =
    rawEntryPrice > 0n ? rawEntryPrice : getEntryPrice(slabAddress, userAccount.idx);
  if (resolvedEntryPrice <= 0n) return null;

  const pnlTokens = computeMarkPnl(account.positionSize, resolvedEntryPrice, livePriceE6);
  const pnlUsd = (Number(pnlTokens) / 10 ** decimals) * priceUsd;
  const roe = computePnlPercent(pnlTokens, account.capital);

  if (!Number.isFinite(pnlUsd) || !Number.isFinite(roe)) return null;

  const { display, sign } = formatPnl(pnlUsd, roe);
  const colorClass =
    sign === "positive" ? "text-green-400" : sign === "negative" ? "text-red-400" : "text-[var(--text-dim)]";

  return (
    <div className="absolute top-10 right-2 z-10 flex items-center gap-1.5 rounded-none border border-[var(--border)]/60 bg-[var(--bg)]/90 px-2 py-1 backdrop-blur-sm">
      <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--text-dim)]">PnL</span>
      <span className={`text-[10px] font-mono ${colorClass}`}>{display}</span>
    </div>
  );
};
