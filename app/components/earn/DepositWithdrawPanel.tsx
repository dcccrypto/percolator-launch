'use client';

import { useState, useCallback, useMemo } from 'react';
import { GlowButton } from '@/components/ui/GlowButton';
import { useWalletCompat } from '@/hooks/useWalletCompat';
import dynamic from 'next/dynamic';

const ConnectButton = dynamic(
  () =>
    import('@/components/wallet/ConnectButton').then((m) => m.ConnectButton),
  { ssr: false },
);

type Tab = 'deposit' | 'withdraw';

interface DepositWithdrawPanelProps {
  /** User's collateral balance (lamports/raw) */
  userBalance: bigint;
  /** User's LP token balance */
  userLpBalance: bigint;
  /** Vault total balance */
  vaultBalance: bigint;
  /** LP supply */
  lpSupply: bigint;
  /** Collateral decimals */
  decimals: number;
  /** Collateral symbol (e.g. USDC) */
  collateralSymbol: string;
  /** Loading state */
  loading: boolean;
  /** Cooldown elapsed (for withdraw) */
  cooldownElapsed: boolean;
  /** Deposit callback */
  onDeposit: (amount: bigint) => Promise<void>;
  /** Withdraw callback */
  onWithdraw: (lpAmount: bigint) => Promise<void>;
}

