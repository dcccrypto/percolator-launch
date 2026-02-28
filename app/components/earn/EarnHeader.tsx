'use client';

import { AnimatedNumber } from '@/components/ui/AnimatedNumber';
import type { EarnStats } from '@/hooks/useEarnStats';

interface EarnHeaderProps {
  stats: EarnStats;
  loading: boolean;
}

export function EarnHeader({ stats, loading }: EarnHeaderProps) {
  return (
    <div className="relative">
      {/* Background grid fade */}
      <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />

      <div className="relative mx-auto max-w-6xl px-4 pt-10 pb-6">
        {/* Section tag */}
        <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
          // earn
        </div>

        {/* Title */}
        <h1
          className="text-xl font-medium tracking-[-0.01em] text-white sm:text-2xl"
          style={{ fontFamily: 'var(--font-heading)' }}
        >
          <span className="font-normal text-white/50">LP </span>Vaults
        </h1>
        <p className="mt-2 text-[13px] text-[var(--text-secondary)] max-w-lg">
          Provide liquidity to Percolator markets. Earn trading fees from every
          perpetual trade. Fully on-chain, transparent yield.
        </p>

        {/* Stats row */}
        <div className="mt-6 grid grid-cols-2 gap-px border border-[var(--border)] bg-[var(--border)] sm:grid-cols-4">
          <StatCell
            label="Total Value Locked"
            loading={loading}
          >
            <AnimatedNumber
              value={stats.tvl}
              prefix="$"
              decimals={0}
              className="text-lg font-semibold text-white"
            />
          </StatCell>
          <StatCell
            label="Average APY"
            loading={loading}
          >
            <span className="text-lg font-semibold text-[var(--cyan)]">
              <AnimatedNumber
                value={stats.avgApyPct}
                suffix="%"
                decimals={1}
                className="text-lg font-semibold text-[var(--cyan)]"
              />
            </span>
          </StatCell>
          <StatCell
            label="Daily Fee Revenue"
            loading={loading}
          >
            <AnimatedNumber
              value={stats.dailyFeeRevenue}
              prefix="$"
              decimals={0}
              className="text-lg font-semibold text-white"
            />
          </StatCell>
          <StatCell
            label="Insurance Fund"
            loading={loading}
          >
            <AnimatedNumber
              value={stats.totalInsurance}
              prefix="$"
              decimals={0}
              className="text-lg font-semibold text-white"
            />
          </StatCell>
        </div>
      </div>
    </div>
  );
}

function StatCell({
  label,
  children,
  loading,
}: {
  label: string;
  children: React.ReactNode;
  loading: boolean;
}) {
  return (
    <div className="bg-[var(--panel-bg)] p-4 sm:p-5">
      <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-secondary)] mb-1">
        {label}
      </div>
      {loading ? (
        <div className="h-7 w-24 animate-pulse rounded bg-[var(--border)]" />
      ) : (
        children
      )}
    </div>
  );
}
