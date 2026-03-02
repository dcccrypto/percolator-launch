"use client";

import { FC, useState, useCallback } from "react";
import { useOracleFreshness } from "@/hooks/useOracleFreshness";
import { useOraclePublishers } from "@/hooks/useOraclePublishers";
import { OracleDetailsPanel } from "./OracleDetailsPanel";

/**
 * P0 — Price freshness indicator for the trade page.
 *
 * Displays below the mark price: a pulsing dot, elapsed time,
 * oracle mode badge, and publisher count.
 *
 * Color thresholds:
 *   < 5s  → green  (fresh)
 *   5-30s → yellow (aging)
 *   > 30s → red    (stale) + warning banner
 */
export const OracleFreshnessIndicator: FC = () => {
  const {
    mode,
    modeLabel,
    elapsedSecs,
    level,
    color,
    ready,
  } = useOracleFreshness();

  const {
    publisherCount,
    publisherTotal,
  } = useOraclePublishers();

  const [panelOpen, setPanelOpen] = useState(false);

  const handleClick = useCallback(() => {
    setPanelOpen(true);
  }, []);

  if (!ready) return null;

  const elapsedText =
    elapsedSecs < 60
      ? `${elapsedSecs}s ago`
      : `${Math.floor(elapsedSecs / 60)}m ${elapsedSecs % 60}s ago`;

  const publisherText =
    publisherCount !== null && publisherTotal !== null
      ? `${publisherCount} publisher${publisherCount !== 1 ? "s" : ""}`
      : null;

  return (
    <>
      {/* Freshness row */}
      <button
        type="button"
        onClick={handleClick}
        className="group flex w-full items-center gap-1.5 px-1.5 py-0.5 text-left transition-colors hover:bg-[var(--bg-elevated)]/50 rounded-sm"
        title="View oracle details"
      >
        {/* Pulsing dot */}
        <span className="relative flex h-[6px] w-[6px] shrink-0">
          {level === "fresh" && (
            <span
              className="absolute inset-0 rounded-full animate-[freshness-ping_2s_cubic-bezier(0,0,0.2,1)_infinite]"
              style={{ backgroundColor: color, opacity: 0.4 }}
            />
          )}
          <span
            className="relative inline-flex h-[6px] w-[6px] rounded-full"
            style={{ backgroundColor: color }}
          />
        </span>

        {/* Elapsed time */}
        <span
          className="text-[10px] tabular-nums"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
          }}
        >
          Updated {elapsedText}
        </span>

        {/* Separator */}
        <span className="text-[10px]" style={{ color: "var(--text-dim)" }}>
          ·
        </span>

        {/* Oracle mode + publisher count */}
        <span
          className="text-[10px] tabular-nums"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--text-secondary)",
          }}
        >
          <HexIcon size={9} color={getModeBorderColor(mode)} />
          <span className="ml-0.5">{modeLabel}</span>
          {publisherText && (
            <>
              <span className="mx-1" style={{ color: "var(--text-dim)" }}>
                ·
              </span>
              {publisherText}
            </>
          )}
        </span>

        {/* Expand hint */}
        <span className="ml-auto text-[9px] text-[var(--text-dim)] opacity-0 transition-opacity group-hover:opacity-100">
          ▸
        </span>
      </button>

      {/* Stale warning banner */}
      {level === "stale" && (
        <div
          className="flex items-center gap-1.5 px-2 py-1 text-[10px]"
          style={{
            backgroundColor: "rgba(234,179,8,0.10)",
            color: "#eab308",
            fontFamily: "var(--font-mono)",
          }}
        >
          <span>⚠</span>
          <span>
            Oracle price is {elapsedText} stale — trading may be paused
          </span>
        </div>
      )}

      {/* Details panel (P1) */}
      {panelOpen && (
        <OracleDetailsPanel onClose={() => setPanelOpen(false)} />
      )}
    </>
  );
};

/** Small hexagon icon (⬡) rendered as inline SVG */
function HexIcon({ size = 12, color = "#22d3ee" }: { size?: number; color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="inline-block align-[-1px]"
    >
      <path d="M12 2l8.5 5v10L12 22l-8.5-5V7z" />
    </svg>
  );
}

/** Get the border/accent color for a given oracle mode */
function getModeBorderColor(mode: string | null): string {
  switch (mode) {
    case "hyperp":
      return "#22d3ee"; // cyan
    case "pyth-pinned":
      return "#a78bfa"; // purple
    case "admin":
      return "#fb923c"; // orange
    default:
      return "#38bdf8"; // blue
  }
}
