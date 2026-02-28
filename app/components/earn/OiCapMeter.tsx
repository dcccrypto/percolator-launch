'use client';

import { useMemo } from 'react';

interface OiCapMeterProps {
  currentOI: number;
  maxOI: number;
  /** Compact variant for cards */
  compact?: boolean;
  className?: string;
}

/**
 * Live OI cap meter — visualises current OI vs max OI allowed by LP capital.
 * Shows utilization percentage with color-coded danger zones.
 */
export function OiCapMeter({
  currentOI,
  maxOI,
  compact = false,
  className = '',
}: OiCapMeterProps) {
  const utilPct = useMemo(() => {
    if (maxOI <= 0) return 0;
    return Math.min((currentOI / maxOI) * 100, 100);
  }, [currentOI, maxOI]);

  // Color zones: green (<50%), yellow (50-75%), orange (75-90%), red (>90%)
  const barColor = useMemo(() => {
    if (utilPct >= 90) return 'var(--short)';
    if (utilPct >= 75) return 'var(--warning)';
    if (utilPct >= 50) return '#E5A100';
    return 'var(--cyan)';
  }, [utilPct]);

  const barGlow = useMemo(() => {
    if (utilPct >= 90) return 'rgba(255, 59, 92, 0.3)';
    if (utilPct >= 75) return 'rgba(229, 161, 0, 0.3)';
    if (utilPct >= 50) return 'rgba(229, 161, 0, 0.2)';
    return 'rgba(20, 241, 149, 0.2)';
  }, [utilPct]);

  const statusLabel = useMemo(() => {
    if (utilPct >= 90) return 'Near Capacity';
    if (utilPct >= 75) return 'High Utilization';
    if (utilPct >= 50) return 'Moderate';
    return 'Healthy';
  }, [utilPct]);

  if (compact) {
    return (
      <div className={`flex items-center gap-2 ${className}`}>
        <div className="flex-1 h-1.5 bg-[var(--border)] rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700 ease-out"
            style={{
              width: `${utilPct}%`,
              backgroundColor: barColor,
              boxShadow: `0 0 8px ${barGlow}`,
            }}
          />
        </div>
        <span
          className="text-[10px] font-mono tabular-nums min-w-[3.5ch] text-right"
          style={{ color: barColor }}
        >
          {utilPct.toFixed(0)}%
        </span>
      </div>
    );
  }

  return (
    <div className={`${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-secondary)]">
          OI Capacity
        </span>
        <span
          className="text-[10px] uppercase tracking-[0.15em] font-medium px-2 py-0.5 rounded-sm border"
          style={{
            color: barColor,
            borderColor: `${barColor}33`,
            backgroundColor: `${barColor}0A`,
          }}
        >
          {statusLabel}
        </span>
      </div>

      {/* Meter bar */}
      <div className="relative h-3 bg-[var(--border)] rounded-sm overflow-hidden">
        {/* Segment markers */}
        <div className="absolute inset-0 flex">
          <div className="w-1/2 border-r border-[var(--bg)]/30" />
          <div className="w-1/4 border-r border-[var(--bg)]/30" />
          <div className="w-[15%] border-r border-[var(--bg)]/30" />
          <div className="flex-1" />
        </div>

        {/* Fill bar */}
        <div
          className="absolute inset-y-0 left-0 rounded-sm transition-all duration-700 ease-out"
          style={{
            width: `${utilPct}%`,
            backgroundColor: barColor,
            boxShadow: `0 0 12px ${barGlow}, inset 0 1px 0 rgba(255,255,255,0.1)`,
          }}
        />
      </div>

      {/* Labels */}
      <div className="mt-2 flex items-center justify-between text-[11px]">
        <div className="flex items-center gap-4">
          <span className="text-[var(--text-secondary)]">
            Current:{' '}
            <span className="text-white font-mono tabular-nums">
              ${formatCompact(currentOI)}
            </span>
          </span>
          <span className="text-[var(--text-secondary)]">
            Max:{' '}
            <span className="text-white font-mono tabular-nums">
              ${formatCompact(maxOI)}
            </span>
          </span>
        </div>
        <span
          className="font-mono tabular-nums font-semibold"
          style={{ color: barColor }}
        >
          {utilPct.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

/** Format large numbers compactly: 1,234,567 → 1.23M */
function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}
