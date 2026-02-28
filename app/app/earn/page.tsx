'use client';

import { useEffect } from 'react';
import dynamic from 'next/dynamic';
import { useEarnStats } from '@/hooks/useEarnStats';
import { ScrollReveal } from '@/components/ui/ScrollReveal';

const EarnHeader = dynamic(
  () => import('@/components/earn/EarnHeader').then((m) => m.EarnHeader),
  {
    ssr: false,
    loading: () => (
      <div className="h-[280px] animate-pulse bg-[var(--panel-bg)]" />
    ),
  },
);

const OiCapMeter = dynamic(
  () => import('@/components/earn/OiCapMeter').then((m) => m.OiCapMeter),
  {
    ssr: false,
    loading: () => (
      <div className="h-20 animate-pulse bg-[var(--panel-bg)] border border-[var(--border)]" />
    ),
  },
);

const VaultGrid = dynamic(
  () => import('@/components/earn/VaultGrid').then((m) => m.VaultGrid),
  {
    ssr: false,
    loading: () => (
      <div className="h-[400px] animate-pulse bg-[var(--panel-bg)] border border-[var(--border)]" />
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
      <div className="h-[300px] animate-pulse bg-[var(--panel-bg)] border border-[var(--border)]" />
    ),
  },
);

export default function EarnPage() {
  useEffect(() => {
    document.title = 'Earn — Percolator';
  }, []);

  const { stats, loading, error } = useEarnStats();

  return (
    <div className="min-h-[calc(100vh-48px)]">
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
                  className="text-sm font-medium text-white"
                  style={{ fontFamily: 'var(--font-heading)' }}
                >
                  <span className="text-white/50">Active </span>Vaults
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
                  className="text-sm font-medium text-white mb-4"
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
                    desc="Monitor your APY, share value, and position in real-time"
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
        {error && (
          <div className="fixed bottom-4 right-4 z-50 bg-[var(--short)]/10 border border-[var(--short)]/30 rounded-sm px-4 py-3 text-[12px] text-[var(--short)]">
            {error}
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
        <div className="text-[12px] text-white font-medium">{title}</div>
        <div className="text-[11px] text-[var(--text-secondary)]">{desc}</div>
      </div>
    </div>
  );
}
