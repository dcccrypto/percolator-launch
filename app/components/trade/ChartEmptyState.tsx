"use client";

import { FC } from "react";
import Image from "next/image";

interface ChartEmptyStateProps {
  /** Optional current price to display alongside the empty state */
  currentPrice?: number;
  /** Height class for the container (default: h-[300px]) */
  heightClass?: string;
}

/**
 * Empty state for chart components when no OHLCV / price data is available.
 * Uses the designer-provided SVG with ghost candlestick bars.
 */
export const ChartEmptyState: FC<ChartEmptyStateProps> = ({
  currentPrice,
  heightClass = "h-[300px]",
}) => {
  return (
    <div
      className={`relative flex ${heightClass} flex-col items-center justify-center rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 overflow-hidden`}
    >
      {/* Background SVG illustration */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <Image
          src="/chart-empty-state.svg"
          alt=""
          width={600}
          height={320}
          className="w-full h-full object-contain opacity-80"
          priority={false}
          aria-hidden="true"
        />
      </div>

      {/* Overlay content — sits above the SVG */}
      <div className="relative z-10 flex flex-col items-center text-center px-4">
        {currentPrice != null && currentPrice > 0 ? (
          <>
            <div
              className="text-2xl font-bold text-[var(--text)] drop-shadow-sm"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              ${currentPrice < 0.01 ? currentPrice.toFixed(6) : currentPrice.toFixed(2)}
            </div>
            <div className="mt-1 text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
              Price chart building…
            </div>
          </>
        ) : (
          <>
            <div
              className="text-[15px] font-semibold text-[#94a3b8]"
              style={{ fontFamily: "'Space Grotesk', system-ui, sans-serif" }}
            >
              No chart data yet
            </div>
            <div
              className="mt-1 text-xs text-[#475569]"
              style={{ fontFamily: "'Space Grotesk', system-ui, sans-serif" }}
            >
              Price history will appear once trading begins
            </div>
          </>
        )}
      </div>
    </div>
  );
};
