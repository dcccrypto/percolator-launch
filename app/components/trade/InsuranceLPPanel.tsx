'use client';

import { useState } from 'react';
import { useInsuranceLP } from '../../hooks/useInsuranceLP';
import { useWallet } from '@solana/wallet-adapter-react';
import { useSlabState } from '../providers/SlabProvider';
import { useTokenMeta } from '../../hooks/useTokenMeta';
import { formatTokenAmount } from '../../lib/format';
import { parseHumanAmount } from '../../lib/parseAmount';

function formatCollateral(lamports: bigint, decimals: number = 6): string {
  if (lamports === 0n) return '0';
  const formatted = formatTokenAmount(lamports, decimals);
  const num = parseFloat(formatted);
  if (num < 0.001 && num > 0) return '<0.001';
  return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatRate(rateE6: bigint): string {
  const rate = Number(rateE6) / 1e6;
  return rate.toFixed(4);
}

export function InsuranceLPPanel() {
  const { publicKey } = useWallet();
  const slabState = useSlabState();
  const tokenMeta = useTokenMeta(slabState?.config?.collateralMint ?? null);
  const tokenSymbol = tokenMeta?.symbol ?? 'Token';
  const tokenDecimals = tokenMeta?.decimals ?? 6;
  const { state, loading, error, createMint, deposit, withdraw } = useInsuranceLP();
  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit');
  const [amount, setAmount] = useState('');
  const [txStatus, setTxStatus] = useState<string | null>(null);

  const isAdmin = publicKey && slabState?.header?.admin &&
    publicKey.toBase58() === slabState.header.admin.toBase58();

  const handleDeposit = async () => {
    if (!amount) return;
    setTxStatus('Depositing...');
    try {
      const lamports = parseHumanAmount(amount, tokenDecimals);
      await deposit(lamports);
      setTxStatus('Deposit successful!');
      setAmount('');
      setTimeout(() => setTxStatus(null), 3000);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setTxStatus(`Error: ${message}`);
    }
  };

  const handleWithdraw = async () => {
    if (!amount) return;
    setTxStatus('Withdrawing...');
    try {
      const lpTokens = parseHumanAmount(amount, tokenDecimals);
      await withdraw(lpTokens);
      setTxStatus('Withdrawal successful!');
      setAmount('');
      setTimeout(() => setTxStatus(null), 3000);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setTxStatus(`Error: ${message}`);
    }
  };

  const handleCreateMint = async () => {
    setTxStatus('Creating insurance LP mint...');
    try {
      await createMint();
      setTxStatus('Insurance LP mint created!');
      setTimeout(() => setTxStatus(null), 3000);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setTxStatus(`Error: ${message}`);
    }
  };

  // Preview calculation — use parseHumanAmount for precision
  const previewTokens = (() => {
    if (!amount || mode !== 'deposit') return null;
    try {
      const lamports = parseHumanAmount(amount, tokenDecimals);
      if (lamports <= 0n) return null;
      if (state.lpSupply === 0n) return lamports; // 1:1
      if (state.insuranceBalance === 0n) return null;
      return (lamports * state.lpSupply) / state.insuranceBalance;
    } catch { return null; }
  })();

  const previewCollateral = (() => {
    if (!amount || mode !== 'withdraw') return null;
    try {
      const lpTokens = parseHumanAmount(amount, tokenDecimals);
      if (lpTokens <= 0n) return null;
      if (state.lpSupply === 0n) return null;
      return (lpTokens * state.insuranceBalance) / state.lpSupply;
    } catch { return null; }
  })();

  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-none p-4">
      <div className="flex items-center gap-2 mb-4">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">Insurance Pool</h3>
        {state.mintExists && (
          <span className="ml-auto text-[10px] px-1.5 py-0.5 bg-[var(--long)]/10 text-[var(--long)] rounded-none border border-[var(--long)]/20">
            LIVE
          </span>
        )}
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div>
          <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Pool Size</p>
          <p className="text-sm font-mono text-[var(--text)]">{formatCollateral(state.insuranceBalance, tokenDecimals)} {tokenSymbol}</p>
        </div>
        <div>
          <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">LP Supply</p>
          <p className="text-sm font-mono text-[var(--text)]">{formatCollateral(state.lpSupply, tokenDecimals)}</p>
        </div>
        <div>
          <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Rate</p>
          <p className="text-sm font-mono text-[var(--text)]">{formatRate(state.redemptionRateE6)} {tokenSymbol}/LP</p>
        </div>
        <div>
          <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Your Share</p>
          <p className="text-sm font-mono text-[var(--text)]">
            {state.userSharePct > 0 ? `${state.userSharePct.toFixed(1)}%` : '—'}
          </p>
        </div>
      </div>

      {/* User Position */}
      {state.userLpBalance > 0n && (
        <div className="bg-white/[0.05] rounded-none p-3 mb-4 border border-white/[0.08]">
          <div className="flex justify-between items-center">
            <div>
              <p className="text-[10px] text-[var(--text-muted)] uppercase">Your LP Tokens</p>
              <p className="text-sm font-mono text-[var(--text)]">{formatCollateral(state.userLpBalance, tokenDecimals)}</p>
            </div>
            <div className="text-right">
              <p className="text-[10px] text-[var(--text-muted)] uppercase">Redeemable</p>
              <p className="text-sm font-mono text-[var(--long)]">{formatCollateral(state.userRedeemableValue, tokenDecimals)} {tokenSymbol}</p>
            </div>
          </div>
        </div>
      )}

      {/* Admin: Create Mint */}
      {!state.mintExists && isAdmin && (
        <button
          onClick={handleCreateMint}
          disabled={loading}
          className="w-full py-2 px-4 bg-[var(--long)] hover:bg-[var(--long)]/80 disabled:bg-white/[0.05] disabled:text-[var(--text-muted)] text-[var(--bg)] text-sm font-medium rounded-none transition-colors mb-3"
        >
          {loading ? 'Creating...' : 'Create Insurance LP Mint'}
        </button>
      )}

      {/* Not created yet */}
      {!state.mintExists && !isAdmin && (
        <p className="text-xs text-[var(--text-muted)] text-center py-2">
          Insurance LP not yet enabled for this market
        </p>
      )}

      {/* Deposit / Withdraw */}
      {state.mintExists && publicKey && (
        <>
          {/* Tab Switcher */}
          <div className="flex gap-1 mb-3 bg-white/[0.05] rounded-none p-0.5">
            <button
              onClick={() => { setMode('deposit'); setAmount(''); }}
              className={`flex-1 py-1.5 text-xs font-medium rounded-none transition-colors ${
                mode === 'deposit'
                  ? 'bg-[var(--long)] text-[var(--bg)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text)]'
              }`}
            >
              Deposit
            </button>
            <button
              onClick={() => { setMode('withdraw'); setAmount(''); }}
              className={`flex-1 py-1.5 text-xs font-medium rounded-none transition-colors ${
                mode === 'withdraw'
                  ? 'bg-[var(--short)] text-white'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text)]'
              }`}
            >
              Withdraw
            </button>
          </div>

          {/* Amount Input */}
          <div className="relative mb-3">
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={mode === 'deposit' ? `Amount (${tokenSymbol})` : 'LP tokens'}
              className="w-full bg-white/[0.05] border border-white/[0.08] rounded-none px-3 py-2 text-sm text-[var(--text)] font-mono placeholder:text-[var(--text-dim)] focus:outline-none focus:border-white/[0.12]"
              min="0"
              step="0.001"
            />
            {mode === 'withdraw' && state.userLpBalance > 0n && (
              <button
                onClick={() => setAmount(formatTokenAmount(state.userLpBalance, tokenDecimals))}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-[var(--long)] hover:text-[var(--long)]/80"
              >
                MAX
              </button>
            )}
          </div>

          {/* Preview */}
          {previewTokens !== null && mode === 'deposit' && (
            <p className="text-xs text-[var(--text-muted)] mb-3">
              You receive: <span className="text-[var(--text-secondary)] font-mono">~{formatCollateral(previewTokens, tokenDecimals)}</span> LP tokens
            </p>
          )}
          {previewCollateral !== null && mode === 'withdraw' && (
            <p className="text-xs text-[var(--text-muted)] mb-3">
              You receive: <span className="text-[var(--text-secondary)] font-mono">~{formatCollateral(previewCollateral, tokenDecimals)}</span> {tokenSymbol}
            </p>
          )}

          {/* Action Button */}
          <button
            onClick={mode === 'deposit' ? handleDeposit : handleWithdraw}
            disabled={loading || !amount || parseFloat(amount) <= 0}
            className={`w-full py-2 px-4 text-white text-sm font-medium rounded-none transition-colors disabled:bg-white/[0.05] disabled:text-[var(--text-muted)] ${
              mode === 'deposit'
                ? 'bg-[var(--long)] hover:bg-[var(--long)]/80 text-[var(--bg)]'
                : 'bg-[var(--short)] hover:bg-[var(--short)]/80'
            }`}
          >
            {loading
              ? 'Processing...'
              : mode === 'deposit'
                ? 'Provide Insurance'
                : 'Withdraw Insurance'
            }
          </button>
        </>
      )}

      {/* Status */}
      {(txStatus || error) && (
        <p className={`text-xs mt-2 ${
          (txStatus || error || '').includes('Error') ? 'text-[var(--short)]' : 'text-[var(--long)]'
        }`}>
          {txStatus || error}
        </p>
      )}
    </div>
  );
}
