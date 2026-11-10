"use client";

import type { CSSProperties, FC } from "react";
import { liqPricePlainText, type LiqPriceDisplay } from "@/lib/liq-price-display";

/**
 * Renders a liquidation-price cell from `describeLiqPrice`. Every surface that
 * shows a liquidation price must go through it (or use `describeLiqPrice`
 * directly where it needs a string) — enforced by
 * __tests__/components/margin-health-surfaces.test.ts, which scans the tree.
 */
export const LiqPriceValue: FC<{
  display: LiqPriceDisplay;
  className?: string;
  style?: CSSProperties;
  /** New-order previews: say "None (fully covered)" instead of "110% mgn". Position rows keep the margin-health text. */
  plain?: boolean;
}> = ({ display, className, style, plain }) => (
  <span className={className} style={style} title={display.title} data-liq-kind={display.kind}>
    {plain ? liqPricePlainText(display) : display.text}
  </span>
);
