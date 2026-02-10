'use client';

import { useState } from 'react';
import { useInsuranceLP } from '../../hooks/useInsuranceLP';
import { useWallet } from '@solana/wallet-adapter-react';
import { useSlabState } from '../providers/SlabProvider';
import { useTokenMeta } from '../../hooks/useTokenMeta';

function formatCollateral(lamports: bigint, decimals: number = 9): string {
  const amount = Number(lamports) / 10 ** decimals;
  if (amount === 0) return '0';
  if (amount < 0.001) return '<0.001';
  return amount.toLocaleString(undefined, { maximumFractionDigits: 4 });
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
  const tokenDecimals = tokenMeta?.decimals ?? 9;
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
      const lamports = BigInt(Math.floor(parseFloat(amount) * 10 ** tokenDecimals));
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
      const lpTokens = BigInt(Math.floor(parseFloat(amount) * 10 ** tokenDecimals));
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
    const lamports = BigInt(Math.floor(parseFloat(amount) * 10 ** tokenDecimals));
    if (lamports <= 0n) return null;
    if (state.lpSupply === 0n) return lamports; // 1:1
    if (state.insuranceBalance === 0n) return null;
    return (lamports * state.lpSupply) / state.insuranceBalance;
  })();

  const previewCollateral = (() => {
    if (!amount || mode !== 'withdraw') return null;
    const lpTokens = BigInt(Math.floor(parseFloat(amount) * 10 ** tokenDecimals));
    if (lpTokens <= 0n) return null;
    if (state.lpSupply === 0n) return null;
    return (lpTokens * state.insuranceBalance) / state.lpSupply;
  })();

  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-4">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-lg">🛡️</span>
        <h3 className="text-sm font-semibold text-[#F0F4FF]">Insurance Pool</h3>
        {state.mintExists && (
          <span className="ml-auto text-[10px] px-1.5 py-0.5 bg-[#00FFB2]/10 text-[#00FFB2] rounded border border-[#00FFB2]/20">
            LIVE
          </span>
        )}
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div>
          <p className="text-[10px] text-[#5a6382] uppercase tracking-wider">Pool Size</p>
          <p className="text-sm font-mono text-[#F0F4FF]">{formatCollateral(state.insuranceBalance, tokenDecimals)} {tokenSymbol}</p>
        </div>
        <div>
          <p className="text-[10px] text-[#5a6382] uppercase tracking-wider">LP Supply</p>
          <p className="text-sm font-mono text-[#F0F4FF]">{formatCollateral(state.lpSupply, tokenDecimals)}</p>
        </div>
        <div>
          <p className="text-[10px] text-[#5a6382] uppercase tracking-wider">Rate</p>
          <p className="text-sm font-mono text-[#F0F4FF]">{formatRate(state.redemptionRateE6)} {tokenSymbol}/LP</p>
        </div>
        <div>
          <p className="text-[10px] text-[#5a6382] uppercase tracking-wider">Your Share</p>
          <p className="text-sm font-mono text-[#F0F4FF]">
            {state.userSharePct > 0 ? `${state.userSharePct.toFixed(1)}%` : '—'}
          </p>
        </div>
      </div>

      {/* User Position */}
      {state.userLpBalance > 0n && (
        <div className="bg-white/[0.05] rounded p-3 mb-4 border border-white/[0.08]">
          <div className="flex justify-between items-center">
            <div>
              <p className="text-[10px] text-[#5a6382] uppercase">Your LP Tokens</p>
              <p className="text-sm font-mono text-[#F0F4FF]">{formatCollateral(state.userLpBalance, tokenDecimals)}</p>
            </div>
            <div className="text-right">
              <p className="text-[10px] text-[#5a6382] uppercase">Redeemable</p>
              <p className="text-sm font-mono text-[#00FFB2]">{formatCollateral(state.userRedeemableValue, tokenDecimals)} {tokenSymbol}</p>
            </div>
          </div>
        </div>
      )}

      {/* Admin: Create Mint */}
      {!state.mintExists && isAdmin && (
        <button
          onClick={handleCreateMint}
          disabled={loading}
          className="w-full py-2 px-4 bg-[#00FFB2] hover:bg-[#00FFB2]/80 disabled:bg-white/[0.05] disabled:text-[#5a6382] text-[#06080d] text-sm font-medium rounded transition-colors mb-3"
        >
          {loading ? 'Creating...' : 'Create Insurance LP Mint'}
        </button>
      )}

      {/* Not created yet */}
      {!state.mintExists && !isAdmin && (
        <p className="text-xs text-[#5a6382] text-center py-2">
          Insurance LP not yet enabled for this market
        </p>
      )}

      {/* Deposit / Withdraw */}
      {state.mintExists && publicKey && (
        <>
          {/* Tab Switcher */}
          <div className="flex gap-1 mb-3 bg-white/[0.05] rounded p-0.5">
            <button
              onClick={() => { setMode('deposit'); setAmount(''); }}
              className={`flex-1 py-1.5 text-xs font-medium rounded transition-colors ${
                mode === 'deposit'
                  ? 'bg-[#00FFB2] text-[#06080d]'
                  : 'text-[#8B95B0] hover:text-[#F0F4FF]'
              }`}
            >
              Deposit
            </button>
            <button
              onClick={() => { setMode('withdraw'); setAmount(''); }}
              className={`flex-1 py-1.5 text-xs font-medium rounded transition-colors ${
                mode === 'withdraw'
                  ? 'bg-[#FF4466] text-white'
                  : 'text-[#8B95B0] hover:text-[#F0F4FF]'
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
              className="w-full bg-white/[0.05] border border-white/[0.08] rounded px-3 py-2 text-sm text-[#F0F4FF] font-mono placeholder:text-[#3D4563] focus:outline-none focus:border-white/[0.12]"
              min="0"
              step="0.001"
            />
            {mode === 'withdraw' && state.userLpBalance > 0n && (
              <button
                onClick={() => setAmount(((Number(state.userLpBalance) / 10 ** tokenDecimals)).toString())}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-[#00FFB2] hover:text-[#00FFB2]/80"
              >
                MAX
              </button>
            )}
          </div>

          {/* Preview */}
          {previewTokens !== null && mode === 'deposit' && (
            <p className="text-xs text-[#5a6382] mb-3">
              You receive: <span className="text-[#c4cbde] font-mono">~{formatCollateral(previewTokens, tokenDecimals)}</span> LP tokens
            </p>
          )}
          {previewCollateral !== null && mode === 'withdraw' && (
            <p className="text-xs text-[#5a6382] mb-3">
              You receive: <span className="text-[#c4cbde] font-mono">~{formatCollateral(previewCollateral, tokenDecimals)}</span> {tokenSymbol}
            </p>
          )}

          {/* Action Button */}
          <button
            onClick={mode === 'deposit' ? handleDeposit : handleWithdraw}
            disabled={loading || !amount || parseFloat(amount) <= 0}
            className={`w-full py-2 px-4 text-white text-sm font-medium rounded transition-colors disabled:bg-white/[0.05] disabled:text-[#5a6382] ${
              mode === 'deposit'
                ? 'bg-[#00FFB2] hover:bg-[#00FFB2]/80 text-[#06080d]'
                : 'bg-[#FF4466] hover:bg-[#FF4466]/80'
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
          (txStatus || error || '').includes('Error') ? 'text-[#FF4466]' : 'text-[#00FFB2]'
        }`}>
          {txStatus || error}
        </p>
      )}
    </div>
  );
}
