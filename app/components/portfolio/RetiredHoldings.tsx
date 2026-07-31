"use client";

/**
 * "Retired markets holding your funds" — renders ONLY when the connected
 * wallet has capital or an open position in a blocklisted market. Without
 * this section, retirement made that money silently invisible (the portfolio
 * universe is blocklist-filtered by design). Each row links to the trade
 * page, which renders retired markets in close/withdraw-only mode.
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
          Retired markets holding your funds
        </h2>
        <p className="mt-1 text-[10px] leading-relaxed text-[var(--text-secondary)]">
          These markets have been retired and are hidden from the market lists, but your money in
          them is still yours. Open one to close positions or withdraw where the market allows it —
          note that a market locked by an on-chain bankruptcy cannot release funds until it is
          resolved.
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
              <span className="text-[var(--accent)]">manage →</span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
};
