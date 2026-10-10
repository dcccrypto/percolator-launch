"use client";

import { lotExpOf, tokenUsdOfLotUsd } from "@/lib/v22/lot";
import { useMemo } from "react";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useSlabState } from "@/components/providers/SlabProvider";
import { onChainMarkE6, terminalPositionPnl } from "@/lib/position-pnl";

export interface PositionLinePrices {
  /** Liquidation price (USD), or null: no position, covered position, or PnL not known. */
  liq: number | null;
  /** Entry price (USD), or null when it must not be drawn. */
  entry: number | null;
  /** The entry is a back-solve, not a recorded price: label it "est." (ESTIMATE_LABEL). */
  entryIsEstimate: boolean;
}

const NONE: PositionLinePrices = { liq: null, entry: null, entryIsEstimate: false };

/**
 * Entry and liquidation prices (USD) for the connected wallet's position, for every chart engine.
 *
 * Both come from the SAME shared resolution as every PnL surface (`computePositionPnl` through
 * `terminalPositionPnl`, lib/position-pnl.ts, #3077): entry priority server > cache > back-solve over
 * the ADL-EFFECTIVE size, valued at the on-chain mark. A line is drawn ONLY when `pnlKnown` is true
 * (ADL state known and a real entry resolved); an unknown entry or unknown ADL factors draw nothing,
 * never a fallback to the mark. A back-solved entry is flagged `entryIsEstimate`.
 */
export function usePositionLinePrices(slabAddress: string): PositionLinePrices {
  const ua = useUserAccount();
  const { config, params, adlFactors, wrapperConfigV17, raw: slabRaw } = useSlabState();
  // v2.2 lots: entry / liq are per LOT; chart lines are per TOKEN (identity at lotExp 0).
  const lotExp = lotExpOf(slabRaw);

  const pnl = useMemo(() => {
    if (!ua || ua.account.positionSize === 0n) return null;
    // v17 `markEwmaE6` is already post-inversion: do NOT apply `invert` again.
    const markE6 = onChainMarkE6(config, wrapperConfigV17 !== null) ?? 0n;
    const r = terminalPositionPnl({
      account: ua.account,
      slabAddress,
      accountIdx: ua.idx,
      adlFactors,
      adlApplicable: wrapperConfigV17 !== null,
      markE6,
      initialMarginBps: params?.initialMarginBps ?? 1000n,
      maintenanceMarginBps: params?.maintenanceMarginBps ?? 500n,
    });
    return r;
  }, [ua, config, params, adlFactors, wrapperConfigV17, slabAddress]);

  if (!pnl || !pnl.pnlKnown || pnl.entrySource === "unknown" || pnl.entry <= 0n) return NONE;
  // The engine liquidation price on EFFECTIVE size, straight from the shared result (0n = none, null = unknown).
  const liq = pnl.liquidationPriceE6;
  return {
    entry: tokenUsdOfLotUsd(Number(pnl.entry) / 1e6, lotExp),
    entryIsEstimate: pnl.isEstimate,
    liq: liq != null && liq > 0n ? tokenUsdOfLotUsd(Number(liq) / 1e6, lotExp) : null,
  };
}
