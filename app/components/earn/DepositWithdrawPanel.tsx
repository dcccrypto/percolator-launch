'use client';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { formatPercent } from "@/lib/formatters";
import { earnErrorMessage } from "@/lib/earnErrors";
import { formatTokenAmount } from "@/lib/format";
import { drawNoticeText, type DrawSummary } from "@/lib/limits/p3-draw-logs";
import { GlowButton } from '@/components/ui/GlowButton';
import { StatusLine } from '@/components/ui/StatusLine';
import { EarnPendingWithdrawal } from '@/components/earn/EarnPendingWithdrawal';
import { EarnPayoutCapError } from '@/lib/limits/earn-split-pot';
import {
  EARN_WITHDRAW_COPY as WC,
  cooldownPhrase,
  previewDepositShares,
  previewWithdrawAtoms,
  sharesForUsdc,
  withdrawFlow,
} from '@/lib/limits/earn-withdraw';
import { useWalletCompat, useConnectionCompat } from '@/hooks/useWalletCompat';
import { checkSignatureLanded, timedOutSignature } from '@/lib/tx';
import { watchPendingSignature } from '@/lib/pending-signature';
import { explorerTxUrl } from '@/lib/config';
import dynamic from 'next/dynamic';

const ConnectButton = dynamic(
  () =>
    import('@/components/wallet/ConnectButton').then((m) => m.ConnectButton),
  { ssr: false },
);

type Tab = 'deposit' | 'withdraw';

/**
 * GH#2804: a submitted tx whose confirmation timed out. 'watching': its signature is polled and the
 * submit stays disabled (a second click would send a second deposit while the first may land).
 * 'undetermined': still unresolved after the watch window; the form is usable again, the explorer
 * link stays.
 */
type PendingTx = { sig: string; action: Tab; state: 'watching' | 'undetermined' };

/**
 * S2 fix: `onWithdraw` reports which redemption step actually ran so the
 * caller can show the correct toast. 'requested' means RequestRedeemLpShares
 * fired (cooldown just started, NO funds moved); 'executed' means
 * ExecuteRedemption fired (funds sent to the wallet). `| void` keeps this
 * backward-compatible with callers/tests that don't return a value.
 */
export interface WithdrawStepResult {
  step: 'requested' | 'executed';
}

interface DepositWithdrawPanelProps {
  /** User's collateral balance (lamports/raw) */
  userBalance: bigint;
  /** User's LP token balance */
  userLpBalance: bigint;
  /** Vault total balance */
  vaultBalance: bigint;
  /** LP supply */
  lpSupply: bigint;
  /** Whether both the LP Vault Registry and LP mint exist on-chain. */
  vaultAvailable: boolean;
  /** Collateral decimals */
  decimals: number;
  /** Collateral symbol (e.g. USDC) */
  collateralSymbol: string;
  /** Loading state */
  loading: boolean;
  /** Cooldown elapsed (for withdraw) */
  cooldownElapsed: boolean;
  /** Cooldown duration in slots (0 = no cooldown) */
  cooldownSlots?: bigint;
  /**
   * S1 fix: whether the connected wallet has an open RequestRedeemLpShares
   * ticket. A full ("Max") redemption request moves the user's ENTIRE LP
   * balance into escrow, zeroing `userLpBalance` — without this flag the
   * Withdraw button becomes permanently disabled (`rawAmount <= userLpBalance
   * === 0`) with no way to reach ExecuteRedemption and claim the funds.
   */
  hasPendingRedemption?: boolean;
  /** LP shares locked in the pending redemption ticket (0 if none). */
  pendingRedemptionShares?: bigint;
  /** Slots remaining until the pending redemption's cooldown elapses (0 = elapsed/none). */
  cooldownRemainingSlots?: bigint;
  /** Deposit callback */
  onDeposit: (amount: bigint) => Promise<void>;
  /**
   * P3 (limits UI): when set, deposits are refused by the program for this vault right now
   * (senior impaired / pending-fee genesis / stale valuation). The Deposit button is disabled
   * and this reason is shown. Withdrawals are unaffected.
   */
  depositBlockedReason?: string | null;
  depositBlockKind?: string | null;
  /** Withdraw callback — see `WithdrawStepResult` (S2 fix). */
  onWithdraw: (lpAmount: bigint) => Promise<WithdrawStepResult | void>;
  /** P3: the vault owns its market's LP, which changes what a claim-side 21 means (E2E B24). */
  p3Bound?: boolean;
  /**
   * The market's counterparty has no funds left (market health lpDepleted), so trading is paused.
   * On an unbound vault an Earn deposit goes to the backing that pays traders' payouts and never
   * reaches the counterparty, so it can't reopen trading (GH#2882). Not shown when p3Bound: there
   * the vault funds the counterparty.
   */
  lpDepleted?: boolean;
  /** d119eebd: senior draw booked / restored by the user's last Earn tx (its program logs). */
  drawSummary?: DrawSummary | null;
  /**
   * UX WP-4: the P3 pricing the program uses (registry shares + the senior value at the WORSE of
   * the effective / target price for each side), and what the vault can pay out now. Absent on a
   * vault without it: the previews fall back to vaultBalance / lpSupply.
   */
  pricing?: {
    totalShares: bigint;
    depositSeniorValue: bigint | null;
    withdrawSeniorValue: bigint | null;
    maxNowAtoms: bigint | null;
  } | null;
  /** UX WP-4: re-read the ticket when the countdown reaches 0. */
  onRefresh?: () => Promise<void> | void;
  /**
   * Two-pot vault: the pending withdrawal is more than the vault can pay right now. Re-request
   * `shares` (cancel + request in one transaction); the payout then collects by itself.
   */
  onResizeRedemption?: (shares: bigint) => Promise<void>;
}

