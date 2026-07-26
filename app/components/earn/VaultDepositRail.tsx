'use client';

import { useCallback, useEffect } from 'react';
import { SlabProvider, useSlabState } from '@/components/providers/SlabProvider';
import { useInsuranceLP } from '@/hooks/useInsuranceLP';
import { useTokenMeta } from '@/hooks/useTokenMeta';
import { DepositWithdrawPanel } from '@/components/earn/DepositWithdrawPanel';
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
  const { state, loading, deposit, withdraw, refreshState } = useInsuranceLP();
  const { config } = useSlabState();

  const collateralMeta = useTokenMeta(config?.collateralMint ?? null);
  const collateralSymbol = collateralMeta?.symbol ?? 'USDC';
  const collateralDecimals = collateralMeta?.decimals ?? 6;
  const collDivisor = 10 ** collateralDecimals;

  const vaultUsd = Number(state.vaultTotalAtoms) / collDivisor;
  const positionUsd = Number(state.userVaultValueAtoms) / collDivisor;
  const hasPosition = state.userLpBalance > 0n;

  const symbol = vault?.symbol ?? `${slab.slice(0, 4)}…`;

  // Report the resolved deposit up so the table's "Your Deposit" column fills in
  // for this row as the user browses vaults.
  useEffect(() => {
    onPositionResolved?.(slab, positionUsd);
  }, [slab, positionUsd, onPositionResolved]);

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
      {/* Selected-vault header + key figures + position */}
      <div className="border border-[var(--border)] bg-[var(--panel-bg)] hud-corners">
        <div className="h-px bg-gradient-to-r from-transparent via-[var(--accent)]/40 to-transparent" />
        <div className="p-4">
          <div className="mb-3 flex items-center gap-2.5">
            <MarketLogo mainnetCa={vault?.mainnetCa} symbol={symbol} pixelOverride={28} decorative />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold text-[var(--text)]">
                {symbol}
                <span className="font-normal text-[var(--text-secondary)]">-PERP</span>
              </div>
              <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)]">LP Vault</div>
            </div>
          </div>

          {/* Key figures */}
          <div className="grid grid-cols-2 gap-3 border-t border-[var(--border)]/60 pt-3">
            <Figure label="TVL" value={`$${formatCompact(vaultUsd)}`} />
            <Figure label="Fee" value={`${((vault?.tradingFeeBps ?? 10) / 100).toFixed(2)}%`} />
            <Figure label="Cooldown" value={slotsToLabel(state.redemptionCooldownSlots)} />
            <Figure
              label="Your Deposit"
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

          {!loading && !state.registryExists && (
            <p className="mt-3 border-t border-[var(--warning)]/20 pt-3 text-[11px] text-[var(--warning)]">
              ⚠ This vault isn&apos;t initialized on-chain yet — deposits are unavailable until the deployer creates it.
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
        decimals={collateralDecimals}
        collateralSymbol={collateralSymbol}
        loading={loading}
        cooldownElapsed={state.cooldownElapsed}
        cooldownSlots={state.redemptionCooldownSlots}
        hasPendingRedemption={state.hasPendingRedemption}
        pendingRedemptionShares={state.pendingRedemptionShares}
        cooldownRemainingSlots={state.cooldownRemainingSlots}
        onDeposit={handleDeposit}
        onWithdraw={handleWithdraw}
      />
    </div>
  );
}

function Figure({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="mb-0.5 text-[9px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">{label}</div>
      <div
        className={`truncate text-[13px] tabular-nums ${accent ? 'text-[var(--accent-text)]' : 'text-[var(--text)]'}`}
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        {value}
      </div>
    </div>
  );
}
