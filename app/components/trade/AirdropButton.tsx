/**
 * PERC-363: Airdrop button for user-created markets
 *
 * Shows a "Get [TOKEN]" button that airdrops $500 USD worth of devnet tokens.
 * Rate limited: 1 claim per wallet per market per 24h with countdown timer.
 *
 * Fix (PERC-510): Pass `mintAddress` (devnet token mint / collateralMint) to API,
 * not `marketAddress` (slab address). The /api/devnet-airdrop route validates
 * against the devnet_mints table which keys on the devnet token mint address.
 */

"use client";

import { useState, useCallback, useEffect } from "react";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { getNetwork } from "@/lib/config";

interface AirdropButtonProps {
  /** Devnet token mint address (collateralMint from slab config) */
  mintAddress: string;
  symbol: string;
  /** Only show on user-created markets (not SOL-PERP, etc.) */
  isUserCreated?: boolean;
}

export function AirdropButton({ mintAddress, symbol, isUserCreated = true }: AirdropButtonProps) {
  const { publicKey, connected } = useWalletCompat();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ amount: number; nextClaimAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<string | null>(null);
  const [nextClaimAt, setNextClaimAt] = useState<string | null>(null);

  const isDevnet = getNetwork() === "devnet";

  // Countdown timer
  useEffect(() => {
    const target = nextClaimAt ?? result?.nextClaimAt;
    if (!target) { setCountdown(null); return; }

    const update = () => {
      const remaining = new Date(target).getTime() - Date.now();
      if (remaining <= 0) {
        setCountdown(null);
        setNextClaimAt(null);
        setResult(null);
        return;
      }
      const h = Math.floor(remaining / 3600000);
      const m = Math.floor((remaining % 3600000) / 60000);
      setCountdown(`${h}h ${m}m`);
    };

    update();
    const interval = setInterval(update, 60000);
    return () => clearInterval(interval);
  }, [nextClaimAt, result?.nextClaimAt]);

  const claim = useCallback(async () => {
    if (!publicKey || loading || !mintAddress) return;
    setLoading(true);
    setError(null);

    try {
      const resp = await fetch("/api/devnet-airdrop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mintAddress,                    // ← FIX: was marketAddress (slab address)
          walletAddress: publicKey.toBase58(),
        }),
      });

      const data = await resp.json();

      if (resp.status === 429) {
        setNextClaimAt(data.nextClaimAt);
        setError(`Next claim in ${Math.floor((data.retryAfterSecs ?? 86400) / 3600)}h`);
      } else if (!resp.ok) {
        setError(data.error ?? "Airdrop failed");
      } else {
        setResult({ amount: data.amount, nextClaimAt: data.nextClaimAt });
        setError(null);
      }
    } catch (e: any) {
      setError(e.message ?? "Network error");
    } finally {
      setLoading(false);
    }
  }, [publicKey, mintAddress, loading]);

  // Don't render on mainnet, non-user-created markets, or missing mint
  if (!isDevnet || !isUserCreated || !mintAddress) return null;
  if (!connected) return null;

  // Already claimed — show countdown
  if (countdown) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--bg-elevated)] border border-[var(--border)] text-[11px] font-mono">
        <span className="text-[var(--text-muted)]">Claimed — next in</span>
        <span className="text-[var(--accent)] tabular-nums">{countdown}</span>
      </div>
    );
  }

  // Success state
  if (result && !error) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--long)]/10 border border-[var(--long)]/20 text-[11px]">
        <span className="text-[var(--long)] font-medium">
          ✓ {result.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} {symbol} airdropped
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <button
        onClick={claim}
        disabled={loading || !mintAddress}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md
                   bg-[var(--accent)]/10 border border-[var(--accent)]/30
                   text-[var(--accent)] text-[11px] font-medium
                   hover:bg-[var(--accent)]/20 hover:border-[var(--accent)]/50
                   active:scale-95 transition-all duration-150
                   disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {loading ? (
          <>
            <span className="animate-spin inline-block">⟳</span>
            <span>Claiming...</span>
          </>
        ) : (
          <>
            <span>💧</span>
            <span>Get {symbol}</span>
          </>
        )}
      </button>
      {error && (
        <span className="text-[10px] text-[var(--short)] leading-none pr-0.5">{error}</span>
      )}
    </div>
  );
}
