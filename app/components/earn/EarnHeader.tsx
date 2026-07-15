'use client';

import { AnimatedNumber } from '@/components/ui/AnimatedNumber';
import type { EarnStats } from '@/hooks/useEarnStats';
import { ShimmerSkeleton } from '@/components/ui/ShimmerSkeleton';
import { InDevelopmentBanner } from '@/components/InDevelopmentBanner';


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
          className="text-2xl font-medium tracking-[-0.01em] text-[var(--text)]"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          <span className="font-normal text-[var(--text-secondary)]">LP </span>Vaults
        </h1>
        <p className="mt-2 text-[13px] text-[var(--text-secondary)] max-w-lg">
          Provide counterparty backing to Percolator markets — fully on-chain and
          transparent.
        </p>

        <div className="mt-5 max-w-3xl">
          <InDevelopmentBanner>
            LP vaults accept deposits and redemptions work, but yield distribution isn&apos;t live on
            the deployed program yet — <span className="text-[var(--text)]">APY is genuinely 0%</span>.
            Deposited capital is held as protocol counterparty backing; treat this as experimental, not
            a yield product.
          </InDevelopmentBanner>
        </div>

        {/* Stats row */}
        <div className="mt-6 grid grid-cols-1 gap-px border border-[var(--border)] bg-[var(--border)] sm:grid-cols-3" aria-label="Earn statistics">
          <StatCell
            label="Total Value Locked"
            loading={loading}
          >
            <AnimatedNumber
              value={stats.tvl}
              prefix="$"
              decimals={0}
              className="text-2xl font-bold text-[var(--text)]"
            />
          </StatCell>
          <StatCell
            label="Daily Fee Revenue"
            loading={loading}
          >
            <AnimatedNumber
              value={stats.dailyFeeRevenue}
              prefix="$"
              decimals={0}
              className="text-2xl font-bold text-[var(--text)]"
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
              className="text-2xl font-bold text-[var(--text)]"
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
  tooltip,
}: {
  label: string;
  children: React.ReactNode;
  loading: boolean;
  tooltip?: string;
}) {
  return (
    <div className="bg-[var(--panel-bg)] p-4 sm:p-5">
      <div
        className={`text-[10px] uppercase tracking-[0.2em] text-[var(--text-secondary)] mb-1 ${
          tooltip ? 'cursor-help underline decoration-dotted decoration-[var(--text-muted)]' : ''
        }`}
        title={tooltip}
      >
        {label}
      </div>
      {loading ? (
        <ShimmerSkeleton className="h-7 w-24 rounded" />
      ) : (
        children
      )}
    </div>
  );
}
