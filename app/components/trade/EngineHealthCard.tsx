"use client";

import { FC } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { computeMarketHealth } from "@/lib/health";
import { formatTokenAmount, formatSlotAge } from "@/lib/format";

const HEALTH_COLORS: Record<string, string> = {
  healthy: "bg-green-900/40 text-green-400",
  caution: "bg-yellow-900/40 text-yellow-400",
  warning: "bg-red-900/40 text-red-400",
  empty: "bg-[#1a1a2e] text-[#71717a]",
};

export const EngineHealthCard: FC = () => {
  const { engine, loading } = useEngineState();
  const { accounts } = useSlabState();

  if (loading || !engine) {
    return (
      <div className="rounded-xl border border-[#1e1e2e] bg-[#12121a] p-5">
        <p className="text-sm text-[#71717a]">{loading ? "Loading..." : "No engine"}</p>
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
    <div className="rounded-xl border border-[#1e1e2e] bg-[#12121a] p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wider text-[#71717a]">Engine Health</h3>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${HEALTH_COLORS[health.level]}`}>
          {health.label}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-x-4 gap-y-3">
        {metrics.map((m) => (
          <div key={m.label}>
            <p className="text-[10px] uppercase text-[#52525b]">{m.label}</p>
            <p className="font-mono text-xs text-[#e4e4e7]">{m.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
};
