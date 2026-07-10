'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useEarnStats } from '@/hooks/useEarnStats';
import { ScrollReveal } from '@/components/ui/ScrollReveal';
import { ShimmerSkeleton } from '@/components/ui/ShimmerSkeleton';

const EarnHeader = dynamic(
  () => import('@/components/earn/EarnHeader').then((m) => m.EarnHeader),
  {
    ssr: false,
    loading: () => (
      <div className="relative mx-auto max-w-6xl px-4 pt-10 pb-6">
        <ShimmerSkeleton className="mb-2 h-3 w-16" />
        <ShimmerSkeleton className="h-7 w-48" />
        <ShimmerSkeleton className="mt-2 h-4 w-96 max-w-full" />
        <div className="mt-6 grid grid-cols-2 gap-px border border-[var(--border)] bg-[var(--border)] sm:grid-cols-4 animate-fade-in">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-[var(--panel-bg)] p-4 sm:p-5 space-y-2">
              <ShimmerSkeleton className="h-3 w-24" />
              <ShimmerSkeleton className="h-6 w-16" />
            </div>
          ))}
        </div>
      </div>
    ),
  },
);

const OiCapMeter = dynamic(
  () => import('@/components/earn/OiCapMeter').then((m) => m.OiCapMeter),
  {
    ssr: false,
    loading: () => (
      <div className="space-y-3 p-5">
        <div className="flex justify-between items-center">
          <ShimmerSkeleton className="h-3 w-20" />
          <ShimmerSkeleton className="h-4.5 w-16 rounded-sm" />
        </div>
        <ShimmerSkeleton className="h-3 w-full" />
        <div className="flex justify-between items-center">
          <div className="flex gap-4">
            <ShimmerSkeleton className="h-3 w-28" />
            <ShimmerSkeleton className="h-3 w-20" />
          </div>
          <ShimmerSkeleton className="h-3 w-8" />
        </div>
      </div>
    ),
  },
);

const VaultGrid = dynamic(
  () => import('@/components/earn/VaultGrid').then((m) => m.VaultGrid),
  {
    ssr: false,
    loading: () => (
      <div>
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-6">
          <ShimmerSkeleton className="h-9 w-full sm:w-64" />
          <div className="flex items-center gap-1">
            <ShimmerSkeleton className="h-3 w-10 mr-2" />
            {[1, 2, 3, 4].map(i => <ShimmerSkeleton key={i} className="h-8 w-16" />)}
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="border border-[var(--border)] bg-[var(--panel-bg)] p-5 space-y-4 rounded-sm">
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-3">
                  <ShimmerSkeleton className="w-8 h-8 rounded-full" />
                  <div>
                    <ShimmerSkeleton className="h-4 w-20 mb-1" />
                    <ShimmerSkeleton className="h-3 w-16" />
                  </div>
                </div>
                <div className="text-right space-y-1">
                  <ShimmerSkeleton className="h-2.5 w-12" />
                  <ShimmerSkeleton className="h-5 w-16" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {[1, 2, 3, 4].map(j => (
                  <div key={j} className="space-y-1">
                    <ShimmerSkeleton className="h-2 w-10" />
                    <ShimmerSkeleton className="h-4.5 w-16" />
                  </div>
                ))}
              </div>
              <ShimmerSkeleton className="h-2 w-full mt-2" />
            </div>
          ))}
        </div>
      </div>
    ),
  },
);

const InsuranceFundDisplay = dynamic(
  () =>
    import('@/components/earn/InsuranceFundDisplay').then(
      (m) => m.InsuranceFundDisplay,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm p-5 space-y-4">
        <div className="flex items-center gap-2">
          <ShimmerSkeleton className="w-6 h-6 rounded-sm shrink-0" />
          <ShimmerSkeleton className="h-4 w-28" />
        </div>
        <div className="space-y-1">
          <ShimmerSkeleton className="h-7 w-20" />
          <ShimmerSkeleton className="h-3 w-40" />
        </div>
        <div className="border-t border-[var(--border)] pt-4 space-y-3">
          <ShimmerSkeleton className="h-3 w-16" />
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
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
    ),
  },
);

