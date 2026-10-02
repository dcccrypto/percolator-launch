'use client';

import { useCallback, useEffect, useState } from 'react';
import { SlabProvider, useSlabState } from '@/components/providers/SlabProvider';
import { useInsuranceLP } from '@/hooks/useInsuranceLP';
import { useTokenMeta } from '@/hooks/useTokenMeta';
import { DepositWithdrawPanel } from '@/components/earn/DepositWithdrawPanel';
import { EarnTrancheCardView } from '@/components/limits/EarnTrancheCard';
import { useVaultLpValuation } from '@/hooks/useVaultLpValuation';
import { ResolvedExitPanel } from '@/components/limits/ResolvedExitPanel';
import { earnExitProps } from '@/lib/limits/resolved-finish';
import { useWalletCompat } from '@/hooks/useWalletCompat';
import { LoadingValue } from '@/components/ui/LoadingValue';
import { useMarketLimits } from '@/hooks/useMarketLimits';
import { useSingleMarketHealth } from '@/hooks/useMarketHealth';
import { earnDepositPause, earnGateShares, earnViewFromLimits, earnPanelPricing, withSplitPotPricing } from '@/lib/limits/earn';
import { earnDepositBlock } from '@/lib/limits/vault-tranche';
import { COPY } from '@/lib/limits/copy';
import { chargedTradeFeeLabel } from '@/lib/limits/format';
import { decodeMarketEngineView } from '@/lib/limits/decode';
import { MarketLogo } from '@/components/market/MarketLogo';
import { formatCompact } from '@/lib/formatters';
import type { MarketVaultInfo } from '@/hooks/useEarnStats';

/** Devnet slot time, for rendering the redemption cooldown as an approximate duration. */
const SLOT_SECONDS = 0.4;
function slotsToLabel(slots: bigint): string {
  if (slots <= 0n) return 'None';
  const s = Math.round(Number(slots) * SLOT_SECONDS);
  return s < 60 ? `~${s}s` : `~${Math.round(s / 60)}m`;
}

interface VaultDepositRailProps {
  /** Selected vault's slab, or null when nothing is selected yet. */
  slab: string | null;
  /** Cosmetic info for the selected vault from useEarnStats (symbol/logo/fee). */
  vault: MarketVaultInfo | null;
  /** Refresh the parent table's stats after a deposit/withdraw settles. */
  onTxSuccess?: () => void;
  /** Report the wallet's resolved deposit (USD) in this vault back to the table. */
  onPositionResolved?: (slab: string, usd: number) => void;
}

/**
 * The LP-vault deposit rail — the trade terminal's OrderTicket analogue for the
 * Earn tab. Always visible on the right; bound to whichever vault row is
 * selected. Reuses DepositWithdrawPanel + the useInsuranceLP deposit/withdraw
 * hooks unchanged — this is purely the binding + presentation.
 */
export function VaultDepositRail({ slab, vault, onTxSuccess, onPositionResolved }: VaultDepositRailProps) {
  if (!slab) {
    return (
      <div className="border border-[var(--border)] bg-[var(--panel-bg)] p-8 text-center hud-corners">
        <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-secondary)]" style={{ fontFamily: 'var(--font-mono)' }}>
          No vault selected
        </div>
        <p className="mt-2 text-[12px] text-[var(--text-secondary)]">
          Select a vault from the table to deposit or withdraw.
        </p>
      </div>
    );
  }

  // key={slab} forces a clean remount on vault switch so the panel never shows
  // the previous vault's balances/cooldown while the new one's reads resolve.
  return (
    <SlabProvider key={slab} slabAddress={slab}>
      <VaultDepositRailInner slab={slab} vault={vault} onTxSuccess={onTxSuccess} onPositionResolved={onPositionResolved} />
    </SlabProvider>
  );
}

