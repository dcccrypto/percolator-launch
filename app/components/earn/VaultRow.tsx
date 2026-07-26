'use client';

import type { MarketVaultInfo } from '@/hooks/useEarnStats';
import { formatCompact } from '@/lib/formatters';
import { MarketLogo } from '@/components/market/MarketLogo';
import { OiCapMeter } from './OiCapMeter';

/**
 * Shared CSS-grid column template for the LP-vault table — used by BOTH the
 * column-header row (in VaultGrid) and every VaultRow below it so headers and
 * cells always line up. Mirrors the terminal-table idiom in
 * components/trade/TradeHistoryTable.tsx.
 *
 * Columns: Market · TVL · Utilization · Fee · Your Deposit.
 */
export const VAULT_GRID_COLS =
  'grid grid-cols-[minmax(120px,1.6fr)_84px_minmax(104px,1.2fr)_64px_92px] items-center gap-x-3';

interface VaultRowProps {
  vault: MarketVaultInfo;
  selected: boolean;
  /** User's deposit in this vault (USD). null = not yet resolved / unknown. */
  userDepositUsd: number | null;
  onSelect: (slabAddress: string) => void;
}

/**
 * A single selectable vault row in the LP-vault table. Clicking (or activating
 * via keyboard) loads this vault into the deposit rail on the right. The whole
 * row is the target — the "obvious, always-reachable deposit flow."
 */
export function VaultRow({ vault, selected, userDepositUsd, onSelect }: VaultRowProps) {
  const vaultUsd = vault.vaultBalance / 10 ** vault.decimals;

  return (
    <button
      type="button"
      onClick={() => onSelect(vault.slabAddress)}
      aria-pressed={selected}
      className={`${VAULT_GRID_COLS} w-full border-b border-[var(--border)] border-l-2 px-3 py-2.5 text-left transition-colors duration-100 ${
        selected
          ? 'border-l-[var(--accent)] bg-[var(--accent)]/[0.06]'
          : 'border-l-transparent hover:bg-[var(--bg-elevated)]'
      }`}
    >
      {/* Market */}
      <div className="flex min-w-0 items-center gap-2">
        <MarketLogo mainnetCa={vault.mainnetCa} symbol={vault.symbol} pixelOverride={22} decorative />
        <span className="min-w-0 truncate text-[12px] font-medium text-[var(--text)]">
          {vault.symbol}
          <span className="text-[var(--text-muted)]">-PERP</span>
        </span>
      </div>

      {/* TVL */}
      <span
        className="text-right text-[12px] tabular-nums text-[var(--text)]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        ${formatCompact(vaultUsd)}
      </span>

      {/* Utilization — thin OI/capacity bar + % */}
      <OiCapMeter currentOI={vault.totalOI} maxOI={vault.maxOI} compact />

      {/* Fee */}
      <span
        className="text-right text-[12px] tabular-nums text-[var(--text-secondary)]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        {(vault.tradingFeeBps / 100).toFixed(2)}%
      </span>

      {/* Your Deposit */}
      <span
        className={`text-right text-[12px] tabular-nums ${
          userDepositUsd && userDepositUsd > 0 ? 'text-[var(--accent-text)]' : 'text-[var(--text-muted)]'
        }`}
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        {userDepositUsd == null ? '—' : userDepositUsd > 0 ? `$${formatCompact(userDepositUsd)}` : '$—'}
      </span>
    </button>
  );
}
