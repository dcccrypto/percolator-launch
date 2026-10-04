"use client";

import { FC } from "react";
import { bigintToFloat } from "@/lib/formatters";
import { isExactEntrySource, DERIVED_ENTRY_TOOLTIP, ESTIMATE_LABEL } from "@/lib/entry-price-display";
import { onChainMarkE6, terminalPositionPnl } from "@/lib/position-pnl";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useLivePrice } from "@/hooks/useLivePrice";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockUserAccount } from "@/lib/mock-trade-data";
import { formatPnl } from "@/lib/chart-pnl-format";
import { useMarketInfo } from "@/hooks/useMarketInfo";
import { useEngineState } from "@/hooks/useEngineState";
import { PnlShareButton } from "@/components/share/PnlShareButton";
import { poolPayableCapacity, type PnlCardData } from "@/lib/pnl-card";

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
 *  Math is delegated to the shared `terminalPositionPnl` (lib/position-pnl.ts),
 *  the same function the dock, bar and portfolio card use; this component owns
 *  only the data plumbing + presentation. */
export const ChartPnlBadge: FC<ChartPnlBadgeProps> = ({ slabAddress }) => {
  const realUserAccount = useUserAccount();
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  const userAccount = realUserAccount ?? (mockMode ? getMockUserAccount(slabAddress) : null);
  const { priceE6: livePriceE6 } = useLivePrice();
  const { config: marketConfig, params, adlFactors, wrapperConfigV17 } = useSlabState();
  const tokenMeta = useTokenMeta(marketConfig?.collateralMint ?? null);
  const decimals = tokenMeta?.decimals ?? 6;
  // For the Share-PnL card: market identity + the pool's payout capacity (same
  // vault+insurance formula the dock caps on). Hooks stay above the early returns.
  const { market: marketInfo } = useMarketInfo(slabAddress);
  const { engine, insuranceBalance } = useEngineState();

  if (!userAccount) return null;
  const { account } = userAccount;
  if (account.positionSize === 0n) return null;
  if (livePriceE6 == null || livePriceE6 <= 0n) return null;

  // ONE shared computation for every PnL surface (lib/position-pnl.ts, #3077).
  // Entry: server > this device's cache > back-solve (#2990: a cache MISS is the
  // normal state on any other device, so the badge resolves rather than hides).
  // Size: ADL-EFFECTIVE - never raw basis, and never a guess when the factors
  // are unknown. Valued at the mark, like liquidation. The dock, the bar and the
  // portfolio card call the same function, so they read the same figure.
  const initialMarginBps = params?.initialMarginBps ?? 1000n;
  const pnlResult = terminalPositionPnl({
    account,
    slabAddress,
    accountIdx: userAccount.idx,
    adlFactors,
    adlApplicable: wrapperConfigV17 !== null,
    markE6: livePriceE6,
    anchorMarkE6: onChainMarkE6(marketConfig, wrapperConfigV17 !== null) ?? undefined,
    initialMarginBps,
  });
  // No entry / unknown ADL factors: no number, and no "$0.00" that reads as flat.
  if (!pnlResult.pnlKnown || pnlResult.unrealizedPnl === null || pnlResult.roe === null) return null;
  const effectiveSize = pnlResult.effectiveSize ?? account.positionSize;
  // Collateral is $1-pegged sim-USDC: the collateral amount IS the dollar figure
  // (same conversion the dock uses), not a float re-priced by the display tick.
  const pnlUsd = bigintToFloat(pnlResult.unrealizedPnl, decimals);
  const roe = pnlResult.roe;

  if (pnlUsd === null || !Number.isFinite(pnlUsd) || !Number.isFinite(roe)) return null;

  const { display, sign } = formatPnl(pnlUsd, roe);
  const colorClass =
    sign === "positive" ? "text-[var(--long)]" : sign === "negative" ? "text-[var(--short)]" : "text-[var(--text-secondary)]";

  // Share-PnL card for THIS market's open position — only with the entry
  // RECORDED at open (on chain, or this device's getEntryPrice cache), never a
  // back-solved estimate. Same gate the dock's Share button applies
  // (PositionsDock: `resolvedEntryPrice > 0n`, cache-only). The shareable entry
  // is read here directly rather than inferred from how the badge resolved its
  // display entry, so the gate holds even when the badge renders from a derived
  // entry on a device with no cache (#2990/#3020). The pool payout capacity
  // rides along so the card caps a winning PnL exactly where the dock's caveat does.
  const recordedEntryE6 = isExactEntrySource(pnlResult.entrySource) ? pnlResult.entry : 0n;
  const marketDisplaySymbol = (marketInfo?.symbol ?? "").replace(/-PERP$/i, "");
  const pnlCardData: PnlCardData | null = recordedEntryE6 <= 0n ? null : {
    slab: slabAddress,
    symbol: marketDisplaySymbol,
    name: marketInfo?.name ?? marketDisplaySymbol,
    logoUrl: marketInfo?.logo_url ?? null,
    mainnetCa: marketInfo?.mainnet_ca ?? null,
    payableCapacityAtoms: poolPayableCapacity(engine?.vault, insuranceBalance),
    decimals,
    nominalSizeQ: account.positionSize,
    effectiveSizeQ: effectiveSize,
    entryE6: recordedEntryE6,
    initialMarginBps,
    initialMarkE6: livePriceE6,
  };

  // Positioning is owned by DraggableChartBadges in TradingChart — the PnL chip
  // and the Share chip stack under PositionSummary and drag with it as one unit.
  return (
    <>
      <div className="flex items-center gap-1.5 rounded-none border border-[var(--border)]/60 bg-[var(--bg)]/90 px-2 py-1 backdrop-blur-sm">
        <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--text-secondary)]">PnL</span>
        <span className={`text-[10px] font-mono ${colorClass}`}>{display}</span>
        {pnlResult.isEstimate && (
          <span className="text-[9px] text-[var(--text-dim)]" title={DERIVED_ENTRY_TOOLTIP}>{ESTIMATE_LABEL}</span>
        )}
      </div>
      {/* The badge group is itself the drag handle — DraggableChartBadges takes
          pointer capture on pointerdown — so stop pointerdown here, otherwise a
          tap on Share starts a drag and the click never lands. */}
      {pnlCardData && (
      <span onPointerDown={(e) => e.stopPropagation()}>
        <PnlShareButton
          data={pnlCardData}
          label="↗ Share PnL"
          title="Share your PnL as a card"
          className="cursor-pointer rounded-none border border-[var(--accent)]/50 bg-[var(--bg)]/90 px-2 py-1 text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--accent)] backdrop-blur-sm transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent)]/10"
        />
      </span>
      )}
    </>
  );
};
