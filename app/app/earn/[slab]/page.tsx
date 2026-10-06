'use client';

import { LoadingValue, loadingText } from '@/components/ui/LoadingValue';
import { baseSymbol } from '@/lib/symbol-utils';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { SlabProvider, useSlabState } from '@/components/providers/SlabProvider';
import { useInsuranceLP } from '@/hooks/useInsuranceLP';
import { useLpCostBasis } from '@/hooks/useLpCostBasis';
import { useWalletCompat } from '@/hooks/useWalletCompat';
import { computeLpEarnedForVault } from '@/lib/lp-earned';
import { isDevnetV21Enabled } from '@/lib/v21/flag';
import { computeEntryVsExit } from '@/lib/v21/entry-exit';
import { ResolvedExitPanel } from '@/components/limits/ResolvedExitPanel';
import { earnExitProps } from '@/lib/limits/resolved-finish';
import { EarnTrancheCardView } from '@/components/limits/EarnTrancheCard';
import { useVaultLpValuation } from '@/hooks/useVaultLpValuation';
import { useMarketLimits } from '@/hooks/useMarketLimits';
import { useSingleMarketHealth } from '@/hooks/useMarketHealth';
import { earnViewFromLimits, earnPanelPricing, withSplitPotPricing } from '@/lib/limits/earn';
import { cooldownPhrase, previewWithdrawAtoms } from '@/lib/limits/earn-withdraw';
import { formatTokenAmount } from '@/lib/format';
import { chargedTradeFeeLabel } from '@/lib/limits/format';
import { decodeMarketEngineView } from '@/lib/limits/decode';
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
    resizeRedemption: lpVaultResizeRedemption,
    refreshState,
    lastDrawSummary,
    readError: lpVaultReadError,
  } = useInsuranceLP();
  // UX WP-10 (UI-2): until the first read lands, figures show "—" (data-state="loading").
  const [loadedOnce, setLoadedOnce] = useState(false);
  // A failed read is not a load: its zeros stay "—".
  useEffect(() => {
    if (!lpVaultLoading && !lpVaultReadError) setLoadedOnce(true);
  }, [lpVaultLoading, lpVaultReadError]);
  const firstLoad = !loadedOnce;
  const earnWallet = useWalletCompat();
  const earnLimits = useMarketLimits(slabAddress);
  // GH#2882: a depleted counterparty pauses trading; Earn deposits on an unbound vault can't reopen it.
  const marketHealth = useSingleMarketHealth(slabAddress);
  // UX WP-5 (§3.7): a stale LP certificate is valued by a simulated crank, never "Needs refresh".
  const lpValuation = useVaultLpValuation(slabAddress, earnLimits);
  const earnTrancheView = earnViewFromLimits(earnLimits, lpVaultState.backingNavAtoms, lpVaultState.userLpBalance, undefined, lpValuation.value);
  const earnPricing = withSplitPotPricing(earnPanelPricing(earnLimits, lpVaultState.backingNavAtoms, lpValuation.sim ?? lpValuation.value), lpVaultState.splitPot);
  const { engine, totalOI, vault: engineVault } = useEngineState();

  // percolator-indexer#207: exact earned = value − indexed cost basis (+ realized), priced on
  // the same NAV/share pair as the card's Value (two-pot vaults use the registry's shares).
  const lpClaimShares = lpVaultState.userLpBalance + lpVaultState.pendingRedemptionShares;
  const lpCostBasis = useLpCostBasis(slabAddress, earnWallet.publicKey?.toBase58() ?? null, lpClaimShares);
  const lpEarned = useMemo(
    () => computeLpEarnedForVault(lpCostBasis, lpVaultState),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lpCostBasis, lpVaultState.userLpBalance, lpVaultState.pendingRedemptionShares, lpVaultState.vaultTotalAtoms, lpVaultState.lpSupply, lpVaultState.splitPot],
  );

  // BUG-5 FIX: resolve actual collateral mint from on-chain slab data.
  // Previously hardcoded to USDC — wrong for coin-margined markets.
  const { config: slabConfig, raw: slabRaw } = useSlabState();
  const collateralTokenMeta = useTokenMeta(slabConfig?.collateralMint ?? null);
  const collateralSymbol = collateralTokenMeta?.symbol ?? 'Token';
  const collateralDecimals = collateralTokenMeta?.decimals ?? 6;

  // Get market info from earn stats
  const { stats: earnStats, loading: earnLoading, error: earnStatsError, refresh: refreshEarnStats } = useEarnStats();
  const marketInfo = useMemo<MarketVaultInfo | null>(() => {
    return earnStats.markets.find((m) => m.slabAddress === slabAddress) ?? null;
  }, [earnStats.markets, slabAddress]);

  // Fallback: fetch symbol directly from Supabase if market not in earn stats
  // (e.g., market status is not 'active' so it's filtered out of useEarnStats)
  const [fallbackSymbol, setFallbackSymbol] = useState<string | null>(null);
  useEffect(() => {
    if (marketInfo || earnLoading) return;
    let cancelled = false;
    try {
      getSupabase()
        .from('markets_with_stats')
        .select('symbol, name')
        .eq('slab_address', slabAddress)
        .maybeSingle()
        .then(
          ({ data }) => {
            if (!cancelled && data?.symbol) {
              setFallbackSymbol(data.symbol);
            }
          },
          (err: unknown) => {
            console.error('[earn/[slab]] fallback symbol lookup failed:', err);
          },
        );
    } catch (err) {
      console.error('[earn/[slab]] fallback symbol lookup failed:', err);
    }
    return () => { cancelled = true; };
  }, [marketInfo, earnLoading, slabAddress]);

  const loading = lpVaultLoading || earnLoading;
  const vaultAvailable =
    lpVaultState.registryExists && lpVaultState.mintExists;

  // Callbacks
  const handleDeposit = useCallback(
    async (amount: bigint) => {
      await lpVaultDeposit(amount);
      await refreshState();
      // marketInfo (maxOI, insurance, APY) comes from a separate useEarnStats
      // instance that only advances on its own 15s timer — without this the
      // OI meter/APY/insurance figures would sit stale for up to 15s after a
      // deposit changes the vault's TVL.
      refreshEarnStats();
    },
    [lpVaultDeposit, refreshState, refreshEarnStats],
  );

  const handleWithdraw = useCallback(
    async (lpAmount: bigint) => {
      // S2 fix: propagate which redemption step ran (RequestRedeemLpShares vs
      // ExecuteRedemption) so DepositWithdrawPanel can show the correct toast
      // instead of a blanket "Withdrawal successful!".
      const result = await lpVaultWithdraw(lpAmount);
      await refreshState();
      refreshEarnStats();
      return result;
    },
    [lpVaultWithdraw, refreshState, refreshEarnStats],
  );

  // No signal about this slab from any source (not in earn stats, no Supabase
  // row, no on-chain LP vault registry) once both loads have settled — a
  // genuinely bad/unknown slab, distinct from a market that's just excluded
  // from useEarnStats (e.g. non-'active' status) but still has a real vault.
  const marketNotFound =
    !loading && !marketInfo && !fallbackSymbol && !lpVaultState.registryExists && !lpVaultReadError;

  const symbol = marketInfo?.symbol ?? fallbackSymbol ?? 'UNKNOWN';
  // maxOI is only known once marketInfo resolves — without it we can't tell "no OI
  // cap" (real 0) apart from "cap unknown" (marketInfo not loaded yet / market not
  // in earn stats), so the meter must not claim a health status in the latter case.
  const maxOI = marketInfo?.maxOI ?? 0;
  const oiCapKnown = marketInfo != null;
  const collDivisor = 10 ** collateralDecimals;
  const currentOI = marketInfo?.totalOI ?? (totalOI ? Number(totalOI) / collDivisor : 0);
  const collateralScale = Math.pow(10, collateralDecimals);
  // TVL = the LP Vault Registry's own backing (shares + distributed fees), NOT the
  // percolator-stake pool (poolState.vaultBalance, wrong account — see hook comment above).
  const vaultUsd = Number(lpVaultState.vaultTotalAtoms) / collateralScale;
  const insuranceFund = marketInfo?.insuranceFund ?? 0;

  if (marketNotFound) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="text-center space-y-4 px-4">
          <div className="text-[var(--text-secondary)] text-sm">
            This market could not be found.
          </div>
          <Link href="/earn" className="text-[var(--accent)] text-sm hover:underline">
            ← Back to Earn
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-[calc(100dvh-48px)] animate-fade-in">
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
          <span className="text-[var(--text)]">{baseSymbol(symbol)} Earn vault</span>
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
              {earnStatsError} — volume and insurance figures below may be stale.{!lpVaultReadError && ' Vault balance and deposit/withdraw are unaffected.'}
            </p>
          </div>
        )}

        {/* Earn vault read failed: unknown, not missing */}
        {!loading && !vaultAvailable && lpVaultReadError && (
          <div className="mb-6 border border-[var(--short)]/30 bg-[var(--short)]/5 rounded-sm px-4 py-3">
            <p className="text-[12px] font-medium text-[var(--short)]">
              ⚠ Couldn&apos;t load this Earn vault
            </p>
            <p className="text-[11px] text-[var(--text-secondary)] mt-1">
              The network didn&apos;t respond. Retrying every 10 seconds; deposits and withdrawals are off until the vault loads.
            </p>
          </div>
        )}

        {/* Earn vault availability warning */}
        {!loading && !vaultAvailable && !lpVaultReadError && (
          <div className="mb-6 border border-[var(--warning)]/30 bg-[var(--warning)]/5 rounded-sm px-4 py-3">
            <p className="text-[12px] font-medium text-[var(--warning)]">
              Earn Vault Unavailable
            </p>
            <p className="text-[11px] text-[var(--text-secondary)] mt-1">
              This market doesn't have an Earn vault yet, so deposits and withdrawals aren't available here.
            </p>
          </div>
        )}

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-[var(--accent)]/10 border border-[var(--accent)]/20 flex items-center justify-center text-2xl font-bold text-[var(--accent)]">
              {symbol.slice(0, 2)}
            </div>
            <div>
              <h1
                className="text-2xl font-medium text-[var(--text)]"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                {baseSymbol(symbol)}{' '}
                <span className="text-[var(--text-secondary)] font-normal">Earn vault</span>
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
              <div data-testid="earn-page-tvl" className="text-2xl font-semibold text-[var(--text)] font-mono tabular-nums">
                <LoadingValue loading={firstLoad}>${formatCompact(vaultUsd)}</LoadingValue>
              </div>
            </div>
          </div>
        </div>

        {/* Stats row */}
        <ScrollReveal>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-px border border-[var(--border)] bg-[var(--border)] mb-6">
            <StatCell label="Vault Balance" loading={loading || firstLoad}>
              <AnimatedNumber
                value={vaultUsd}
                prefix="$"
                decimals={2}
                className="text-sm font-semibold text-[var(--text)]"
              />
            </StatCell>
            <StatCell label="Earn shares" loading={loading || firstLoad}>
              <span className="text-sm font-mono tabular-nums text-[var(--text)]">
                {formatCompact(Number(lpVaultState.lpSupply) / collDivisor)}
              </span>
            </StatCell>
            <StatCell label="Open Interest" loading={loading}>
              <span className="text-sm font-mono tabular-nums text-[var(--text)]">
                {oiCapKnown ? `$${formatCompact(currentOI)}` : '—'}
              </span>
            </StatCell>
            <StatCell label="Insurance" loading={loading}>
              <span className="text-sm font-mono tabular-nums text-[var(--text)]">
                ${formatCompact(insuranceFund / collDivisor)}
              </span>
            </StatCell>
            <StatCell label="Max Leverage" loading={loading}>
              <span className="text-sm font-mono tabular-nums text-[var(--text)]">
                {/* marketInfo.maxLeverage is real (useEarnStats derives it from on-chain
                    initialMarginBps); when marketInfo hasn't resolved it is UNKNOWN —
                    the old `?? 10` invented a 10x cap. */}
                {marketInfo ? `${marketInfo.maxLeverage}×` : '—'}
              </span>
            </StatCell>
          </div>
        </ScrollReveal>

        {/* OI meter */}
        <ScrollReveal>
          <div className="mb-8 border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm p-5 hud-corners">
            {oiCapKnown ? (
              <OiCapMeter currentOI={currentOI} maxOI={maxOI} />
            ) : (
              <div className="text-[11px] text-[var(--text-secondary)]">
                OI capacity data unavailable for this market.
              </div>
            )}
          </div>
        </ScrollReveal>

        {/* Main grid: position + deposit/withdraw */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* LP Position dashboard */}
          <ScrollReveal>
            <LpPositionDashboard
              // Escrowed (pending-withdrawal) shares are still the user's until paid; priced at
              // the program's NAV over registry shares on a two-pot vault (state.splitPot).
              userLpBalance={lpVaultState.userLpBalance + lpVaultState.pendingRedemptionShares}
              lpSupply={lpVaultState.splitPot?.totalShares ?? lpVaultState.lpSupply}
              vaultBalance={lpVaultState.vaultTotalAtoms}
              decimals={collateralDecimals}
              lpDecimals={lpVaultState.lpDecimals}
              collateralSymbol={collateralSymbol}
              redemptionRateE6={lpVaultState.vaultSharePriceE6}
              loading={loading || firstLoad}
              pendingWithdrawalLabel={(() => {
                if (!lpVaultState.hasPendingRedemption) return null;
                const pr = earnPricing;
                const atoms = pr ? previewWithdrawAtoms(lpVaultState.pendingRedemptionShares, pr.totalShares, pr.withdrawSeniorValue) : null;
                return atoms !== null
                  ? `${formatTokenAmount(atoms, collateralDecimals)} ${collateralSymbol}`
                  : `${formatTokenAmount(lpVaultState.pendingRedemptionShares, collateralDecimals)} shares`;
              })()}
              earned={lpEarned}
              entryVsExit={
                isDevnetV21Enabled()
                  ? computeEntryVsExit({
                      earned: lpEarned,
                      exitAtoms: earnPricing
                        ? previewWithdrawAtoms(
                            lpVaultState.userLpBalance + lpVaultState.pendingRedemptionShares,
                            earnPricing.totalShares,
                            earnPricing.withdrawSeniorValue,
                          )
                        : null,
                      claimShares: lpVaultState.userLpBalance + lpVaultState.pendingRedemptionShares,
                      decimals: collateralDecimals,
                      lpDecimals: lpVaultState.lpDecimals,
                    })
                  : null
              }
            />
          </ScrollReveal>

          {/* E2E B17: the P3 tranche card (senior/junior, NAV share price, cushion) belongs on the
              market's own Earn page too, not only in the /earn list rail. Renders nothing unless
              the vault owns the LP (and LIMITS_P3 is on). */}
          <EarnTrancheCardView
            limits={earnLimits}
            view={earnTrancheView}
            slab={slabAddress}
            withdrawShares={lpVaultState.userLpBalance}
            decimals={collateralDecimals}
            collateralSymbol={collateralSymbol}
            valuation={lpValuation}
            maxNowAtoms={earnPricing?.maxNowAtoms ?? null}
          />

          {/* P3 / F-4: after Resolve, finish the market so Earn can pay out (nothing on a live market). */}
          <ResolvedExitPanel slab={slabAddress} walletConnected={!!earnWallet.publicKey} onDone={refreshState} {...earnExitProps(lpVaultState, collateralDecimals, collateralSymbol)} />

          {/* Deposit / Withdraw */}
          <ScrollReveal>
            <DepositWithdrawPanel
              userBalance={lpVaultState.userCollateralBalance}
              userLpBalance={lpVaultState.userLpBalance}
              vaultBalance={lpVaultState.vaultTotalAtoms}
              lpSupply={lpVaultState.lpSupply}
              vaultAvailable={vaultAvailable}
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
              p3Bound={earnLimits.vaultLp?.bound === true}
              lpDepleted={marketHealth?.lpDepleted === true}
              drawSummary={lastDrawSummary}
              pricing={earnPricing}
              onRefresh={refreshState}
              onResizeRedemption={async (shares) => {
                await lpVaultResizeRedemption(shares);
                await refreshState();
              }}
            />
          </ScrollReveal>
        </div>

        {/* Vault info footer */}
        <ScrollReveal>
          <div className="mt-8 border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm p-5 hud-corners">
            <div className="h-px bg-gradient-to-r from-transparent via-[var(--accent)]/20 to-transparent -mx-5 -mt-5 mb-5" />
            <h3
              className="text-sm font-medium text-[var(--text)] mb-4"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              Vault Details
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-[12px]">
              <InfoRow
                label="Withdrawal wait"
                value={loadingText(firstLoad, lpVaultState.redemptionCooldownSlots > 0n ? cooldownPhrase(lpVaultState.redemptionCooldownSlots) : 'None')}
              />
              {/* LP Vault Registry has no deposit-cap field (unlike the /stake pools) —
                  it's bounded indirectly via oiReservationThresholdBps, not a hard cap. */}
              <InfoRow label="Deposit Cap" value="Unlimited" />
              {/* E2E B5: the CHARGED fee (wrapper trade_fee_base_bps), not the matcher's
                  tradingFeeBps (fills settle at mark, so that one is never charged). */}
              <InfoRow
                label="Trading Fee"
                value={chargedTradeFeeLabel(slabRaw ? decodeMarketEngineView(slabRaw)?.tradeFeeBaseBps : null) ?? '—'}
              />
              <InfoRow
                label="Vault status"
                value={loadingText(firstLoad, vaultAvailable ? 'Active' : 'Unavailable')}
              />
            </div>
            {/* UX WP-5 (§4.4): addresses live under Details. */}
            <details className="mt-4 text-[12px]" data-testid="earn-vault-details-more">
              <summary className="cursor-pointer text-[11px] text-[var(--text-secondary)] hover:text-[var(--text)]">Details</summary>
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <InfoRow label="Market address" value={slabAddress} mono />
                <InfoRow label="Vault address" value={lpVaultState.registryAddress?.toBase58() ?? '-'} mono />
              </div>
            </details>
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
