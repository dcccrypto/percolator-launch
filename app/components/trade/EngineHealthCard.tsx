"use client";

import { FC } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
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
  const { accounts, config } = useSlabState();
  const tokenMeta = useTokenMeta(config?.collateralMint ?? null);
  const decimals = tokenMeta?.decimals ?? 6;
  const { showUsd } = useUsdToggle();
  const { priceUsd } = useLivePrice();

  if (loading || !engine) {
    return (
      <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-2">
        <p className="text-[10px] text-[var(--text-secondary)]">{loading ? "Loading..." : "No engine"}</p>
      </div>
    );
  }

  const health = computeMarketHealth(engine);

  const cTot = engine.cTot ?? 0n;
  const pnlPosTot = engine.pnlPosTot ?? 0n;
  const netLpPos = engine.netLpPos ?? 0n;
  const lpSumAbs = engine.lpSumAbs ?? 0n;

  const haircutDenom = cTot + pnlPosTot;
  const haircutPct = haircutDenom > 0n
    ? (Number(pnlPosTot * 10000n / haircutDenom) / 100).toFixed(2) + "%"
    : "0%";

  const netLpPosDisplay = showUsd && priceUsd != null
    ? formatNum((Number(netLpPos < 0n ? -netLpPos : netLpPos) / (10 ** decimals)) * priceUsd)
    : formatTokenAmount(netLpPos < 0n ? -netLpPos : netLpPos, decimals);
  const lpSumAbsDisplay = showUsd && priceUsd != null
    ? formatNum((Number(lpSumAbs) / (10 ** decimals)) * priceUsd)
    : formatTokenAmount(lpSumAbs, decimals);
  const cTotDisplay = showUsd && priceUsd != null
    ? formatNum((Number(cTot) / (10 ** decimals)) * priceUsd)
    : formatTokenAmount(cTot, decimals);
  const pnlPosTotDisplay = showUsd && priceUsd != null
    ? formatNum((Number(pnlPosTot) / (10 ** decimals)) * priceUsd)
    : formatTokenAmount(pnlPosTot, decimals);

  const metrics = [
    { label: "Crank Age", value: formatSlotAge(engine.currentSlot ?? 0n, engine.lastCrankSlot ?? 0n) },
    { label: "Current Slot", value: Number(engine.currentSlot ?? 0n).toLocaleString() },
    { label: "Liquidations", value: (engine.lifetimeLiquidations ?? 0n).toLocaleString() },
    { label: "Force Closes", value: (engine.lifetimeForceCloses ?? 0n).toLocaleString() },
    { label: "Net LP Pos", value: netLpPosDisplay },
    { label: "LP Sum |Pos|", value: lpSumAbsDisplay },
    { label: "Total Capital", value: cTotDisplay },
    { label: "Pos. PnL Tot", value: pnlPosTotDisplay },
    { label: "Haircut Ratio", value: haircutPct },
    { label: "Liq/GC Cursor", value: `${engine.liqCursor ?? "—"}/${engine.gcCursor ?? "—"}` },
    { label: "Crank Cursor", value: engine.crankCursor?.toString() ?? "—" },
    { label: "Sweep Start", value: engine.sweepStartIdx?.toString() ?? "—" },
  ];

  return (
    <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className={`text-[10px] font-medium uppercase tracking-[0.15em] ${HEALTH_COLORS[health.level]}${health.level === "warning" || health.level === "caution" ? " animate-pulse" : ""}`}>
          {health.label}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-px">
        {metrics.map((m) => (
          <div key={m.label} className="px-1.5 py-1 border-b border-r border-[var(--border)]/20 last:border-r-0 [&:nth-child(3n)]:border-r-0 [&:nth-last-child(-n+3)]:border-b-0">
            <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">{m.label}</p>
            <p className="text-[11px] font-medium text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{m.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
};
