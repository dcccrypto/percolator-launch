"use client";
import { explorerTxUrl } from "@/lib/config";

import { FC, useState, useEffect, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useConnection } from "@solana/wallet-adapter-react";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useDeposit } from "@/hooks/useDeposit";
import { useWithdraw } from "@/hooks/useWithdraw";
import { useInitUser } from "@/hooks/useInitUser";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { parseHumanAmount } from "@/lib/parseAmount";
import { formatTokenAmount } from "@/lib/format";

export const DepositWithdrawCard: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const { connected, publicKey } = useWallet();
  const { connection } = useConnection();
  const userAccount = useUserAccount();
  const { deposit, loading: depositLoading, error: depositError } = useDeposit(slabAddress);
  const { withdraw, loading: withdrawLoading, error: withdrawError } = useWithdraw(slabAddress);
  const { initUser, loading: initLoading, error: initError } = useInitUser(slabAddress);
  const { config: mktConfig } = useSlabState();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const symbol = tokenMeta?.symbol ?? "Token";

  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [walletBalance, setWalletBalance] = useState<bigint | null>(null);
  // Track raw BigInt when MAX is used — avoids format→parse round-trip precision issues
  const maxRawRef = useRef<bigint | null>(null);
  // On-chain decimals from getTokenAccountBalance — ground truth, avoids tokenMeta race
  const [onChainDecimals, setOnChainDecimals] = useState<number | null>(null);
  const decimals = onChainDecimals ?? tokenMeta?.decimals ?? 6;
  useEffect(() => {
    if (!publicKey || !mktConfig?.collateralMint) { setWalletBalance(null); setOnChainDecimals(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const ata = getAssociatedTokenAddressSync(mktConfig.collateralMint, publicKey);
        const info = await connection.getTokenAccountBalance(ata);
        if (!cancelled && info.value.amount) {
          setWalletBalance(BigInt(info.value.amount));
          if (info.value.decimals !== undefined) {
            setOnChainDecimals(info.value.decimals);
          }
        }
      } catch { if (!cancelled) { setWalletBalance(null); setOnChainDecimals(null); } }
    })();
    return () => { cancelled = true; };
  }, [publicKey, mktConfig?.collateralMint, connection, lastSig]);

  if (!connected) {
    return (
      <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-5">
        <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-[var(--text-secondary)]">Deposit / Withdraw</h3>
        <p className="text-sm text-[var(--text-muted)]">Connect wallet</p>
      </div>
    );
  }

  if (!userAccount) {
    const hasTokens = walletBalance !== null && walletBalance > 0n;
    const suggestedDeposit = walletBalance !== null && walletBalance > 0n
      ? walletBalance > 10_000_000n ? 10_000_000n : walletBalance
      : 0n;
    return (
      <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-5">
        <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-[var(--text-secondary)]">Create Account</h3>
        {walletBalance !== null && (
          <p className="mb-2 text-xs text-[var(--text-muted)]">
            Wallet: {formatTokenAmount(walletBalance, decimals)} {symbol}
          </p>
        )}
        {!hasTokens && (
          <div className="mb-3 border border-[var(--warning)]/20 bg-[var(--warning)]/[0.04] p-3">
            <p className="text-[11px] text-[var(--warning)]">
              You need {symbol} tokens to trade this market.{" "}
              {mktConfig?.collateralMint && (
                <a href="/devnet-mint" className="underline underline-offset-2 hover:text-[var(--warning)]/80">
                  Mint some from the faucet →
                </a>
              )}
            </p>
          </div>
        )}
        {hasTokens ? (
          <>
            <p className="mb-3 text-xs text-[var(--text-secondary)]">
              Create an account with an initial deposit to start trading.
            </p>
            <button
              onClick={async () => { try { const sig = await initUser(suggestedDeposit); setLastSig(sig ?? null); } catch {} }}
              disabled={initLoading}
              className="w-full rounded-sm bg-[var(--accent)] py-2.5 text-sm font-medium text-white hover:bg-[var(--accent-muted)] hover:scale-[1.01] active:scale-[0.99] transition-transform disabled:opacity-50"
            >
              {initLoading ? "Creating..." : `Create Account (deposit ${formatTokenAmount(suggestedDeposit, decimals)} ${symbol})`}
            </button>
          </>
        ) : (
          <>
            <p className="mb-3 text-xs text-[var(--text-secondary)]">
              Get tokens first, then create your account.
            </p>
            <button
              disabled
              className="w-full rounded-sm bg-[var(--bg-surface)] py-2.5 text-sm font-medium text-[var(--text-muted)] cursor-not-allowed opacity-50"
            >
              Create Account
            </button>
          </>
        )}
        {initError && <p className="mt-2 text-xs text-[var(--short)]">{initError}</p>}
        {lastSig && <p className="mt-2 text-xs text-[var(--text-muted)]">Tx: {lastSig.slice(0, 12)}...</p>}
      </div>
    );
  }

  const capital = userAccount.account.capital;
  const positionSize = userAccount.account.positionSize ?? 0n;
  const loading = mode === "deposit" ? depositLoading : withdrawLoading;
  const error = mode === "deposit" ? depositError : withdrawError;

  // Validation — use raw BigInt when MAX was clicked to avoid format→parse precision issues
  const parsedAmount = maxRawRef.current ?? (amount ? parseHumanAmount(amount, decimals) : 0n);
  const isOverWithdraw = mode === "withdraw" && parsedAmount > 0n && parsedAmount > capital;
  const isOverDeposit = mode === "deposit" && parsedAmount > 0n && walletBalance !== null && parsedAmount > walletBalance;
  const validationError = isOverWithdraw
    ? "Insufficient capital"
    : isOverDeposit
    ? "Insufficient wallet balance"
    : null;
  const hasOpenPosition = positionSize !== 0n;

  async function handleSubmit() {
    if (!amount || !userAccount || validationError) return;
    try {
      // Use raw BigInt directly when MAX was clicked
      const amtNative = maxRawRef.current ?? parseHumanAmount(amount, decimals);
      if (amtNative <= 0n) return;
      let sig: string | undefined;
      if (mode === "deposit") {
        sig = await deposit({ userIdx: userAccount.idx, amount: amtNative });
      } else {
        sig = await withdraw({ userIdx: userAccount.idx, amount: amtNative });
      }
      setLastSig(sig ?? null);
      setAmount("");
    } catch {}
  }

  return (
    <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-5">
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wider text-[var(--text-secondary)]">Deposit / Withdraw</h3>
      <p className="mb-1 text-lg font-bold text-[var(--text)]">{formatTokenAmount(capital, decimals)} <span className="text-sm font-normal text-[var(--text-secondary)]">{symbol}</span></p>
      {walletBalance !== null && (
        <p className="mb-3 text-xs text-[var(--text-muted)]">Wallet: {formatTokenAmount(walletBalance, decimals)} {symbol}</p>
      )}

      <div className="mb-3 flex gap-1.5">
        <button onClick={() => setMode("deposit")} className={`flex-1 rounded-sm py-1.5 text-xs font-medium ${mode === "deposit" ? "bg-[var(--long)] text-white shadow-sm" : "bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:bg-[var(--border)]"}`}>Deposit</button>
        <button onClick={() => setMode("withdraw")} className={`flex-1 rounded-sm py-1.5 text-xs font-medium ${mode === "withdraw" ? "bg-[var(--warning)] text-white shadow-sm" : "bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:bg-[var(--border)]"}`}>Withdraw</button>
      </div>

      <div className="mb-3">
        <div className="relative">
          <input
            type="text"
            value={amount}
            onChange={(e) => { maxRawRef.current = null; setAmount(e.target.value.replace(/[^0-9.]/g, "")); }}
            placeholder={`Amount (${symbol})`}
            className="w-full rounded-sm border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2 pr-14 text-sm text-[var(--text)] placeholder-[var(--text-muted)] focus:border-[var(--accent)]/40 focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20"
          />
          {mode === "withdraw" && capital > 0n && (
            <button
              type="button"
              onClick={() => { maxRawRef.current = capital; setAmount(formatTokenAmount(capital, decimals)); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--accent)] hover:bg-[var(--accent)]/10"
            >
              Max
            </button>
          )}
          {mode === "deposit" && walletBalance !== null && walletBalance > 0n && (
            <button
              type="button"
              onClick={() => { maxRawRef.current = walletBalance; setAmount(formatTokenAmount(walletBalance, decimals)); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--accent)] hover:bg-[var(--accent)]/10"
            >
              Max
            </button>
          )}
        </div>
        {validationError && (
          <p className="mt-1 text-[11px] text-[var(--short)]">{validationError}</p>
        )}
      </div>

      {mode === "withdraw" && hasOpenPosition && (
        <div className="mb-3 border border-[var(--warning)]/20 bg-[var(--warning)]/[0.04] p-2">
          <p className="text-[11px] text-[var(--warning)]">⚠ Warning: Withdrawing margin with an open position may trigger liquidation</p>
        </div>
      )}

      <button
        onClick={handleSubmit}
        disabled={loading || !amount || !!validationError}
        className="w-full rounded-sm bg-[var(--accent)] py-2.5 text-sm font-medium text-white hover:bg-[var(--accent-muted)] hover:scale-[1.01] active:scale-[0.99] transition-transform disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? "Sending..." : validationError ? validationError : mode === "deposit" ? "Deposit" : "Withdraw"}
      </button>

      {error && <p className="mt-2 text-xs text-[var(--short)]">{error}</p>}
      {lastSig && <p className="mt-2 text-xs text-[var(--text-muted)]">Tx: <a href={`${explorerTxUrl(lastSig)}`} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] hover:underline">{lastSig.slice(0, 12)}...</a></p>}
    </div>
  );
};
