"use client";

import { FC, useState, useEffect, useMemo } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { formatHumanAmount } from "@/lib/parseAmount";
import { isValidBase58Pubkey } from "@/lib/createWizardUtils";

interface StepTokenSelectProps {
  mintAddress: string;
  onMintChange: (mint: string) => void;
  onTokenResolved: (meta: { name: string; symbol: string; decimals: number } | null) => void;
  onBalanceChange: (balance: bigint | null) => void;
  onDexPoolDetected?: (pool: { priceUsd: number; pairLabel: string } | null) => void;
  onContinue: () => void;
  canContinue: boolean;
}

/**
 * Step 1 — Token Mint Input + Auto-resolve card.
 * Validates the mint, fetches metadata, shows a resolved card.
 */
export const StepTokenSelect: FC<StepTokenSelectProps> = ({
  mintAddress,
  onMintChange,
  onTokenResolved,
  onBalanceChange,
  onContinue,
  canContinue,
}) => {
  const { publicKey } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const [inputValue, setInputValue] = useState(mintAddress);
  const [debounced, setDebounced] = useState(mintAddress);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);

  // Debounce mint input
  useEffect(() => {
    const timer = setTimeout(() => {
      const trimmed = inputValue.trim();
      setDebounced(trimmed);
      onMintChange(trimmed);
    }, 400);
    return () => clearTimeout(timer);
  }, [inputValue, onMintChange]);

  const mintValid = isValidBase58Pubkey(debounced) && debounced.length >= 32;
  const mintPk = useMemo(
    () => (mintValid ? new PublicKey(debounced) : null),
    [debounced, mintValid]
  );
  const tokenMeta = useTokenMeta(mintPk);

  // Propagate token meta changes
  useEffect(() => {
    onTokenResolved(tokenMeta);
  }, [tokenMeta, onTokenResolved]);

  // Check wallet token balance
  useEffect(() => {
    if (!publicKey || !mintValid) {
      setBalance(null);
      onBalanceChange(null);
      return;
    }
    let cancelled = false;
    setBalanceLoading(true);
    (async () => {
      try {
        const pk = new PublicKey(debounced);
        const ata = await getAssociatedTokenAddress(pk, publicKey);
        const account = await getAccount(connection, ata);
        if (!cancelled) {
          setBalance(account.amount);
          onBalanceChange(account.amount);
        }
      } catch {
        if (!cancelled) {
          setBalance(0n);
          onBalanceChange(0n);
        }
      } finally {
        if (!cancelled) setBalanceLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, publicKey, debounced, mintValid, onBalanceChange]);

  const showInvalid = debounced.length > 0 && !mintValid;
  const showResolved = mintValid && tokenMeta;

  return (
    <div className="space-y-5">
      <div>
        <label
          htmlFor="token-mint"
          className="block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)] mb-2"
        >
          Token Mint Address
        </label>
        <input
          id="token-mint"
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onBlur={() => setInputValue(inputValue.trim())}
          placeholder="Paste mint address..."
          className={`w-full border px-3 py-3 text-[12px] font-mono transition-colors focus:outline-none ${
            showInvalid
              ? "border-[var(--short)]/40 bg-[var(--short)]/[0.04] text-[var(--text)] placeholder:text-[var(--text-dim)] focus:border-[var(--short)]/60"
              : "border-[var(--border)] bg-[var(--bg)] text-[var(--text)] placeholder:text-[var(--text-dim)] focus:border-[var(--accent)]/40"
          }`}
        />
        {showInvalid && (
          <p className="mt-1.5 text-[10px] text-[var(--short)]">Invalid mint address</p>
        )}
      </div>

      {/* Loading skeleton */}
      {mintValid && !tokenMeta && (
        <div className="border border-[var(--border)] bg-[var(--panel-bg)] p-4 animate-pulse">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 bg-[var(--border)]" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-24 bg-[var(--border)]" />
              <div className="h-2.5 w-48 bg-[var(--border)]" />
            </div>
          </div>
        </div>
      )}

      {/* Resolved token card */}
      {showResolved && (
        <div className="border border-[var(--accent)]/20 bg-[var(--accent)]/[0.03] p-4">
          <div className="flex items-center gap-3">
            {/* Token avatar */}
            <div className="flex h-8 w-8 items-center justify-center border border-[var(--accent)]/30 bg-[var(--accent)]/[0.08] text-[11px] font-bold text-[var(--accent)]">
              {tokenMeta.symbol.slice(0, 2).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold text-white">
                {tokenMeta.symbol}
                <span className="ml-2 text-[11px] font-normal text-[var(--text-secondary)]">
                  {tokenMeta.name}
                </span>
              </p>
              <p className="text-[10px] font-mono text-[var(--text-dim)] truncate">
                {debounced.slice(0, 6)}...{debounced.slice(-4)}
              </p>
            </div>
          </div>
          {tokenMeta.decimals > 12 && (
            <div className="mt-3 border border-[var(--short)]/30 bg-[var(--short)]/[0.04] px-3 py-2">
              <p className="text-[10px] text-[var(--short)] font-medium">
                ⚠ Decimals &gt; 12 risk integer overflow. Market creation blocked.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Balance */}
      {mintValid && !balanceLoading && balance !== null && tokenMeta && (
        <div className="text-[11px] font-mono text-[var(--text-dim)]">
          Wallet balance:{" "}
          <span className={balance > 0n ? "text-[var(--text)]" : "text-[var(--short)]"}>
            {formatHumanAmount(balance, tokenMeta.decimals)} {tokenMeta.symbol}
          </span>
        </div>
      )}
      {balanceLoading && mintValid && (
        <p className="text-[10px] text-[var(--text-dim)]">Checking wallet balance...</p>
      )}

      {/* Continue */}
      <button
        type="button"
        onClick={onContinue}
        disabled={!canContinue}
        className="w-full border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] py-3 text-[13px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-all duration-200 hud-btn-corners hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.15] disabled:cursor-not-allowed disabled:border-[var(--border)] disabled:bg-transparent disabled:text-[var(--text-dim)] disabled:opacity-50"
      >
        CONTINUE →
      </button>
    </div>
  );
};
