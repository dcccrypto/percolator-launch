"use client";

import { FC, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import gsap from "gsap";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

interface TradeConfirmationModalProps {
  direction: "long" | "short";
  positionSize: bigint;
  margin: bigint;
  leverage: number;
  estimatedLiqPrice: bigint;
  tradingFee: bigint;
  symbol: string;
  decimals: number;
  onConfirm: () => void;
  onCancel: () => void;
}

function formatPerc(native: bigint, decimals = 6): string {
  const abs = native < 0n ? -native : native;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const w = whole.toString();
  return frac ? `${w}.${frac}` : w;
}

export const TradeConfirmationModal: FC<TradeConfirmationModalProps> = ({
  direction,
  positionSize,
  margin,
  leverage,
  estimatedLiqPrice,
  tradingFee,
  symbol,
  decimals,
  onConfirm,
  onCancel,
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const prefersReduced = usePrefersReducedMotion();

  // Keep callback refs so the mount effect never re-runs on parent re-renders.
  // Without this, every WS price tick creates a new onCancel reference which
  // re-triggers the useEffect, replaying the GSAP fade-in animation and making
  // the modal appear to "refresh" constantly.
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

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
      if (e.key === "Escape") onCancelRef.current();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefersReduced]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onCancel();
  };

  const content = (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 p-4"
    style={{ opacity: 0 }}
    >
      <div
        ref={modalRef}
        className="relative w-full max-w-md rounded-none border border-[var(--border)] bg-[var(--bg)] p-6 shadow-2xl"
      style={{ opacity: 0 }}
      >
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-[var(--text)]">
            Confirm Trade
          </h2>
          <button
            onClick={onCancel}
            className="text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
            aria-label="Close"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Warning banner */}
        <div className={`mb-4 rounded-none border p-3 ${
          direction === "long"
            ? "border-[var(--long)]/30 bg-[var(--long)]/5"
            : "border-[var(--short)]/30 bg-[var(--short)]/5"
        }`}>
          <p className="text-[10px] font-medium uppercase tracking-[0.15em]" style={{ color: direction === "long" ? "var(--long)" : "var(--short)" }}>
            {direction === "long" ? "Opening Long Position" : "Opening Short Position"}
          </p>
          <p className="mt-1 text-[10px] text-[var(--text-secondary)]">
            Review the details carefully before confirming. This trade cannot be undone.
          </p>
        </div>

        {/* Trade details */}
        <div className="mb-6 space-y-2 text-xs">
          <div className="flex justify-between">
            <span className="text-[var(--text-dim)]">Position Size:</span>
            <span className="font-mono font-medium text-[var(--text)]">
              {formatPerc(positionSize, decimals)} {symbol}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--text-dim)]">Margin Required:</span>
            <span className="font-mono font-medium text-[var(--text)]">
              {formatPerc(margin, decimals)} {symbol}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--text-dim)]">Leverage:</span>
            <span className="font-mono font-medium text-[var(--text)]">{leverage}x</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--text-dim)]">Trading Fee:</span>
            <span className="font-mono font-medium text-[var(--text)]">
              {formatPerc(tradingFee, decimals)} {symbol}
            </span>
          </div>
          <div className="flex justify-between border-t border-[var(--border)]/30 pt-2">
            <span className="text-[var(--text-dim)]">Est. Liquidation Price:</span>
            <span className="font-mono font-medium text-[var(--short)]">
              {estimatedLiqPrice <= 0n ? "N/A" : `$${formatPerc(estimatedLiqPrice, 6)}`}
            </span>
          </div>
        </div>

        {/* Risk warning */}
        <div className="mb-6 rounded-none border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-3">
          <p className="text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--warning)]">
            ⚠️ Risk Warning
          </p>
          <p className="mt-1 text-[10px] leading-relaxed text-[var(--warning)]/70">
            Leveraged trading carries high risk. You may lose your entire margin if the market moves against you.
            The liquidation price is an estimate and may vary.
          </p>
        </div>

        {/* Action buttons */}
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 rounded-none border border-[var(--border)] py-2.5 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-colors hover:border-[var(--text-muted)] hover:text-[var(--text)]"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 rounded-none py-2.5 text-[11px] font-medium uppercase tracking-[0.1em] text-white transition-all duration-150 hover:brightness-110 ${
              direction === "long" ? "bg-[var(--long)]" : "bg-[var(--short)]"
            }`}
          >
            Confirm Trade
          </button>
        </div>
      </div>
    </div>
  );

  return typeof window !== "undefined" ? createPortal(content, document.body) : null;
};
