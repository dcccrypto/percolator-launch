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
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockUserAccount } from "@/lib/mock-trade-data";

export const DepositWithdrawCard: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const { connected: walletConnected, publicKey } = useWallet();
  const { connection } = useConnection();
  const realUserAccount = useUserAccount();
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  const connected = walletConnected || mockMode;
  const userAccount = realUserAccount ?? (mockMode ? getMockUserAccount(slabAddress) : null);
  const { deposit, loading: depositLoading, error: depositError } = useDeposit(slabAddress);
  const { withdraw, loading: withdrawLoading, error: withdrawError } = useWithdraw(slabAddress);
  const { initUser, loading: initLoading, error: initError } = useInitUser(slabAddress);
  const { config: mktConfig } = useSlabState();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const symbol = tokenMeta?.symbol ?? "Token";

  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [walletBalance, setWalletBalance] = useState<bigint | null>(mockMode ? 500_000_000n : null);
  const maxRawRef = useRef<bigint | null>(null);
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
      <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <p className="text-[11px] text-[var(--text-muted)]">Connect wallet</p>
      </div>
    );
  }

  if (!userAccount) {
    const hasTokens = walletBalance !== null && walletBalance > 0n;
    const suggestedDeposit = walletBalance !== null && walletBalance > 0n
      ? walletBalance > 10_000_000n ? 10_000_000n : walletBalance
      : 0n;
    return (
      <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <p className="mb-1 text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Create Account</p>
        {walletBalance !== null && (
          <p className="mb-2 text-[10px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>
            Wallet: {formatTokenAmount(walletBalance, decimals)} {symbol}
          </p>
        )}
        {!hasTokens && (
          <div className="mb-2 border border-[var(--warning)]/20 bg-[var(--warning)]/[0.04] p-2">
            <p className="text-[10px] text-[var(--warning)]">
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
            <p className="mb-2 text-[10px] text-[var(--text-secondary)]">
              Create an account with an initial deposit to start trading.
            </p>
            <button
              onClick={async () => { 
                try { 
                  const sig = await initUser(suggestedDeposit); 
                  setLastSig(sig ?? null); 
                } catch (err) {
                  if (process.env.NODE_ENV === 'development') {
                    console.error('initUser failed:', err);
                  }
                }
              }}
              disabled={initLoading}
              className="w-full rounded-none bg-[var(--accent)] py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-white hover:bg-[var(--accent-muted)] hover:scale-[1.01] active:scale-[0.99] transition-transform disabled:opacity-50"
            >
              {initLoading ? "Creating..." : `Create Account (deposit ${formatTokenAmount(suggestedDeposit, decimals)} ${symbol})`}
            </button>
          </>
        ) : (
          <>
            <p className="mb-2 text-[10px] text-[var(--text-secondary)]">
              Get tokens first, then create your account.
            </p>
            <button
              disabled
              className="w-full rounded-none bg-[var(--bg-surface)] py-2 text-[10px] font-medium text-[var(--text-muted)] cursor-not-allowed opacity-50"
            >
              Create Account
            </button>
          </>
        )}
        {initError && <p className="mt-2 text-[10px] text-[var(--short)]">{initError}</p>}
        {lastSig && <p className="mt-2 text-[10px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>Tx: {lastSig.slice(0, 12)}...</p>}
      </div>
    );
  }

  const capital = userAccount.account.capital;
  const positionSize = userAccount.account.positionSize ?? 0n;
  const loading = mode === "deposit" ? depositLoading : withdrawLoading;
  const error = mode === "deposit" ? depositError : withdrawError;

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
    if (mockMode) { setAmount(""); return; }
    try {
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
    } catch (err) {
      if (process.env.NODE_ENV === 'development') {
        console.error(`${mode} failed:`, err);
      }
      // Error state is already handled by deposit/withdraw hooks
    }
  }

  return (
    <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
      {/* Onboarding hint for new users */}
      {capital === 0n && !mockMode && (
        <div className="mb-3 border-b border-[var(--border)]/30 pb-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--accent)] mb-1">Getting Started</p>
          <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
            Deposit collateral to start trading. Your collateral is the token you&apos;ll use as margin for leveraged positions.
          </p>
        </div>
      )}

      {/* Balance overview */}
      <div className="mb-3 grid grid-cols-2 gap-px border border-[var(--border)]/20">
        <div className="p-2">
          <p className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Account Balance</p>
          <p className="text-sm font-medium text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{formatTokenAmount(capital, decimals)} <span className="text-[10px] font-normal text-[var(--text-secondary)]">{symbol}</span></p>
        </div>
        <div className="p-2 border-l border-[var(--border)]/20">
          <p className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Wallet Balance</p>
          <p className="text-sm font-medium text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{walletBalance !== null ? formatTokenAmount(walletBalance, decimals) : "—"} <span className="text-[10px] font-normal text-[var(--text-secondary)]">{symbol}</span></p>
        </div>
      </div>
      {mode === "deposit" && walletBalance !== null && walletBalance === 0n && mktConfig?.collateralMint && (
        <div className="mb-2 border border-[var(--warning)]/20 bg-[var(--warning)]/[0.04] p-2">
          <p className="text-[10px] text-[var(--warning)]">
            Wallet has 0 {symbol}. You may have a different token with the same name.{" "}
            <a href={`/devnet-mint`} className="underline underline-offset-2 hover:text-[var(--warning)]/80">
              Mint more →
            </a>
          </p>
          <p className="mt-1 text-[9px] text-[var(--text-dim)] break-all" style={{ fontFamily: "var(--font-mono)" }}>
            Mint: {mktConfig.collateralMint.toBase58()}
          </p>
        </div>
      )}

      <div className="mb-2 flex gap-1">
        <button onClick={() => setMode("deposit")} className={`flex-1 rounded-none py-1.5 text-[10px] font-medium uppercase tracking-[0.1em] ${mode === "deposit" ? "bg-[var(--long)] text-white" : "border border-[var(--border)]/30 text-[var(--text-muted)] hover:text-[var(--text-secondary)]"}`}>Deposit</button>
        <button onClick={() => setMode("withdraw")} className={`flex-1 rounded-none py-1.5 text-[10px] font-medium uppercase tracking-[0.1em] ${mode === "withdraw" ? "bg-[var(--warning)] text-white" : "border border-[var(--border)]/30 text-[var(--text-muted)] hover:text-[var(--text-secondary)]"}`}>Withdraw</button>
      </div>

      <div className="mb-2">
        <div className="relative">
          <input
            type="text"
            value={amount}
            onChange={(e) => { 
              const newValue = e.target.value.replace(/[^0-9.]/g, "");
              if (newValue !== amount) {
                maxRawRef.current = null;
              }
              setAmount(newValue);
            }}
            placeholder={`Amount (${symbol})`}
            style={{ fontFamily: "var(--font-mono)" }}
            className="w-full rounded-none border border-[var(--border)]/50 bg-[var(--bg)] px-3 py-2 pr-14 text-sm text-[var(--text)] placeholder-[var(--text-muted)] focus:border-[var(--accent)]/40 focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20"
          />
          {mode === "withdraw" && capital > 0n && (
            <button
              type="button"
              onClick={() => { maxRawRef.current = capital; setAmount(formatTokenAmount(capital, decimals)); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-none px-2 py-0.5 text-[9px] font-semibold uppercase text-[var(--accent)] hover:bg-[var(--accent)]/10"
            >
              Max
            </button>
          )}
          {mode === "deposit" && walletBalance !== null && walletBalance > 0n && (
            <button
              type="button"
              onClick={() => { maxRawRef.current = walletBalance; setAmount(formatTokenAmount(walletBalance, decimals)); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-none px-2 py-0.5 text-[9px] font-semibold uppercase text-[var(--accent)] hover:bg-[var(--accent)]/10"
            >
              Max
            </button>
          )}
        </div>
        {validationError && (
          <p className="mt-1 text-[10px] text-[var(--short)]">{validationError}</p>
        )}
      </div>

      {mode === "withdraw" && hasOpenPosition && (
        <div className="mb-2 border border-[var(--warning)]/20 bg-[var(--warning)]/[0.04] p-2">
          <p className="text-[10px] text-[var(--warning)]">⚠ Withdrawing margin with an open position may trigger liquidation</p>
        </div>
      )}

      <button
        onClick={handleSubmit}
        disabled={loading || !amount || !!validationError}
        className={`w-full rounded-none py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-white hover:scale-[1.01] active:scale-[0.99] transition-transform disabled:cursor-not-allowed disabled:opacity-50 ${mode === "deposit" ? "bg-[var(--long)] hover:brightness-110" : "bg-[var(--warning)] hover:brightness-110"}`}
      >
        {loading ? "Sending..." : validationError ? validationError : mode === "deposit" ? `Deposit ${symbol}` : `Withdraw ${symbol}`}
      </button>

      {error && <p className="mt-2 text-[10px] text-[var(--short)]">{error}</p>}
      {lastSig && <p className="mt-2 text-[10px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>Tx: <a href={`${explorerTxUrl(lastSig)}`} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] hover:underline">{lastSig.slice(0, 12)}...</a></p>}
    </div>
  );
};
