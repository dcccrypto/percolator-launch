'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { SlabProvider } from '@/components/providers/SlabProvider';
import { useStakePool } from '@/hooks/useStakePool';
import { useStakeDeposit } from '@/hooks/useStakeDeposit';
import { useStakeWithdraw } from '@/hooks/useStakeWithdraw';
import { useEngineState } from '@/hooks/useEngineState';
import { useEarnStats, type MarketVaultInfo } from '@/hooks/useEarnStats';
import { OiCapMeter } from '@/components/earn/OiCapMeter';
import { ScrollReveal } from '@/components/ui/ScrollReveal';
import { AnimatedNumber } from '@/components/ui/AnimatedNumber';

const DepositWithdrawPanel = dynamic(
  () =>
    import('@/components/earn/DepositWithdrawPanel').then(
      (m) => m.DepositWithdrawPanel,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="h-[400px] animate-pulse bg-[var(--panel-bg)] border border-[var(--border)] rounded-sm" />
    ),
  },
);

const LpPositionDashboard = dynamic(
  () =>
    import('@/components/earn/LpPositionDashboard').then(
      (m) => m.LpPositionDashboard,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="h-[300px] animate-pulse bg-[var(--panel-bg)] border border-[var(--border)] rounded-sm" />
    ),
  },
);

/** Wrapper that provides SlabProvider context for the vault detail inner component. */
export default function VaultDetailPage() {
  const params = useParams();
  const slabAddress = params?.slab as string;

  return (
    <SlabProvider slabAddress={slabAddress}>
      <VaultDetailInner slabAddress={slabAddress} />
    </SlabProvider>
  );
}

