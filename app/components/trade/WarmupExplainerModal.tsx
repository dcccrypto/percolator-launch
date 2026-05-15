"use client";

import { FC, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import gsap from "gsap";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

interface WarmupExplainerModalProps {
  onClose: () => void;
}

export const WarmupExplainerModal: FC<WarmupExplainerModalProps> = ({
  onClose,
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const prefersReduced = usePrefersReducedMotion();

  // Keep the onClose callback in a ref so the mount effect never re-runs on parent
  // re-renders. Trade-page parents re-render frequently (countdown ticks, WS price
  // updates, etc.) and pass freshly-allocated inline `onClose` closures each time;
  // with `onClose` in the effect deps, every parent re-render re-fired the gsap
  // fade-in (opacity 0 → 1) and made the modal blink continuously while open.
  // Same canonical pattern as TradeConfirmationModal.tsx.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const overlay = overlayRef.current;
    const modal = modalRef.current;
    if (!overlay || !modal) return;

    if (prefersReduced) {
      overlay.style.opacity = "1";
      modal.style.opacity = "1";
      modal.style.transform = "scale(1)";
    } else {
      gsap.fromTo(
        overlay,
        { opacity: 0 },
        { opacity: 1, duration: 0.15, ease: "power2.out" }
      );
      gsap.fromTo(
        modal,
        { opacity: 0, scale: 0.97, y: -4 },
        { opacity: 1, scale: 1, y: 0, duration: 0.2, ease: "power2.out" }
      );
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefersReduced]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const content = (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 p-4"
      onClick={handleOverlayClick}
    style={{ opacity: 0 }}
    >
      <div
        ref={modalRef}
        className="w-full max-w-sm border border-[var(--border)] bg-[var(--bg)] shadow-2xl shadow-black/30"
      style={{ opacity: 0 }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border)]/50 px-4 py-2">
          <span className="text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">
            PnL Warmup
          </span>
          <button
            onClick={onClose}
            className="flex h-5 w-5 items-center justify-center text-[var(--text-dim)] transition-colors hover:text-[var(--text)]"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-3 space-y-3">
          {/* Description */}
          <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
            When you close a profitable position, PnL is <strong className="text-[var(--text)]">locked</strong> and
            linearly vests over ~1000 slots (~6.7 min). This prevents oracle manipulation attacks
            by ensuring fake profits cannot be instantly withdrawn.
          </p>

          {/* Params */}
          <div className="border border-[var(--border)]/30 divide-y divide-[var(--border)]/30">
            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="text-[10px] text-[var(--text-dim)]">Period</span>
              <span className="text-[10px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>1,000 slots</span>
            </div>
            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="text-[10px] text-[var(--text-dim)]">Duration</span>
              <span className="text-[10px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>~6.7 min</span>
            </div>
            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="text-[10px] text-[var(--text-dim)]">Vesting</span>
              <span className="text-[10px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>Linear</span>
            </div>
            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="text-[10px] text-[var(--text-dim)]">Enforcement</span>
              <span className="text-[10px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>On-chain (crank)</span>
            </div>
          </div>

          {/* How it works */}
          <div>
            <span className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">Lifecycle</span>
            <div className="mt-1.5 flex items-center gap-0 text-[10px]" style={{ fontFamily: "var(--font-mono)" }}>
              <span className="border border-[var(--border)]/50 bg-[var(--bg-elevated)] px-2 py-1 text-[var(--text-secondary)]">Close&nbsp;+PnL</span>
              <span className="text-[var(--text-dim)] px-1">&rarr;</span>
              <span className="border border-[var(--short)]/30 bg-[var(--short)]/5 px-2 py-1 text-[var(--short)]">Locked</span>
              <span className="text-[var(--text-dim)] px-1">&rarr;</span>
              <span className="border border-[var(--accent)]/30 bg-[var(--accent)]/5 px-2 py-1 text-[var(--accent)]">Vesting</span>
              <span className="text-[var(--text-dim)] px-1">&rarr;</span>
              <span className="border border-[var(--long)]/30 bg-[var(--long)]/5 px-2 py-1 text-[var(--long)]">Unlocked</span>
            </div>
          </div>

          {/* Formula */}
          <div className="bg-[var(--bg-elevated)] border border-[var(--border)]/30 px-3 py-2">
            <code className="text-[10px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
              unlocked = (elapsed_slots / total_slots) * profit
            </code>
          </div>

          {/* Note */}
          <p className="text-[9px] leading-relaxed text-[var(--text-dim)]">
            Losses are applied immediately. Only positive PnL enters warmup.
            Verified with 145 Kani formal proofs.
          </p>
        </div>

        {/* Footer */}
        <div className="border-t border-[var(--border)]/50 px-4 py-2">
          <button
            onClick={onClose}
            className="w-full py-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-colors hover:text-[var(--text)]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined"
    ? createPortal(content, document.body)
    : null;
};
