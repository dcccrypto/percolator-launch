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
import { portfolioPositionPnl } from "@/lib/position-pnl";

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
  /** PnL rests on a back-solved entry: label it "est.". */
  isEstimate: boolean;
}

export interface LivePortfolioMetrics {
  /**
   * Open positions whose PnL is unknown (no entry / unknown ADL state). They add 0 to
   * `totalUnrealizedPnl`; every aggregate must say so (`unknownPnlCaveat`) or show "--"
   * when ALL open positions are unknown.
   */
  unknownPnlCount: number;
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

      // The ONE shared PnL computation (lib/position-pnl.ts): ADL-effective
      // size, entry server > cache > derived, valued at the live mark. An
      // unknown entry or unknown ADL factors yields pnlKnown false and a 0
      // placeholder - never a number derived from the mark placeholder or raw size.
      const live = portfolioPositionPnl(pos, liveMark);

      return {
        position: pos,
        markE6,
        pnl: live.unrealizedPnl ?? 0n,
        pnlPercent: live.roe ?? 0,
        pnlKnown: live.pnlKnown,
        isEstimate: live.isEstimate,
      };
    });

    const totalUnrealizedPnl = livePositions.reduce(
      (sum, metric) => sum + metric.pnl,
      0n,
    );

    return {
      unknownPnlCount: livePositions.filter((m) => !m.pnlKnown).length,
      openPositions,
      livePositions,
      totalUnrealizedPnl,
      totalValue: totalDeposited + totalUnrealizedPnl,
    };
  }, [openPositions, totalDeposited, liveVersion]);
}
