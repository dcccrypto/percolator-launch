"use client";

import { type FC } from "react";

/** The small "withdraw only" chip next to a market name in the list (v2.2 preview: a market kept for holders to exit). */
export const WithdrawOnlyBadge: FC = () => (
  <span
    data-testid="withdraw-only-badge"
    title="Close any position and withdraw. No new positions."
    className="ml-1.5 whitespace-nowrap border border-[var(--warning)]/40 px-1.5 py-0.5 align-middle text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--warning)]"
  >
    Withdraw only
  </span>
);
