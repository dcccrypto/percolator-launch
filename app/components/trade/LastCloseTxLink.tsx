"use client";

import type { FC } from "react";
import { explorerTxUrl } from "@/lib/config";
import { useLastCloseEntry } from "@/lib/last-close-tx";

/** "Position closed · View transaction" for the market's most recent close (QA minor: the signature used to vanish with the row). */
export const LastCloseTxLink: FC<{ slabAddress: string; className?: string }> = ({ slabAddress, className = "" }) => {
  const entry = useLastCloseEntry(slabAddress);
  if (!entry) return null;
  const sig = entry.signature;
  return (
    <p data-testid="last-close-tx" className={`text-[11px] text-[var(--text-secondary)] ${className}`}>
      {entry.label ?? (entry.partial ? "Partly closed." : "Position closed.")}{" "}
      <a href={explorerTxUrl(sig)} target="_blank" rel="noopener noreferrer" title={sig} className="underline hover:text-[var(--text)]">
        View transaction {sig.slice(0, 4)}…{sig.slice(-4)} <span aria-hidden="true">↗</span>
      </a>
    </p>
  );
};
