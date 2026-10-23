"use client";

import Link from "next/link";
import { useRef } from "react";
import { useClosedPositionNotices } from "@/hooks/useClosedPositionNotices";
import { useOtherModalOpen } from "@/hooks/useOtherModalOpen";
import { formatUsdPriceE6 } from "@/lib/format";
import { describeLiqPrice } from "@/lib/liq-price-display";
import type { ClosedNotice } from "@/lib/closed-positions";

/** Notices shown at once; the rest wait behind them (each is dismissed on its own). */
const MAX_SHOWN = 2;

/** "3 h ago" style age; coarse on purpose, the exact close time is not known. */
export function sinceLabel(fromMs: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (s < 90) return "a minute ago";
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** The notice's sentence parts, kept pure for tests. */
export function noticeCopy(n: ClosedNotice, nowMs: number = Date.now()) {
  const name = n.symbol ? `${n.symbol} ${n.side}` : `${n.side} position`;
  // The shared liquidation-price display decides whether there is a real price to state (margin-health-surfaces
  // guard). The remembered row has no capital or entry, so only a real price is said; "covered"/"unknown" say nothing.
  const liq = describeLiqPrice({
    liqPriceE6: BigInt(n.liqPriceE6 || "0"),
    positionSize: BigInt(n.sizeAbs || "0") * (n.side === "short" ? -1n : 1n),
    capital: null,
    // #3454 made entry and effective size required (margin health = equity over notional). The remembered row
    // (SeenPosition) stores neither, and the notice renders only kind "price" + its text, which depend on
    // liqPriceE6 and the size alone; health is never shown here. So null (unknown) is the true input, not a guess.
    entryPriceE6: null,
    effectiveSize: null,
    markPriceE6: BigInt(n.markE6 || "0"),
    maintenanceMarginBps: 0n,
    hasResolvedEntry: false,
    formatPrice: formatUsdPriceE6,
  });
  const liqText = liq.kind === "price" ? ` Its liquidation price was ${liq.text}.` : "";
  return {
    title: `Your ${name} was closed`,
    body: `You hadn't traded it since we last saw it open ${sinceLabel(n.lastSeenAt, nowMs)}, so the protocol closed it: most likely a liquidation, or the market was settled.${liqText} Any margin left is on that market's Withdraw tab.`,
  };
}

/**
 * A card under the header for each position the protocol closed while the trader was away
 * (useClosedPositionNotices). Top-right, so it never sits on the bottom-corner liquidation-risk card.
 * Stays until dismissed; steps aside while another dialog is open.
 */
export function ClosedPositionNotice() {
  const { notices, dismiss } = useClosedPositionNotices();
  const ref = useRef<HTMLElement | null>(null);
  const otherModalOpen = useOtherModalOpen(ref);
  if (notices.length === 0 || otherModalOpen) return null;
  const shown = notices.slice(0, MAX_SHOWN);

  return (
    <aside
      ref={ref}
      aria-label="Positions closed while you were away"
      data-testid="closed-position-notice"
      className="fixed left-3 right-3 top-[calc(env(safe-area-inset-top,0px)+112px)] z-[85] flex flex-col gap-2 md:left-auto md:right-5 md:w-[360px]"
    >
      <span className="sr-only" role="status">
        {notices.length === 1 ? "1 position was closed while you were away" : `${notices.length} positions were closed while you were away`}
      </span>
      {shown.map((n) => {
        const copy = noticeCopy(n);
        return (
          <div
            key={`${n.key}-${n.lastSeenAt}`}
            className="border border-[var(--short)]/40 bg-[var(--bg)]/95 p-3 shadow-[0_8px_30px_rgba(0,0,0,0.45)] backdrop-blur"
          >
            <div className="flex items-baseline gap-2">
              <span className="inline-block h-1.5 w-1.5 translate-y-[-1px] rounded-full bg-[var(--short)]" aria-hidden />
              <span className="text-[12px] font-medium text-[var(--text)]">{copy.title}</span>
            </div>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">{copy.body}</p>
            <div className="mt-2.5 flex items-center gap-2">
              <Link
                href={`/trade/${n.slab}`}
                onClick={() => dismiss(n.key)}
                className="border border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--text)] transition-colors hover:border-[var(--accent)]/50"
              >
                Go to market
              </Link>
              <button
                type="button"
                onClick={() => dismiss(n.key)}
                className="ml-auto px-2 py-1.5 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text)]"
              >
                Dismiss
              </button>
            </div>
          </div>
        );
      })}
      {notices.length > MAX_SHOWN && (
        <span className="px-1 text-[10.5px] text-[var(--text-secondary)]">+{notices.length - MAX_SHOWN} more after these</span>
      )}
    </aside>
  );
}
