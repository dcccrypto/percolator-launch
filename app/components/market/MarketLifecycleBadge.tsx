"use client";

import { type FC } from "react";
import { LIFECYCLE_HINTS, LIFECYCLE_LABELS, type MarketLifecycleState } from "@/lib/v22/market-lifecycle";

const TONE: Record<MarketLifecycleState, string> = {
  live: "border-[var(--long)]/40 text-[var(--long)]",
  stale: "border-[var(--warning)]/40 text-[var(--warning)]",
  settling: "border-[var(--warning)]/40 text-[var(--warning)]",
  settled: "border-[var(--border)] text-[var(--text-secondary)]",
  retired: "border-[var(--border)] text-[var(--text-secondary)]",
};

/**
 * The state chip next to a market name in the list. A Live market shows nothing (the common case stays quiet); every other state
 * is labelled, with one plain line on hover.
 */
export const MarketLifecycleBadge: FC<{ state: MarketLifecycleState }> = ({ state }) =>
  state === "live" ? null : (
    <span
      data-testid={`lifecycle-badge-${state}`}
      title={LIFECYCLE_HINTS[state]}
      className={`ml-1.5 whitespace-nowrap border px-1.5 py-0.5 align-middle text-[9px] font-medium uppercase tracking-[0.1em] ${TONE[state]}`}
    >
      {LIFECYCLE_LABELS[state]}
    </span>
  );
