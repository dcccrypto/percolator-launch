'use client';

import { useState } from 'react';
import { useInsuranceLP } from '../../hooks/useInsuranceLP';
import { useWallet } from '@solana/wallet-adapter-react';
import { useSlabState } from '../providers/SlabProvider';

function formatSol(lamports: bigint): string {
  const sol = Number(lamports) / 1e9;
  if (sol === 0) return '0';
  if (sol < 0.001) return '<0.001';
  return sol.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatRate(rateE6: bigint): string {
  const rate = Number(rateE6) / 1e6;
  return rate.toFixed(4);
}

export function InsuranceLPPanel() {
  const { publicKey } = useWallet();
  const slabState = useSlabState();
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
      const lamports = BigInt(Math.floor(parseFloat(amount) * 1e9));
      await deposit(lamports);
      setTxStatus('Deposit successful!');
      setAmount('');
      setTimeout(() => setTxStatus(null), 3000);
    } catch (err: any) {
      setTxStatus(`Error: ${err.message}`);
    }
  };

  const handleWithdraw = async () => {
    if (!amount) return;
    setTxStatus('Withdrawing...');
    try {
      const lpTokens = BigInt(Math.floor(parseFloat(amount) * 1e9));
      await withdraw(lpTokens);
      setTxStatus('Withdrawal successful!');
      setAmount('');
      setTimeout(() => setTxStatus(null), 3000);
    } catch (err: any) {
      setTxStatus(`Error: ${err.message}`);
    }
  };

  const handleCreateMint = async () => {
    setTxStatus('Creating insurance LP mint...');
    try {
      await createMint();
      setTxStatus('Insurance LP mint created!');
      setTimeout(() => setTxStatus(null), 3000);
    } catch (err: any) {
      setTxStatus(`Error: ${err.message}`);
    }
  };

  // Preview calculation
  const previewTokens = (() => {
    if (!amount || mode !== 'deposit') return null;
    const lamports = BigInt(Math.floor(parseFloat(amount) * 1e9));
    if (lamports <= 0n) return null;
    if (state.lpSupply === 0n) return lamports; // 1:1
    if (state.insuranceBalance === 0n) return null;
    return (lamports * state.lpSupply) / state.insuranceBalance;
  })();

  const previewCollateral = (() => {
    if (!amount || mode !== 'withdraw') return null;
    const lpTokens = BigInt(Math.floor(parseFloat(amount) * 1e9));
    if (lpTokens <= 0n) return null;
    if (state.lpSupply === 0n) return null;
    return (lpTokens * state.insuranceBalance) / state.lpSupply;
  })();

  return (
    <div className="bg-[var(--panel-bg)] border border-[var(--border)] rounded-sm p-4">
      <div className="flex items-center gap-2 mb-4">
        <h3 className="text-sm font-semibold text-[var(--text)]">Insurance Pool</h3>
        {state.mintExists && (
          <span className="ml-auto text-[10px] px-1.5 py-0.5 bg-[var(--long)]/10 text-[var(--long)] rounded-sm border border-[var(--long)]/20">
            LIVE
          </span>
        )}
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div>
          <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Pool Size</p>
          <p className="text-sm font-mono text-[var(--text)]">{formatSol(state.insuranceBalance)} SOL</p>
        </div>
        <div>
          <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">LP Supply</p>
          <p className="text-sm font-mono text-[var(--text)]">{formatSol(state.lpSupply)}</p>
        </div>
        <div>
          <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Rate</p>
          <p className="text-sm font-mono text-[var(--text)]">{formatRate(state.redemptionRateE6)} SOL/LP</p>
        </div>
        <div>
          <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Your Share</p>
          <p className="text-sm font-mono text-[var(--text)]">
            {state.userSharePct > 0 ? `${state.userSharePct.toFixed(1)}%` : '\u2014'}
          </p>
        </div>
      </div>

      {/* User Position */}
      {state.userLpBalance > 0n && (
        <div className="bg-[var(--bg-surface)] rounded-sm p-3 mb-4 border border-[var(--border)]">
          <div className="flex justify-between items-center">
            <div>
              <p className="text-[10px] text-[var(--text-muted)] uppercase">Your LP Tokens</p>
              <p className="text-sm font-mono text-[var(--text)]">{formatSol(state.userLpBalance)}</p>
            </div>
            <div className="text-right">
              <p className="text-[10px] text-[var(--text-muted)] uppercase">Redeemable</p>
              <p className="text-sm font-mono text-[var(--long)]">{formatSol(state.userRedeemableValue)} SOL</p>
            </div>
          </div>
        </div>
      )}

      {/* Admin: Create Mint */}
      {!state.mintExists && isAdmin && (
        <button
          onClick={handleCreateMint}
          disabled={loading}
          className="w-full py-2 px-4 bg-[var(--accent)] hover:bg-[var(--accent-muted)] disabled:bg-[var(--bg-surface)] disabled:text-[var(--text-muted)] text-white text-sm font-medium rounded-sm transition-colors hud-btn-corners hover:scale-[1.01] active:scale-[0.99] transition-transform mb-3"
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
          <div className="flex gap-1 mb-3 bg-[var(--bg-surface)] rounded-sm p-0.5">
            <button
              onClick={() => { setMode('deposit'); setAmount(''); }}
              className={`flex-1 py-1.5 text-xs font-medium rounded-sm transition-colors ${
                mode === 'deposit'
                  ? 'bg-[var(--accent)] text-white shadow-sm'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text)]'
              }`}
            >
              Deposit
            </button>
            <button
              onClick={() => { setMode('withdraw'); setAmount(''); }}
              className={`flex-1 py-1.5 text-xs font-medium rounded-sm transition-colors ${
                mode === 'withdraw'
                  ? 'bg-[var(--short)] text-white shadow-sm'
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
              placeholder={mode === 'deposit' ? 'Amount (SOL)' : 'LP tokens'}
              className="w-full bg-[var(--bg-surface)] border border-[var(--border)] rounded-sm px-3 py-2 text-sm text-[var(--text)] font-mono placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]/40"
              min="0"
              step="0.001"
            />
            {mode === 'withdraw' && state.userLpBalance > 0n && (
              <button
                onClick={() => setAmount((Number(state.userLpBalance) / 1e9).toString())}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-[var(--accent)] hover:text-[var(--accent-muted)]"
              >
                MAX
              </button>
            )}
          </div>

          {/* Preview */}
          {previewTokens !== null && mode === 'deposit' && (
            <p className="text-xs text-[var(--text-muted)] mb-3">
              You receive: <span className="text-[var(--text-secondary)] font-mono">~{formatSol(previewTokens)}</span> LP tokens
            </p>
          )}
          {previewCollateral !== null && mode === 'withdraw' && (
            <p className="text-xs text-[var(--text-muted)] mb-3">
              You receive: <span className="text-[var(--text-secondary)] font-mono">~{formatSol(previewCollateral)}</span> SOL
            </p>
          )}

          {/* Action Button */}
          <button
            onClick={mode === 'deposit' ? handleDeposit : handleWithdraw}
            disabled={loading || !amount || parseFloat(amount) <= 0}
            className={`w-full py-2 px-4 text-white text-sm font-medium rounded-sm transition-colors hud-btn-corners hover:scale-[1.01] active:scale-[0.99] transition-transform disabled:bg-[var(--bg-surface)] disabled:text-[var(--text-muted)] ${
              mode === 'deposit'
                ? 'bg-[var(--accent)] hover:bg-[var(--accent-muted)] text-white'
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
