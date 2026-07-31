"use client";

import { FC, useEffect, useRef, useState, useMemo } from "react";
import { createPortal } from "react-dom";
import gsap from "gsap";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useLockBodyScroll } from "@/hooks/useLockBodyScroll";
import { formatTokenAmount, formatUsdPriceE6 } from "@/lib/format";
import { computeMarkPnl, computeMarkPnlCollateral, clampClosePercent } from "@/lib/trading";

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
  /** B-3: Trading fee basis points — subtracted from Est. Receive so the preview matches on-chain. */
  tradingFeeBps?: bigint;
  /** GH#1842: Block submission when oracle price is stale or unavailable */
  oracleStale?: boolean;
  /** PERC-2312: Surfaced close-tx failure (from useClosePosition's `error`) — rendered
   *  inside the modal itself so it's visible to the user regardless of which page
   *  mounts this modal, instead of relying on a banner elsewhere in the page that a
   *  full-screen modal portal would visually cover. */
  error?: string | null;
  /**
   * The market's per-fill cap (matcherCaps.maxFillAbs, base q units), when
   * known. A close bigger than this executes as several batch legs in one
   * transaction (useClosePosition), which is invisible unless we SAY so —
   * without this line the user just sees a bigger fee than the preview
   * implied and no explanation. Null/absent hides the line.
   */
  maxFillAbs?: bigint | null;
  onConfirm: (percent: number) => void;
  onCancel: () => void;
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

const PRESETS = [25, 50, 75, 100];

