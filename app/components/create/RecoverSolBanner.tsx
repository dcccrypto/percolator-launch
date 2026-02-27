"use client";

import { FC, useState } from "react";
import { useStuckSlabs, type StuckSlab } from "@/hooks/useStuckSlabs";

interface RecoverSolBannerProps {
  /** Called when user wants to resume market creation with the stuck slab */
  onResume?: (slabPublicKey: string) => void;
}

/**
 * Banner that detects stuck slab accounts from a previous failed market creation.
 *
 * Scenarios handled:
 * 1. Account exists + initialized → "Resume creation from the next step"
 * 2. Account exists + NOT initialized → "Retry market creation" (re-use keypair)
 * 3. Account doesn't exist → silently clean up localStorage (atomic tx rolled back)
 *
 * With the atomic createAccount + InitMarket flow, scenario 2 is extremely rare —
 * it would only happen if the tx landed on-chain but the client lost the confirmation.
 */
export const RecoverSolBanner: FC<RecoverSolBannerProps> = ({ onResume }) => {
  const { stuckSlab, loading, clearStuck, refresh } = useStuckSlabs();
  const [dismissed, setDismissed] = useState(false);

  // Don't show while loading
  if (loading) return null;

  // No stuck slab found
  if (!stuckSlab) return null;

  // Already dismissed this session
  if (dismissed) return null;

  // Account doesn't exist — the atomic tx rolled back. Show a brief info and auto-clean.
  if (!stuckSlab.exists) {
    return (
      <div className="mb-4 border border-[var(--text-dim)]/20 bg-[var(--bg-surface)] p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[11px] font-medium text-[var(--text-muted)]">
                ℹ Previous attempt detected
              </span>
            </div>
            <p className="text-[11px] text-[var(--text-dim)]">
              A previous market creation attempt was found but the transaction was
              rolled back. No SOL was lost. You can safely start a new market.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              clearStuck();
              setDismissed(true);
            }}
            className="flex-shrink-0 text-[10px] text-[var(--text-dim)] hover:text-[var(--text)] transition-colors px-2 py-1"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
        <button
          type="button"
          onClick={() => {
            clearStuck();
            setDismissed(true);
          }}
          className="mt-3 border border-[var(--border)] px-4 py-2 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] hover:border-[var(--accent)]/30 hover:text-[var(--text)] transition-colors"
        >
          CLEAR &amp; START FRESH
        </button>
      </div>
    );
  }

  // Account exists and market IS initialized — resume from where we left off
  if (stuckSlab.isInitialized) {
    const rentSol = (stuckSlab.lamports / 1_000_000_000).toFixed(4);

    return (
      <div className="mb-4 border border-[var(--accent)]/30 bg-[var(--accent)]/[0.04] p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className="h-2 w-2 rounded-full bg-[var(--accent)] animate-pulse" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--accent)]">
                Incomplete Market Found
              </span>
            </div>
            <p className="text-[11px] text-[var(--text-secondary)] mb-1">
              A market was partially created at{" "}
              <code className="font-mono text-[10px] text-[var(--accent)]/80">
                {stuckSlab.publicKey.toBase58().slice(0, 8)}...
                {stuckSlab.publicKey.toBase58().slice(-4)}
              </code>
            </p>
            <p className="text-[10px] text-[var(--text-dim)]">
              The slab account is initialized ({rentSol} SOL in rent).
              Resume to complete setup (oracle, LP, insurance).
            </p>
          </div>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="flex-shrink-0 text-[10px] text-[var(--text-dim)] hover:text-[var(--text)] transition-colors px-2 py-1"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {onResume && (
            <button
              type="button"
              onClick={() => onResume(stuckSlab.publicKey.toBase58())}
              className="border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] hover:bg-[var(--accent)]/[0.15] transition-colors"
            >
              RESUME CREATION →
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              clearStuck();
              setDismissed(true);
            }}
            className="border border-[var(--border)] px-4 py-2 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] hover:border-[var(--accent)]/30 hover:text-[var(--text)] transition-colors"
          >
            DISCARD &amp; START NEW
          </button>
        </div>
      </div>
    );
  }

  // Account exists but NOT initialized — rarest case (tx confirmed on-chain but
  // client lost confirmation). The slab is program-owned so we can't close it,
  // but we can retry InitMarket on it.
  const rentSol = (stuckSlab.lamports / 1_000_000_000).toFixed(4);

  return (
    <div className="mb-4 border border-[var(--warning)]/30 bg-[var(--warning)]/[0.04] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--warning)]">
              ⚠ Stuck Slab Account Detected
            </span>
          </div>
          <p className="text-[11px] text-[var(--text-secondary)] mb-1">
            A slab account was created at{" "}
            <code className="font-mono text-[10px] text-[var(--warning)]/80">
              {stuckSlab.publicKey.toBase58().slice(0, 8)}...
              {stuckSlab.publicKey.toBase58().slice(-4)}
            </code>{" "}
            but market initialization didn&apos;t complete.
          </p>
          <p className="text-[10px] text-[var(--text-dim)]">
            {rentSol} SOL is locked as rent. You can retry initialization to
            recover the account, or discard and start fresh (rent is not recoverable
            since the account is now program-owned).
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="flex-shrink-0 text-[10px] text-[var(--text-dim)] hover:text-[var(--text)] transition-colors px-2 py-1"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {onResume && (
          <button
            type="button"
            onClick={() => onResume(stuckSlab.publicKey.toBase58())}
            className="border border-[var(--warning)]/50 bg-[var(--warning)]/[0.08] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--warning)] hover:bg-[var(--warning)]/[0.15] transition-colors"
          >
            RETRY INITIALIZATION →
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            clearStuck();
            setDismissed(true);
          }}
          className="border border-[var(--border)] px-4 py-2 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] hover:border-[var(--accent)]/30 hover:text-[var(--text)] transition-colors"
        >
          DISCARD &amp; START NEW
        </button>
        <a
          href={`https://explorer.solana.com/address/${stuckSlab.publicKey.toBase58()}?cluster=devnet`}
          target="_blank"
          rel="noopener noreferrer"
          className="border border-[var(--border)] px-4 py-2 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-dim)] hover:text-[var(--text)] transition-colors"
        >
          VIEW ON EXPLORER ↗
        </a>
      </div>
    </div>
  );
};
