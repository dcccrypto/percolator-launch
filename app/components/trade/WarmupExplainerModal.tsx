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
            What is PNL Warmup?
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
              When you close a profitable position, your profit is{" "}
              <strong>&quot;locked&quot;</strong> for approximately 8 minutes and
              gradually becomes withdrawable over time.
            </p>
            <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
              This is called <strong>PNL warmup</strong> — your profits
              &quot;warm up&quot; from locked to unlocked state.
            </p>
          </section>

          {/* Why it exists */}
          <section className="rounded-none border-l-2 border-l-[var(--warning)] bg-[var(--warning)]/5 p-4">
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">
              Why does it exist?
            </h3>
            <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
              <strong>Oracle manipulation protection.</strong>
            </p>
            <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
              If someone manipulates the price oracle (e.g., flash loan attack,
              oracle exploit), they can&apos;t instantly withdraw fake profits. The
              market has time to react and correct the price before the attacker
              can cash out.
            </p>
            <div className="mt-3 rounded-none border border-[var(--short)]/30 bg-[var(--short)]/5 p-3">
              <div className="mb-1 flex items-center gap-1.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--short)]" />
                <span className="text-xs font-bold uppercase tracking-wider text-[var(--short)]">
                  Attack Scenario (Prevented)
                </span>
              </div>
              <ol className="space-y-1 text-sm text-[var(--text-secondary)]">
                <li className="flex items-start gap-2">
                  <span className="font-mono text-[var(--text-dim)]">1.</span>
                  <span>Attacker manipulates oracle (fake price spike)</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="font-mono text-[var(--text-dim)]">2.</span>
                  <span>Opens position at manipulated price</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="font-mono text-[var(--text-dim)]">3.</span>
                  <span>Closes position immediately with &quot;profit&quot;</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="font-mono text-[var(--text-dim)]">4.</span>
                  <span className="text-[var(--short)]">
                    <strong>Can&apos;t withdraw</strong> — profit is locked for 8
                    minutes
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="font-mono text-[var(--text-dim)]">5.</span>
                  <span>Market corrects price before unlock</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="font-mono text-[var(--text-dim)]">6.</span>
                  <span className="text-[var(--long)]">
                    <strong>Attack fails</strong> — no fake profit withdrawal
                  </span>
                </li>
              </ol>
            </div>
          </section>

          {/* How it works */}
          <section>
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">
              How it works
            </h3>
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10 text-xs font-bold text-[var(--accent)]">
                  1
                </div>
                <div className="flex-1">
                  <div className="text-sm font-medium text-[var(--text)]">
                    Close position with profit
                  </div>
                  <div className="text-xs text-[var(--text-dim)]">
                    Your PNL is calculated and enters warmup
                  </div>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10 text-xs font-bold text-[var(--accent)]">
                  2
                </div>
                <div className="flex-1">
                  <div className="text-sm font-medium text-[var(--text)]">
                    Profit enters warmup (locked)
                  </div>
                  <div className="text-xs text-[var(--text-dim)]">
                    100% of profit is initially locked
                  </div>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10 text-xs font-bold text-[var(--accent)]">
                  3
                </div>
                <div className="flex-1">
                  <div className="text-sm font-medium text-[var(--text)]">
                    Gradually unlocks over 1000 slots
                  </div>
                  <div className="text-xs text-[var(--text-dim)]">
                    Each Solana slot (~400ms) unlocks a small portion
                  </div>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[var(--long)]/20 text-xs font-bold text-[var(--long)]">
                  ✓
                </div>
                <div className="flex-1">
                  <div className="text-sm font-medium text-[var(--text)]">
                    Fully withdrawable after ~8 minutes
                  </div>
                  <div className="text-xs text-[var(--text-dim)]">
                    All profit is unlocked and can be withdrawn
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Formula */}
          <section className="rounded-none bg-[var(--bg-elevated)] p-4">
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">
              Technical Details
            </h3>
            <div className="space-y-2 text-xs text-[var(--text-secondary)]">
              <div className="flex items-start gap-2">
                <span className="font-mono text-[var(--accent)]">•</span>
                <span>
                  <strong>Warmup Period:</strong> 1000 Solana slots (~6.7
                  minutes)
                </span>
              </div>
              <div className="flex items-start gap-2">
                <span className="font-mono text-[var(--accent)]">•</span>
                <span>
                  <strong>Unlock Rate:</strong> Linear vesting (constant per
                  slot)
                </span>
              </div>
              <div className="flex items-start gap-2">
                <span className="font-mono text-[var(--accent)]">•</span>
                <span>
                  <strong>Formula:</strong>{" "}
                  <code className="font-mono text-[var(--text-dim)]">
                    unlocked = (elapsed_slots / total_slots) × total_profit
                  </code>
                </span>
              </div>
              <div className="flex items-start gap-2">
                <span className="font-mono text-[var(--accent)]">•</span>
                <span>
                  <strong>On-chain verification:</strong> Crank-driven (trustless)
                </span>
              </div>
            </div>
          </section>

          {/* Safety guarantee */}
          <section className="rounded-none border-l-2 border-l-[var(--long)] bg-[var(--long)]/5 p-4">
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">
              Safety Guarantee
            </h3>
            <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
              Percolator&apos;s PNL warmup mechanism is verified with:
            </p>
            <ul className="mt-2 space-y-1 text-sm text-[var(--text-secondary)]">
              <li className="flex items-start gap-2">
                <span className="text-[var(--long)]">✓</span>
                <span>
                  <strong>145 Kani formal verification proofs</strong>{" "}
                  (mathematically proven correctness)
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[var(--long)]">✓</span>
                <span>
                  <strong>Comprehensive test suite</strong> covering attack
                  vectors
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[var(--long)]">✓</span>
                <span>
                  <strong>Bypass-proof design</strong> — no way to skip warmup
                </span>
              </li>
            </ul>
            <p className="mt-3 text-xs italic text-[var(--text-dim)]">
              "Most perp DEXs are vulnerable to oracle manipulation. Percolator
              has protection baked into every trade."
            </p>
          </section>

          {/* Comparison */}
          <section>
            <h3 className="mb-2 text-sm font-bold text-[var(--text)]">
              Industry Comparison
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--border)]">
                    <th className="pb-2 text-left font-medium text-[var(--text-dim)]">
                      Platform
                    </th>
                    <th className="pb-2 text-left font-medium text-[var(--text-dim)]">
                      Oracle Protection
                    </th>
                    <th className="pb-2 text-left font-medium text-[var(--text-dim)]">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]/30">
                  <tr>
                    <td className="py-2 font-medium text-[var(--text)]">
                      Percolator
                    </td>
                    <td className="py-2 text-[var(--text-secondary)]">
                      PNL Warmup (8 min)
                    </td>
                    <td className="py-2">
                      <span className="flex items-center gap-1">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--long)]" />
                        <span className="text-[var(--long)]">Protected</span>
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2 font-medium text-[var(--text-dim)]">
                      Most DEXs
                    </td>
                    <td className="py-2 text-[var(--text-secondary)]">
                      None
                    </td>
                    <td className="py-2">
                      <span className="flex items-center gap-1">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--short)]" />
                        <span className="text-[var(--short)]">Vulnerable</span>
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
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

  return typeof document !== "undefined"
    ? createPortal(content, document.body)
    : null;
};