export default function EarnPage() {
  const { stats, loading, error } = useEarnStats();
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const showError = error && error !== dismissedError;

  return (
    <div className="min-h-[calc(100dvh-48px)] animate-fade-in">
      {/* Header with stats banner */}
      <EarnHeader stats={stats} loading={loading} />

      <div className="mx-auto max-w-6xl px-4 pb-16">
        {/* Platform-wide OI cap meter */}
        <ScrollReveal>
          <div className="mb-8 border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm p-5 hud-corners">
            <OiCapMeter
              currentOI={stats.totalOI}
              maxOI={stats.maxOI}
            />
          </div>
        </ScrollReveal>

        {/* Main content grid */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Vault list — 3 cols */}
          <div className="lg:col-span-3">
            <ScrollReveal>
              <div className="mb-4 flex items-center justify-between">
                <h2
                  className="text-sm font-medium text-[var(--text)]"
                  style={{ fontFamily: 'var(--font-heading)' }}
                >
                  <span className="text-[var(--text-secondary)]">Active </span>Vaults
                </h2>
                <span className="text-[11px] text-[var(--text-secondary)]">
                  {stats.markets.length} market{stats.markets.length !== 1 ? 's' : ''}
                </span>
              </div>
              <VaultGrid markets={stats.markets} loading={loading} />
            </ScrollReveal>
          </div>

          {/* Sidebar — insurance + info */}
          <div className="lg:col-span-1 space-y-6">
            <ScrollReveal>
              <InsuranceFundDisplay stats={stats} loading={loading} />
            </ScrollReveal>

            {/* How it works */}
            <ScrollReveal>
              <div className="border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm p-5 hud-corners">
                <div className="h-px bg-gradient-to-r from-transparent via-[var(--accent)]/30 to-transparent -mx-5 -mt-5 mb-5" />
                <h3
                  className="text-sm font-medium text-[var(--text)] mb-4"
                  style={{ fontFamily: 'var(--font-heading)' }}
                >
                  How It Works
                </h3>
                <div className="space-y-3">
                  <Step
                    num={1}
                    title="Deposit SOL"
                    desc="Provide collateral to any perp market vault"
                  />
                  <Step
                    num={2}
                    title="Earn Fees"
                    desc="Every trade on that market generates fees for LPs"
                  />
                  <Step
                    num={3}
                    title="Track Yield"
                    desc="Monitor your share value and position in real-time"
                  />
                  <Step
                    num={4}
                    title="Withdraw"
                    desc="Redeem LP tokens for your share of the vault anytime"
                  />
                </div>

                {/* Risk notice */}
                <div className="mt-5 pt-4 border-t border-[var(--border)]">
                  <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--warning)] mb-2">
                    ⚠ Risk Notice
                  </div>
                  <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
                    LP deposits are exposed to trader PnL. When traders win, LPs may
                    see temporary drawdowns. The insurance fund provides a buffer.
                    Only deposit what you can afford to lose.
                  </p>
                </div>
              </div>
            </ScrollReveal>
          </div>
        </div>

        {/* Error toast */}
        {showError && (
          <div
            role="alert"
            className="fixed bottom-4 right-4 z-50 flex items-start gap-3 bg-[var(--short)]/10 border border-[var(--short)]/30 rounded-sm px-4 py-3 text-[12px] text-[var(--short)]"
          >
            <span>{error}</span>
            <button
              onClick={() => setDismissedError(error)}
              aria-label="Dismiss error"
              className="text-[var(--short)]/70 hover:text-[var(--short)] transition-colors"
            >
              ✕
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Step({
  num,
  title,
  desc,
}: {
  num: number;
  title: string;
  desc: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-5 h-5 rounded-sm bg-[var(--accent)]/10 border border-[var(--accent)]/20 flex items-center justify-center text-[10px] font-bold text-[var(--accent)] shrink-0 mt-0.5">
        {num}
      </div>
      <div>
        <div className="text-[12px] text-[var(--text)] font-medium">{title}</div>
        <div className="text-[11px] text-[var(--text-secondary)]">{desc}</div>
      </div>
    </div>
  );
}
