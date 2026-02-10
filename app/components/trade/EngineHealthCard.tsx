"use client";

import { FC } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { computeMarketHealth } from "@/lib/health";
import { formatTokenAmount, formatSlotAge } from "@/lib/format";

const HEALTH_COLORS: Record<string, string> = {
  healthy: "bg-[var(--long)]/10 text-[var(--long)]",
  caution: "bg-[var(--warning)]/10 text-[var(--warning)]",
  warning: "bg-[var(--short)]/10 text-[var(--short)]",
  empty: "bg-[var(--bg-surface)] text-[var(--text-secondary)]",
};

export const EngineHealthCard: FC = () => {
  const { engine, loading } = useEngineState();
  const { accounts } = useSlabState();

  if (loading || !engine) {
    return (
      <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-5">
        <p className="text-sm text-[var(--text-secondary)]">{loading ? "Loading..." : "No engine"}</p>
      </div>
    );
  }

  const health = computeMarketHealth(engine);

  // Haircut ratio: pnlPosTot / (cTot + pnlPosTot)
  const haircutDenom = engine.cTot + engine.pnlPosTot;
  const haircutPct = haircutDenom > 0n
    ? (Number(engine.pnlPosTot * 10000n / haircutDenom) / 100).toFixed(2) + "%"
    : "0%";

  const metrics = [
    { label: "Crank Age", value: formatSlotAge(engine.currentSlot, engine.lastCrankSlot) },
    { label: "Current Slot", value: engine.currentSlot.toLocaleString() },
    { label: "Liquidations", value: engine.lifetimeLiquidations.toLocaleString() },
    { label: "Force Closes", value: engine.lifetimeForceCloses.toLocaleString() },
    { label: "Net LP Pos", value: formatTokenAmount(engine.netLpPos < 0n ? -engine.netLpPos : engine.netLpPos) },
    { label: "LP Sum |Pos|", value: formatTokenAmount(engine.lpSumAbs) },
    { label: "Total Capital", value: formatTokenAmount(engine.cTot) },
    { label: "Pos. PnL Tot", value: formatTokenAmount(engine.pnlPosTot) },
    { label: "Haircut Ratio", value: haircutPct },
    { label: "Liq/GC Cursor", value: `${engine.liqCursor}/${engine.gcCursor}` },
    { label: "Crank Cursor", value: engine.crankCursor.toString() },
    { label: "Sweep Start", value: engine.sweepStartIdx.toString() },
  ];

  return (
    <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wider text-[var(--text-secondary)]">Engine Health</h3>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${HEALTH_COLORS[health.level]}${health.level === "warning" || health.level === "caution" ? " animate-pulse" : ""}`}>
          {health.label}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-x-4 gap-y-3">
        {metrics.map((m) => (
          <div key={m.label} className="rounded-sm p-2 transition-colors duration-150 hover:bg-[var(--accent)]/[0.06]">
            <p className="text-[10px] uppercase text-[var(--text-muted)]">{m.label}</p>
            <p className="font-mono text-xs text-[var(--text)]">{m.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
};
