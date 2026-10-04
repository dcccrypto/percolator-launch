"use client";

import { formatCompactUsd, formatPct } from "@/lib/chart/header-stats";
import { formatPerpPrice } from "@/lib/chart/precision";
import type { PerpHeaderStats } from "@/hooks/usePerpHeaderStats";

function Stat({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="flex shrink-0 flex-col" title={title}>
      <span className="text-[9px] uppercase tracking-[0.1em] text-[var(--text-muted)]">{label}</span>
      <span className="text-[12px] tabular-nums text-[var(--text)]">{children}</span>
    </div>
  );
}

export type LiveState = "live" | "delayed" | "offline";

/**
 * The strip above the chart: live price, 24h change, 24h volume, open interest, funding, and a
 * live/delayed marker. Scrolls horizontally on a phone instead of wrapping into the chart.
 *
 * Funding: Percolator accrues funding per slot (continuously), so there is no discrete payment
 * to count down to. We show the hourly-equivalent rate and say it is continuous; for markets
 * where funding is structurally off (every wizard market) the rate is exactly 0 and the chip says so.
 */
export function PerpChartHeader({
  price,
  stats,
  live,
  ageSec,
  seriesLabel,
}: {
  price: number | null;
  stats: PerpHeaderStats;
  live: LiveState;
  ageSec: number | null;
  /** Which series the price and 24h change are computed from (Mark / Oracle / Last). */
  seriesLabel: string;
}) {
  const ch = stats.change;
  const chColor = !ch || ch.pct === 0 ? "text-[var(--text)]" : ch.pct > 0 ? "text-[var(--long)]" : "text-[var(--short)]";
  const f = stats.funding;
  const funding =
    f === undefined ? "…"
    : f === null ? "—"
    : f.enabled ? `${f.hourlyPct >= 0 ? "+" : ""}${f.hourlyPct.toFixed(4)}% / h`
    : "0.0000% / h";
  const fundingTitle =
    f && !f.enabled
      ? "Funding is off on this market (rate is exactly 0)."
      : "Funding accrues continuously, every slot. Shown as the hourly-equivalent rate.";
  const dot = live === "live" ? "bg-[var(--long)]" : live === "delayed" ? "bg-[var(--warning,#f5a524)]" : "bg-[var(--short)]";
  const label = live === "live" ? "Live" : live === "delayed" ? "Delayed" : "Offline";
  return (
    <div className="flex items-end gap-4 overflow-x-auto px-2 py-1.5 [scrollbar-width:none]" data-testid="perp-chart-header">
      <div className="flex shrink-0 flex-col">
        <span className="text-[9px] uppercase tracking-[0.1em] text-[var(--text-muted)]">Price</span>
        <span className="text-sm font-medium tabular-nums text-[var(--text)]" data-testid="perp-price">{formatPerpPrice(price)}</span>
      </div>
      <Stat label="24h" title={`${ch?.partial ? "Since the first available bar (less than 24h of history)" : "Change over the last 24 hours"} · ${seriesLabel} price`}>
        <span className={chColor}>{ch ? `${formatPct(ch.pct)}${ch.partial ? "*" : ""}` : "—"}</span>
      </Stat>
      <Stat label="24h volume">{formatCompactUsd(stats.volume24hUsd)}</Stat>
      <Stat label="Open interest">{formatCompactUsd(stats.oiUsd)}</Stat>
      <Stat label="Funding" title={fundingTitle}>{funding}</Stat>
      <div className="ml-auto flex shrink-0 items-center gap-1.5 pb-0.5 text-[10px] text-[var(--text-muted)]" aria-live="off">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />
        <span>{label}{ageSec !== null && live !== "offline" ? ` ${ageSec < 10 ? ageSec.toFixed(1) : Math.round(ageSec)}s` : ""}</span>
      </div>
    </div>
  );
}