export function DepositWithdrawPanel({
  userBalance,
  userLpBalance,
  vaultBalance,
  lpSupply,
  decimals,
  collateralSymbol,
  loading,
  cooldownElapsed,
  onDeposit,
  onWithdraw,
}: DepositWithdrawPanelProps) {
  const { connected } = useWalletCompat();
  const [tab, setTab] = useState<Tab>('deposit');
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);
  const [txSuccess, setTxSuccess] = useState<string | null>(null);

  const divisor = 10n ** BigInt(decimals);

  // Parse amount to raw bigint
  const rawAmount = useMemo(() => {
    if (!amount || isNaN(Number(amount))) return 0n;
    try {
      const parts = amount.split('.');
      const whole = BigInt(parts[0] || '0');
      let frac = 0n;
      if (parts[1]) {
        const fracStr = parts[1].slice(0, decimals).padEnd(decimals, '0');
        frac = BigInt(fracStr);
      }
      return whole * divisor + frac;
    } catch {
      return 0n;
    }
  }, [amount, decimals, divisor]);

  // Preview shares for deposit
  const previewShares = useMemo(() => {
    if (rawAmount <= 0n) return 0n;
    if (lpSupply === 0n || vaultBalance === 0n) return rawAmount; // 1:1 initial mint
    return (rawAmount * lpSupply) / vaultBalance;
  }, [rawAmount, lpSupply, vaultBalance]);

  // Preview collateral for withdrawal
  const previewCollateral = useMemo(() => {
    if (rawAmount <= 0n) return 0n;
    if (lpSupply === 0n) return 0n;
    return (rawAmount * vaultBalance) / lpSupply;
  }, [rawAmount, lpSupply, vaultBalance]);

  const maxAmount = useMemo(() => {
    const raw = tab === 'deposit' ? userBalance : userLpBalance;
    return formatRaw(raw, decimals);
  }, [tab, userBalance, userLpBalance, decimals]);

  const handleSetMax = useCallback(() => {
    setAmount(maxAmount);
  }, [maxAmount]);

  const handleSetPercent = useCallback(
    (pct: number) => {
      const raw = tab === 'deposit' ? userBalance : userLpBalance;
      const partial = (raw * BigInt(pct)) / 100n;
      setAmount(formatRaw(partial, decimals));
    },
    [tab, userBalance, userLpBalance, decimals],
  );

  const handleSubmit = useCallback(async () => {
    if (rawAmount <= 0n) return;
    setSubmitting(true);
    setTxError(null);
    setTxSuccess(null);

    try {
      if (tab === 'deposit') {
        await onDeposit(rawAmount);
        setTxSuccess('Deposit successful!');
      } else {
        await onWithdraw(rawAmount);
        setTxSuccess('Withdrawal successful!');
      }
      setAmount('');
    } catch (e) {
      setTxError(e instanceof Error ? e.message : 'Transaction failed');
    } finally {
      setSubmitting(false);
    }
  }, [rawAmount, tab, onDeposit, onWithdraw]);

  // Validation
  const isValid = useMemo(() => {
    if (rawAmount <= 0n) return false;
    if (tab === 'deposit' && rawAmount > userBalance) return false;
    if (tab === 'withdraw') {
      if (rawAmount > userLpBalance) return false;
      if (!cooldownElapsed) return false;
    }
    return true;
  }, [rawAmount, tab, userBalance, userLpBalance, cooldownElapsed]);

  if (!connected) {
    return (
      <div className="border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm p-8 text-center hud-corners">
        <div className="text-3xl mb-3">🔐</div>
        <p className="text-[13px] text-[var(--text-secondary)] mb-4">
          Connect your wallet to deposit or withdraw
        </p>
        <ConnectButton />
      </div>
    );
  }

  return (
    <div className="border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm overflow-hidden hud-corners">
      <div className="h-px bg-gradient-to-r from-transparent via-[var(--accent)]/40 to-transparent" />

      {/* Tab switcher */}
      <div className="flex border-b border-[var(--border)]">
        {(['deposit', 'withdraw'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => {
              setTab(t);
              setAmount('');
              setTxError(null);
              setTxSuccess(null);
            }}
            className={`flex-1 py-3 text-[12px] font-medium uppercase tracking-[0.15em] transition-all duration-150 ${
              tab === t
                ? 'text-[var(--accent)] border-b-2 border-[var(--accent)] bg-[var(--accent)]/[0.04]'
                : 'text-[var(--text-secondary)] hover:text-white'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="p-5">
        {/* Amount input */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <label className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-secondary)]">
              {tab === 'deposit' ? 'Deposit Amount' : 'LP Tokens to Burn'}
            </label>
            <button
              onClick={handleSetMax}
              className="text-[10px] text-[var(--accent)] hover:text-[var(--accent)]/80 transition-colors"
            >
              Max: {maxAmount} {tab === 'deposit' ? collateralSymbol : 'LP'}
            </button>
          </div>

          <div className="relative">
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => {
                const v = e.target.value;
                if (/^\d*\.?\d*$/.test(v)) setAmount(v);
              }}
              className="w-full h-12 px-4 pr-16 text-lg font-mono tabular-nums bg-[var(--bg)] border border-[var(--border)] rounded-sm text-white placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]/40 transition-colors"
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[12px] text-[var(--text-secondary)]">
              {tab === 'deposit' ? collateralSymbol : 'LP'}
            </span>
          </div>

          {/* Quick percentage buttons */}
          <div className="flex gap-2 mt-2">
            {[25, 50, 75, 100].map((pct) => (
              <button
                key={pct}
                onClick={() => handleSetPercent(pct)}
                className="flex-1 py-1.5 text-[10px] font-medium border border-[var(--border)] rounded-sm text-[var(--text-secondary)] hover:border-[var(--accent)]/30 hover:text-white transition-all"
              >
                {pct}%
              </button>
            ))}
          </div>
        </div>

        {/* Preview */}
        {rawAmount > 0n && (
          <div className="mb-4 p-3 bg-[var(--bg)] border border-[var(--border)] rounded-sm">
            <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-secondary)] mb-2">
              {tab === 'deposit' ? 'You will receive' : 'You will receive'}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-mono tabular-nums text-white">
                {tab === 'deposit'
                  ? `≈ ${formatRaw(previewShares, decimals)} LP tokens`
                  : `≈ ${formatRaw(previewCollateral, decimals)} ${collateralSymbol}`}
              </span>
              {tab === 'deposit' && lpSupply > 0n && (
                <span className="text-[10px] text-[var(--text-secondary)]">
                  Share: {((Number(previewShares) / Number(lpSupply + previewShares)) * 100).toFixed(2)}%
                </span>
              )}
            </div>
          </div>
        )}

        {/* Cooldown warning */}
        {tab === 'withdraw' && !cooldownElapsed && (
          <div className="mb-4 p-3 bg-[var(--warning)]/5 border border-[var(--warning)]/20 rounded-sm">
            <p className="text-[11px] text-[var(--warning)]">
              ⏳ Cooldown period has not elapsed. You cannot withdraw yet.
            </p>
          </div>
        )}

        {/* Error / Success */}
        {txError && (
          <div className="mb-4 p-3 bg-[var(--short)]/5 border border-[var(--short)]/20 rounded-sm">
            <p className="text-[11px] text-[var(--short)]">{txError}</p>
          </div>
        )}
        {txSuccess && (
          <div className="mb-4 p-3 bg-[var(--cyan)]/5 border border-[var(--cyan)]/20 rounded-sm">
            <p className="text-[11px] text-[var(--cyan)]">{txSuccess}</p>
          </div>
        )}

        {/* Submit */}
        <GlowButton
          onClick={handleSubmit}
          disabled={!isValid || submitting || loading}
          variant="primary"
          size="lg"
          className="w-full"
        >
          {submitting
            ? 'Confirming...'
            : tab === 'deposit'
              ? 'Deposit'
              : 'Withdraw'}
        </GlowButton>
      </div>
    </div>
  );
}

/** Format raw bigint to human-readable decimal string */
function formatRaw(raw: bigint, decimals: number): string {
  if (raw <= 0n) return '0';
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}
