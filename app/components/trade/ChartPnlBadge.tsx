"use client";

import { FC } from "react";
import { computeMarkPnl, computeMarkPnlCollateral, computePnlPercent, computePositionInitialMargin } from "@/lib/trading";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useLivePrice } from "@/hooks/useLivePrice";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockUserAccount } from "@/lib/mock-trade-data";
import { getEntryPrice } from "@/lib/entry-price";
import { formatPnl } from "@/lib/chart-pnl-format";
import { adlSideFactor, effectiveExposureQ } from "@/lib/v17-adl";

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
  const { config: marketConfig, params, adlFactors } = useSlabState();
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
  // BUG 10 fix: scope the cache lookup to this account's own wallet (its
  // on-chain `owner`) — the unscoped key collapsed to one slot per market
  // shared by every wallet that traded it in this browser (v17 accountIdx is
  // always 0), so switching wallets showed the previous wallet's entry price.
  const rawEntryPrice = account.entryPrice ?? 0n;
  const resolvedEntryPrice =
    rawEntryPrice > 0n ? rawEntryPrice : getEntryPrice(slabAddress, userAccount.idx, account.owner.toBase58());
  if (resolvedEntryPrice <= 0n) return null;

  // A deleveraged leg moves at `basis * a_side / a_basis`, not at raw basis —
  // feeding nominal size here overstated the badge by the ADL factor (2x on
  // live devnet markets). See lib/v17-adl.ts.
  const effectiveSize = adlFactors
    ? effectiveExposureQ(account.positionSize, account.adlABasis, adlSideFactor(adlFactors, account.positionSize > 0n ? 0 : 1))
    : account.positionSize;
  const pnlTokens = computeMarkPnl(effectiveSize, resolvedEntryPrice, livePriceE6);
  const pnlUsd = (Number(pnlTokens) / 10 ** decimals) * priceUsd;
  // pnlTokens is coin-margined native scale (same units as positionSize), not
  // collateral — convert via computeMarkPnlCollateral before it's the basis
  // for ROE% (computePnlPercent expects a collateral-scale numerator to
  // compare against a collateral-scale denominator).
  const pnlCollateral = computeMarkPnlCollateral(pnlTokens, livePriceE6);
  // BUG 14 fix: standardize the ROE denominator on this position's OWN locked
  // initial margin (matches PositionsDock/PositionPanel/AccountRiskSidebar),
  // not `account.capital` — capital includes collateral not backing this
  // specific position, which produced a DIFFERENT (smaller) ROE% here than
  // PositionsDock showed for the identical position. `computePnlPercent` can
  // throw on an extreme dust-margin position (mirrors the guard PositionsDock
  // already has around this same call).
  const initialMarginBps = params?.initialMarginBps ?? 1000n;
  const positionInitialMargin = computePositionInitialMargin(account.positionSize, resolvedEntryPrice, initialMarginBps);
  let roe = 0;
  try {
    roe = positionInitialMargin > 0n ? computePnlPercent(pnlCollateral, positionInitialMargin) : 0;
  } catch {
    roe = 0;
  }

  if (!Number.isFinite(pnlUsd) || !Number.isFinite(roe)) return null;

  const { display, sign } = formatPnl(pnlUsd, roe);
  const colorClass =
    sign === "positive" ? "text-[var(--long)]" : sign === "negative" ? "text-[var(--short)]" : "text-[var(--text-secondary)]";

  // Positioning is owned by DraggableChartBadges in TradingChart — this chip
  // stacks under PositionSummary and drags with it as one unit.
  return (
    <div className="flex items-center gap-1.5 rounded-none border border-[var(--border)]/60 bg-[var(--bg)]/90 px-2 py-1 backdrop-blur-sm">
      <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--text-secondary)]">PnL</span>
      <span className={`text-[10px] font-mono ${colorClass}`}>{display}</span>
    </div>
  );
};
