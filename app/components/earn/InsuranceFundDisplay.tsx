'use client';

import { AnimatedNumber } from '@/components/ui/AnimatedNumber';
import type { EarnStats } from '@/hooks/useEarnStats';

interface InsuranceFundDisplayProps {
  stats: EarnStats;
  loading: boolean;
}

/**
 * Insurance fund aggregate display.
 * Shows total insurance, breakdown by market, and what it covers.
 */
export function InsuranceFundDisplay({
  stats,
  loading,
}: InsuranceFundDisplayProps) {
  if (loading) {
    return (
      <div className="border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm p-6 animate-pulse">
        <div className="h-6 w-40 bg-[var(--border)] rounded mb-4" />
        <div className="h-24 bg-[var(--border)] rounded" />
      </div>
    );
  }

  return (
    <div className="border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm overflow-hidden hud-corners">
      <div className="h-px bg-gradient-to-r from-transparent via-[var(--warning)]/30 to-transparent" />

      <div className="p-5">
        {/* Header */}
        <div className="flex items-center gap-2 mb-4">
          <div className="w-6 h-6 rounded-sm bg-[var(--warning)]/10 flex items-center justify-center text-xs">
            🛡️
          </div>
          <h3
            className="text-sm font-medium text-white"
            style={{ fontFamily: 'var(--font-heading)' }}
          >
            Insurance Fund
          </h3>
        </div>

        {/* Total */}
        <div className="mb-4">
          <AnimatedNumber
            value={stats.totalInsurance}
            prefix="$"
            decimals={0}
            className="text-2xl font-bold text-white"
          />
          <p className="text-[11px] text-[var(--text-secondary)] mt-1">
            Total insurance across all markets
          </p>
        </div>

        {/* What it covers */}
        <div className="border-t border-[var(--border)] pt-4 mb-4">
          <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-secondary)] mb-3">
            Coverage
          </div>
          <div className="space-y-2">
            <CoverageItem
              icon="⚡"
              label="Liquidation Shortfall"
              description="Absorbs losses when liquidations don't fully cover positions"
            />
            <CoverageItem
              icon="🔄"
              label="Socialized Loss Buffer"
              description="Prevents LP losses from cascading to other depositors"
            />
            <CoverageItem
              icon="🏗️"
              label="Protocol Solvency"
              description="Final backstop ensuring all withdrawals can be honoured"
            />
          </div>
        </div>

        {/* Per-market breakdown */}
        {stats.markets.length > 0 && (
          <div className="border-t border-[var(--border)] pt-4">
            <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-secondary)] mb-3">
              By Market
            </div>
            <div className="space-y-2">
              {stats.markets
                .sort((a, b) => b.insuranceFund - a.insuranceFund)
                .slice(0, 5)
                .map((m) => (
                  <div
                    key={m.slabAddress}
                    className="flex items-center justify-between text-[12px]"
                  >
                    <span className="text-[var(--text-secondary)]">
                      {m.symbol}-PERP
                    </span>
                    <span className="font-mono tabular-nums text-white">
                      ${formatCompact(m.insuranceFund / 1e6)}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CoverageItem({
  icon,
  label,
  description,
}: {
  icon: string;
  label: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-xs mt-0.5">{icon}</span>
      <div>
        <div className="text-[12px] text-white font-medium">{label}</div>
        <div className="text-[11px] text-[var(--text-secondary)]">
          {description}
        </div>
      </div>
    </div>
  );
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}
