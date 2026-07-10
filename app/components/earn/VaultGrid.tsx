'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import { VaultCard } from './VaultCard';
import { VaultCardSkeleton } from './VaultCardSkeleton';
import type { MarketVaultInfo } from '@/hooks/useEarnStats';

type SortKey = 'tvl' | 'volume' | 'utilization';

const PAGE_SIZE = 24;

interface VaultGridProps {
  markets: MarketVaultInfo[];
  loading: boolean;
  /** Set when the last fetch failed — distinguishes "genuinely no vaults" from "couldn't load". */
  error?: string | null;
}

export function VaultGrid({ markets, loading, error }: VaultGridProps) {
  const [sortBy, setSortBy] = useState<SortKey>('tvl');
  const [searchQuery, setSearchQuery] = useState('');
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE);
  const observerTarget = useRef<HTMLDivElement>(null);

  const sorted = useMemo(() => {
    let filtered = markets;

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (m) =>
          m.symbol.toLowerCase().includes(q) ||
          m.name.toLowerCase().includes(q),
      );
    }

    // Sort
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

  // Reset display count when filters change
  useEffect(() => {
    setDisplayCount(PAGE_SIZE);
  }, [searchQuery, sortBy]);

  // Scroll-triggered progressive loading — reveals the next page once the
  // sentinel div at the bottom of the grid enters the viewport.
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
      {/* Filter bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-6">
        {/* Search */}
        <div className="relative w-full sm:w-64">
          <input
            type="text"
            aria-label="Search markets"
            placeholder="Search markets..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-9 px-3 pl-8 text-[13px] bg-[var(--panel-bg)] border border-[var(--border)] rounded-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]/30 transition-colors"
          />
          <svg
            aria-hidden="true"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>

        {/* Sort buttons */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-secondary)] mr-2">
            Sort:
          </span>
          {(
            [
              ['tvl', 'TVL'],
              ['volume', 'Volume'],
              ['utilization', 'Utilization'],
            ] as [SortKey, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSortBy(key)}
              aria-pressed={sortBy === key}
              className={`px-3 py-1.5 text-[11px] rounded-sm border transition-all duration-150 ${
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

      {/* Grid */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <VaultCardSkeleton key={i} />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <div className="border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm p-12 text-center">
          <div aria-hidden="true" className="text-3xl mb-3">{error && !searchQuery ? '⚠' : '🔍'}</div>
          <p className="text-[13px] text-[var(--text-secondary)]">
            {searchQuery
              ? `No vaults matching "${searchQuery}"`
              : error
                ? "Couldn't load vaults — please try again shortly"
                : 'No active vaults found'}
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {sorted.slice(0, displayCount).map((vault) => (
              <VaultCard key={vault.slabAddress} vault={vault} />
            ))}
          </div>
          {displayCount < sorted.length ? (
            <div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {[1, 2, 3].map((i) => (
                  <VaultCardSkeleton key={i} />
                ))}
              </div>
              <div ref={observerTarget} className="h-2 w-full" />
            </div>
          ) : sorted.length > PAGE_SIZE ? (
            <div className="flex items-center justify-center gap-3 py-4">
              <span className="text-[11px] text-[var(--text-dim)]" style={{ fontFamily: 'var(--font-mono)' }}>
                all {sorted.length} vault{sorted.length !== 1 ? 's' : ''} loaded
              </span>
              <button
                onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
                className="text-[12px] text-[var(--accent)] hover:text-[var(--accent)]/80 transition-colors"
              >
                ↑ top
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
