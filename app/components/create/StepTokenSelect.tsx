"use client";

import { FC, useState, useEffect, useMemo } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { formatHumanAmount } from "@/lib/parseAmount";
import { isValidBase58Pubkey } from "@/lib/createWizardUtils";
import { getNetwork } from "@/lib/config";

type MintNetworkStatus = "idle" | "loading" | "valid" | "invalid" | "mirroring" | "mirror-failed";

interface StepTokenSelectProps {
  mintAddress: string;
  onMintChange: (mint: string) => void;
  onTokenResolved: (meta: { name: string; symbol: string; decimals: number } | null) => void;
  onBalanceChange: (balance: bigint | null) => void;
  onDexPoolDetected?: (pool: { priceUsd: number; pairLabel: string } | null) => void;
  onMintNetworkValidChange?: (valid: boolean) => void;
  /** Called when a devnet mirror mint is created/found for a mainnet CA */
  onDevnetMintResolved?: (devnetMint: string, meta?: { name: string; symbol: string; decimals: number }) => void;
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
  onMintNetworkValidChange,
  onDevnetMintResolved,
  onContinue,
  canContinue,
}) => {
  const { publicKey } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const [inputValue, setInputValue] = useState(mintAddress);
  const [debounced, setDebounced] = useState(mintAddress);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [mintNetworkStatus, setMintNetworkStatus] = useState<MintNetworkStatus>("idle");
  const [mirrorError, setMirrorError] = useState<string | null>(null);
  const [mirrorMeta, setMirrorMeta] = useState<{ name: string; symbol: string; decimals: number } | null>(null);
  const isDevnet = getNetwork() === "devnet";

  // Debounce mint input
  useEffect(() => {
    const timer = setTimeout(() => {
      const trimmed = inputValue.trim();
      setDebounced(trimmed);
      onMintChange(trimmed);
    }, 400);
    return () => clearTimeout(timer);
  }, [inputValue, onMintChange]);

  const mintIsUrl =
    debounced.startsWith("http://") ||
    debounced.startsWith("https://") ||
    debounced.includes("://");
  const mintValid = !mintIsUrl && isValidBase58Pubkey(debounced) && debounced.length >= 32;
  const mintPk = useMemo(
    () => (mintValid ? new PublicKey(debounced) : null),
    [debounced, mintValid]
  );
  const tokenMeta = useTokenMeta(mintPk);

  // On-chain mint existence validation — ensures the CA exists on the current network.
  // On devnet: if mint doesn't exist, auto-mirror the mainnet CA to devnet.
  useEffect(() => {
    if (!mintPk) {
      setMintNetworkStatus("idle");
      setMirrorError(null);
      onMintNetworkValidChange?.(false);
      return;
    }
    // Devnet: accept any valid pubkey — mirror endpoint handles devnet mint creation
    if (isDevnet) {
      setMintNetworkStatus("valid");
      onMintNetworkValidChange?.(true);
      return;
    }
    let cancelled = false;
    setMintNetworkStatus("loading");
    setMirrorError(null);
    setMirrorMeta(null);
    (async () => {
      try {
        const accountInfo = await connection.getAccountInfo(mintPk);
        if (cancelled) return;
        if (accountInfo) {
          // Account exists — verify it's a Token program mint
          const ownerKey = accountInfo.owner.toBase58();
          const isTokenMint =
            ownerKey === TOKEN_PROGRAM_ID.toBase58() ||
            ownerKey === TOKEN_2022_PROGRAM_ID.toBase58();
          if (!isTokenMint) {
            setMintNetworkStatus("invalid");
            onMintNetworkValidChange?.(false);
            return;
          }
          setMintNetworkStatus("valid");
          onMintNetworkValidChange?.(true);
          return;
        }

        // Account does not exist on this network
        if (!isDevnet) {
          // On mainnet, just block — no mirroring
          setMintNetworkStatus("invalid");
          onMintNetworkValidChange?.(false);
          return;
        }

        // DEVNET: Auto-mirror the mainnet CA
        setMintNetworkStatus("mirroring");
        const resp = await fetch("/api/devnet-mirror-mint", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mainnetCA: debounced }),
        });
        if (cancelled) return;
        const data = await resp.json();
        if (!resp.ok) {
          setMintNetworkStatus("mirror-failed");
          setMirrorError(data.error ?? `Mirror failed (HTTP ${resp.status})`);
          onMintNetworkValidChange?.(false);
          return;
        }

        // Mirror succeeded — notify parent with devnet mint + metadata
        const resolvedMirrorMeta = {
          name: data.name ?? `Token ${debounced.slice(0, 6)}`,
          symbol: data.symbol ?? debounced.slice(0, 4).toUpperCase(),
          decimals: data.decimals ?? 6,
        };
        setMirrorMeta(resolvedMirrorMeta);
        onDevnetMintResolved?.(data.devnetMint, resolvedMirrorMeta);
        // Also push metadata to parent (useTokenMeta won't find it on devnet)
        onTokenResolved(resolvedMirrorMeta);
        setMintNetworkStatus("valid");
        onMintNetworkValidChange?.(true);
      } catch {
        if (!cancelled) {
          setMintNetworkStatus("invalid");
          onMintNetworkValidChange?.(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [mintPk, connection, onMintNetworkValidChange, onDevnetMintResolved, isDevnet, debounced]);

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
  const effectiveMeta = tokenMeta ?? mirrorMeta;
  const showResolved = mintValid && effectiveMeta && mintNetworkStatus === "valid";
  // Block continue if mint doesn't exist on the current network or is still being checked
  const mintNetworkBlocked = mintValid && (mintNetworkStatus === "loading" || mintNetworkStatus === "invalid" || mintNetworkStatus === "mirroring" || mintNetworkStatus === "mirror-failed");
  const effectiveCanContinue = canContinue && !mintNetworkBlocked;

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
          <p className="mt-1.5 text-[10px] text-[var(--short)]">
            {mintIsUrl
              ? "Paste a valid Solana token address, not a URL"
              : "Invalid mint address — must be a base58 Solana token address"}
          </p>
        )}
        {/* Network-level mint validation feedback */}
        {mintValid && mintNetworkStatus === "loading" && (
          <p className="mt-1.5 text-[10px] text-[var(--text-dim)] animate-pulse">
            ⏳ Checking mint on network...
          </p>
        )}
        {mintValid && mintNetworkStatus === "mirroring" && (
          <p className="mt-1.5 text-[10px] text-[var(--accent)] animate-pulse">
            🪞 Mainnet token detected — creating devnet mirror...
          </p>
        )}
        {mintValid && mintNetworkStatus === "mirror-failed" && (
          <p className="mt-1.5 text-[10px] text-[var(--short)]">
            ✗ Failed to mirror mainnet token: {mirrorError ?? "Unknown error"}
          </p>
        )}
        {mintValid && mintNetworkStatus === "invalid" && (
          <p className="mt-1.5 text-[10px] text-[var(--short)]">
            ✗ Mint not found on this network — use a token that exists on the current cluster (devnet/mainnet)
          </p>
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
      {showResolved && effectiveMeta && (
        <div className="border border-[var(--accent)]/20 bg-[var(--accent)]/[0.03] p-4">
          <div className="flex items-center gap-3">
            {/* Token avatar */}
            <div className="flex h-8 w-8 items-center justify-center border border-[var(--accent)]/30 bg-[var(--accent)]/[0.08] text-[11px] font-bold text-[var(--accent)]">
              {effectiveMeta.symbol.slice(0, 2).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold text-white">
                {effectiveMeta.symbol}
                <span className="ml-2 text-[11px] font-normal text-[var(--text-secondary)]">
                  {effectiveMeta.name}
                </span>
              </p>
              <p className="text-[10px] font-mono text-[var(--text-dim)] truncate">
                {debounced.slice(0, 6)}...{debounced.slice(-4)}
              </p>
              {mirrorMeta && (
                <p className="text-[9px] text-[var(--accent)]/60 mt-0.5">
                  🪞 Devnet mirror of mainnet token
                </p>
              )}
            </div>
          </div>
          {effectiveMeta.decimals > 12 && (
            <div className="mt-3 border border-[var(--short)]/30 bg-[var(--short)]/[0.04] px-3 py-2">
              <p className="text-[10px] text-[var(--short)] font-medium">
                ⚠ Decimals &gt; 12 risk integer overflow. Market creation blocked.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Balance */}
      {mintValid && !balanceLoading && balance !== null && effectiveMeta && (
        <div className="text-[11px] font-mono text-[var(--text-dim)]">
          Wallet balance:{" "}
          <span className={balance > 0n ? "text-[var(--text)]" : "text-[var(--short)]"}>
            {formatHumanAmount(balance, effectiveMeta.decimals)} {effectiveMeta.symbol}
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
        disabled={!effectiveCanContinue}
        className="w-full border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] py-3 text-[13px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-all duration-200 hud-btn-corners hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.15] disabled:cursor-not-allowed disabled:border-[var(--border)] disabled:bg-transparent disabled:text-[var(--text-dim)] disabled:opacity-50"
      >
        {mintNetworkStatus === "loading" ? "VALIDATING..." : mintNetworkStatus === "mirroring" ? "MIRRORING..." : "CONTINUE →"}
      </button>
    </div>
  );
};

