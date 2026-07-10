'use client';

import { AnimatedNumber } from '@/components/ui/AnimatedNumber';
import type { EarnStats } from '@/hooks/useEarnStats';
import { ShimmerSkeleton } from '@/components/ui/ShimmerSkeleton';
import { formatCompact } from '@/lib/formatters';

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
      <div className="border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm p-5 hud-corners">
        <div className="flex items-center gap-2 mb-4">
          <ShimmerSkeleton className="w-6 h-6 rounded-sm shrink-0" />
          <ShimmerSkeleton className="h-4 w-28" />
        </div>
        <div className="mb-4 space-y-1">
          <ShimmerSkeleton className="h-7 w-20" />
          <ShimmerSkeleton className="h-3 w-40" />
        </div>
        <div className="border-t border-[var(--border)] pt-4 mb-4 space-y-3">
          <ShimmerSkeleton className="h-3 w-16" />
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex gap-2">
                <ShimmerSkeleton className="w-4 h-4 rounded-full shrink-0" />
                <div className="flex-1 space-y-1">
                  <ShimmerSkeleton className="h-3.5 w-24" />
                  <ShimmerSkeleton className="h-3 w-full" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm overflow-hidden hud-corners">
      <div className="h-px bg-gradient-to-r from-transparent via-[var(--warning)]/30 to-transparent" />

      <div className="p-5">
        {/* Header */}
        <div className="flex items-center gap-2 mb-4">
          <div aria-hidden="true" className="w-6 h-6 rounded-sm bg-[var(--warning)]/10 flex items-center justify-center text-xs">
            🛡️
          </div>
          <h3
            className="text-sm font-medium text-[var(--text)]"
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
            className="text-2xl font-bold text-[var(--text)]"
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
              {[...stats.markets]
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
                    <span className="font-mono tabular-nums text-[var(--text)]">
                      ${formatCompact(m.insuranceFund / (10 ** m.decimals))}
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
      <span aria-hidden="true" className="text-xs mt-0.5">{icon}</span>
      <div>
        <div className="text-[12px] text-[var(--text)] font-medium">{label}</div>
        <div className="text-[11px] text-[var(--text-secondary)]">
          {description}
        </div>
      </div>
    </div>
  );
}
