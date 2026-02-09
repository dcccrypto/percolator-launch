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
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-lg">🛡️</span>
        <h3 className="text-sm font-semibold text-zinc-200">Insurance Pool</h3>
        {state.mintExists && (
          <span className="ml-auto text-[10px] px-1.5 py-0.5 bg-emerald-500/10 text-emerald-400 rounded border border-emerald-500/20">
            LIVE
          </span>
        )}
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div>
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Pool Size</p>
          <p className="text-sm font-mono text-zinc-200">{formatSol(state.insuranceBalance)} SOL</p>
        </div>
        <div>
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider">LP Supply</p>
          <p className="text-sm font-mono text-zinc-200">{formatSol(state.lpSupply)}</p>
        </div>
        <div>
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Rate</p>
          <p className="text-sm font-mono text-zinc-200">{formatRate(state.redemptionRateE6)} SOL/LP</p>
        </div>
        <div>
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Your Share</p>
          <p className="text-sm font-mono text-zinc-200">
            {state.userSharePct > 0 ? `${state.userSharePct.toFixed(1)}%` : '—'}
          </p>
        </div>
      </div>

      {/* User Position */}
      {state.userLpBalance > 0n && (
        <div className="bg-zinc-800/50 rounded p-3 mb-4 border border-zinc-700/50">
          <div className="flex justify-between items-center">
            <div>
              <p className="text-[10px] text-zinc-500 uppercase">Your LP Tokens</p>
              <p className="text-sm font-mono text-zinc-200">{formatSol(state.userLpBalance)}</p>
            </div>
            <div className="text-right">
              <p className="text-[10px] text-zinc-500 uppercase">Redeemable</p>
              <p className="text-sm font-mono text-emerald-400">{formatSol(state.userRedeemableValue)} SOL</p>
            </div>
          </div>
        </div>
      )}

      {/* Admin: Create Mint */}
      {!state.mintExists && isAdmin && (
        <button
          onClick={handleCreateMint}
          disabled={loading}
          className="w-full py-2 px-4 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm font-medium rounded transition-colors mb-3"
        >
          {loading ? 'Creating...' : 'Create Insurance LP Mint'}
        </button>
      )}

      {/* Not created yet */}
      {!state.mintExists && !isAdmin && (
        <p className="text-xs text-zinc-500 text-center py-2">
          Insurance LP not yet enabled for this market
        </p>
      )}

      {/* Deposit / Withdraw */}
      {state.mintExists && publicKey && (
        <>
          {/* Tab Switcher */}
          <div className="flex gap-1 mb-3 bg-zinc-800 rounded p-0.5">
            <button
              onClick={() => { setMode('deposit'); setAmount(''); }}
              className={`flex-1 py-1.5 text-xs font-medium rounded transition-colors ${
                mode === 'deposit'
                  ? 'bg-emerald-600 text-white'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Deposit
            </button>
            <button
              onClick={() => { setMode('withdraw'); setAmount(''); }}
              className={`flex-1 py-1.5 text-xs font-medium rounded transition-colors ${
                mode === 'withdraw'
                  ? 'bg-red-600 text-white'
                  : 'text-zinc-400 hover:text-zinc-200'
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
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
              min="0"
              step="0.001"
            />
            {mode === 'withdraw' && state.userLpBalance > 0n && (
              <button
                onClick={() => setAmount((Number(state.userLpBalance) / 1e9).toString())}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-indigo-400 hover:text-indigo-300"
              >
                MAX
              </button>
            )}
          </div>

          {/* Preview */}
          {previewTokens !== null && mode === 'deposit' && (
            <p className="text-xs text-zinc-500 mb-3">
              You receive: <span className="text-zinc-300 font-mono">~{formatSol(previewTokens)}</span> LP tokens
            </p>
          )}
          {previewCollateral !== null && mode === 'withdraw' && (
            <p className="text-xs text-zinc-500 mb-3">
              You receive: <span className="text-zinc-300 font-mono">~{formatSol(previewCollateral)}</span> SOL
            </p>
          )}

          {/* Action Button */}
          <button
            onClick={mode === 'deposit' ? handleDeposit : handleWithdraw}
            disabled={loading || !amount || parseFloat(amount) <= 0}
            className={`w-full py-2 px-4 text-white text-sm font-medium rounded transition-colors disabled:bg-zinc-700 disabled:text-zinc-500 ${
              mode === 'deposit'
                ? 'bg-emerald-600 hover:bg-emerald-500'
                : 'bg-red-600 hover:bg-red-500'
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
          (txStatus || error || '').includes('Error') ? 'text-red-400' : 'text-emerald-400'
        }`}>
          {txStatus || error}
        </p>
      )}
    </div>
  );
}
