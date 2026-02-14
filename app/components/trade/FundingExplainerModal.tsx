"use client";

import { FC, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import gsap from "gsap";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

interface FundingExplainerModalProps {
  onClose: () => void;
}

export const FundingExplainerModal: FC<FundingExplainerModalProps> = ({ onClose }) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const prefersReduced = usePrefersReducedMotion();

  useEffect(() => {
    const overlay = overlayRef.current;
    const modal = modalRef.current;
    if (!overlay || !modal) return;

    if (prefersReduced) {
      overlay.style.opacity = "1";
      modal.style.opacity = "1";
      modal.style.transform = "scale(1)";
    } else {
      gsap.fromTo(overlay, { opacity: 0 }, { opacity: 1, duration: 0.2, ease: "power2.out" });
      gsap.fromTo(
        modal,
        { opacity: 0, scale: 0.95 },
        { opacity: 1, scale: 1, duration: 0.25, ease: "power2.out" }
      );
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onClose, prefersReduced]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const content = (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={handleOverlayClick}
    >
      <div
        ref={modalRef}
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-sm border border-[var(--border)] bg-[var(--bg)] shadow-2xl"
      >
        {/* Header */}
        <div className="sticky top-0 flex items-center justify-between border-b border-[var(--border)]/50 bg-[var(--bg)] px-4 py-3">
          <h2 className="text-lg font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-display)" }}>
            Understanding Funding Rates
          </h2>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-sm text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text)]"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* What are funding rates? */}
          <section>
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">What are funding rates?</h3>
            <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
              Funding rates are periodic payments between traders that help keep perpetual futures prices
              aligned with the spot market. They balance long and short positions by making one side pay the other.
            </p>
          </section>

          {/* Why do they exist? */}
          <section>
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">Why do they exist?</h3>
            <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
              Unlike traditional futures, perpetual contracts have no expiration date. Without funding rates,
              traders could hold unbalanced positions indefinitely, creating risk for the exchange and liquidity providers.
            </p>
            <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
              Funding rates create an economic incentive to balance the market:
            </p>
            <ul className="mt-2 space-y-1 text-sm text-[var(--text-secondary)]">
              <li className="flex items-start gap-2">
                <span className="mt-0.5 text-[var(--short)]">→</span>
                <span>If longs dominate, longs pay shorts (discourages more longs)</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 text-[var(--long)]">→</span>
                <span>If shorts dominate, shorts pay longs (discourages more shorts)</span>
              </li>
            </ul>
          </section>

          {/* How Percolator's funding works */}
          <section className="rounded-none border-l-2 border-l-[var(--accent)] bg-[var(--accent)]/5 p-4">
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">
              Percolator's Inventory-Based Funding
            </h3>
            <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
              Percolator uses a unique <strong>inventory-based funding mechanism</strong> to protect liquidity providers (LPs).
            </p>
            <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
              When traders open positions, LPs take the opposite side. If too many traders go long, LPs are forced short
              and exposed to price risk. Funding rates compensate LPs for this inventory risk.
            </p>
            <div className="mt-3 space-y-2">
              <div className="flex items-start gap-2 text-sm">
                <span className="font-mono text-[var(--text-dim)]">1.</span>
                <span className="text-[var(--text-secondary)]">
                  <strong>LP net long</strong> (traders net short) → negative funding → shorts pay longs
                </span>
              </div>
              <div className="flex items-start gap-2 text-sm">
                <span className="font-mono text-[var(--text-dim)]">2.</span>
                <span className="text-[var(--text-secondary)]">
                  <strong>LP net short</strong> (traders net long) → positive funding → longs pay shorts
                </span>
              </div>
              <div className="flex items-start gap-2 text-sm">
                <span className="font-mono text-[var(--text-dim)]">3.</span>
                <span className="text-[var(--text-secondary)]">
                  <strong>Balanced</strong> → zero or minimal funding
                </span>
              </div>
            </div>
          </section>

          {/* When do you pay vs receive? */}
          <section>
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">When do you pay vs receive?</h3>
            <div className="space-y-3">
              <div className="rounded-none border border-[var(--long)]/30 bg-[var(--long)]/5 p-3">
                <div className="mb-1 text-xs font-bold uppercase tracking-wider text-[var(--long)]">
                  ✓ You Receive Funding
                </div>
                <ul className="space-y-1 text-sm text-[var(--text-secondary)]">
                  <li>• You're LONG and funding rate is <strong>negative</strong></li>
                  <li>• You're SHORT and funding rate is <strong>positive</strong></li>
                </ul>
              </div>
              <div className="rounded-none border border-[var(--short)]/30 bg-[var(--short)]/5 p-3">
                <div className="mb-1 text-xs font-bold uppercase tracking-wider text-[var(--short)]">
                  ⚠ You Pay Funding
                </div>
                <ul className="space-y-1 text-sm text-[var(--text-secondary)]">
                  <li>• You're LONG and funding rate is <strong>positive</strong></li>
                  <li>• You're SHORT and funding rate is <strong>negative</strong></li>
                </ul>
              </div>
            </div>
          </section>

          {/* How is it calculated? */}
          <section>
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">How is it calculated?</h3>
            <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
              The funding rate is computed based on:
            </p>
            <ul className="mt-2 space-y-1 text-sm text-[var(--text-secondary)]">
              <li className="flex items-start gap-2">
                <span className="text-[var(--accent)]">•</span>
                <span><strong>LP net position</strong> (inventory imbalance)</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[var(--accent)]">•</span>
                <span><strong>Current market price</strong></span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[var(--accent)]">•</span>
                <span><strong>Funding parameters</strong> (k, scale, max rate)</span>
              </li>
            </ul>
            <p className="mt-3 text-xs text-[var(--text-dim)] font-mono">
              Rate = (notional / scale) × k × sign(LP position)
            </p>
            <p className="mt-1 text-xs text-[var(--text-dim)]">
              Capped at maximum rates to prevent extreme scenarios.
            </p>
          </section>

          {/* Security */}
          <section>
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">Is it secure?</h3>
            <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
              Yes. Percolator's funding mechanism is battle-tested with:
            </p>
            <ul className="mt-2 space-y-1 text-sm text-[var(--text-secondary)]">
              <li className="flex items-start gap-2">
                <span className="text-[var(--long)]">✓</span>
                <span><strong>145 Kani formal proofs</strong> (verified correctness)</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[var(--long)]">✓</span>
                <span><strong>20+ comprehensive test cases</strong></span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[var(--long)]">✓</span>
                <span><strong>Anti-retroactivity guarantees</strong> (no historical manipulation)</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[var(--long)]">✓</span>
                <span><strong>Rate caps</strong> (prevents extreme funding)</span>
              </li>
            </ul>
          </section>
        </div>

        {/* Footer */}
        <div className="border-t border-[var(--border)]/50 bg-[var(--bg-elevated)] px-6 py-4">
          <button
            onClick={onClose}
            className="w-full rounded-none border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-4 py-2 text-sm font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/20"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(content, document.body) : null;
};