/**
 * Focusable-element selector for the focus trap. Excludes `[disabled]` controls:
 * a disabled button can never be `document.activeElement`, so if it were the
 * first/last boundary the Tab-wrap would never fire and focus would escape the
 * dialog (Cancel/Confirm here are disabled while `loading`/`oracleStale`).
 */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
  tradingFeeBps = 0n,
  oracleStale = false,
  error = null,
  maxFillAbs = null,
  onConfirm,
  onCancel,
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const prefersReduced = usePrefersReducedMotion();
  useLockBodyScroll();
  const [percent, setPercent] = useState(100);
  // Single clamp source: every write to `percent` goes through here, so the state
  // is always a valid whole [1,100] and every display/math/confirm site below
  // agrees by construction — see clampClosePercent in lib/trading.ts.
  const updatePercent = (value: number) => setPercent(clampClosePercent(value));

  // Ref-based callback to prevent WS price ticks from replaying the GSAP animation
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  // BUG 22 fix: mark a dialog as open on a body-level counter for the whole
  // time this modal is mounted — see the matching comment in
  // TradeConfirmationModal.tsx. `MobileOrderSheet` (app/trade/[slab]/page.tsx)
  // checks this counter and ignores its OWN Escape handler while it's > 0, so
  // a single Escape keypress doesn't both cancel this modal AND collapse the
  // sheet underneath it. Mount/unmount-once (empty deps) — independent of the
  // animation effect below, which can re-run on a `prefersReduced` change.
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

  const colSym = collateralSymbol ?? symbol;
  const absPosition = abs(positionSize);

  // How many matcher fills this close needs (lib/closeChunks.ts does the real
  // split in useClosePosition — this is the same ceil, for the explainer line).
  const closeAbsForFills =
    percent >= 100 ? absPosition : (absPosition * BigInt(clampClosePercent(percent))) / 100n;
  const fillCount =
    maxFillAbs != null && maxFillAbs > 0n && closeAbsForFills > 0n
      ? Number((closeAbsForFills + maxFillAbs - 1n) / maxFillAbs)
      : 1;

  const preview = useMemo(() => {
    const closeAbs = percent >= 100
      ? absPosition
      : (absPosition * BigInt(percent)) / 100n;
    const remainingAbs = absPosition - closeAbs;

    // Compute PnL on the close portion. computeMarkPnl returns coin-margined
    // native units (same scale as positionSize), NOT collateral — convert via
    // computeMarkPnlCollateral before it's combined with any collateral-scale
    // amount (rawReceive below) or shown labeled with the collateral symbol.
    const closePositionSigned = isLong ? closeAbs : -closeAbs;
    const pnlNative = currentPrice > 0n && entryPrice > 0n
      ? computeMarkPnl(closePositionSigned, entryPrice, currentPrice)
      : 0n;
    const pnl = currentPrice > 0n ? computeMarkPnlCollateral(pnlNative, currentPrice) : 0n;

    // Proportional capital for the close portion
    const closeCapital = percent >= 100
      ? capital
      : (capital * BigInt(percent)) / 100n;

    // B-3: Compute the trading fee charged on close (notional * feeBps / 10_000).
    // Without this, "Est. Receive" overstates what the user actually receives on-chain.
    const closeNotional = currentPrice > 0n ? (closeAbs * currentPrice) / 1_000_000n : 0n;
    const closeFee = tradingFeeBps > 0n ? (closeNotional * tradingFeeBps) / 10_000n : 0n;

    // Estimated receive = proportional capital + PnL (collateral-scale) − trading fee (clamped to 0)
    const rawReceive = closeCapital + pnl - closeFee;
    const receive = rawReceive > 0n ? rawReceive : 0n;

    // Derived from the NATIVE pnl + float priceUsd (same pattern ChartPnlBadge
    // uses) — not re-derived from the already-converted `pnl` above, which
    // would double-apply the price.
    const pnlUsd = priceUsd !== null && currentPrice > 0n
      ? (Number(pnlNative) / (10 ** decimals)) * priceUsd
      : null;

    return { closeAbs, remainingAbs, pnl, pnlUsd, closeFee, receive };
  }, [percent, absPosition, isLong, entryPrice, currentPrice, capital, priceUsd, tradingFeeBps]);

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
    style={{ opacity: 0 }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-position-title"
        className="relative w-full max-w-md rounded-none border border-[var(--border)] bg-[var(--bg)] p-6 shadow-2xl"
      style={{ opacity: 0 }}
      >
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 id="close-position-title" className="text-sm font-bold uppercase tracking-[0.15em] text-[var(--text)]">
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
            <span style={{ fontFamily: "var(--font-mono)" }}>{formatUsdPriceE6(entryPrice)}</span> entry
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
            onChange={(e) => updatePercent(Number(e.target.value))}
            style={{
              background: `linear-gradient(to right, var(--short) 0%, var(--short) ${percent}%, rgba(255,255,255,0.03) ${percent}%, rgba(255,255,255,0.03) 100%)`,
              backgroundSize: "100% 2px",
              backgroundPosition: "center",
              backgroundRepeat: "no-repeat",
              height: "20px",
            }}
            className="mb-2 h-1 w-full cursor-pointer appearance-none [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:bg-[var(--short)] [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-none [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[var(--short)] [&::-moz-range-track]:bg-transparent"
          />
          <div className="flex gap-1">
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => updatePercent(p)}
                className={`flex-1 rounded-none py-1 text-[10px] font-medium transition-colors duration-150 ${
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
              {formatTokenAmount(abs(preview.pnl), decimals)} {colSym}
              {preview.pnlUsd !== null && (
                <span className="ml-1 text-[10px]">
                  {/* BUG 23 fix: was `preview.pnlUsd >= 0 ? "+" : ""` — for a
                      negative value that left the prefix EMPTY (not "-"), so
                      -$5.30 rendered as "$5.30" with sign carried only by
                      color. Sign from `preview.pnl` — the same collateral-
                      scale bigint the line above already signs correctly —
                      rather than re-deriving it from the float. */}
                  ({preview.pnl > 0n ? "+" : preview.pnl < 0n ? "-" : ""}${Math.abs(preview.pnlUsd).toFixed(2)})
                </span>
              )}
            </span>
          </div>
          {preview.closeFee > 0n && (
            <div className="flex justify-between">
              <span className="text-[var(--text-dim)]">Trading Fee:</span>
              <span className="font-mono font-medium text-[var(--text-secondary)]">
                −{formatTokenAmount(preview.closeFee, decimals)} {colSym}
              </span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-[var(--text-dim)]">Est. Receive:</span>
            <span className="font-mono font-medium text-[var(--text)]">
              ~{formatTokenAmount(preview.receive, decimals)} {colSym}
            </span>
          </div>
        </div>

        {/* GH#1842: Oracle staleness warning — mirrors TradeForm oracle stale block */}
        {oracleStale && (
          <div className="mb-4 rounded-none border border-[var(--warning)]/30 bg-[var(--warning)]/[0.07] p-2.5">
            <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--warning)]">
              ⚠ Oracle Stale
            </p>
            <p className="mt-1 text-[9px] text-[var(--text-secondary)] leading-relaxed">
              The oracle price has not been updated recently. Closing is temporarily disabled to prevent failed transactions.
            </p>
          </div>
        )}

        {/* Over-cap close: it still lands in ONE transaction, but as several
            matcher fills — say so, or the user sees nothing but a slightly
            different fee than the preview implied. */}
        {fillCount > 1 && (
          <div className="mb-4 rounded-none border border-[var(--border)] bg-[var(--bg)] p-2.5">
            <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-secondary)]">
              Closes as {fillCount} fills
            </p>
            <p className="mt-1 text-[9px] text-[var(--text-secondary)] leading-relaxed">
              This close is larger than the market fills in one trade, so it executes as {fillCount} back-to-back
              fills inside a single transaction — one signature, no extra steps.
            </p>
          </div>
        )}

        {/* PERC-2312: Close-tx failure — was previously swallowed by callers that
            only destructured { closePosition, loading } from useClosePosition and
            dropped `error`, so a failed close just silently re-enabled the modal
            with no feedback. Rendered here (inside the modal) rather than only in
            the parent page so it's visible for however long the modal stays open. */}
        {error && (
          <div className="mb-4 rounded-none border border-[var(--short)]/20 bg-[var(--short)]/5 px-3 py-2">
            <p className="text-[10px] text-[var(--short)]">{error}</p>
          </div>
        )}

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
            disabled={loading || oracleStale}
            className="flex-1 rounded-none bg-[var(--short)] py-2.5 text-[11px] font-medium uppercase tracking-[0.1em] text-white transition-[filter,opacity] duration-150 hover:brightness-110 disabled:opacity-50"
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
