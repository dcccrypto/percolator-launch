"use client";

import { useMemo } from "react";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useLiqPrice } from "@/hooks/useLiqPrice";
import { useSlabState } from "@/components/providers/SlabProvider";
import { applyInvert, sanitizePriceE6 } from "@/lib/oraclePrice";
import { terminalPositionPnl } from "@/lib/position-pnl";

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
  const liqE6 = useLiqPrice();
  const { config, params, adlFactors, wrapperConfigV17 } = useSlabState();

  const entry = useMemo(() => {
    if (!ua || ua.account.positionSize === 0n) return null;
    const markE6 = config ? sanitizePriceE6(applyInvert(config.lastEffectivePriceE6, config.invert)) : 0n;
    const r = terminalPositionPnl({
      account: ua.account,
      slabAddress,
      accountIdx: ua.idx,
      adlFactors,
      adlApplicable: wrapperConfigV17 !== null,
      markE6,
      initialMarginBps: params?.initialMarginBps ?? 1000n,
    });
    return r;
  }, [ua, config, params, adlFactors, wrapperConfigV17, slabAddress]);

  if (!entry || !entry.pnlKnown || entry.entrySource === "unknown" || entry.entry <= 0n) return NONE;
  return {
    entry: Number(entry.entry) / 1e6,
    entryIsEstimate: entry.isEstimate,
    liq: liqE6 != null && liqE6 > 0n ? Number(liqE6) / 1e6 : null,
  };
}
