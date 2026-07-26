'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useEarnStats } from '@/hooks/useEarnStats';
import { ShimmerSkeleton } from '@/components/ui/ShimmerSkeleton';
import { VaultGrid } from '@/components/earn/VaultGrid';
import { VaultDepositRail } from '@/components/earn/VaultDepositRail';
import { formatCompact } from '@/lib/formatters';

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

export function EarnVaultView() {
  const { stats, loading, error, refresh } = useEarnStats();
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [selectedSlab, setSelectedSlab] = useState<string | null>(null);
  const [userDeposits, setUserDeposits] = useState<Record<string, number>>({});

  const showError = error && error !== dismissedError;

  // Auto-select the first vault once markets load so the deposit rail is always
  // bound to something (mirrors the trade terminal always having a live ticket).
  useEffect(() => {
    if (selectedSlab) return;
    if (stats.markets.length > 0) setSelectedSlab(stats.markets[0].slabAddress);
  }, [stats.markets, selectedSlab]);

  const selectedVault = useMemo(
    () => stats.markets.find((m) => m.slabAddress === selectedSlab) ?? null,
    [stats.markets, selectedSlab],
  );

  // The rail reports the connected wallet's resolved deposit for the selected
  // vault; store it so the table's "Your Deposit" column fills in per row as the
  // user browses. Only writes on an actual value change (no render loop).
  const handlePositionResolved = useCallback((slab: string, usd: number) => {
    setUserDeposits((prev) => (prev[slab] === usd ? prev : { ...prev, [slab]: usd }));
  }, []);

  return (
    <div className="animate-fade-in">
      {/* Compact header + stats strip */}
      <EarnHeader stats={stats} loading={loading} />

      <div className="mx-auto max-w-[1400px] px-4 pb-16 lg:px-6">
        {/* MAIN (table) + RIGHT RAIL (deposit/withdraw) — mirrors the trade terminal */}
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6">
          {/* MAIN — scannable vault table */}
          <div className="min-w-0">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium text-[var(--text)]" style={{ fontFamily: 'var(--font-display)' }}>
                <span className="text-[var(--text-secondary)]">Active </span>Vaults
              </h2>
              <span className="text-[11px] text-[var(--text-secondary)] tabular-nums" style={{ fontFamily: 'var(--font-mono)' }}>
                {loading ? '…' : `${stats.markets.length} market${stats.markets.length !== 1 ? 's' : ''}`}
              </span>
            </div>
            <VaultGrid
              markets={stats.markets}
              loading={loading}
              error={error}
              selectedSlab={selectedSlab}
              onSelect={setSelectedSlab}
              userDeposits={userDeposits}
            />
          </div>

          {/* RIGHT RAIL — deposit/withdraw bound to the selected row */}
          <div className="lg:sticky lg:top-4">
            <VaultDepositRail
              slab={selectedSlab}
              vault={selectedVault}
              onTxSuccess={refresh}
              onPositionResolved={handlePositionResolved}
            />
          </div>
        </div>

        {/* SECONDARY — explanatory content, kept below the functional table+rail */}
        <EarnInfoStrip totalInsurance={stats.totalInsurance} />
      </div>

      {/* Error toast */}
      {showError && (
        <div
          role="alert"
          className="fixed bottom-4 right-4 z-50 flex items-start gap-3 rounded-sm border border-[var(--short)]/30 bg-[var(--short)]/10 px-4 py-3 text-[12px] text-[var(--short)]"
        >
          <span>{error}</span>
          <button
            onClick={() => setDismissedError(error)}
            aria-label="Dismiss error"
            className="text-[var(--short)]/70 transition-colors hover:text-[var(--short)]"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Secondary info strip — slim row of small cards below the table+rail ── */

function EarnInfoStrip({ totalInsurance }: { totalInsurance: number }) {
  return (
    <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
      {/* How it works */}
      <div className="border border-[var(--border)] bg-[var(--panel-bg)] p-4 hud-corners">
        <h3 className="mb-3 text-[12px] font-medium text-[var(--text)]" style={{ fontFamily: 'var(--font-display)' }}>
          How It Works
        </h3>
        <ol className="space-y-2">
          <MiniStep num={1} title="Deposit" desc="Provide sim-USDC as counterparty backing" />
          <MiniStep num={2} title="Earn fees" desc="Every trade on that market generates LP fees" />
          <MiniStep num={3} title="Withdraw" desc="Redeem LP tokens for your share after cooldown" />
        </ol>
      </div>

      {/* Insurance fund */}
      <div className="border border-[var(--border)] bg-[var(--panel-bg)] p-4 hud-corners">
        <div className="mb-1 flex items-center gap-2">
          <span aria-hidden="true" className="text-xs">🛡️</span>
          <h3 className="text-[12px] font-medium text-[var(--text)]" style={{ fontFamily: 'var(--font-display)' }}>
            Insurance Fund
          </h3>
        </div>
        <div className="mb-2 text-lg font-bold tabular-nums text-[var(--text)]" style={{ fontFamily: 'var(--font-mono)' }}>
          ${formatCompact(totalInsurance)}
        </div>
        <ul className="space-y-1 text-[11px] text-[var(--text-secondary)]">
          <li>· Absorbs liquidation shortfalls</li>
          <li>· Buffers socialized losses before LPs</li>
          <li>· Backstops protocol solvency</li>
        </ul>
      </div>

      {/* Risk notice */}
      <div className="border border-[var(--border)] bg-[var(--panel-bg)] p-4 hud-corners">
        <div className="mb-2 text-[10px] uppercase tracking-[0.15em] text-[var(--warning)]">⚠ Risk Notice</div>
        <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
          LP deposits are exposed to trader PnL — when traders win, LPs may see drawdowns. The
          insurance fund provides a buffer. Only deposit what you can afford to lose.
        </p>
      </div>
    </div>
  );
}

function MiniStep({ num, title, desc }: { num: number; title: string; desc: string }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-[var(--accent)]/20 bg-[var(--accent)]/10 text-[9px] font-bold text-[var(--accent-text)]">
        {num}
      </span>
      <div className="min-w-0">
        <div className="text-[11px] font-medium text-[var(--text)]">{title}</div>
        <div className="text-[11px] text-[var(--text-secondary)]">{desc}</div>
      </div>
    </li>
  );
}
