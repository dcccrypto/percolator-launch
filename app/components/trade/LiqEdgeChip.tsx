"use client";

import { FC } from "react";
import { formatPerpPrice } from "@/lib/chart/precision";
import type { LiqEdge } from "@/lib/tv/liqEdge";

/**
 * "LIQ ↑ x" / "LIQ ↓ x": the liquidation line is off the top / bottom of the visible price range.
 *
 * Rendered in the chart CHROME (the strip above the chart), never as an overlay on the chart area: on the
 * TradingView chart the area is an iframe whose own dialogs and menus cannot be drawn above a DOM overlay.
 */
export const LiqEdgeChip: FC<{ edge: LiqEdge; price: number | null | undefined }> = ({ edge, price }) => {
  if (!edge || price == null || !Number.isFinite(price) || !(price > 0)) return null;
  const arrow = edge === "above" ? "↑" : "↓";
  return (
    <span
      data-testid="liq-edge-chip"
      data-edge={edge}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-none border border-[var(--short)]/50 bg-[var(--bg)]/90 px-1.5 py-0.5 font-mono text-[9px] font-semibold"
      title={`Liquidation price ${formatPerpPrice(price)} is off the ${edge === "above" ? "top" : "bottom"} of the chart. Scroll the price axis to see the line`}
    >
      <span className="uppercase tracking-[0.1em] text-[var(--short)]">Liq</span>
      <span className="text-[var(--short)]">{arrow}</span>
      <span className="text-[var(--text)]">{formatPerpPrice(price)}</span>
    </span>
  );
};
