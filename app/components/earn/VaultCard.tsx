'use client';

import Link from 'next/link';
import { OiCapMeter } from './OiCapMeter';
import type { MarketVaultInfo } from '@/hooks/useEarnStats';

interface VaultCardProps {
  vault: MarketVaultInfo;
}

/**
 * Individual vault card in the Earn page grid.
 * Shows key metrics and links to the deposit/withdraw page.
 */
export function VaultCard({ vault }: VaultCardProps) {
  const vaultUsd = vault.vaultBalance / 1e6;

  return (
    <Link
      href={`/earn/${vault.slabAddress}`}
      className="group block"
    >
      <div className="border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm overflow-hidden transition-all duration-200 hover:border-[var(--accent)]/20 hud-corners">
        {/* Accent top line */}
        <div className="h-px bg-gradient-to-r from-transparent via-[var(--accent)]/40 to-transparent" />

        <div className="p-5">
          {/* Token header */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              {/* Token icon placeholder */}
              <div className="w-8 h-8 rounded-full bg-[var(--accent)]/10 border border-[var(--accent)]/20 flex items-center justify-center text-xs font-bold text-[var(--accent)]">
                {vault.symbol.slice(0, 2)}
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">
                  {vault.symbol}-PERP
                </h3>
                <p className="text-[10px] text-[var(--text-secondary)]">
                  {vault.name}
                </p>
              </div>
            </div>

            {/* APY badge */}
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-secondary)] mb-0.5">
                Est. APY
              </div>
              <div className="text-lg font-bold text-[var(--cyan)] font-mono tabular-nums">
                {vault.estimatedApyPct.toFixed(1)}%
              </div>
            </div>
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <MetricCell
              label="TVL"
              value={`$${formatCompact(vaultUsd)}`}
            />
            <MetricCell
              label="24h Volume"
              value={`$${formatCompact(vault.volume24h)}`}
            />
            <MetricCell
              label="Insurance"
              value={`$${formatCompact(vault.insuranceFund / 1e6)}`}
            />
            <MetricCell
              label="Max Leverage"
              value={`${vault.maxLeverage}×`}
            />
          </div>

          {/* OI Capacity meter */}
          <OiCapMeter
            currentOI={vault.totalOI}
            maxOI={vault.maxOI}
            compact
          />

          {/* CTA */}
          <div className="mt-4 flex items-center justify-between">
            <span className="text-[11px] text-[var(--text-secondary)]">
              Fee: {(vault.tradingFeeBps / 100).toFixed(2)}%
            </span>
            <span className="text-[11px] font-medium text-[var(--accent)] opacity-0 group-hover:opacity-100 transition-opacity duration-200">
              Deposit →
            </span>
          </div>
        </div>
      </div>
    </Link>
  );
}

function MetricCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-secondary)] mb-0.5">
        {label}
      </div>
      <div className="text-sm font-mono tabular-nums text-white">{value}</div>
    </div>
  );
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}
