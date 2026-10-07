"use client";

import { FC, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import gsap from "gsap";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useLockBodyScroll } from "@/hooks/useLockBodyScroll";
import { ClosePositionForm } from "@/components/trade/ClosePositionForm";

interface ClosePositionModalProps {
  positionSize: bigint;
  entryPrice: bigint;
  currentPrice: bigint;
  capital: bigint;
  /** Index asset symbol for position size (e.g. "SOL") */
  symbol: string;
  /** Collateral symbol for PnL/capital amounts (e.g. "USDC"). Falls back to symbol. */
  collateralSymbol?: string;
  decimals: number;
  priceUsd: number | null;
  isLong: boolean;
  loading: boolean;
  /** B-3: Trading fee basis points — subtracted from Est. Account Balance After so the preview matches on-chain. */
  tradingFeeBps?: bigint;
  /** GH#1842: Block submission when oracle price is stale or unavailable */
  oracleStale?: boolean;
  /** PERC-2312: Surfaced close-tx failure (from useClosePosition's `error`). */
  error?: string | null;
  /** The market's per-fill cap (matcherCaps.maxFillAbs), when known. */
  maxFillAbs?: bigint | null;
  /** ADL state unknown: withhold the raw-size preview (see ClosePositionFormProps). */
  previewUnavailable?: boolean;
  onConfirm: (percent: number) => void;
  onCancel: () => void;
}

/**
 * Focusable-element selector for the focus trap. Excludes `[disabled]` controls:
 * a disabled button can never be `document.activeElement`, so if it were the
 * first/last boundary the Tab-wrap would never fire and focus would escape the
 * dialog (Cancel/Confirm here are disabled while `loading`/`oracleStale`).
 */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Full-screen dialog wrapper around the shared ClosePositionForm — the portal,
 * overlay, entrance animation, body-scroll lock, and focus trap. The close
 * controls + PnL/fee/receive math live in ClosePositionForm (also rendered
 * inline in the order ticket's Close tab), so the two can never drift.
 */
export const ClosePositionModal: FC<ClosePositionModalProps> = ({
  positionSize,
  entryPrice,
  currentPrice,
  capital,
  symbol,
  collateralSymbol,
  decimals,
  priceUsd,
  isLong,
  loading,
  tradingFeeBps,
  oracleStale = false,
  error = null,
  maxFillAbs = null,
  previewUnavailable = false,
  onConfirm,
  onCancel,
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const prefersReduced = usePrefersReducedMotion();
  useLockBodyScroll();

  // Ref-based callback to prevent WS price ticks from replaying the GSAP animation
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  // BUG 22 fix: mark a dialog as open on a body-level counter for the whole
  // time this modal is mounted — see the matching comment in
  // TradeConfirmationModal.tsx. MobileOrderSheet checks this counter and ignores
  // its own Escape handler while it's > 0, so one Escape doesn't both cancel this
  // modal AND collapse the sheet underneath it.
  useEffect(() => {
    const current = Number(document.body.dataset.percOpenDialogs ?? "0");
    document.body.dataset.percOpenDialogs = String(current + 1);
    return () => {
      const remaining = Number(document.body.dataset.percOpenDialogs ?? "1") - 1;
      if (remaining <= 0) delete document.body.dataset.percOpenDialogs;
      else document.body.dataset.percOpenDialogs = String(remaining);
    };
  }, []);

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
      gsap.fromTo(modal, { opacity: 0, scale: 0.95 }, { opacity: 1, scale: 1, duration: 0.25, ease: "power2.out" });
    }

    // Move initial focus inside the dialog (APG dialog pattern) so Tab starts trapped.
    const focusable = modal.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    focusable[0]?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancelRef.current();
        return;
      }
      if (e.key === "Tab") {
        const items = modal.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefersReduced]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onCancel();
  };

  const content = (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-[9999] flex justify-center overflow-y-auto overscroll-contain bg-black/80 p-4"
      style={{ opacity: 0 }}
    >
      <div
        ref={modalRef}
        role="dialog"
        data-testid="close-modal"
        aria-modal="true"
        aria-labelledby="close-position-title"
        className="relative my-auto w-full max-w-md rounded-none border border-[var(--border)] bg-[var(--bg)] p-6 shadow-2xl"
        style={{ opacity: 0 }}
      >
        <ClosePositionForm
          variant="modal"
          positionSize={positionSize}
          entryPrice={entryPrice}
          currentPrice={currentPrice}
          capital={capital}
          symbol={symbol}
          collateralSymbol={collateralSymbol}
          decimals={decimals}
          priceUsd={priceUsd}
          isLong={isLong}
          loading={loading}
          tradingFeeBps={tradingFeeBps}
          oracleStale={oracleStale}
          error={error}
          maxFillAbs={maxFillAbs}
          previewUnavailable={previewUnavailable}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      </div>
    </div>
  );

  return typeof window !== "undefined" ? createPortal(content, document.body) : null;
};
