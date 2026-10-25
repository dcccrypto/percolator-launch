"use client";

/**
 * "Positions in settled and retired markets" — renders ONLY when the connected wallet has capital or an open position in a
 * market that is Resolved (settled) or blocklisted. Without this section, settling or retiring a market made that money silently
 * invisible (the portfolio universe is blocklist-filtered by design). Each row links to the market page, whose claim panel lists
 * what can be collected and the next step (lib/v22/resolved-claims.ts).
 */
import { FC } from "react";
import Link from "next/link";
import { useRetiredHoldings } from "@/hooks/useRetiredHoldings";
import { formatTokenAmount } from "@/lib/format";

export const RetiredHoldings: FC = () => {
  const { holdings } = useRetiredHoldings();
  if (holdings.length === 0) return null;

  return (
    <section className="mt-6 border border-[var(--short)]/30 bg-[var(--short)]/[0.04]">
      <div className="border-b border-[var(--short)]/20 px-4 py-2.5">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.15em] text-[var(--short)]">
          Positions in settled and retired markets
        </h2>
        <p className="mt-1 text-[10px] leading-relaxed text-[var(--text-secondary)]">
          These markets are settled or retired, and may be hidden from the market lists, but your money in
          them is still yours. Open one to see what you can collect and the next step. This list is positions only:
          Earn deposits are on the Earn page and stake is on the Stake page.
        </p>
      </div>
      <div className="divide-y divide-[var(--border)]/30">
        {holdings.map((h) => (
          <Link
            key={h.slabAddress}
            href={`/trade/${h.slabAddress}`}
            className="flex items-center justify-between px-4 py-2.5 transition-colors hover:bg-[var(--bg-elevated)]"
          >
            <span
              className="text-[11px] text-[var(--text)]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {h.slabAddress.slice(0, 4)}…{h.slabAddress.slice(-4)}
            </span>
            <span className="flex items-center gap-4 text-[11px] font-mono tabular-nums">
              <span className="text-[var(--text)]">
                {formatTokenAmount(h.capital, 6)} USDC deposited
              </span>
              {h.positionSizeQ !== 0n && (
                <span className="text-[var(--text-secondary)]">+ open position</span>
              )}
              <span data-testid="retired-holding-state" className="text-[var(--text-secondary)]">{h.settled ? "settled" : "retired"}</span>
              <span className="text-[var(--accent)]">{h.settled ? "claim →" : "manage →"}</span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
};
