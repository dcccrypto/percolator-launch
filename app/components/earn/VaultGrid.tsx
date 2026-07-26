'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import { VaultRow, VAULT_GRID_COLS } from './VaultRow';
import { ShimmerSkeleton } from '@/components/ui/ShimmerSkeleton';
import type { MarketVaultInfo } from '@/hooks/useEarnStats';

type SortKey = 'tvl' | 'volume' | 'utilization';

const PAGE_SIZE = 24;

interface VaultGridProps {
  markets: MarketVaultInfo[];
  loading: boolean;
  /** Set when the last fetch failed — distinguishes "genuinely no vaults" from "couldn't load". */
  error?: string | null;
  /** Slab of the currently-selected vault (drives the deposit rail). */
  selectedSlab: string | null;
  /** Called when a row is picked. */
  onSelect: (slabAddress: string) => void;
  /** slab → the connected wallet's deposit in that vault (USD). Sparse. */
  userDeposits: Record<string, number>;
}

/**
 * Dense, scannable LP-vault table — the "hero" of the Earn tab, mirroring the
 * trade terminal's main content area (and the vault/pool lists on Hyperliquid /
 * GMX / Drift). Columns: Market · TVL · Utilization · Fee · Your Deposit. The
 * whole row is selectable and loads that vault into the deposit rail.
 */
export function VaultGrid({
  markets,
  loading,
  error,
  selectedSlab,
  onSelect,
  userDeposits,
}: VaultGridProps) {
  const [sortBy, setSortBy] = useState<SortKey>('tvl');
  const [searchQuery, setSearchQuery] = useState('');
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE);
  const observerTarget = useRef<HTMLDivElement>(null);

  const sorted = useMemo(() => {
    let filtered = markets;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (m) =>
          m.symbol.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
      );
    }

    return [...filtered].sort((a, b) => {
      switch (sortBy) {
        case 'tvl':
          return b.vaultBalance - a.vaultBalance;
        case 'volume':
          return b.volume24h - a.volume24h;
        case 'utilization':
          return b.oiUtilPct - a.oiUtilPct;
        default:
          return 0;
      }
    });
  }, [markets, sortBy, searchQuery]);

  useEffect(() => {
    setDisplayCount(PAGE_SIZE);
  }, [searchQuery, sortBy]);

  // Scroll-triggered progressive loading — reveals the next page once the
  // sentinel row enters the viewport.
  useEffect(() => {
    const target = observerTarget.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setDisplayCount((prev) => Math.min(prev + PAGE_SIZE, sorted.length));
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(target);
    return () => observer.unobserve(target);
  }, [sorted.length]);

  return (
    <div>
      {/* Filter bar — search + sort controls (kept from the card grid). */}
      <div className="mb-3 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div className="relative w-full sm:w-64">
          <input
            type="text"
            aria-label="Search markets"
            placeholder="Search markets..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-9 w-full rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] pl-8 pr-3 text-[13px] text-[var(--text)] placeholder:text-[var(--text-muted)] transition-colors focus:border-[var(--accent)]/30 focus:outline-none"
          />
          <svg
            aria-hidden="true"
            className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>

        <div className="flex items-center gap-1">
          <span className="mr-2 text-[10px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">
            Sort:
          </span>
          {(
            [
              ['tvl', 'TVL'],
              ['volume', 'Volume'],
              ['utilization', 'Util'],
            ] as [SortKey, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSortBy(key)}
              aria-pressed={sortBy === key}
              className={`rounded-sm border px-3 py-1.5 text-[11px] transition-all duration-150 ${
                sortBy === key
                  ? 'border-[var(--accent)]/40 bg-[var(--accent)]/[0.06] text-[var(--accent)]'
                  : 'border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)]/20 hover:text-[var(--text)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto border border-[var(--border)] bg-[var(--panel-bg)]">
        <div className="min-w-[560px]">
          {/* Column headers */}
          <div
            className={`${VAULT_GRID_COLS} border-b border-[var(--border)] bg-[var(--bg-elevated)]/50 px-3 py-2`}
          >
            <span className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)]">
              Market
            </span>
            <span className="text-right text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)]">
              TVL
            </span>
            <span className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)]">
              Utilization
            </span>
            <span className="text-right text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)]">
              Fee
            </span>
            <span className="text-right text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)]">
              Your Deposit
            </span>
          </div>

          {/* Rows */}
          {loading ? (
            <div>
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className={`${VAULT_GRID_COLS} border-b border-[var(--border)] px-3 py-2.5`}>
                  <div className="flex items-center gap-2">
                    <ShimmerSkeleton className="h-[22px] w-[22px]" />
                    <ShimmerSkeleton className="h-3.5 w-16" />
                  </div>
                  <ShimmerSkeleton className="ml-auto h-3.5 w-12" />
                  <ShimmerSkeleton className="h-1.5 w-full" />
                  <ShimmerSkeleton className="ml-auto h-3.5 w-8" />
                  <ShimmerSkeleton className="ml-auto h-3.5 w-10" />
                </div>
              ))}
            </div>
          ) : sorted.length === 0 ? (
            <div className="px-3 py-12 text-center">
              <div
                className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-secondary)]"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                {searchQuery ? 'No matches' : error ? 'Unavailable' : 'No vaults'}
              </div>
              <p className="mt-2 text-[13px] text-[var(--text-secondary)]">
                {searchQuery
                  ? `No vaults matching "${searchQuery}"`
                  : error
                    ? "Couldn't load vaults — please try again shortly"
                    : 'No LP vaults are live yet.'}
              </p>
            </div>
          ) : (
            <>
              {sorted.slice(0, displayCount).map((vault) => (
                <VaultRow
                  key={vault.slabAddress}
                  vault={vault}
                  selected={vault.slabAddress === selectedSlab}
                  userDepositUsd={
                    vault.slabAddress in userDeposits ? userDeposits[vault.slabAddress] : null
                  }
                  onSelect={onSelect}
                />
              ))}
              {displayCount < sorted.length && <div ref={observerTarget} className="h-px w-full" />}
            </>
          )}
        </div>
      </div>

      {!loading && sorted.length > PAGE_SIZE && displayCount >= sorted.length && (
        <div className="flex items-center justify-center gap-3 py-3">
          <span className="text-[11px] text-[var(--text-dim)]" style={{ fontFamily: 'var(--font-mono)' }}>
            all {sorted.length} vault{sorted.length !== 1 ? 's' : ''} loaded
          </span>
        </div>
      )}
    </div>
  );
}
