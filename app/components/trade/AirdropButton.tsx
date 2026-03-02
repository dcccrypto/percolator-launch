/**
 * PERC-363: Airdrop button for user-created markets
 *
 * Shows a "Get [TOKEN]" button that airdrops $500 USD worth of devnet tokens.
 * Rate limited: 1 claim per wallet per market per 24h with countdown timer.
 */

"use client";

import { useState, useCallback, useEffect } from "react";
import { useWalletCompat } from "@/hooks/useWalletCompat";

interface AirdropButtonProps {
  marketAddress: string;
  symbol: string;
  /** Only show on user-created markets (not SOL-PERP, etc.) */
  isUserCreated?: boolean;
}

export function AirdropButton({ marketAddress, symbol, isUserCreated = true }: AirdropButtonProps) {
  const { publicKey, connected } = useWalletCompat();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ tokens: number; nextClaimAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<string | null>(null);
  const [nextClaimAt, setNextClaimAt] = useState<string | null>(null);

  const isDevnet = process.env.NEXT_PUBLIC_SOLANA_NETWORK === "devnet";

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
    if (!publicKey || loading) return;
    setLoading(true);
    setError(null);

    try {
      const resp = await fetch("/api/airdrop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketAddress,
          walletAddress: publicKey.toBase58(),
        }),
      });

      const data = await resp.json();

      if (resp.status === 429) {
        setNextClaimAt(data.nextClaimAt);
        setError("Already claimed — try again later");
      } else if (!resp.ok) {
        setError(data.error ?? "Airdrop failed");
      } else {
        setResult({ tokens: data.tokens, nextClaimAt: data.nextClaimAt });
      }
    } catch (e: any) {
      setError(e.message ?? "Network error");
    } finally {
      setLoading(false);
    }
  }, [publicKey, marketAddress, loading]);

  // Don't render on mainnet or for non-user-created markets
  if (!isDevnet || !isUserCreated) return null;

  // Not connected
  if (!connected) return null;

  // Already claimed with countdown
  if (countdown) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded bg-[var(--panel-bg)] border border-[var(--border)] text-[11px]">
        <span className="text-[var(--text-secondary)]">Next claim in</span>
        <span className="text-[var(--accent)] font-mono tabular-nums">{countdown}</span>
      </div>
    );
  }

  // Success state
  if (result) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded bg-[var(--long)]/10 border border-[var(--long)]/20 text-[11px]">
        <span className="text-[var(--long)]">
          ✅ Got {result.tokens.toLocaleString(undefined, { maximumFractionDigits: 2 })} {symbol}
        </span>
      </div>
    );
  }

  return (
    <button
      onClick={claim}
      disabled={loading}
      className="px-4 py-2 rounded bg-[var(--accent)] text-black text-[12px] font-medium
                 hover:brightness-110 active:brightness-95 transition-all
                 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {loading ? (
        <span className="flex items-center gap-2">
          <span className="animate-spin">⟳</span> Claiming...
        </span>
      ) : (
        <>Get {symbol} 💰</>
      )}
      {error && (
        <span className="block text-[10px] text-red-400 mt-0.5">{error}</span>
      )}
    </button>
  );
}
