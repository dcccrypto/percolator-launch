/**
 * PERC-475: Devnet token faucet button for mirror markets.
 *
 * Shows a "Get [SYMBOL] Tokens" button on the trade page for devnet mirror
 * markets (i.e. markets whose collateral mint is in the devnet_mints table).
 * Calls POST /api/devnet-airdrop to mint $500 USD worth of devnet tokens.
 *
 * Only renders on devnet with a connected wallet.
 */

"use client";

import { useState, useCallback } from "react";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { getNetwork } from "@/lib/config";

interface DevnetTokenFaucetButtonProps {
  /** Devnet SPL mint address (collateralMint) */
  mintAddress: string;
  /** Token symbol shown on the button */
  symbol: string;
}

export function DevnetTokenFaucetButton({ mintAddress, symbol }: DevnetTokenFaucetButtonProps) {
  const { publicKey, connected } = useWalletCompat();
  const [loading, setLoading] = useState(false);
  const [claimed, setClaimed] = useState<{ amount: number; sig: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rateLimited, setRateLimited] = useState<{ nextClaimAt: string } | null>(null);
  // GH#1367: set true when API confirms this mint is not a devnet mirror
  const [isNonMirrorMint, setIsNonMirrorMint] = useState(false);

  const isDevnet = getNetwork() === "devnet";

  const claim = useCallback(async () => {
    if (!publicKey || loading) return;
    setLoading(true);
    setError(null);

    try {
      const resp = await fetch("/api/devnet-airdrop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mintAddress,
          walletAddress: publicKey.toBase58(),
        }),
      });

      const data = await resp.json();

      if (resp.status === 429) {
        setRateLimited({ nextClaimAt: data.nextClaimAt });
      } else if (resp.status === 400 && data.error?.includes("not a known devnet mirror mint")) {
        // GH#1367: Token is not a devnet mirror mint — switch to faucet link UI
        setIsNonMirrorMint(true);
        setError(null);
      } else if (!resp.ok) {
        setError(data.error ?? "Faucet failed");
      } else {
        setClaimed({ amount: data.amount, sig: data.signature });
      }
    } catch (e: any) {
      setError(e.message ?? "Network error");
    } finally {
      setLoading(false);
    }
  }, [publicKey, mintAddress, loading]);

  // Don't render on mainnet
  if (!isDevnet) return null;

  // Don't render without wallet
  if (!connected || !publicKey) return null;

  // GH#1367: Not a devnet mirror mint — show faucet page link instead of airdrop button
  if (isNonMirrorMint) {
    return (
      <div className="flex items-center gap-1.5 text-[10px]">
        <span className="text-[var(--text-secondary)]">Get {symbol} →</span>
        <a
          href={`/devnet-mint?mint=${encodeURIComponent(mintAddress)}&symbol=${encodeURIComponent(symbol)}`}
          className="text-[var(--accent)] hover:underline underline-offset-2 font-medium"
        >
          Devnet Faucet
        </a>
      </div>
    );
  }

  // Rate limited — show countdown info + a fallback to this app's own
  // faucet page. This mint's own devnet-airdrop endpoint has a per-wallet
  // cooldown (h/m below); /faucet mints the SAME sim-USDC under its own,
  // separate 1-claim-per-hour limit, so it's a genuine fallback rather than
  // just re-hitting the same rate limit.
  if (rateLimited) {
    const target = new Date(rateLimited.nextClaimAt);
    const remaining = Math.max(0, target.getTime() - Date.now());
    const h = Math.floor(remaining / 3_600_000);
    const m = Math.floor((remaining % 3_600_000) / 60_000);
    return (
      <div className="flex flex-col gap-1.5 px-3 py-2 border border-[var(--border)]/40 text-[10px]">
        <div className="flex items-center gap-2">
          <span className="text-[var(--text-secondary)]">Next {symbol} claim in</span>
          <span className="font-mono text-[var(--accent)] tabular-nums">{h}h {m}m</span>
        </div>
        <a
          href="/faucet"
          className="inline-block text-[var(--accent)] underline underline-offset-2 hover:text-[var(--text)]"
        >
          Try our own faucet page (separate limit) →
        </a>
      </div>
    );
  }

  // Success state
  if (claimed) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 border border-[var(--long)]/30 bg-[var(--long)]/[0.05] text-[10px]">
        <span className="text-[var(--long)]">✓</span>
        <span className="text-[var(--text-secondary)]">
          Got{" "}
          <span className="font-medium text-[var(--text)]">
            {claimed.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} {symbol}
          </span>
        </span>
        <a
          href={`https://explorer.solana.com/tx/${claimed.sig}?cluster=devnet`}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto text-[9px] text-[var(--accent)] hover:underline underline-offset-2"
        >
          Explorer ↗
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={claim}
        disabled={loading}
        className="w-full border border-[var(--accent)]/40 bg-[var(--accent)]/[0.06] px-3 py-2 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/[0.12] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <span className="inline-block animate-spin">⟳</span>
            Minting…
          </span>
        ) : (
          `Get ${symbol} Tokens`
        )}
      </button>
      {error && (
        <p className="text-[9px] text-[var(--short)]">{error}</p>
      )}
    </div>
  );
}
