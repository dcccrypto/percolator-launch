"use client";

import { FC, useEffect, useRef, useState, useMemo } from "react";
import { createPortal } from "react-dom";
import gsap from "gsap";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { formatTokenAmount, formatUsd } from "@/lib/format";
import { computeMarkPnl } from "@/lib/trading";

interface ClosePositionModalProps {
  positionSize: bigint;
  entryPrice: bigint;
  currentPrice: bigint;
  capital: bigint;
  symbol: string;
  decimals: number;
  priceUsd: number | null;
  isLong: boolean;
  loading: boolean;
  onConfirm: (percent: number) => void;
  onCancel: () => void;
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

const PRESETS = [25, 50, 75, 100];

export const ClosePositionModal: FC<ClosePositionModalProps> = ({
  positionSize,
  entryPrice,
  currentPrice,
  capital,
  symbol,
  decimals,
  priceUsd,
  isLong,
  loading,
  onConfirm,
  onCancel,
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const prefersReduced = usePrefersReducedMotion();
  const [percent, setPercent] = useState(100);

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
        { opacity: 1, duration: 0.2, ease: "power2.out" },
      );
      gsap.fromTo(
        modal,
        { opacity: 0, scale: 0.95 },
        { opacity: 1, scale: 1, duration: 0.25, ease: "power2.out" },
      );
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onCancel, prefersReduced]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onCancel();
  };

  const absPosition = abs(positionSize);

  const preview = useMemo(() => {
    const closeAbs = percent >= 100
      ? absPosition
      : (absPosition * BigInt(percent)) / 100n;
    const remainingAbs = absPosition - closeAbs;

    // Compute PnL on the close portion
    const closePositionSigned = isLong ? closeAbs : -closeAbs;
    const pnl = currentPrice > 0n
      ? computeMarkPnl(closePositionSigned, entryPrice, currentPrice)
      : 0n;

    // Proportional capital for the close portion
    const closeCapital = percent >= 100
      ? capital
      : (capital * BigInt(percent)) / 100n;

    // Estimated receive = proportional capital + PnL (clamped to 0)
    const rawReceive = closeCapital + pnl;
    const receive = rawReceive > 0n ? rawReceive : 0n;

    const pnlUsd = priceUsd !== null && currentPrice > 0n
      ? (Number(pnl) / (10 ** decimals)) * priceUsd
      : null;

    return { closeAbs, remainingAbs, pnl, pnlUsd, receive };
  }, [percent, absPosition, isLong, entryPrice, currentPrice, capital, priceUsd]);

  const pnlColor =
    preview.pnl === 0n
      ? "text-[var(--text-muted)]"
      : preview.pnl > 0n
        ? "text-[var(--long)]"
        : "text-[var(--short)]";

  const content = (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 p-4"
    >
      <div
        ref={modalRef}
        className="relative w-full max-w-md rounded-none border border-[var(--border)] bg-[var(--bg)] p-6 shadow-2xl"
      >
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-[var(--text)]">
            Close Position
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

        {/* Position info banner */}
        <div className={`mb-4 rounded-none border p-3 ${
          isLong
            ? "border-[var(--long)]/30 bg-[var(--long)]/5"
            : "border-[var(--short)]/30 bg-[var(--short)]/5"
        }`}>
          <p className="text-[10px] font-medium uppercase tracking-[0.15em]" style={{ color: isLong ? "var(--long)" : "var(--short)" }}>
            Closing {isLong ? "Long" : "Short"} Position
          </p>
          <p className="mt-1 text-[10px] text-[var(--text-secondary)]">
            <span style={{ fontFamily: "var(--font-mono)" }}>{formatTokenAmount(absPosition, decimals)}</span> {symbol} at{" "}
            <span style={{ fontFamily: "var(--font-mono)" }}>{formatUsd(entryPrice)}</span> entry
          </p>
        </div>

        {/* Percentage slider */}
        <div className="mb-4">
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Close Amount</label>
            <span className="text-[11px] font-medium text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{percent}%</span>
          </div>
          <input
            type="range"
            min={1}
            max={100}
            step={1}
            value={percent}
            onChange={(e) => setPercent(Number(e.target.value))}
            style={{
              background: `linear-gradient(to right, var(--short) 0%, var(--short) ${percent}%, rgba(255,255,255,0.03) ${percent}%, rgba(255,255,255,0.03) 100%)`,
            }}
            className="mb-2 h-1 w-full cursor-pointer appearance-none [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:bg-[var(--short)]"
          />
          <div className="flex gap-1">
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => setPercent(p)}
                className={`flex-1 rounded-none py-1 text-[10px] font-medium transition-all duration-150 ${
                  percent === p
                    ? "bg-[var(--short)] text-white"
                    : "border border-[var(--border)]/30 text-[var(--text-muted)] hover:border-[var(--short)]/30 hover:text-[var(--text-secondary)]"
                }`}
              >
                {p}%
              </button>
            ))}
          </div>
        </div>

        {/* Preview details */}
        <div className="mb-6 space-y-2 text-xs">
          <div className="flex justify-between">
            <span className="text-[var(--text-dim)]">Close Size:</span>
            <span className="font-mono font-medium text-[var(--text)]">
              {formatTokenAmount(preview.closeAbs, decimals)} {symbol}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--text-dim)]">Remaining:</span>
            <span className="font-mono font-medium text-[var(--text)]">
              {formatTokenAmount(preview.remainingAbs, decimals)} {symbol}
            </span>
          </div>
          <div className="flex justify-between border-t border-[var(--border)]/30 pt-2">
            <span className="text-[var(--text-dim)]">Est. PnL:</span>
            <span className={`font-mono font-medium ${pnlColor}`}>
              {preview.pnl > 0n ? "+" : preview.pnl < 0n ? "-" : ""}
              {formatTokenAmount(abs(preview.pnl), decimals)} {symbol}
              {preview.pnlUsd !== null && (
                <span className="ml-1 text-[10px]">
                  ({preview.pnlUsd >= 0 ? "+" : ""}${Math.abs(preview.pnlUsd).toFixed(2)})
                </span>
              )}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--text-dim)]">Est. Receive:</span>
            <span className="font-mono font-medium text-[var(--text)]">
              ~{formatTokenAmount(preview.receive, decimals)} {symbol}
            </span>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            disabled={loading}
            className="flex-1 rounded-none border border-[var(--border)] py-2.5 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-colors hover:border-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(percent)}
            disabled={loading}
            className="flex-1 rounded-none bg-[var(--short)] py-2.5 text-[11px] font-medium uppercase tracking-[0.1em] text-white transition-all duration-150 hover:brightness-110 disabled:opacity-50"
          >
            {loading ? (
              <span className="inline-flex items-center gap-2">
                <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Closing...
              </span>
            ) : (
              `Close ${percent}%`
            )}
          </button>
        </div>
      </div>
    </div>
  );

  return typeof window !== "undefined" ? createPortal(content, document.body) : null;
};