function VaultDepositRailInner({ slab, vault, onTxSuccess, onPositionResolved }: VaultDepositRailProps & { slab: string }) {
  const { state, loading, deposit, withdraw, resizeRedemption, refreshState, lastDrawSummary } = useInsuranceLP();
  const { config, raw: slabRaw } = useSlabState();
  const wallet = useWalletCompat();
  const vaultAvailable = state.registryExists && state.mintExists;

  // Latch "we've completed at least one load" so the "not initialized" warning
  // is driven by the durable `state.registryExists` fact, not by the transient
  // `loading` flag that toggles on every background revalidation (which made the
  // warning flicker on and off). Resets per vault via the key={slab} remount.
  const [everLoaded, setEverLoaded] = useState(false);
  useEffect(() => {
    if (!loading) setEverLoaded(true);
  }, [loading]);

  const collateralMeta = useTokenMeta(config?.collateralMint ?? null);
  const collateralSymbol = collateralMeta?.symbol ?? 'USDC';
  const collateralDecimals = collateralMeta?.decimals ?? 6;
  const collDivisor = 10 ** collateralDecimals;

  const vaultUsd = Number(state.vaultTotalAtoms) / collDivisor;
  const positionUsd = Number(state.userVaultValueAtoms) / collDivisor;
  // A pending withdrawal keeps its shares in escrow until paid: still the user's deposit.
  const hasPosition = state.userLpBalance > 0n || state.pendingRedemptionShares > 0n;

  const symbol = vault?.symbol ?? `${slab.slice(0, 4)}…`;

  // P3 (flag-gated; "off" = no RPC): one limits read model feeds the tranche card AND the
  // deposit gate, which mirrors the program's own tag-75 refusals (lib/limits/vault-tranche.ts).
  const marketLimits = useMarketLimits(slab);
  // GH#2882: a depleted counterparty pauses trading; Earn deposits on an unbound vault can't reopen it.
  const marketHealth = useSingleMarketHealth(slab);
  // UX WP-5 (§3.7): a stale LP certificate is valued by a simulated crank, never "Needs refresh".
  const lpValuation = useVaultLpValuation(slab, marketLimits);
  const trancheView = earnViewFromLimits(marketLimits, state.backingNavAtoms, state.userLpBalance, undefined, lpValuation.value);
  const earnPricing = withSplitPotPricing(earnPanelPricing(marketLimits, state.backingNavAtoms, lpValuation.sim ?? lpValuation.value), state.splitPot);
  const gateShares = earnGateShares(marketLimits);
  // Genesis with fees pending (P3-L1) is NOT a block any more: the deposit tx bundles tag 78
  // first (lib/limits/earn-ixs.ts earnTxPlan), so only a real refusal disables the button.
  const rawDepositBlock = gateShares === null ? null : earnDepositBlock(trancheView, gateShares);
  // UX WP-5 (§3.6): "valuation-stale" is not a block either — the deposit tx self-repairs 85
  // (vault-LP crank bundled by sendTx). Only "covering a loss" pauses deposits.
  const depositBlock = earnDepositPause(rawDepositBlock);
  const depositBlockedReason = depositBlock === 'senior-impaired' ? COPY.depositsPausedImpaired : null;

  // Report the resolved deposit up so the table's "Your Deposit" column fills in
  // for this row as the user browses vaults.
  // Only once this vault's first read has landed: reporting the pre-load 0 would overwrite the
  // table's chain-read position (incl. a creator's seed) with "$—".
  useEffect(() => {
    if (!everLoaded) return;
    onPositionResolved?.(slab, positionUsd);
  }, [slab, positionUsd, onPositionResolved, everLoaded]);

  const handleDeposit = useCallback(
    async (amount: bigint) => {
      await deposit(amount);
      await refreshState();
      onTxSuccess?.();
    },
    [deposit, refreshState, onTxSuccess],
  );

  const handleWithdraw = useCallback(
    async (lpAmount: bigint) => {
      const result = await withdraw(lpAmount);
      await refreshState();
      onTxSuccess?.();
      return result;
    },
    [withdraw, refreshState, onTxSuccess],
  );

  return (
    <div className="space-y-3">
      {/* P3 / F-4: after Resolve, Earn pays out only once the market is terminal-flat; anyone
          can run the permissionless sweep. Renders nothing on a live market. */}
      <ResolvedExitPanel slab={slab} walletConnected={!!wallet.publicKey} onDone={refreshState} {...earnExitProps(state, collateralDecimals, collateralSymbol)} />
      {/* P3 (flag-gated): senior/junior tranches, NAV share price, APY from real fees.
          Withdrawal preview = the wallet's whole position. Null unless the vault owns the LP. */}
      <EarnTrancheCardView
        limits={marketLimits}
        view={trancheView}
        slab={slab}
        withdrawShares={state.userLpBalance}
        decimals={collateralDecimals}
        collateralSymbol={collateralSymbol}
        valuation={lpValuation}
        maxNowAtoms={earnPricing?.maxNowAtoms ?? null}
      />
      {/* Selected-vault header + key figures + position */}
      <div className="border border-[var(--border)] bg-[var(--panel-bg)] hud-corners">
        <div className="h-px bg-gradient-to-r from-transparent via-[var(--accent)]/40 to-transparent" />
        <div className="p-4">
          <div className="mb-3 flex items-center gap-2.5">
            <MarketLogo mainnetCa={vault?.mainnetCa} symbol={symbol} pixelOverride={28} decorative />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold text-[var(--text)]">
                {symbol}
              </div>
              <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)]">Earn vault</div>
            </div>
          </div>

          {/* Key figures */}
          <div className="grid grid-cols-2 gap-3 border-t border-[var(--border)]/60 pt-3">
            {/* UX WP-10 (UI-2): "—" with data-state="loading" until the first read lands. */}
            <Figure label="TVL" loading={!everLoaded} value={`$${formatCompact(vaultUsd)}`} />
            {/* E2E B5: the CHARGED fee (trade_fee_base_bps), not the matcher's tradingFeeBps. */}
            <Figure label="Fee" loading={!everLoaded} value={chargedTradeFeeLabel(slabRaw ? decodeMarketEngineView(slabRaw)?.tradeFeeBaseBps : null) ?? '—'} />
            <Figure label="Cooldown" loading={!everLoaded} value={slotsToLabel(state.redemptionCooldownSlots)} />
            <Figure
              label="Your Deposit"
              loading={!everLoaded}
              value={hasPosition ? `$${formatCompact(positionUsd)}` : '$—'}
              accent={hasPosition}
            />
          </div>

          {hasPosition && (
            <div className="mt-3 flex items-center justify-between border-t border-[var(--border)]/60 pt-3">
              <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">Pool Share</span>
              <span className="text-[12px] tabular-nums text-[var(--text)]" style={{ fontFamily: 'var(--font-mono)' }}>
                {state.userSharePct.toFixed(2)}%
              </span>
            </div>
          )}

          {everLoaded && !vaultAvailable && (
            <p className="mt-3 border-t border-[var(--border)]/60 pt-3 text-[11px] text-[var(--text-secondary)]">
              This market doesn't have an Earn vault yet, so deposits and withdrawals aren't available here.
            </p>
          )}
        </div>
      </div>

      {/* Deposit / Withdraw — reused unchanged */}
      <DepositWithdrawPanel
        userBalance={state.userCollateralBalance}
        userLpBalance={state.userLpBalance}
        vaultBalance={state.vaultTotalAtoms}
        lpSupply={state.lpSupply}
        vaultAvailable={vaultAvailable}
        decimals={collateralDecimals}
        collateralSymbol={collateralSymbol}
        loading={loading}
        cooldownElapsed={state.cooldownElapsed}
        cooldownSlots={state.redemptionCooldownSlots}
        hasPendingRedemption={state.hasPendingRedemption}
        pendingRedemptionShares={state.pendingRedemptionShares}
        cooldownRemainingSlots={state.cooldownRemainingSlots}
        onDeposit={handleDeposit}
        depositBlockedReason={depositBlockedReason}
        depositBlockKind={depositBlock}
        onWithdraw={handleWithdraw}
        p3Bound={marketLimits.vaultLp?.bound === true}
        lpDepleted={marketHealth?.lpDepleted === true}
        drawSummary={lastDrawSummary}
        pricing={earnPricing}
        onRefresh={refreshState}
        onResizeRedemption={async (shares) => {
          await resizeRedemption(shares);
          await refreshState();
        }}
      />
    </div>
  );
}

function Figure({ label, value, accent = false, loading = false }: { label: string; value: string; accent?: boolean; loading?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="mb-0.5 text-[9px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">{label}</div>
      <div
        data-testid={`earn-rail-figure-${label.toLowerCase().replace(/\s+/g, '-')}`}
        className={`truncate text-[13px] tabular-nums ${accent ? 'text-[var(--accent-text)]' : 'text-[var(--text)]'}`}
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        <LoadingValue loading={loading}>{value}</LoadingValue>
      </div>
    </div>
  );
}