function VaultDetailInner({ slabAddress }: { slabAddress: string }) {

  useEffect(() => {
    document.title = 'Vault — Percolator';
  }, []);

  // Get stake pool state for this market
  const { state: poolState, loading: poolLoading, refreshState } = useStakePool();
  const { deposit: stakeDeposit, loading: depositLoading } = useStakeDeposit();
  const { withdraw: stakeWithdraw, loading: withdrawLoading } = useStakeWithdraw();
  const { engine, totalOI, vault: engineVault } = useEngineState();

  // Get market info from earn stats
  const { stats: earnStats, loading: earnLoading } = useEarnStats();
  const marketInfo = useMemo<MarketVaultInfo | null>(() => {
    return earnStats.markets.find((m) => m.slabAddress === slabAddress) ?? null;
  }, [earnStats.markets, slabAddress]);

  const loading = poolLoading || earnLoading;

  // Callbacks
  const handleDeposit = useCallback(
    async (amount: bigint) => {
      await stakeDeposit(amount);
      await refreshState();
    },
    [stakeDeposit, refreshState],
  );

  const handleWithdraw = useCallback(
    async (lpAmount: bigint) => {
      await stakeWithdraw(lpAmount);
      await refreshState();
    },
    [stakeWithdraw, refreshState],
  );

  const symbol = marketInfo?.symbol ?? 'UNKNOWN';
  const maxOI = marketInfo?.maxOI ?? 0;
  const currentOI = marketInfo?.totalOI ?? (totalOI ? Number(totalOI) / 1e6 : 0);
  const estimatedApy = marketInfo?.estimatedApyPct ?? 0;
  const vaultUsd = Number(poolState.vaultBalance) / 1e6;
  const insuranceFund = marketInfo?.insuranceFund ?? 0;

  return (
    <div className="min-h-[calc(100vh-48px)]">
      {/* Background */}
      <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />

      <div className="relative mx-auto max-w-5xl px-4 pt-8 pb-16">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 mb-6 text-[11px]">
          <Link
            href="/earn"
            className="text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors"
          >
            ← Earn
          </Link>
          <span className="text-[var(--text-muted)]">/</span>
          <span className="text-white">{symbol}-PERP Vault</span>
        </div>

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-[var(--accent)]/10 border border-[var(--accent)]/20 flex items-center justify-center text-lg font-bold text-[var(--accent)]">
              {symbol.slice(0, 2)}
            </div>
            <div>
              <h1
                className="text-xl font-medium text-white"
                style={{ fontFamily: 'var(--font-heading)' }}
              >
                {symbol}-PERP{' '}
                <span className="text-white/50 font-normal">Vault</span>
              </h1>
              <p className="text-[11px] text-[var(--text-secondary)] font-mono mt-0.5">
                {slabAddress.slice(0, 8)}...{slabAddress.slice(-8)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-6">
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">
                Est. APY
              </div>
              <div className="text-2xl font-bold text-[var(--cyan)] font-mono tabular-nums">
                {estimatedApy.toFixed(1)}%
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">
                TVL
              </div>
              <div className="text-lg font-semibold text-white font-mono tabular-nums">
                ${formatCompact(vaultUsd)}
              </div>
            </div>
          </div>
        </div>

        {/* Stats row */}
        <ScrollReveal>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-px border border-[var(--border)] bg-[var(--border)] mb-6">
            <StatCell label="Vault Balance" loading={loading}>
              <AnimatedNumber
                value={vaultUsd}
                prefix="$"
                decimals={2}
                className="text-sm font-semibold text-white"
              />
            </StatCell>
            <StatCell label="LP Supply" loading={loading}>
              <span className="text-sm font-mono tabular-nums text-white">
                {formatCompact(Number(poolState.lpSupply) / 1e6)}
              </span>
            </StatCell>
            <StatCell label="Open Interest" loading={loading}>
              <span className="text-sm font-mono tabular-nums text-white">
                ${formatCompact(currentOI)}
              </span>
            </StatCell>
            <StatCell label="Insurance" loading={loading}>
              <span className="text-sm font-mono tabular-nums text-white">
                ${formatCompact(insuranceFund / 1e6)}
              </span>
            </StatCell>
            <StatCell label="Max Leverage" loading={loading}>
              <span className="text-sm font-mono tabular-nums text-white">
                {marketInfo?.maxLeverage ?? 10}×
              </span>
            </StatCell>
          </div>
        </ScrollReveal>

        {/* OI meter */}
        <ScrollReveal>
          <div className="mb-8 border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm p-5 hud-corners">
            <OiCapMeter currentOI={currentOI} maxOI={maxOI} />
          </div>
        </ScrollReveal>

        {/* Main grid: position + deposit/withdraw */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* LP Position dashboard */}
          <ScrollReveal>
            <LpPositionDashboard
              userLpBalance={poolState.userLpBalance}
              lpSupply={poolState.lpSupply}
              vaultBalance={poolState.vaultBalance}
              decimals={6}
              collateralSymbol="USDC"
              estimatedApyPct={estimatedApy}
              redemptionRateE6={poolState.redemptionRateE6}
              loading={loading}
            />
          </ScrollReveal>

          {/* Deposit / Withdraw */}
          <ScrollReveal>
            <DepositWithdrawPanel
              userBalance={poolState.userCollateralBalance}
              userLpBalance={poolState.userLpBalance}
              vaultBalance={poolState.vaultBalance}
              lpSupply={poolState.lpSupply}
              decimals={6}
              collateralSymbol="USDC"
              loading={loading || depositLoading || withdrawLoading}
              cooldownElapsed={poolState.cooldownElapsed}
              onDeposit={handleDeposit}
              onWithdraw={handleWithdraw}
            />
          </ScrollReveal>
        </div>

        {/* Vault info footer */}
        <ScrollReveal>
          <div className="mt-8 border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm p-5 hud-corners">
            <div className="h-px bg-gradient-to-r from-transparent via-[var(--accent)]/20 to-transparent -mx-5 -mt-5 mb-5" />
            <h3
              className="text-sm font-medium text-white mb-4"
              style={{ fontFamily: 'var(--font-heading)' }}
            >
              Vault Details
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-[12px]">
              <InfoRow label="Slab Address" value={slabAddress} mono />
              <InfoRow
                label="Pool Address"
                value={poolState.poolAddress?.toBase58() ?? '-'}
                mono
              />
              <InfoRow
                label="Cooldown Period"
                value={
                  poolState.cooldownSlots > 0n
                    ? `${poolState.cooldownSlots.toString()} slots (~${Math.round(
                        Number(poolState.cooldownSlots) * 0.4,
                      )}s)`
                    : 'None'
                }
              />
              <InfoRow
                label="Deposit Cap"
                value={
                  poolState.depositCap > 0n
                    ? `${formatCompact(Number(poolState.depositCap) / 1e6)} USDC`
                    : 'Unlimited'
                }
              />
              <InfoRow
                label="Trading Fee"
                value={`${(marketInfo?.tradingFeeBps ?? 10) / 100}%`}
              />
              <InfoRow
                label="Pool Status"
                value={poolState.poolExists ? 'Active' : 'Not Initialized'}
              />
            </div>
          </div>
        </ScrollReveal>
      </div>
    </div>
  );
}

function StatCell({
  label,
  children,
  loading,
}: {
  label: string;
  children: React.ReactNode;
  loading: boolean;
}) {
  return (
    <div className="bg-[var(--panel-bg)] p-3 sm:p-4">
      <div className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-secondary)] mb-1">
        {label}
      </div>
      {loading ? (
        <div className="h-5 w-16 animate-pulse rounded bg-[var(--border)]" />
      ) : (
        children
      )}
    </div>
  );
}

function InfoRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-[var(--border)]/50">
      <span className="text-[var(--text-secondary)]">{label}</span>
      <span
        className={`text-white ${mono ? 'font-mono text-[11px]' : ''}`}
        title={mono ? value : undefined}
      >
        {mono && value.length > 20
          ? `${value.slice(0, 8)}...${value.slice(-8)}`
          : value}
      </span>
    </div>
  );
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(2);
}
