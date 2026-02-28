'use client';

import { useState, useMemo } from 'react';
import { VaultCard } from './VaultCard';
import type { MarketVaultInfo } from '@/hooks/useEarnStats';

type SortKey = 'apy' | 'tvl' | 'volume' | 'utilization';

interface VaultGridProps {
  markets: MarketVaultInfo[];
  loading: boolean;
}

export function VaultGrid({ markets, loading }: VaultGridProps) {
  const [sortBy, setSortBy] = useState<SortKey>('apy');
  const [searchQuery, setSearchQuery] = useState('');

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
        case 'apy':
          return b.estimatedApyPct - a.estimatedApyPct;
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

  return (
    <div>
      {/* Filter bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-6">
        {/* Search */}
        <div className="relative w-full sm:w-64">
          <input
            type="text"
            placeholder="Search markets..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-9 px-3 pl-8 text-[13px] bg-[var(--panel-bg)] border border-[var(--border)] rounded-sm text-white placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]/30 transition-colors"
          />
          <svg
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
              ['apy', 'APY'],
              ['tvl', 'TVL'],
              ['volume', 'Volume'],
              ['utilization', 'Utilization'],
            ] as [SortKey, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSortBy(key)}
              className={`px-3 py-1.5 text-[11px] rounded-sm border transition-all duration-150 ${
                sortBy === key
                  ? 'border-[var(--accent)]/40 bg-[var(--accent)]/[0.06] text-[var(--accent)]'
                  : 'border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)]/20 hover:text-white'
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
            <div
              key={i}
              className="h-[280px] animate-pulse bg-[var(--panel-bg)] border border-[var(--border)] rounded-sm"
            />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <div className="border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm p-12 text-center">
          <div className="text-3xl mb-3">🔍</div>
          <p className="text-[13px] text-[var(--text-secondary)]">
            {searchQuery
              ? `No vaults matching "${searchQuery}"`
              : 'No active vaults found'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {sorted.map((vault) => (
            <VaultCard key={vault.slabAddress} vault={vault} />
          ))}
        </div>
      )}
    </div>
  );
}
