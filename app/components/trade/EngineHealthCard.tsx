"use client";

import { FC } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useUsdToggle } from "@/components/providers/UsdToggleProvider";
import { useLivePrice } from "@/hooks/useLivePrice";
import { computeMarketHealth } from "@/lib/health";
import { formatTokenAmount, formatSlotAge } from "@/lib/format";

function formatNum(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const HEALTH_COLORS: Record<string, string> = {
  healthy: "text-[var(--long)]",
  caution: "text-[var(--warning)]",
  warning: "text-[var(--short)]",
  empty: "text-[var(--text-secondary)]",
};

export const EngineHealthCard: FC = () => {
  const { engine, loading } = useEngineState();
  const { accounts } = useSlabState();
  const { showUsd } = useUsdToggle();
  const { priceUsd } = useLivePrice();

  if (loading || !engine) {
    return (
      <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <p className="text-[10px] text-[var(--text-secondary)]">{loading ? "Loading..." : "No engine"}</p>
      </div>
    );
  }

  const health = computeMarketHealth(engine);

  const haircutDenom = engine.cTot + engine.pnlPosTot;
  const haircutPct = haircutDenom > 0n
    ? (Number(engine.pnlPosTot * 10000n / haircutDenom) / 100).toFixed(2) + "%"
    : "0%";

  const netLpPosDisplay = showUsd && priceUsd != null
    ? formatNum((Number(engine.netLpPos < 0n ? -engine.netLpPos : engine.netLpPos) / 1e6) * priceUsd)
    : formatTokenAmount(engine.netLpPos < 0n ? -engine.netLpPos : engine.netLpPos);
  const lpSumAbsDisplay = showUsd && priceUsd != null
    ? formatNum((Number(engine.lpSumAbs) / 1e6) * priceUsd)
    : formatTokenAmount(engine.lpSumAbs);
  const cTotDisplay = showUsd && priceUsd != null
    ? formatNum((Number(engine.cTot) / 1e6) * priceUsd)
    : formatTokenAmount(engine.cTot);
  const pnlPosTotDisplay = showUsd && priceUsd != null
    ? formatNum((Number(engine.pnlPosTot) / 1e6) * priceUsd)
    : formatTokenAmount(engine.pnlPosTot);

  const metrics = [
    { label: "Crank Age", value: formatSlotAge(engine.currentSlot, engine.lastCrankSlot) },
    { label: "Current Slot", value: engine.currentSlot.toLocaleString() },
    { label: "Liquidations", value: engine.lifetimeLiquidations.toLocaleString() },
    { label: "Force Closes", value: engine.lifetimeForceCloses.toLocaleString() },
    { label: "Net LP Pos", value: netLpPosDisplay },
    { label: "LP Sum |Pos|", value: lpSumAbsDisplay },
    { label: "Total Capital", value: cTotDisplay },
    { label: "Pos. PnL Tot", value: pnlPosTotDisplay },
    { label: "Haircut Ratio", value: haircutPct },
    { label: "Liq/GC Cursor", value: `${engine.liqCursor}/${engine.gcCursor}` },
    { label: "Crank Cursor", value: engine.crankCursor.toString() },
    { label: "Sweep Start", value: engine.sweepStartIdx.toString() },
  ];

  return (
    <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className={`text-[10px] font-medium uppercase tracking-[0.15em] ${HEALTH_COLORS[health.level]}${health.level === "warning" || health.level === "caution" ? " animate-pulse" : ""}`}>
          {health.label}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-px">
        {metrics.map((m) => (
          <div key={m.label} className="p-1.5 border-b border-r border-[var(--border)]/20 last:border-r-0 [&:nth-child(3n)]:border-r-0 [&:nth-last-child(-n+3)]:border-b-0">
            <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">{m.label}</p>
            <p className="text-[10px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{m.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
};
