"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  isOpenPosition,
  type PortfolioPosition,
} from "@/hooks/usePortfolio";
import {
  subscribeSlab,
  getSnapshot,
} from "@/lib/priceStore/priceStore";
import { computeLivePositionPnl } from "@/lib/trading";
import { displayEntryE6 } from "@/lib/entry-price-display";

export interface LivePositionMetric {
  position: PortfolioPosition;
  /** Fresh shared mark, falling back to the portfolio scan snapshot. */
  markE6: bigint;
  /** Current displayable PnL in collateral atoms. */
  pnl: bigint;
  /** Current ROE percentage. */
  pnlPercent: number;
  /**
   * False when Entry is not trustworthy or there is no usable mark.
   * Individual position surfaces must render "--" instead of a fabricated
   * current PnL in that case (#2660/#2671).
   */
  pnlKnown: boolean;
}

export interface LivePortfolioMetrics {
  openPositions: PortfolioPosition[];
  /**
   * One entry per OPEN position, in the same order as `openPositions`.
   *
   * Deliberately NOT keyed by slab: a wallet can hold more than one portfolio
   * on the same market (usePortfolio returns one row per portfolio account),
   * and a slab-keyed lookup collapsed them so every card on that market showed
   * the LAST portfolio's PnL. Render from this list (each entry carries its own
   * `position`) instead of looking metrics up.
   */
  livePositions: LivePositionMetric[];
  totalUnrealizedPnl: bigint;
  /** Same definition usePortfolio uses: deposited capital + current unrealized PnL. */
  totalValue: bigint;
}

/**
 * Revalue a portfolio snapshot against the shared live price store.
 *
 * `usePortfolio()` intentionally refreshes expensive on-chain portfolio state
 * on a much slower cadence. That snapshot is correct for capital/size/entry/
 * risk metadata, but it is not a "now" price source. PositionsBar and the trade
 * terminal already consume priceStore ticks immediately; dashboard surfaces
 * labelled Mark / PnL / ROE / "Unrealized · now" must use the same mark.
 *
 * Multiple callers are safe: priceStore refcounts subscriptions by slab, so
 * this does not create one WebSocket per Dashboard component.
 */
export function useLivePortfolioMetrics(
  positions: PortfolioPosition[],
  totalDeposited: bigint = 0n,
): LivePortfolioMetrics {
  const openPositions = useMemo(
    () => positions.filter(isOpenPosition),
    [positions],
  );

  // One deterministic primitive identifies the exact slab subscription set.
  const slabKey = useMemo(
    () =>
      Array.from(new Set(openPositions.map((pos) => pos.slabAddress)))
        .sort()
        .join("|"),
    [openPositions],
  );

  const slabs = useMemo(
    () => (slabKey ? slabKey.split("|") : []),
    [slabKey],
  );

  const subscribe = useCallback(
    (cb: () => void) => {
      const releases = slabs.map((slab) => subscribeSlab(slab, cb));
      return () => {
        for (const release of releases) release();
      };
    },
    [slabs],
  );

  // useSyncExternalStore requires referentially-stable snapshots while nothing
  // changed. A primitive string is a render/version signal only; actual prices
  // are read below when deriving metrics.
  const getLiveVersion = useCallback(
    () =>
      slabs
        .map((slab) => {
          const price = getSnapshot(slab).priceE6;
          return price != null ? price.toString() : "";
        })
        .join("|"),
    [slabs],
  );

  const liveVersion = useSyncExternalStore(
    subscribe,
    getLiveVersion,
    () => "",
  );

  return useMemo(() => {
    // liveVersion is intentionally consumed only as an invalidation dependency.
    void liveVersion;

    const livePositions: LivePositionMetric[] = openPositions.map((pos) => {
      const liveMark = getSnapshot(pos.slabAddress).priceE6;
      const markE6 =
        liveMark != null && liveMark > 0n
          ? liveMark
          : pos.oraclePriceE6;

      // This is the ONE display-entry gate used elsewhere in the app.
      // "unknown" resolves numerically to the mark for risk math, but must
      // become 0 here so current PnL cannot be fabricated from that placeholder.
      const entryE6 = displayEntryE6(
        pos.effectiveEntryPrice,
        pos.entryPriceSource,
      );

      const live = computeLivePositionPnl(
        pos.effectiveSize,
        entryE6,
        markE6,
        pos.initialMarginBps,
        pos.account?.capital ?? 0n,
        pos.unrealizedPnl,
        pos.pnlPercent,
      );

      return {
        position: pos,
        markE6,
        pnl: live.pnl,
        pnlPercent: live.pnlPercent,
        pnlKnown: markE6 > 0n && entryE6 > 0n,
      };
    });

    const totalUnrealizedPnl = livePositions.reduce(
      (sum, metric) => sum + metric.pnl,
      0n,
    );

    return {
      openPositions,
      livePositions,
      totalUnrealizedPnl,
      totalValue: totalDeposited + totalUnrealizedPnl,
    };
  }, [openPositions, totalDeposited, liveVersion]);
}
