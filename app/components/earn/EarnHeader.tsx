'use client';

import { AnimatedNumber } from '@/components/ui/AnimatedNumber';
import type { EarnStats } from '@/hooks/useEarnStats';
import { ShimmerSkeleton } from '@/components/ui/ShimmerSkeleton';
import { FeeBreakdown } from "@/components/FeeBreakdown";
import { FEE_LEGS, legPercent } from "@/lib/fee-breakdown";

/** Derived, never restated — see lib/fee-breakdown.ts. */
const LP_SHARE_PCT = legPercent(FEE_LEGS.find((l) => l.id === "lp")!);


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
          Earn
        </h1>
        <p className="mt-2 text-[13px] text-[var(--text-secondary)] max-w-lg">
          Deposit USDC into a market&apos;s vault and earn a share of its trading fees.
        </p>
        {/* Small and muted, not a prominent banner. Corrected 2026-07-28: this
            used to say yield distribution "isn't active on the deployed program
            yet", which was false — the program distributes fees fine, nothing
            was calling the crank. Verified on a fresh market: a 500-notional
            round trip accrued 1_440_000 atoms (the LP's 48% of the fee) and one
            LpVaultCrankFees moved all of it into the vault. The keeper now
            cranks on its own interval. */}
        {/* UX WP-10 (MB-3, §4.4): on phones the explainer is a collapsed "How Earn works"
            disclosure so the vault list comes first; from md up it shows as before. */}
        <details data-testid="earn-how-it-works" className="mt-2 md:hidden">
          <summary className="cursor-pointer select-none text-[12px] text-[var(--text-secondary)]">How Earn works</summary>
        <p className="mt-1.5 text-[11px] text-[var(--text-secondary)] max-w-lg">
          Earn deposits receive a {LP_SHARE_PCT}% share of every trading fee, added to the vault
          automatically, so the yield follows real trading activity and reads 0% while a market is
          quiet.
        </p>
        <div className="mt-3 max-w-lg border border-[var(--border)] bg-[var(--panel-bg)] p-3">
          <FeeBreakdown highlight="lp" />
        </div>
        </details>
        <div className="hidden md:block">
        <p className="mt-1.5 text-[11px] text-[var(--text-secondary)] max-w-lg">
          Earn deposits receive a {LP_SHARE_PCT}% share of every trading fee, added to the vault
          automatically, so the yield follows real trading activity and reads 0% while a market is
          quiet.
        </p>
        <div className="mt-3 max-w-lg border border-[var(--border)] bg-[var(--panel-bg)] p-3">
          <FeeBreakdown highlight="lp" />
        </div>
        </div>

        {/* Stats row */}
        <div className="mt-5 grid grid-cols-1 gap-px border border-[var(--border)] bg-[var(--border)] sm:grid-cols-3" aria-label="Earn statistics">
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
            {stats.unvaluedSymbols.length > 0 && (
              <p data-testid="earn-tvl-excludes" className="mt-1 text-[11px] text-[var(--text-muted)]">
                {excludesNote(stats.unvaluedSymbols)}
              </p>
            )}
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

/** "Excludes 1 vault (X) that can't be valued right now." Names up to three, then counts the rest. */
export function excludesNote(symbols: string[]): string {
  const n = symbols.length;
  const shown = n > 3 ? `${symbols.slice(0, 3).join(", ")} and ${n - 3} more` : symbols.join(", ");
  return `Excludes ${n} vault${n === 1 ? "" : "s"} (${shown}) that can't be valued right now.`;
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
