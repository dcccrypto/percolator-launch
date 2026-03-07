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
            {/* Bug #852: consistent icon + heading + subtext pattern */}
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mb-2 text-[#475569]"
              aria-hidden="true"
            >
              {/* Candlestick chart icon */}
              <line x1="18" y1="3" x2="18" y2="6" />
              <line x1="18" y1="11" x2="18" y2="21" />
              <rect x="15" y="6" width="6" height="5" rx="1" />
              <line x1="12" y1="6" x2="12" y2="8" />
              <line x1="12" y1="15" x2="12" y2="21" />
              <rect x="9" y="8" width="6" height="7" rx="1" />
              <line x1="6" y1="3" x2="6" y2="10" />
              <line x1="6" y1="17" x2="6" y2="21" />
              <rect x="3" y="10" width="6" height="7" rx="1" />
            </svg>
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
