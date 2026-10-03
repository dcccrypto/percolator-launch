"use client";

import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useOtherModalOpen } from "@/hooks/useOtherModalOpen";

interface MobileTradeBandProps {
  /** Whether the order sheet this band opens is currently open. */
  open: boolean;
  onOpen: () => void;
  /** Short ticket-row label ("Long 2x" etc.), or null for plain "Trade". */
  label: string | null;
  ticketRow: string | null | undefined;
  /** The order sheet's own dialog element — never treated as "another" dialog. */
  sheetRef: RefObject<HTMLElement | null>;
}

/**
 * The mobile "Trade" trigger band (below lg).
 *
 * Portaled to <body>: inline, it sat inside the trade page's `animate-fade-in`
 * wrapper, whose opacity animation forms a stacking context that capped its
 * z-40 and let <Footer> paint over it. In <body> it competes with the layout's
 * `z-[1]` page wrapper instead (40 > 1).
 *
 * That same move means it would now also paint over any dialog still rendered
 * inline in the page wrapper (Add Margin, the oracle panel) — so it steps
 * aside whenever another modal dialog is showing.
 *
 * It docks on top of MobileBottomNav: the calc is that nav's exact height —
 * `min-h-[56px]` + `border-t` (1px) + `env(safe-area-inset-bottom)` — so the
 * two abut with no slit. `md:bottom-0` takes over from md, where the nav hides
 * itself but this trigger is still live up to lg. Fully opaque so content
 * scrolling behind it cannot bleed through.
 */
export function MobileTradeBand({ open, onOpen, label, ticketRow, sheetRef }: MobileTradeBandProps) {
  // Portal gate (same as components/ui/Tooltip.tsx): nothing on the server or
  // the first client pass so hydration matches.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const otherModalOpen = useOtherModalOpen(sheetRef);

  if (!mounted || otherModalOpen) return null;

  return createPortal(
    <div
      data-testid="mobile-trade-band"
      className="fixed inset-x-0 z-40 bottom-[calc(3.5rem+1px+env(safe-area-inset-bottom,0px))] border-t border-[var(--border)] bg-[var(--bg)] md:bottom-0 lg:hidden"
    >
      <button
        onClick={onOpen}
        className="flex min-h-[48px] w-full items-center justify-center gap-2 bg-[var(--accent)]/10 px-4 py-3.5 text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--accent)] transition-colors duration-150 active:bg-[var(--accent)]/25"
        data-testid="mobile-trade-bar"
        data-ticket-row={ticketRow ?? undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span>{label ? `Trade · ${label}` : "Trade"}</span>
        {/* Chevron points up: the ticket opens upward as a bottom sheet. */}
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 15l6-6 6 6" />
        </svg>
      </button>
    </div>,
    document.body,
  );
}
