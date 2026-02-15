"use client";

import { FC, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import gsap from "gsap";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

interface InsuranceExplainerModalProps {
  onClose: () => void;
}

export const InsuranceExplainerModal: FC<InsuranceExplainerModalProps> = ({
  onClose,
}) => {
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
      gsap.fromTo(
        overlay,
        { opacity: 0 },
        { opacity: 1, duration: 0.2, ease: "power2.out" }
      );
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
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-none border border-[var(--border)] bg-[var(--bg)] shadow-2xl"
      >
        {/* Header */}
        <div className="sticky top-0 flex items-center justify-between border-b border-[var(--border)]/50 bg-[var(--bg)] px-4 py-3">
          <h2
            className="text-lg font-bold text-[var(--text)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            What is the Insurance Fund?
          </h2>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-none text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text)]"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="space-y-6 p-6">
          {/* What it is */}
          <section>
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">
              What is it?
            </h3>
            <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
              The <strong>Insurance Fund</strong> is a safety net that protects
              liquidity providers (LPs) from bankruptcy during extreme market
              events.
            </p>
            <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
              It's a pool of capital that absorbs losses when traders get
              liquidated but their positions can't be closed profitably.
            </p>
          </section>

          {/* How it works */}
          <section className="rounded-none border-l-2 border-l-[var(--accent)] bg-[var(--accent)]/5 p-4">
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">
              How it works
            </h3>
            <div className="space-y-3">
              <div className="flex items-start gap-2">
                <span className="text-[var(--long)]">✓</span>
                <div>
                  <div className="text-sm font-medium text-[var(--text)]">
                    Accumulates from trading fees
                  </div>
                  <div className="text-xs text-[var(--text-dim)]">
                    A portion of every trade goes to the insurance fund
                  </div>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-[var(--long)]">✓</span>
                <div>
                  <div className="text-sm font-medium text-[var(--text)]">
                    Covers LP losses in liquidations
                  </div>
                  <div className="text-xs text-[var(--text-dim)]">
                    When a trader is liquidated, insurance covers any shortfall
                  </div>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-[var(--long)]">✓</span>
                <div>
                  <div className="text-sm font-medium text-[var(--text)]">
                    Anyone can contribute (permissionless)
                  </div>
                  <div className="text-xs text-[var(--text-dim)]">
                    Community members can top up the insurance fund anytime
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Why it matters */}
          <section>
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">
              Why it matters
            </h3>
            <div className="space-y-3">
              <div className="rounded-none border border-[var(--long)]/30 bg-[var(--long)]/5 p-3">
                <div className="mb-1 flex items-center gap-1.5">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--long)]" />
                  <span className="text-xs font-bold uppercase tracking-wider text-[var(--long)]">
                    Strong Insurance = Safer Markets
                  </span>
                </div>
                <p className="text-sm text-[var(--text-secondary)]">
                  High insurance coverage means LPs are protected even in
                  extreme volatility. Traders can trade with confidence knowing
                  the system won't collapse.
                </p>
              </div>
              <div className="rounded-none border border-[var(--short)]/30 bg-[var(--short)]/5 p-3">
                <div className="mb-1 flex items-center gap-1.5">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--short)]" />
                  <span className="text-xs font-bold uppercase tracking-wider text-[var(--short)]">
                    Low Insurance = Higher Risk
                  </span>
                </div>
                <p className="text-sm text-[var(--text-secondary)]">
                  Low insurance coverage means the system is vulnerable to
                  cascading liquidations. If multiple large positions get
                  liquidated, LPs could face losses.
                </p>
              </div>
            </div>
          </section>

          {/* Scenario */}
          <section>
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">
              Example Scenario
            </h3>
            <div className="space-y-2 text-sm text-[var(--text-secondary)]">
              <div className="flex items-start gap-2">
                <span className="font-mono text-[var(--text-dim)]">1.</span>
                <span>
                  Trader opens 10x leveraged LONG position: $10,000 notional
                  with $1,000 collateral
                </span>
              </div>
              <div className="flex items-start gap-2">
                <span className="font-mono text-[var(--text-dim)]">2.</span>
                <span>
                  Market crashes -15%. Trader's position is now worth $8,500
                </span>
              </div>
              <div className="flex items-start gap-2">
                <span className="font-mono text-[var(--text-dim)]">3.</span>
                <span>
                  Trader gets liquidated. Liquidation tries to close position
                  at $8,500
                </span>
              </div>
              <div className="flex items-start gap-2">
                <span className="font-mono text-[var(--text-dim)]">4.</span>
                <span>
                  LP takes on the position at a loss: should receive $10,000
                  but only gets $8,500
                </span>
              </div>
              <div className="flex items-start gap-2">
                <span className="font-mono text-[var(--text-dim)]">5.</span>
                <span className="text-[var(--long)]">
                  <strong>Insurance fund covers the $1,500 shortfall</strong> →
                  LP is made whole
                </span>
              </div>
            </div>
          </section>

          {/* Transparency */}
          <section className="rounded-none border-l-2 border-l-[var(--warning)] bg-[var(--warning)]/5 p-4">
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">
              Transparency
            </h3>
            <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
              Most DEXs <strong>hide</strong> their insurance fund data. You
              have no idea if the platform is adequately capitalized.
            </p>
            <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
              Percolator shows you the <strong>exact balance</strong>,{" "}
              <strong>accumulation rate</strong>, and{" "}
              <strong>coverage ratio</strong>. Full transparency.
            </p>
          </section>

          {/* How to contribute */}
          <section>
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">
              How to contribute
            </h3>
            <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
              Anyone can top up the insurance fund by depositing collateral.
              This is <strong>permissionless</strong> — no approvals needed.
            </p>
            <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
              Why would you contribute?
            </p>
            <ul className="mt-2 space-y-1 text-sm text-[var(--text-secondary)]">
              <li className="flex items-start gap-2">
                <span className="text-[var(--accent)]">•</span>
                <span>
                  <strong>Protect your LP position:</strong> If you're an LP,
                  stronger insurance = safer investment
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[var(--accent)]">•</span>
                <span>
                  <strong>Support the ecosystem:</strong> Help Percolator grow
                  by making markets safer
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[var(--accent)]">•</span>
                <span>
                  <strong>Community alignment:</strong> Show you believe in the
                  project
                </span>
              </li>
            </ul>
          </section>

          {/* Coverage Ratio */}
          <section className="rounded-none bg-[var(--bg-elevated)] p-4">
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">
              Understanding Coverage Ratio
            </h3>
            <div className="space-y-2 text-xs text-[var(--text-secondary)]">
              <div className="flex items-start gap-2">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--long)] mt-0.5" />
                <span>
                  <strong>&gt;5x coverage:</strong> Healthy — insurance can
                  cover multiple large liquidations
                </span>
              </div>
              <div className="flex items-start gap-2">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 mt-0.5" />
                <span>
                  <strong>2-5x coverage:</strong> Moderate — acceptable but
                  should be monitored
                </span>
              </div>
              <div className="flex items-start gap-2">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--short)] mt-0.5" />
                <span>
                  <strong>&lt;2x coverage:</strong> Low — risky, consider
                  topping up
                </span>
              </div>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="border-t border-[var(--border)]/50 bg-[var(--bg-elevated)] px-6 py-4 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 rounded-none border border-[var(--border)]/50 px-4 py-2 text-sm font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--bg)]"
          >
            Close
          </button>
          <button
            onClick={() => {
              onClose();
              // This will be handled by parent component to open TopUp modal
            }}
            className="flex-1 rounded-none border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-4 py-2 text-sm font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/20"
          >
            Top Up Insurance
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined"
    ? createPortal(content, document.body)
    : null;
};
