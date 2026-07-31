"use client";

import { useState } from "react";
import { usePortfolio, isOpenPosition } from "@/hooks/usePortfolio";

/**
 * PnL Chart — shows real portfolio PnL.
 * Previously used getMockPnlHistory. Now shows current PnL from positions.
 * Full historical chart requires trade history indexing (future work).
 */

const ranges = ["24H", "7D", "30D", "ALL"] as const;

export function PnlChart() {
  const [range, setRange] = useState<typeof ranges[number]>("7D");
  const { totalUnrealizedPnl, positions, loading } = usePortfolio();

  // Only OPEN positions contribute PnL — exclude closed (size-0 "Flat") ones so
  // the "Across N positions" caption matches the real open-position count.
  const openPositions = positions.filter(isOpenPosition);

  // Use totalUnrealizedPnl (mark-to-market, already guarded against u64::MAX sentinels)
  // rather than totalPnl (raw account.pnl sum) which can contain uninitialized sentinel
  // values producing septillion-dollar overflow display (GH#1352).
  const pnlFloat = Number(totalUnrealizedPnl) / 1e6;
  const isPositive = pnlFloat >= 0;
  const hasData = openPositions.length > 0;

  return (
    <div className="border border-[var(--border)] bg-[var(--panel-bg)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
        <p className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-secondary)]">
          Portfolio PnL
        </p>
        <div className="flex gap-1">
          {ranges.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-2 py-0.5 text-[9px] font-medium transition-colors ${
                range === r
                  ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text)]"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Chart area */}
      <div className="flex h-[200px] items-center justify-center px-5">
        {loading ? (
          <p className="text-[11px] text-[var(--text-secondary)]">Loading...</p>
        ) : !hasData ? (
          <div className="text-center">
            <p className="text-[11px] text-[var(--text-secondary)]">No positions yet</p>
            <p className="mt-1 text-[9px] text-[var(--text-secondary)]">Open a trade to see your PnL</p>
          </div>
        ) : (
          <div className="text-center">
            <p className={`text-4xl font-bold tabular-nums ${isPositive ? "text-[var(--long)]" : "text-[var(--short)]"}`}
               style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
              {isPositive ? "+" : ""}${Math.abs(pnlFloat).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
            <p className="mt-1 text-[9px] text-[var(--text-secondary)]">
              Across {openPositions.length} position{openPositions.length !== 1 ? "s" : ""} • Historical chart coming soon
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