export function DepositWithdrawPanel({
  userBalance,
  userLpBalance,
  vaultBalance,
  lpSupply,
  vaultAvailable,
  decimals,
  collateralSymbol,
  loading,
  cooldownElapsed,
  cooldownSlots,
  hasPendingRedemption = false,
  pendingRedemptionShares = 0n,
  cooldownRemainingSlots = 0n,
  onDeposit,
  onWithdraw,
  depositBlockedReason = null,
  depositBlockKind = null,
  p3Bound = false,
  lpDepleted = false,
  drawSummary = null,
  pricing = null,
  onRefresh,
  onResizeRedemption,
}: DepositWithdrawPanelProps) {
  const { connected } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const [tab, setTab] = useState<Tab>('deposit');
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);
  const [txSuccess, setTxSuccess] = useState<string | null>(null);
  // Claim-redemption is a separate action from the deposit/withdraw form below —
  // tracked independently so it doesn't fight the form's submitting/error state.
  const [claimSubmitting, setClaimSubmitting] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimSuccess, setClaimSuccess] = useState<string | null>(null);
  // UX WP-4: the withdrawal is asked for in USDC (a "shares" toggle for those who think in shares).
  const [withdrawUnit, setWithdrawUnit] = useState<'usdc' | 'shares'>('usdc');
  // Requested in this page session: the payout prompt opens by itself when the cooldown ends.
  const [armed, setArmed] = useState(false);
  // The payout was refused before signing because the vault can pay only part of it right now.
  const [resizeOffer, setResizeOffer] = useState<{ shares: bigint; atoms: bigint } | null>(null);
  const [pendingTx, setPendingTx] = useState<PendingTx | null>(null);
  const watchAbort = useRef<AbortController | null>(null);
  useEffect(() => () => watchAbort.current?.abort(), []);

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

  // The program's own pricing when known (P3: registry shares + worse-of senior value).
  const shareTotal = pricing?.totalShares ?? lpSupply;
  const depositValue = pricing ? pricing.depositSeniorValue : vaultBalance;
  const withdrawValue = pricing ? pricing.withdrawSeniorValue : vaultBalance;

  // Preview shares for deposit
  const previewShares = useMemo(() => {
    if (!vaultAvailable || rawAmount <= 0n) return 0n;
    if (shareTotal === 0n || (depositValue ?? 0n) === 0n) return rawAmount; // 1:1 initial mint
    return previewDepositShares(rawAmount, shareTotal, depositValue) ?? 0n;
  }, [vaultAvailable, rawAmount, shareTotal, depositValue]);

  // What the whole position redeems for: the Max / 100% amount in USDC.
  const userWithdrawableAtoms = useMemo(
    () => (userLpBalance > 0n && shareTotal > 0n ? previewWithdrawAtoms(userLpBalance, shareTotal, withdrawValue) ?? 0n : 0n),
    [userLpBalance, shareTotal, withdrawValue],
  );

  // Withdraw: the shares this request burns (USDC input -> shares at the withdraw-side value).
  // The whole position's value (Max / 100%) or more burns every share: shares -> USDC -> shares
  // floors twice, so converting the max back came out a share short and left that dust share
  // behind as a $0.00 position that never closes.
  const withdrawShares = useMemo(() => {
    if (!vaultAvailable || rawAmount <= 0n) return 0n;
    if (withdrawUnit === 'shares') return rawAmount;
    if (userWithdrawableAtoms > 0n && rawAmount >= userWithdrawableAtoms) return userLpBalance;
    return sharesForUsdc(rawAmount, shareTotal, withdrawValue, userLpBalance) ?? 0n;
  }, [vaultAvailable, rawAmount, withdrawUnit, shareTotal, withdrawValue, userLpBalance, userWithdrawableAtoms]);

  // Preview collateral for withdrawal
  const previewCollateral = useMemo(() => {
    if (withdrawShares <= 0n || shareTotal === 0n) return 0n;
    return previewWithdrawAtoms(withdrawShares, shareTotal, withdrawValue) ?? 0n;
  }, [withdrawShares, shareTotal, withdrawValue]);
  const pendingAtoms = useMemo(
    () => (pendingRedemptionShares > 0n && shareTotal > 0n ? previewWithdrawAtoms(pendingRedemptionShares, shareTotal, withdrawValue) : null),
    [pendingRedemptionShares, shareTotal, withdrawValue],
  );
  // 88 before it happens (§3.6 item 6): more than the vault can pay out now.
  const maxNow = pricing?.maxNowAtoms ?? null;
  const overMaxNow = tab === 'withdraw' && maxNow !== null && previewCollateral > maxNow;
  const flow = withdrawFlow(cooldownSlots ?? 0n);

  const withdrawMaxRaw = withdrawUnit === 'shares' ? userLpBalance : userWithdrawableAtoms;
  const maxAmount = useMemo(() => {
    const raw = tab === 'deposit' ? userBalance : withdrawMaxRaw;
    return formatRaw(raw, decimals);
  }, [tab, userBalance, withdrawMaxRaw, decimals]);
  const unitLabel = tab === 'deposit' ? collateralSymbol : withdrawUnit === 'shares' ? 'shares' : collateralSymbol;

  const displayMaxAmount = loading || !vaultAvailable ? '—' : maxAmount;

  const handleSetMax = useCallback(() => {
    if (loading || !vaultAvailable) return;
    setAmount(maxAmount);
  }, [loading, vaultAvailable, maxAmount]);

  const handleSetPercent = useCallback(
    (pct: number) => {
      if (loading || !vaultAvailable) return;

      const raw = tab === 'deposit' ? userBalance : withdrawMaxRaw;
      const partial = (raw * BigInt(pct)) / 100n;
      setAmount(formatRaw(partial, decimals));
    },
    [loading, vaultAvailable, tab, userBalance, withdrawMaxRaw, decimals],
  );

  // GH#2804: after a confirmation timeout, watch the signature until it lands, is dropped, or the
  // watch window ends. Only then does the form take another submit.
  const watchTimedOut = useCallback(
    (sig: string, action: Tab) => {
      watchAbort.current?.abort();
      const ctl = new AbortController();
      watchAbort.current = ctl;
      setPendingTx({ sig, action, state: 'watching' });
      const refresh = () => {
        try {
          void Promise.resolve(onRefresh?.()).catch(() => {});
        } catch {
          /* a refresh failure must not mask the outcome */
        }
      };
      void watchPendingSignature(() => checkSignatureLanded(connection, sig), { signal: ctl.signal }).then((outcome) => {
        if (outcome === 'aborted' || ctl.signal.aborted) return;
        if (outcome === 'landed') {
          setPendingTx(null);
          setAmount('');
          setTxSuccess(action === 'deposit' ? 'Deposit successful!' : 'Your withdrawal transaction confirmed.');
          refresh();
        } else if (outcome === 'dropped') {
          setPendingTx(null);
          setTxError(
            action === 'deposit'
              ? "This deposit didn't go through. Nothing was sent. You can try again."
              : "This didn't go through. Nothing was sent. You can try again.",
          );
        } else {
          setPendingTx({ sig, action, state: 'undetermined' });
          refresh();
        }
      });
    },
    [connection, onRefresh],
  );

  const handleSubmit = useCallback(async () => {
    if (!vaultAvailable || rawAmount <= 0n || pendingTx?.state === 'watching') return;

    setSubmitting(true);
    setTxError(null);
    setTxSuccess(null);
    setPendingTx(null);

    try {
      if (tab === 'deposit') {
        await onDeposit(rawAmount);
        setTxSuccess('Deposit successful!');
      } else {
        const result = await onWithdraw(withdrawShares);
        // UX WP-4: a request (76) starts the cooldown; the pending card takes it from here and
        // opens the payout by itself. Only a payout sends funds, so only it earns "sent".
        if (result?.step === 'requested') setArmed(true);
        else setTxSuccess(`Sent ≈ ${formatUsdc(previewCollateral, decimals)} ${collateralSymbol} to your wallet.`);
      }
      setAmount('');
    } catch (e) {
      // GH#2804: submitted but not yet confirmed — it may still land. Watch it; no second send.
      const sig = timedOutSignature(e);
      if (sig) {
        watchTimedOut(sig, tab);
        return;
      }
      // Decode the program error into Earn-specific copy (a locked vault used to
      // surface as a raw "custom program error: 0x15").
      setTxError(earnErrorMessage(e, tab === 'deposit' ? 'deposit' : 'claim', { p3Bound }));
    } finally {
      setSubmitting(false);
    }
  }, [vaultAvailable, rawAmount, pendingTx, tab, onDeposit, onWithdraw, withdrawShares, previewCollateral, decimals, collateralSymbol, p3Bound, watchTimedOut]);

  // The payout (77) of a pending withdrawal: automatic when armed, "Finish withdrawal" otherwise.
  // Deliberately bypasses the form's userLpBalance gate — a full request escrows every share.
  const handleClaimRedemption = useCallback(async () => {
    if (claimSubmitting || loading || !vaultAvailable || !cooldownElapsed) return;
    setClaimSubmitting(true);
    setClaimError(null);
    setClaimSuccess(null);
    try {
      const result = await onWithdraw(pendingRedemptionShares);
      setArmed(false);
      setClaimSuccess(
        result?.step === 'requested'
          ? null
          : `Sent${pendingAtoms !== null ? ` ≈ ${formatUsdc(pendingAtoms, decimals)} ${collateralSymbol}` : ''} to your wallet.`,
      );
    } catch (e) {
      setArmed(false);
      if (e instanceof EarnPayoutCapError && onResizeRedemption && e.maxShares > 0n) {
        setResizeOffer({ shares: e.maxShares, atoms: e.maxAtoms });
        return;
      }
      setClaimError(earnErrorMessage(e, 'claim', { p3Bound }));
    } finally {
      setClaimSubmitting(false);
    }
  }, [claimSubmitting, loading, vaultAvailable, cooldownElapsed, onWithdraw, pendingRedemptionShares, pendingAtoms, decimals, collateralSymbol, p3Bound, onResizeRedemption]);

  const handleResize = useCallback(async () => {
    if (!resizeOffer || !onResizeRedemption || claimSubmitting) return;
    setClaimSubmitting(true);
    setClaimError(null);
    try {
      await onResizeRedemption(resizeOffer.shares);
      setResizeOffer(null);
      // The cooldown restarts; collect by itself when it ends (one flow).
      setArmed(true);
    } catch (e) {
      setClaimError(earnErrorMessage(e, 'claim', { p3Bound }));
    } finally {
      setClaimSubmitting(false);
    }
  }, [resizeOffer, onResizeRedemption, claimSubmitting, p3Bound]);

  // Validation
  const isValid = useMemo(() => {
    if (loading || !vaultAvailable) return false;
    if (rawAmount <= 0n) return false;
    if (tab === 'deposit' && rawAmount > userBalance) return false;
    if (tab === 'deposit' && depositBlockedReason) return false;
    if (tab === 'withdraw') {
      if (hasPendingRedemption) return false;
      if (withdrawShares <= 0n || withdrawShares > userLpBalance) return false;
      if (withdrawUnit === 'shares' && rawAmount > userLpBalance) return false;
      if (overMaxNow) return false;
    }
    return true;
  }, [
    loading,
    vaultAvailable,
    rawAmount,
    tab,
    userBalance,
    userLpBalance,
    withdrawShares,
    withdrawUnit,
    hasPendingRedemption,
    overMaxNow,
    depositBlockedReason,
  ]);

  if (!connected) {
    return (
      <div className="border border-[var(--border)] bg-[var(--panel-bg)] rounded-sm p-8 text-center hud-corners">
        <div className="text-4xl mb-3">🔐</div>
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
            data-testid="earn-tab"
            data-tab={t}
            onClick={() => {
              setTab(t);
              setAmount('');
              setTxError(null);
              setTxSuccess(null);
            }}
            className={`flex-1 py-3 text-[12px] font-medium uppercase tracking-[0.15em] transition-all duration-150 ${
              tab === t
                ? 'text-[var(--accent)] border-b-2 border-[var(--accent)] bg-[var(--accent)]/[0.04]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text)]'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* UX WP-4: the pending withdrawal card (both tabs). A full request escrows every share, so
          this is also what keeps the payout reachable (S1). It counts as an active position. */}
      {hasPendingRedemption && (
        <EarnPendingWithdrawal
          amountLabel={pendingAtoms !== null ? `${formatUsdc(pendingAtoms, decimals)} ${collateralSymbol}` : `${formatRaw(pendingRedemptionShares, decimals)} shares`}
          cooldownElapsed={cooldownElapsed}
          cooldownRemainingSlots={cooldownRemainingSlots}
          armed={armed}
          disabled={!vaultAvailable || loading || claimSubmitting}
          onCollect={handleClaimRedemption}
          onRefresh={onRefresh}
          ticketKey={pendingRedemptionShares.toString()}
          error={claimError}
          resize={
            resizeOffer
              ? {
                  label: WC.maxAvailableAction(`${formatUsdc(resizeOffer.atoms, decimals)} ${collateralSymbol}`),
                  body: WC.maxAvailableBody,
                  onResize: handleResize,
                }
              : null
          }
        />
      )}
      {claimSuccess && (
        <p role="status" aria-live="polite" data-testid="earn-withdraw-sent" className="mx-5 mt-3 text-[12px] text-[var(--text)]">{claimSuccess}</p>
      )}

      <div className="p-5">
        {tab === 'withdraw' && hasPendingRedemption ? (
          <p data-testid="earn-withdraw-in-progress" className="text-[12px] text-[var(--text-secondary)]">
            Your withdrawal is in progress above. You can start another once it is collected.
          </p>
        ) : (
        <>
        {/* Amount input */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <label htmlFor="earn-amount-input" className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-secondary)]">
              {tab === 'deposit' ? 'Deposit Amount' : 'Withdraw Amount'}
            </label>
            <button
              onClick={handleSetMax}
              disabled={loading || !vaultAvailable}
              aria-label={`Set maximum amount: ${displayMaxAmount} ${unitLabel}`}
              className="text-[10px] text-[var(--accent)] hover:text-[var(--accent)]/80 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            >
              Max: {displayMaxAmount} {unitLabel}
            </button>
          </div>

          <div className="relative">
            <input
              id="earn-amount-input"
              data-testid={tab === 'deposit' ? 'earn-deposit-input' : 'earn-withdraw-input'}
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              disabled={loading || !vaultAvailable}
              onChange={(e) => {
                const v = e.target.value;
                if (/^\d*\.?\d*$/.test(v)) setAmount(v);
              }}
              className="w-full h-12 px-4 pr-16 text-2xl font-mono tabular-nums bg-[var(--bg)] border border-[var(--border)] rounded-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]/40 transition-colors"
            />
            {tab === 'deposit' ? (
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[12px] text-[var(--text-secondary)]">{collateralSymbol}</span>
            ) : (
              <button
                type="button"
                data-testid="earn-withdraw-unit"
                data-unit={withdrawUnit}
                onClick={() => {
                  setWithdrawUnit((u) => (u === 'usdc' ? 'shares' : 'usdc'));
                  setAmount('');
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text)]"
              >
                {unitLabel}
              </button>
            )}
          </div>

          {/* Quick percentage buttons */}
          <div className="flex gap-2 mt-2">
            {[25, 50, 75, 100].map((pct) => (
              <button
                key={pct}
                onClick={() => handleSetPercent(pct)}
                disabled={loading || !vaultAvailable}
                className="flex-1 py-1.5 text-[10px] font-medium border border-[var(--border)] rounded-sm text-[var(--text-secondary)] hover:border-[var(--accent)]/30 hover:text-[var(--text)] transition-all disabled:cursor-not-allowed disabled:opacity-40"
              >
                {pct}%
              </button>
            ))}
          </div>
        </div>

        {tab === 'deposit' && !loading && rawAmount > userBalance && (
          <p role="alert" data-testid="earn-deposit-amount-error" className="mb-3 text-[11px] text-[var(--short)]">
            Exceeds your wallet balance ({maxAmount} {collateralSymbol} available)
          </p>
        )}

        {/* Preview */}
        {vaultAvailable && rawAmount > 0n && tab === 'deposit' && (
          <div className="mb-4 p-3 bg-[var(--bg)] border border-[var(--border)] rounded-sm">
            <p data-testid="earn-deposit-preview" className="text-[12px] font-mono tabular-nums text-[var(--text)]">
              {WC.depositPreview(
                formatShares(previewShares, decimals),
                formatPercent(shareTotal + previewShares > 0n ? (Number(previewShares) / Number(shareTotal + previewShares)) * 100 : 100),
              )}
            </p>
          </div>
        )}

        {/* Withdrawal: one receive line (never "LP tokens will be permanently burned": burning
            shares for USDC IS the withdrawal), and 88 before it happens (max_now). */}
        {vaultAvailable && rawAmount > 0n && tab === 'withdraw' && (
          <div className="mb-4 space-y-2">
            <p data-testid="earn-withdraw-receive" className="text-[12px] font-mono tabular-nums text-[var(--text)]">
              {WC.receive(`${formatUsdc(previewCollateral, decimals)} ${collateralSymbol}`, formatShares(withdrawShares, decimals))}
            </p>
            {overMaxNow && maxNow !== null && (
              <StatusLine
                message={{
                  kind: 'earn-max-now',
                  variant: 'paused',
                  title: 'Partly available now',
                  body: WC.maxNow(`${formatUsdc(maxNow, decimals)} ${collateralSymbol}`),
                  action: { id: 'use-max', label: WC.maxNowAction(`${formatUsdc(maxNow, decimals)} ${collateralSymbol}`) },
                }}
                onAction={() => {
                  setWithdrawUnit('usdc');
                  setAmount(formatRaw(maxNow, decimals));
                }}
              />
            )}
          </div>
        )}

        {/* Error / Success */}
        {txError && (
          <div role="alert" data-testid="earn-error" data-kind="tx" className="mb-4 p-3 bg-[var(--short)]/5 border border-[var(--short)]/20 rounded-sm">
            <p className="text-[11px] text-[var(--short)]">{txError}</p>
          </div>
        )}
        {pendingTx && (
          <div role="status" aria-live="polite" data-testid="earn-tx-pending" data-state={pendingTx.state} className="mb-4 p-3 bg-[var(--warning)]/5 border border-[var(--warning)]/20 rounded-sm">
            <p className="text-[11px] text-[var(--text-secondary)]">
              {pendingTx.state === 'watching'
                ? 'Still confirming. Checking the network…'
                : "Couldn't confirm it yet. Check the explorer before trying again."}{' '}
              <a
                href={explorerTxUrl(pendingTx.sig)}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="earn-tx-explorer"
                className="text-[var(--accent)] underline"
              >
                View on explorer
              </a>
            </p>
          </div>
        )}
        {drawSummary && (
          <div role="status" data-testid="earn-draw-notice" className="mb-4 p-3 bg-[var(--warning)]/5 border border-[var(--warning)]/20 rounded-sm">
            <p className="text-[11px] text-[var(--text-secondary)]">
              {drawNoticeText(drawSummary, (a) => `${formatTokenAmount(a, decimals)} ${collateralSymbol}`)}
            </p>
          </div>
        )}
        {txSuccess && (
          <div role="status" aria-live="polite" className="mb-4 p-3 bg-[var(--cyan)]/5 border border-[var(--cyan)]/20 rounded-sm">
            <p className="text-[11px] text-[var(--cyan)]">{txSuccess}</p>
          </div>
        )}

        {tab === 'deposit' && depositBlockedReason && (
          <div
            role="status"
            data-testid="earn-deposit-blocked"
            data-reason={depositBlockKind ?? ''}
            className="mb-3 border border-[var(--warning)]/30 bg-[var(--warning)]/5 px-3 py-2"
          >
            <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--warning)]">Deposits paused</p>
            <p className="mt-1 text-[10px] leading-relaxed text-[var(--text-secondary)]">{depositBlockedReason}</p>
          </div>
        )}

        {tab === 'deposit' && lpDepleted && !p3Bound && (
          <div
            role="status"
            data-testid="earn-lp-depleted-note"
            className="mb-3 border border-[var(--warning)]/30 bg-[var(--warning)]/5 px-3 py-2"
          >
            <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--warning)]">Trading paused</p>
            <p className="mt-1 text-[10px] leading-relaxed text-[var(--text-secondary)]">
              Trading on this market is paused. Deposits here back traders&apos; payouts and don&apos;t reopen trading.
            </p>
          </div>
        )}

        {/* Submit */}
        {tab === 'withdraw' && (
          <p data-testid="earn-withdraw-arrives" className="mb-2 text-[11px] text-[var(--text-secondary)]">
            {WC.requestLine(flow === 'one-tx' ? 'one transaction' : cooldownPhrase(cooldownSlots ?? 0n), flow === 'one-tx' ? 1 : 2)}
          </p>
        )}
        <div className="flex gap-2">
          <GlowButton
            data-testid={tab === 'deposit' ? 'earn-deposit-submit' : 'earn-withdraw-request'}
            onClick={handleSubmit}
            disabled={!isValid || submitting || loading || pendingTx?.state === 'watching'}
            variant="primary"
            size="lg"
            className="flex-1"
          >
            {submitting
              ? 'Confirm in wallet…'
              : pendingTx?.state === 'watching'
                ? 'Confirming…'
                : tab === 'deposit'
                ? 'Deposit'
                : WC.requestButton(rawAmount > 0n ? `${formatUsdc(previewCollateral, decimals)} ${collateralSymbol}` : collateralSymbol)}
          </GlowButton>
        </div>
        </>
        )}
      </div>
    </div>
  );
}

/** USDC to 2 dp (floored) for the withdrawal lines. */
function formatUsdc(raw: bigint, decimals: number): string {
  return formatShares(raw, decimals);
}

/** Shares to 2 dp (never raw atoms like "996058616"). */
function formatShares(raw: bigint, decimals: number): string {
  const d = 10n ** BigInt(decimals);
  const cents = (raw * 100n) / d;
  return `${(cents / 100n).toLocaleString('en-US')}.${(cents % 100n).toString().padStart(2, '0')}`;
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
