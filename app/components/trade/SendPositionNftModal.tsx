"use client";

import { FC, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PublicKey } from "@solana/web3.js";
import gsap from "gsap";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

interface SendPositionNftModalProps {
  /** Human summary of the position being transferred — e.g. "LONG 0.3507 SOL" */
  positionSummary: string;
  /** Mint address of the NFT. Shown read-only for verification. */
  nftMintShort: string;
  loading: boolean;
  error: string | null;
  onConfirm: (destination: PublicKey) => void;
  onCancel: () => void;
}

function isValidPubkey(s: string): PublicKey | null {
  if (!s || s.length < 32 || s.length > 44) return null;
  try {
    return new PublicKey(s.trim());
  } catch {
    return null;
  }
}

export const SendPositionNftModal: FC<SendPositionNftModalProps> = ({
  positionSummary,
  nftMintShort,
  loading,
  error,
  onConfirm,
  onCancel,
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const prefersReduced = usePrefersReducedMotion();

  const [destInput, setDestInput] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);

  const parsedDest = isValidPubkey(destInput);
  const pubkeyInvalid = destInput.length > 0 && !parsedDest;
  const canConfirm = parsedDest !== null && acknowledged && !loading;

  // Trap Escape to cancel, match the other modals
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, loading]);

  // Enter/scale animation matching ClosePositionModal
  useEffect(() => {
    if (prefersReduced) return;
    const overlay = overlayRef.current;
    const modal = modalRef.current;
    if (!overlay || !modal) return;
    gsap.fromTo(overlay, { opacity: 0 }, { opacity: 1, duration: 0.15 });
    gsap.fromTo(modal, { opacity: 0, scale: 0.98 }, { opacity: 1, scale: 1, duration: 0.18, ease: "power2.out" });
  }, [prefersReduced]);

  const body = (
    <div
      ref={overlayRef}
      onClick={(e) => {
        if (e.target === e.currentTarget && !loading) onCancel();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px] p-4"
      aria-modal="true"
      role="dialog"
      aria-label="Send Position NFT"
    >
      <div
        ref={modalRef}
        className="relative w-full max-w-sm rounded-none border border-[var(--border)] bg-[var(--bg)] shadow-xl"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-l-2 border-l-[var(--accent)] bg-[var(--accent)]/[0.06]">
          <span className="text-[13px] leading-none text-[var(--accent)]">◆</span>
          <span className="text-[11px] font-semibold text-[var(--accent)]">SEND POSITION NFT</span>
        </div>

        <div className="p-4 space-y-3">
          {/* What's being transferred */}
          <div className="border border-[var(--border)]/40 bg-[var(--bg-elevated)] px-3 py-2 space-y-1">
            <p className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Transferring</p>
            <p className="text-[12px] font-semibold" style={{ fontFamily: "var(--font-mono)" }}>
              {positionSummary}
            </p>
            <p
              className="text-[10px] text-[var(--text-dim)]"
              style={{ fontFamily: "var(--font-mono)" }}
              title="NFT mint address"
            >
              Mint: {nftMintShort}
            </p>
          </div>

          {/* Destination pubkey */}
          <label className="block space-y-1">
            <span className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
              Destination Wallet
            </span>
            <input
              type="text"
              inputMode="text"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={destInput}
              onChange={(e) => setDestInput(e.target.value)}
              placeholder="Paste Solana pubkey…"
              disabled={loading}
              className={`w-full rounded-none border bg-[var(--bg)] px-2 py-2 text-[11px] font-mono text-[var(--text)] placeholder:text-[var(--text-dim)] focus:outline-none focus:border-[var(--accent)] ${
                pubkeyInvalid ? "border-[var(--short)]/60" : "border-[var(--border)]/60"
              }`}
            />
            {pubkeyInvalid && (
              <p className="text-[10px] text-[var(--short)]">Not a valid Solana pubkey.</p>
            )}
          </label>

          {/* Consequence notice */}
          <div className="border border-[var(--warning)]/30 bg-[var(--warning)]/5 px-3 py-2 space-y-1">
            <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--warning)] font-semibold">
              Irreversible
            </p>
            <p className="text-[10px] text-[var(--text-secondary)] leading-relaxed">
              The NFT <em>and</em> the on-chain position ownership move in a single atomic transaction.
              After this tx lands you will no longer be able to trade, close, or withdraw from this
              sub-account — only the destination wallet can. Collateral remaining in the sub-account
              transfers with it.
            </p>
          </div>

          {/* Acknowledgement */}
          <label className="flex items-start gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              disabled={loading}
              className="mt-0.5 accent-[var(--accent)]"
            />
            <span className="text-[10px] text-[var(--text-secondary)]">
              I understand this transfers ownership of the position, not just the token.
            </span>
          </label>

          {/* On-chain error surfaced from the simulation / tx */}
          {error && (
            <div className="rounded-none border border-[var(--short)]/30 bg-[var(--short)]/5 px-3 py-2">
              <p className="text-[10px] text-[var(--short)]">{error}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onCancel}
              disabled={loading}
              className="flex-1 rounded-none border border-[var(--border)]/60 py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-colors hover:border-[var(--border)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => parsedDest && onConfirm(parsedDest)}
              disabled={!canConfirm}
              className="flex-[1.2] rounded-none bg-[var(--accent)] py-2 text-[10px] font-bold uppercase tracking-[0.1em] text-white transition-all duration-150 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {loading ? "Sending…" : "Confirm & Sign"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(body, document.body);
};
