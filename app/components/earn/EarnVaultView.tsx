'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useEarnStats } from '@/hooks/useEarnStats';
import { ShimmerSkeleton } from '@/components/ui/ShimmerSkeleton';
import { VaultGrid } from '@/components/earn/VaultGrid';
import { VaultDepositRail } from '@/components/earn/VaultDepositRail';
import { useEarnPositions } from '@/hooks/useEarnPositions';
import { useWalletCompat } from '@/hooks/useWalletCompat';
import { formatCompact } from '@/lib/formatters';
import { limitsFlags } from '@/lib/limits/flags';
import { COPY } from '@/lib/limits/copy';
import { isDevnetV22Enabled } from '@/lib/v22/flag';
import { V22_COPY } from '@/lib/v22/copy';

const EarnHeader = dynamic(
  () => import('@/components/earn/EarnHeader').then((m) => m.EarnHeader),
  {
    ssr: false,
    loading: () => (
      // Same shape as EarnHeader: title block, then the three stats (beside it from xl).
      <div className="relative mx-auto max-w-[1400px] px-4 pt-10 pb-6 lg:px-6">
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,40rem)] xl:items-end xl:gap-10">
          <div>
            <ShimmerSkeleton className="mb-2 h-3 w-16" />
            <ShimmerSkeleton className="h-7 w-64 max-w-full" />
            <ShimmerSkeleton className="mt-3 h-4 w-[36rem] max-w-full" />
            <ShimmerSkeleton className="mt-2 h-4 w-80 max-w-full" />
          </div>
          <div className="grid grid-cols-1 gap-px border border-[var(--border)] bg-[var(--border)] sm:grid-cols-3 animate-fade-in">
            {[1, 2, 3].map((i) => (
              <div key={i} className="bg-[var(--panel-bg)] p-4 sm:p-5 space-y-2">
                <ShimmerSkeleton className="h-3 w-24" />
                <ShimmerSkeleton className="h-6 w-16" />
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
  },
);

export function EarnVaultView() {
  const { stats, loading: statsLoading, error, hasData, refresh } = useEarnStats();
  // Until a read succeeds the stats are partly unread (a failed first load), so show the loading
  // state, not their $0 / shares + fees totals.
  const loading = statsLoading || !hasData;
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [selectedSlab, setSelectedSlab] = useState<string | null>(null);
  // Tagged with the wallet they were reported for: after a wallet switch or disconnect the
  // previous wallet's figures must not show as this one's (or drive the Mine filter).
  const [railDeposits, setRailDeposits] = useState<{ owner: string | null; bySlab: Record<string, number> }>({
    owner: null,
    bySlab: {},
  });
  const walletStr = useWalletCompat().publicKey?.toBase58() ?? null;
  const walletRef = useRef(walletStr);
  useEffect(() => {
    walletRef.current = walletStr;
  }, [walletStr]);

  // A dismissal covers this run of the error only: once a refresh succeeds, the next failure
  // (even with the same message) shows again, or the page could sit on stale figures unflagged.
  useEffect(() => {
    if (!error) setDismissedError(null);
  }, [error]);
  const showError = error && error !== dismissedError;

  // Auto-select the first vault once markets load so the deposit rail is always
  // bound to something (mirrors the trade terminal always having a live ticket).
  useEffect(() => {
    if (selectedSlab) return;
    if (stats.markets.length > 0) setSelectedSlab(stats.markets[0].slabAddress);
  }, [stats.markets, selectedSlab]);

  // Below lg the rail renders under the table, so a row tap changed nothing on screen. Bring the
  // rail into view, its top below the sticky header (scroll-mt-24 on the rail). No `behavior`: the
  // html scroll-behavior applies, smooth unless the user prefers reduced motion. Not on auto-select above.
  const railRef = useRef<HTMLDivElement | null>(null);
  const selectVault = useCallback((slab: string) => {
    setSelectedSlab(slab);
    if (!window.matchMedia('(min-width: 64rem)').matches) {
      railRef.current?.scrollIntoView({ block: 'start' });
    }
  }, []);

  const selectedVault = useMemo(
    () => stats.markets.find((m) => m.slabAddress === selectedSlab) ?? null,
    [stats.markets, selectedSlab],
  );

  // The rail reports the connected wallet's resolved deposit for the selected
  // vault; store it so the table's "Your Value" column fills in per row as the
  // user browses. Only writes on an actual value change (no render loop).
  // Stable identity on purpose: a new callback would re-fire the rail's report effect with the
  // previous wallet's figure before its re-read lands.
  const handlePositionResolved = useCallback((slab: string, usd: number) => {
    const owner = walletRef.current;
    setRailDeposits((prev) => {
      if (prev.owner === owner) {
        return prev.bySlab[slab] === usd ? prev : { owner, bySlab: { ...prev.bySlab, [slab]: usd } };
      }
      return { owner, bySlab: { [slab]: usd } };
    });
  }, []);
  const userDeposits = walletStr && railDeposits.owner === walletStr ? railDeposits.bySlab : null;

  // Every row's deposit from chain (wallet LP ATA + pending escrow, incl. a creator's wizard seed),
  // not only the row bound to the rail; the rail's own resolved value wins for the selected row.
  const chainDeposits = useEarnPositions(stats.markets);
  const tableDeposits = useMemo(() => ({ ...chainDeposits, ...userDeposits }), [chainDeposits, userDeposits]);

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
              onSelect={selectVault}
              userDeposits={tableDeposits}
            />
          </div>

          {/* RIGHT RAIL — deposit/withdraw bound to the selected row */}
          <div ref={railRef} className="scroll-mt-24 lg:sticky lg:top-4">
            <VaultDepositRail
              slab={selectedSlab}
              vault={selectedVault}
              onTxSuccess={refresh}
              onPositionResolved={handlePositionResolved}
            />
          </div>
        </div>

        {/* SECONDARY — explanatory content, kept below the functional table+rail */}
        <EarnInfoStrip totalInsurance={loading ? null : stats.totalInsurance} />
      </div>

      {/* Error toast. Below md it sits above the fixed mobile tab bar (MobileBottomNav: 3.5rem + safe
          area, same offset as MobileTradeBand), which otherwise covered it. */}
      {showError && (
        <div
          role="alert"
          data-testid="earn-error"
          data-kind="stats"
          className="fixed bottom-[calc(3.5rem+1rem+env(safe-area-inset-bottom,0px))] md:bottom-4 right-4 z-50 flex items-start gap-3 rounded-sm border border-[var(--short)]/30 bg-[var(--short)]/10 px-4 py-3 text-[12px] text-[var(--short)]"
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

/* ── Secondary info: one row each, closed until asked for, one open at a time ── */

type InfoKey = 'how' | 'insurance' | 'risk';

/** `totalInsurance` null = not read yet, or unknown for every market (no stats row carries it). */
function EarnInfoStrip({ totalInsurance }: { totalInsurance: number | null }) {
  const [open, setOpen] = useState<InfoKey | null>(null);
  const toggle = (key: InfoKey) => setOpen((cur) => (cur === key ? null : key));
  return (
    <div data-testid="earn-info" className="mt-8 divide-y divide-[var(--border)] border border-[var(--border)] bg-[var(--panel-bg)]">
      <InfoRow id="how" title="How it works" open={open === 'how'} onToggle={toggle}>
        <ol className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <MiniStep num={1} title="Deposit" desc={isDevnetV22Enabled() ? V22_COPY.earnPage.howDeposit : "Provide sim-USDC as counterparty backing"} />
          <MiniStep num={2} title="Earn fees" desc="Every trade on that market pays a fee share into the vault" />
          <MiniStep num={3} title="Withdraw" desc="Request a withdrawal; it pays out after a short wait" />
        </ol>
      </InfoRow>

      <InfoRow
        id="insurance"
        title="Insurance fund"
        open={open === 'insurance'}
        onToggle={toggle}
        aside={
          <span data-testid="earn-insurance-figure" className="tabular-nums text-[var(--text)]" style={{ fontFamily: 'var(--font-mono)' }}>
            {totalInsurance == null ? "—" : `$${formatCompact(totalInsurance)}`}
          </span>
        }
      >
        <ul className="space-y-1 text-[11px] text-[var(--text-secondary)]">
          <li>· Absorbs liquidation shortfalls</li>
          <li>· {isDevnetV22Enabled() ? V22_COPY.earnPage.insuranceOrder : "Covers losses before they reach Earn deposits"}</li>
          <li>· Backstops protocol solvency</li>
        </ul>
      </InfoRow>

      <InfoRow id="risk" title="Risk notice" warning open={open === 'risk'} onToggle={toggle}>
        <p className="max-w-[90ch] text-[11px] leading-relaxed text-[var(--text-secondary)]">
          {limitsFlags().p3
            ? COPY.howLossesWork
            : "Earn deposits are exposed to trader profit and loss: when traders win, the vault can go down. The insurance fund provides a buffer. Only deposit what you can afford to lose."}
        </p>
      </InfoRow>
    </div>
  );
}

function InfoRow({
  id,
  title,
  open,
  onToggle,
  aside,
  warning = false,
  children,
}: {
  id: InfoKey;
  title: string;
  open: boolean;
  onToggle: (key: InfoKey) => void;
  aside?: React.ReactNode;
  warning?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-[12px] font-medium" style={{ fontFamily: 'var(--font-display)' }}>
        <button
          type="button"
          id={`earn-info-${id}-button`}
          aria-expanded={open}
          aria-controls={`earn-info-${id}`}
          onClick={() => onToggle(id)}
          className="flex min-h-[44px] w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
        >
          <span className={warning ? 'text-[var(--warning)]' : 'text-[var(--text)]'}>
            {warning && <span aria-hidden="true">⚠ </span>}
            {title}
          </span>
          {aside && <span className="ml-auto text-[12px]">{aside}</span>}
          <span aria-hidden="true" className={`${aside ? '' : 'ml-auto '}text-[var(--text-secondary)] transition-transform duration-150 ${open ? 'rotate-180' : ''}`}>
            ▾
          </span>
        </button>
      </h3>
      <div
        id={`earn-info-${id}`}
        role="region"
        aria-labelledby={`earn-info-${id}-button`}
        hidden={!open}
        className="px-4 pb-4 pt-1"
      >
        {children}
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
