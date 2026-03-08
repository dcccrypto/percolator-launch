"use client";

import { FC, useState } from "react";
import { useStuckSlabs, type StuckSlab } from "@/hooks/useStuckSlabs";
import { useCloseMarket } from "@/hooks/useCloseMarket";
import { useReclaimSlabRent } from "@/hooks/useReclaimSlabRent";

interface RecoverSolBannerProps {
  /**
   * Called when user wants to resume market creation with the stuck slab.
   * `fromStep` is 1 when the market is initialized (need oracle/LP/insurance),
   * or 0 when the slab exists but InitMarket didn't complete (retry from scratch).
   */
  onResume?: (slabPublicKey: string, fromStep: 0 | 1) => void;
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
  const { closeSlab, loading: closeLoading, error: closeError } = useCloseMarket();
  const [dismissed, setDismissed] = useState(false);
  const [reclaimResult, setReclaimResult] = useState<{ sig: string; sol: number } | null>(null);

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
              onClick={() => onResume(stuckSlab.publicKey.toBase58(), 1)}
              className="border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] hover:bg-[var(--accent)]/[0.15] transition-colors"
            >
              RESUME CREATION →
            </button>
          )}
          <button
            type="button"
            disabled={closeLoading}
            onClick={async () => {
              const result = await closeSlab(stuckSlab.publicKey.toBase58());
              if (result) {
                setReclaimResult({
                  sig: result.signature,
                  sol: result.reclaimedLamports / 1_000_000_000,
                });
                clearStuck();
              }
            }}
            className="border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] hover:bg-[var(--accent)]/[0.15] transition-colors disabled:opacity-50"
          >
            {closeLoading ? "RECLAIMING..." : `RECLAIM ~${rentSol} SOL`}
          </button>
          {closeError && (
            <p className="w-full text-[10px] text-[var(--short)]">{closeError}</p>
          )}
          {reclaimResult && (
            <p className="w-full text-[10px] text-[var(--long)]">
              ✓ Reclaimed {reclaimResult.sol.toFixed(4)} SOL —{" "}
              <a
                href={`https://solscan.io/tx/${reclaimResult.sig}?cluster=devnet`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                View tx
              </a>
            </p>
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

  // Account exists but NOT initialized — slab is program-owned but uninitialised (magic = 0).
  // PERC-511: We can now reclaim the SOL via the ReclaimSlabRent instruction (tag 52).
  // The slab keypair signs the tx to prove ownership.
  return <UninitialisedSlabBanner stuckSlab={stuckSlab} onResume={onResume} clearStuck={clearStuck} />;
};

/** Sub-component: handles the uninitialised slab case with ReclaimSlabRent. */
const UninitialisedSlabBanner: FC<{
  stuckSlab: StuckSlab;
  onResume?: (slabPublicKey: string, fromStep: 0 | 1) => void;
  clearStuck: () => void;
}> = ({ stuckSlab, onResume, clearStuck }) => {
  const { status, error: reclaimError, txSig, reclaim } = useReclaimSlabRent();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  const rentSol = (stuckSlab.lamports / 1_000_000_000).toFixed(4);
  const isSending = status === "sending";
  const isSuccess = status === "success";

  // Success state — show confirmation and let user dismiss
  if (isSuccess) {
    return (
      <div className="mb-4 border border-[var(--accent)]/40 bg-[var(--accent)]/[0.06] p-4">
        <div className="flex items-center gap-2 mb-1">
          <span className="h-2 w-2 rounded-full bg-[var(--accent)]" />
          <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--accent)]">
            SOL Reclaimed ✓
          </span>
        </div>
        <p className="text-[11px] text-[var(--text-secondary)] mb-3">
          {rentSol} SOL has been returned to your wallet.
          {txSig && (
            <>
              {" "}
              <a
                href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--accent)]/80 hover:text-[var(--accent)] underline underline-offset-2"
              >
                View tx ↗
              </a>
            </>
          )}
        </p>
        <button
          type="button"
          onClick={() => {
            clearStuck();
            setDismissed(true);
          }}
          className="border border-[var(--border)] px-4 py-2 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] hover:text-[var(--text)] transition-colors"
        >
          START NEW MARKET →
        </button>
      </div>
    );
  }

  return (
    <div className="mb-4 border border-[var(--warning)]/30 bg-[var(--warning)]/[0.04] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--warning)]">
              ⚠ Stuck Slab — SOL Recoverable
            </span>
          </div>
          <p className="text-[11px] text-[var(--text-secondary)] mb-1">
            A slab account was created at{" "}
            <code className="font-mono text-[10px] text-[var(--warning)]/80">
              {stuckSlab.publicKey.toBase58().slice(0, 8)}...
              {stuckSlab.publicKey.toBase58().slice(-4)}
            </code>{" "}
            but market initialisation didn&apos;t complete.
          </p>
          <p className="text-[10px] text-[var(--text-dim)]">
            <strong className="text-[var(--warning)]">{rentSol} SOL</strong> is
            locked as rent. You can reclaim it now, retry initialisation, or start fresh.
          </p>
          {reclaimError && (
            <p className="mt-2 text-[10px] text-red-400 font-medium">
              ⚠ {reclaimError}
            </p>
          )}
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
        {/* Primary CTA: Reclaim SOL (PERC-511) */}
        {stuckSlab.keypair && (
          <button
            type="button"
            disabled={isSending}
            onClick={() => stuckSlab.keypair && reclaim(stuckSlab.keypair)}
            className="border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] hover:bg-[var(--accent)]/[0.15] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSending ? "RECLAIMING…" : `RECLAIM ${rentSol} SOL →`}
          </button>
        )}
        {/* Fallback: retry InitMarket if user wants to proceed with market creation */}
        {onResume && (
          <button
            type="button"
            disabled={isSending}
            onClick={() => onResume(stuckSlab.publicKey.toBase58(), 0)}
            className="border border-[var(--warning)]/50 bg-[var(--warning)]/[0.08] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--warning)] hover:bg-[var(--warning)]/[0.15] transition-colors disabled:opacity-50"
          >
            RETRY INITIALIZATION →
          </button>
        )}
        <button
          type="button"
          disabled={isSending}
          onClick={() => {
            clearStuck();
            setDismissed(true);
          }}
          className="border border-[var(--border)] px-4 py-2 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] hover:border-[var(--accent)]/30 hover:text-[var(--text)] transition-colors disabled:opacity-50"
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
