"use client";

import Link from "next/link";
import { getLiquidationSeverity, type PortfolioPosition } from "@/hooks/usePortfolio";

interface AtRiskBannerProps {
  /** Open positions only — flat/idle deposits always report distancePct=100
   *  ("safe") so passing them in is harmless, but the caller should filter
   *  to positions with a nonzero size for a cheaper pass. */
  positions: PortfolioPosition[];
}

/**
 * Full-width strip listing every position within liquidation-warning
 * distance (see `getLiquidationSeverity` — "warning" <=30%, "danger" <=10%),
 * each linking straight to its market so the trader can act immediately.
 * Renders `null` (zero height) when nothing is at risk — this is a
 * conditional alert surfaced under the header, not decorative chrome.
 */
export function AtRiskBanner({ positions }: AtRiskBannerProps) {
  const atRisk = positions.filter(
    (pos) =>
      (pos.account?.positionSize ?? 0n) !== 0n &&
      getLiquidationSeverity(pos.liquidationDistancePct) !== "safe",
  );
  if (atRisk.length === 0) return null;

  const hasDanger = atRisk.some((pos) => getLiquidationSeverity(pos.liquidationDistancePct) === "danger");

  return (
    <div
      className={`mb-6 flex flex-wrap items-center gap-x-3 gap-y-1.5 border px-4 py-2.5 ${
        hasDanger
          ? "border-[var(--short)]/40 bg-[var(--short)]/5"
          : "border-[var(--warning)]/30 bg-[var(--warning)]/5"
      }`}
    >
      <span
        className={`text-[10px] font-bold uppercase tracking-[0.1em] ${
          hasDanger ? "text-[var(--short)]" : "text-[var(--warning)]"
        }`}
      >
        {hasDanger ? "⚠ Liquidation risk" : "⚡ Approaching liquidation"}
      </span>
      {atRisk.map((pos) => {
        const severity = getLiquidationSeverity(pos.liquidationDistancePct);
        const label = (pos.symbol ?? `${pos.slabAddress.slice(0, 6)}…`).replace(/-PERP$/i, "");
        return (
          <Link
            key={pos.slabAddress}
            href={`/trade/${pos.slabAddress}`}
            className={`text-[11px] font-semibold underline-offset-2 hover:underline ${
              severity === "danger" ? "text-[var(--short)]" : "text-[var(--warning)]"
            }`}
          >
            {label} ({pos.liquidationDistancePct.toFixed(1)}%)
          </Link>
        );
      })}
    </div>
  );
}
