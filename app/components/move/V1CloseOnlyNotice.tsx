"use client";

import { type FC } from "react";
import Link from "next/link";
import { MOVE_COPY } from "@/lib/v21/move/copy";
import { V1_CLOSE_ONLY_LABEL } from "@/lib/v21/move/ids";

/** The small "v1 · close-only" chip next to a market name. */
export const V1CloseOnlyBadge: FC = () => (
  <span data-testid="v1-close-only-badge" className="ml-1.5 border border-[var(--warning)]/40 px-1.5 py-0.5 align-middle text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--warning)]">
    {V1_CLOSE_ONLY_LABEL}
  </span>
);

/** The ticket notice: what still works, and where to move. */
export const V1CloseOnlyBanner: FC = () => (
  <div role="status" data-testid="v1-close-only-banner" className="mb-3 border border-[var(--warning)]/30 bg-[var(--warning)]/[0.04] px-3 py-2 text-[11px]">
    <p className="font-medium text-[var(--text)]">{MOVE_COPY.closeOnlyBanner}</p>
    <Link href="/move" className="mt-1 inline-block text-[var(--accent)] underline" data-testid="v1-move-link">{MOVE_COPY.closeOnlyLink}</Link>
  </div>
);
