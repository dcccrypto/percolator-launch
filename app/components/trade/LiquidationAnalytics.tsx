"use client";

import { FC } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { InfoIcon } from "@/components/ui/Tooltip";

function fmtCompact(n: number): string {
  if (!isFinite(n) || n > 1e12 || n < -1e12) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(2) + "K";
  return n.toFixed(2);
}

export const LiquidationAnalytics: FC = () => {
  const { engine, params, loading } = useEngineState();
  const { config } = useSlabState();
  const tokenMeta = useTokenMeta(config?.collateralMint ?? null);
  const decimals = tokenMeta?.decimals ?? 6;
  const divisor = 10 ** decimals;

  if (loading || !engine) {
    return (
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <span className="text-[10px] text-[var(--text-dim)]">Loading...</span>
      </div>
    );
  }

  const lifetimeLiquidations = Number(engine.lifetimeLiquidations ?? 0n);
  const lifetimeForceCloses = Number(engine.lifetimeForceCloses ?? 0n);
  const insuranceBalance = Number(engine.insuranceFund?.balance ?? 0n) / divisor;
  const totalOI = Number(engine.totalOpenInterest ?? 0n) / divisor;
  const liqFeeBps = params ? Number(params.liquidationFeeBps ?? 0n) : 0;
  const bufferBps = params ? Number(params.liquidationBufferBps ?? 0n) : 0;

  const coveragePercent = totalOI > 0 ? (insuranceBalance / totalOI) * 100 : Infinity;

  let dotColor: string;
  let textColor: string;
  let coverageText: string;
  if (coveragePercent === Infinity || coveragePercent > 100) {
    dotColor = "bg-[var(--long)]";
    textColor = "text-[var(--long)]";
    coverageText = coveragePercent === Infinity ? "∞" : `${coveragePercent.toFixed(1)}%`;
  } else if (coveragePercent >= 10) {
    dotColor = "bg-[var(--warning)]";
    textColor = "text-[var(--warning)]";
    coverageText = `${coveragePercent.toFixed(1)}%`;
  } else {
    dotColor = "bg-[var(--short)]";
    textColor = "text-[var(--short)]";
    coverageText = `${coveragePercent.toFixed(1)}%`;
  }

  const stats = [
    { label: "Liquidations", value: lifetimeLiquidations.toLocaleString(), tip: "Total lifetime liquidations on this market" },
    { label: "Force Closes", value: lifetimeForceCloses.toLocaleString(), tip: "Emergency position closures by the risk engine" },
    { label: "Liq. Fee", value: `${(liqFeeBps / 100).toFixed(2)}%`, tip: "Fee charged on liquidated positions" },
    { label: "Buffer", value: `${(bufferBps / 100).toFixed(2)}%`, tip: "Margin buffer above maintenance to prevent re-liquidation" },
  ];

  return (
    <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
      <div className="mb-3 flex items-center gap-1">
        <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
          Liquidation Analytics
        </span>
        <InfoIcon tooltip="Liquidation metrics and insurance coverage for this market" />
      </div>

      <div className="mb-3 grid grid-cols-2 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="flex flex-col">
            <div className="mb-1 flex items-center gap-1">
              <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">{s.label}</span>
              <InfoIcon tooltip={s.tip} />
            </div>
            <span className="text-sm font-bold text-[var(--text)] font-mono">{s.value}</span>
          </div>
        ))}
      </div>

      <div className="rounded-none border border-[var(--border)]/30 bg-[var(--bg-elevated)] p-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">Insurance Coverage</span>
            <InfoIcon tooltip="Insurance balance as % of open interest. Green = >100%, Yellow = 10-100%, Red = <10%" />
          </div>
          <div className="flex items-center gap-2">
            <span className={`inline-block h-2 w-2 rounded-full ${dotColor}`} />
            <span className={`text-sm font-bold font-mono ${textColor}`}>{coverageText}</span>
          </div>
        </div>
        <div className="mt-1 flex items-center justify-between text-[9px] text-[var(--text-dim)]">
          <span>Insurance: {fmtCompact(insuranceBalance)}</span>
          <span>OI: {fmtCompact(totalOI)}</span>
        </div>
      </div>
    </div>
  );
};
