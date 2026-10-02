"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import type { PnlCardData } from "@/lib/pnl-card";

// The modal pulls in the card + image-capture code; keep it out of the trade /
// portfolio bundles until the button is actually pressed.
const PnlShareModal = dynamic(() => import("@/components/share/PnlShareModal").then((m) => m.PnlShareModal), {
  ssr: false,
});

/**
 * "Share PnL" trigger. `data` is assembled by the caller from its own position
 * context (trade dock or portfolio row); when it's null — no open position, or no
 * known entry to price PnL honestly — the button renders nothing.
 */
export function PnlShareButton({
  data,
  className,
  label = "Share PnL",
  title = "Share your PnL as a card",
}: {
  data: PnlCardData | null;
  className?: string;
  label?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!data) return null;

  return (
    <>
      <button
        type="button"
        title={title}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        className={
          className ??
          "rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] px-2.5 py-1 text-[11px] font-semibold text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/40 hover:text-[var(--text)]"
        }
      >
        {label}
      </button>
      {open && <PnlShareModal data={data} onClose={() => setOpen(false)} />}
    </>
  );
}
