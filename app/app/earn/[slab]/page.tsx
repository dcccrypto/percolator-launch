'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { SlabProvider, useSlabState } from '@/components/providers/SlabProvider';
import { useInsuranceLP } from '@/hooks/useInsuranceLP';
import { useEngineState } from '@/hooks/useEngineState';
import { useEarnStats, type MarketVaultInfo } from '@/hooks/useEarnStats';
import { useTokenMeta } from '@/hooks/useTokenMeta';
import { getSupabase } from '@/lib/supabase';
import { BLOCKED_SLAB_ADDRESSES as BLOCKED_MARKET_ADDRESSES } from '@/lib/blocklist';
import { OiCapMeter } from '@/components/earn/OiCapMeter';
import { ScrollReveal } from '@/components/ui/ScrollReveal';
import { AnimatedNumber } from '@/components/ui/AnimatedNumber';
import { ShimmerSkeleton } from '@/components/ui/ShimmerSkeleton';
import { formatCompact } from '@/lib/formatters';
const DepositWithdrawPanel = dynamic(
  () =>
    import('@/components/earn/DepositWithdrawPanel').then(
      (m) => m.DepositWithdrawPanel,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm overflow-hidden p-5 space-y-5">
        <div className="flex border-b border-[var(--border)] -mx-5 -mt-5">
          <ShimmerSkeleton className="flex-1 h-11" />
          <ShimmerSkeleton className="flex-1 h-11 border-l border-[var(--border)]" />
        </div>
        <div className="space-y-2">
          <div className="flex justify-between">
            <ShimmerSkeleton className="h-3 w-28" />
            <ShimmerSkeleton className="h-3 w-16" />
          </div>
          <ShimmerSkeleton className="h-12 w-full" />
        </div>
        <div className="flex gap-2">
          {[25, 50, 75, 100].map(pct => (
            <ShimmerSkeleton key={pct} className="h-7 flex-1" />
          ))}
        </div>
        <ShimmerSkeleton className="h-10 w-full mt-2" />
      </div>
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
      <div className="border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm p-5 space-y-5">
        <div className="flex items-center justify-between">
          <ShimmerSkeleton className="h-4 w-32" />
          <ShimmerSkeleton className="h-4.5 w-12" />
        </div>
        <div className="p-4 bg-[var(--bg)] border border-[var(--border)] rounded-sm space-y-2">
          <ShimmerSkeleton className="h-3 w-24" />
          <div className="flex items-baseline gap-2">
            <ShimmerSkeleton className="h-7 w-32" />
            <ShimmerSkeleton className="h-4 w-8" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="space-y-1.5">
              <ShimmerSkeleton className="h-3 w-20" />
              <ShimmerSkeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
    ),
  },
);
/** Wrapper that provides SlabProvider context for the vault detail inner component. */
export default function VaultDetailPage() {
  const params = useParams();
  const slabAddress = params?.slab as string;

  // GH#1183: block direct navigation to known-bad markets
  if (BLOCKED_MARKET_ADDRESSES.has(slabAddress)) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="text-[var(--text-secondary)] text-sm">This market is no longer available.</div>
          <Link href="/earn" className="text-[var(--accent)] text-sm hover:underline">
            ← Back to Earn
          </Link>
        </div>
      </div>
    );
  }

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

  // LP Vault ("Earn") state for this market — v17 CreateLpVault/DepositToLpVault/
  // RequestRedeemLpShares/ExecuteRedemption mechanism (wrapper program, tags 74-77).
  // NOT the percolator-stake pool — that's a separate on-chain account backing the
  // /stake page (see hooks/useStakePool.ts). Verified on-chain 2026-07-07: this
  // market's LP Vault Registry holds the real ~10,000 Sim-USDC deposit; the stake
  // pool for the same slab was drained to 0 by an earlier deposit+withdraw test.
  const {
    state: lpVaultState,
    loading: lpVaultLoading,
    deposit: lpVaultDeposit,
    withdraw: lpVaultWithdraw,
    refreshState,
  } = useInsuranceLP();
  const { engine, totalOI, vault: engineVault } = useEngineState();

  // BUG-5 FIX: resolve actual collateral mint from on-chain slab data.
  // Previously hardcoded to USDC — wrong for coin-margined markets.
  const { config: slabConfig } = useSlabState();
  const collateralTokenMeta = useTokenMeta(slabConfig?.collateralMint ?? null);
  const collateralSymbol = collateralTokenMeta?.symbol ?? 'Token';
  const collateralDecimals = collateralTokenMeta?.decimals ?? 6;

  // Get market info from earn stats
  const { stats: earnStats, loading: earnLoading, error: earnStatsError } = useEarnStats();
  const marketInfo = useMemo<MarketVaultInfo | null>(() => {
    return earnStats.markets.find((m) => m.slabAddress === slabAddress) ?? null;
  }, [earnStats.markets, slabAddress]);

  // Fallback: fetch symbol directly from Supabase if market not in earn stats
  // (e.g., market status is not 'active' so it's filtered out of useEarnStats)
  const [fallbackSymbol, setFallbackSymbol] = useState<string | null>(null);
  useEffect(() => {
    if (marketInfo || earnLoading) return;
    let cancelled = false;
    getSupabase()
      .from('markets_with_stats')
      .select('symbol, name')
      .eq('slab_address', slabAddress)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled && data?.symbol) {
          setFallbackSymbol(data.symbol);
        }
      });
    return () => { cancelled = true; };
  }, [marketInfo, earnLoading, slabAddress]);

  const loading = lpVaultLoading || earnLoading;

  // Callbacks
  const handleDeposit = useCallback(
    async (amount: bigint) => {
      await lpVaultDeposit(amount);
      await refreshState();
    },
    [lpVaultDeposit, refreshState],
  );

  const handleWithdraw = useCallback(
    async (lpAmount: bigint) => {
      // S2 fix: propagate which redemption step ran (RequestRedeemLpShares vs
      // ExecuteRedemption) so DepositWithdrawPanel can show the correct toast
      // instead of a blanket "Withdrawal successful!".
      const result = await lpVaultWithdraw(lpAmount);
      await refreshState();
      return result;
    },
    [lpVaultWithdraw, refreshState],
  );

  const symbol = marketInfo?.symbol ?? fallbackSymbol ?? 'UNKNOWN';
  const maxOI = marketInfo?.maxOI ?? 0;
  const collDivisor = 10 ** collateralDecimals;
  const currentOI = marketInfo?.totalOI ?? (totalOI ? Number(totalOI) / collDivisor : 0);
  const collateralScale = Math.pow(10, collateralDecimals);
  // TVL = the LP Vault Registry's own backing (shares + distributed fees), NOT the
  // percolator-stake pool (poolState.vaultBalance, wrong account — see hook comment above).
  const vaultUsd = Number(lpVaultState.vaultTotalAtoms) / collateralScale;
  const insuranceFund = marketInfo?.insuranceFund ?? 0;

  return (
    <div className="min-h-[calc(100dvh-48px)] animate-fade-in">
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
          <span className="text-[var(--text)]">{symbol}-PERP Vault</span>
        </div>

        {/* Earn-stats fetch error — stats (volume/insurance/APY) may be stale or
            zeroed; the on-chain LP vault figures above (TVL, deposit/withdraw)
            are unaffected since they're read independently by useInsuranceLP. */}
        {!earnLoading && earnStatsError && (
          <div className="mb-6 border border-[var(--short)]/30 bg-[var(--short)]/5 rounded-sm px-4 py-3">
            <p className="text-[12px] font-medium text-[var(--short)]">
              ⚠ Couldn&apos;t refresh market stats
            </p>
            <p className="text-[11px] text-[var(--text-secondary)] mt-1">
              {earnStatsError} — volume and insurance figures below may be stale. Vault balance and deposit/withdraw are unaffected.
            </p>
          </div>
        )}

        {/* Not Initialized Warning */}
        {!loading && !lpVaultState.registryExists && (
          <div className="mb-6 border border-[var(--warning)]/30 bg-[var(--warning)]/5 rounded-sm px-4 py-3">
            <p className="text-[12px] font-medium text-[var(--warning)]">
              ⚠ Vault Not Initialized
            </p>
            <p className="text-[11px] text-[var(--text-secondary)] mt-1">
              This market&apos;s LP vault pool has not been created on-chain yet. Deposits and withdrawals are unavailable until the pool is initialized by the market deployer.
            </p>
          </div>
        )}

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-[var(--accent)]/10 border border-[var(--accent)]/20 flex items-center justify-center text-lg font-bold text-[var(--accent)]">
              {symbol.slice(0, 2)}
            </div>
            <div>
              <h1
                className="text-xl font-medium text-[var(--text)]"
                style={{ fontFamily: 'var(--font-heading)' }}
              >
                {symbol}-PERP{' '}
                <span className="text-[var(--text-secondary)] font-normal">Vault</span>
              </h1>
              <p className="text-[11px] text-[var(--text-secondary)] font-mono mt-0.5">
                {slabAddress.slice(0, 8)}...{slabAddress.slice(-8)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-6">
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">
                TVL
              </div>
              <div className="text-lg font-semibold text-[var(--text)] font-mono tabular-nums">
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
                className="text-sm font-semibold text-[var(--text)]"
              />
            </StatCell>
            <StatCell label="LP Supply" loading={loading}>
              <span className="text-sm font-mono tabular-nums text-[var(--text)]">
                {formatCompact(Number(lpVaultState.lpSupply) / collDivisor)}
              </span>
            </StatCell>
            <StatCell label="Open Interest" loading={loading}>
              <span className="text-sm font-mono tabular-nums text-[var(--text)]">
                ${formatCompact(currentOI)}
              </span>
            </StatCell>
            <StatCell label="Insurance" loading={loading}>
              <span className="text-sm font-mono tabular-nums text-[var(--text)]">
                ${formatCompact(insuranceFund / collDivisor)}
              </span>
            </StatCell>
            <StatCell label="Max Leverage" loading={loading}>
              <span className="text-sm font-mono tabular-nums text-[var(--text)]">
                {marketInfo?.maxLeverage || 10}×
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
              userLpBalance={lpVaultState.userLpBalance}
              lpSupply={lpVaultState.lpSupply}
              vaultBalance={lpVaultState.vaultTotalAtoms}
              decimals={collateralDecimals}
              collateralSymbol={collateralSymbol}
              redemptionRateE6={lpVaultState.vaultSharePriceE6}
              loading={loading}
            />
          </ScrollReveal>

          {/* Deposit / Withdraw */}
          <ScrollReveal>
            <DepositWithdrawPanel
              userBalance={lpVaultState.userCollateralBalance}
              userLpBalance={lpVaultState.userLpBalance}
              vaultBalance={lpVaultState.vaultTotalAtoms}
              lpSupply={lpVaultState.lpSupply}
              decimals={collateralDecimals}
              collateralSymbol={collateralSymbol}
              loading={loading || lpVaultLoading}
              cooldownElapsed={lpVaultState.cooldownElapsed}
              cooldownSlots={lpVaultState.redemptionCooldownSlots}
              hasPendingRedemption={lpVaultState.hasPendingRedemption}
              pendingRedemptionShares={lpVaultState.pendingRedemptionShares}
              cooldownRemainingSlots={lpVaultState.cooldownRemainingSlots}
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
              className="text-sm font-medium text-[var(--text)] mb-4"
              style={{ fontFamily: 'var(--font-heading)' }}
            >
              Vault Details
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-[12px]">
              <InfoRow label="Slab Address" value={slabAddress} mono />
              <InfoRow
                label="Vault Registry"
                value={lpVaultState.registryAddress?.toBase58() ?? '-'}
                mono
              />
              <InfoRow
                label="Cooldown Period"
                value={
                  lpVaultState.redemptionCooldownSlots > 0n
                    ? `${lpVaultState.redemptionCooldownSlots.toString()} slots (~${Math.round(
                        Number(lpVaultState.redemptionCooldownSlots) * 0.4,
                      )}s)`
                    : 'None'
                }
              />
              {/* LP Vault Registry has no deposit-cap field (unlike the /stake pools) —
                  it's bounded indirectly via oiReservationThresholdBps, not a hard cap. */}
              <InfoRow label="Deposit Cap" value="Unlimited" />
              <InfoRow
                label="Trading Fee"
                value={`${(marketInfo?.tradingFeeBps ?? 10) / 100}%`}
              />
              <InfoRow
                label="Pool Status"
                value={lpVaultState.registryExists ? 'Active' : 'Not Initialized'}
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
        <ShimmerSkeleton className="h-5 w-16" />
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
        className={`text-[var(--text)] ${mono ? 'font-mono text-[11px]' : ''}`}
        title={mono ? value : undefined}
      >
        {mono && value.length > 20
          ? `${value.slice(0, 8)}...${value.slice(-8)}`
          : value}
      </span>
    </div>
  );
}
