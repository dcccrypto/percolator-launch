"use client";

import { FC } from "react";

interface ConflictWarningProps {
  tradingFeeBps: number;
  initialMarginBps: number;
}

/**
 * Fee ≥ margin error banner.
 * Shows inline in real time when trading fee exceeds initial margin.
 */
export const ConflictWarning: FC<ConflictWarningProps> = ({
  tradingFeeBps,
  initialMarginBps,
}) => {
  if (tradingFeeBps < initialMarginBps) return null;

  return (
    <div className="border border-[var(--short)]/40 bg-[var(--short)]/[0.04] px-4 py-3 flex items-start gap-3">
      <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center border border-[var(--short)]/30 mt-0.5">
        <span className="text-[10px] text-[var(--short)]">!</span>
      </div>
      <div>
        <p className="text-[12px] font-medium text-[var(--short)]">
          Trading fee ({tradingFeeBps} bps) ≥ initial margin ({initialMarginBps} bps).
        </p>
        <p className="text-[11px] text-[var(--text-secondary)] mt-1">
          Lower the trading fee or increase the initial margin. A single trade would consume the entire margin at these settings.
        </p>
      </div>
    </div>
  );
};
