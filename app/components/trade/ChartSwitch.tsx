"use client";

/**
 * The trade page's chart entry point. Today it renders the built-in lightweight-charts chart; it is the seam where the perp-standard chart (and later TradingView Advanced Charts)
 * plug in, so the trade page imports ONE component and never changes again.
 * The choice itself lives in lib/chart-engine.ts (`?chart=legacy` forces the original chart).
 */
import { FC, memo } from "react";
import { TradingChart } from "./TradingChart";

const ChartSwitchInner: FC<{ slabAddress: string; mintAddress?: string }> = ({ slabAddress, mintAddress }) => (
  <TradingChart slabAddress={slabAddress} mintAddress={mintAddress} />
);

/** Memoized for the same reason as TradingChart: the trade page re-renders several times a second. */
export const ChartSwitch = memo(ChartSwitchInner);
