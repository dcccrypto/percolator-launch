"use client";

import { FC } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { InfoIcon } from "@/components/ui/Tooltip";

function fmtCompact(n: number): string {
  if (n >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(2);
}

export const SystemCapitalCard: FC = () => {
  const { engine, loading } = useEngineState();

  if (loading || !engine) {
    return (
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <span className="text-[10px] text-[var(--text-dim)]">Loading...</span>
      </div>
    );
  }

  const vault = Number(engine.vault);
  const cTot = Number(engine.cTot);
  const pnlPosTot = Number(engine.pnlPosTot);
  const insurance = Number(engine.insuranceFund?.balance ?? 0n);
  const totalOI = Number(engine.totalOpenInterest);
  const netLp = Number(engine.netLpPos);
  const lpSum = Number(engine.lpSumAbs);
  const lpMax = Number(engine.lpMaxAbs);
  const accounts = engine.numUsedAccounts;

  // LP concentration: how much of total LP exposure is one whale
  const lpConcentration = lpSum > 0 ? (lpMax / lpSum) * 100 : 0;

  // Haircut ratio: if pnlPosTot > vault, winners get haircut
  const haircutRisk = vault > 0 ? (pnlPosTot / vault) * 100 : 0;

  // Net LP exposure status
  const netLpAbs = Math.abs(netLp);
  const netLpColor = lpSum > 0 && (netLpAbs / lpSum) > 0.3
    ? "text-[var(--short)]"
    : "text-[var(--long)]";

  const stats = [
    {
      label: "Vault",
      value: fmtCompact(vault),
      tip: "Total collateral deposited in this market's vault",
    },
    {
      label: "Total Capital",
      value: fmtCompact(cTot),
      tip: "Sum of all account capital (C_tot). Used for haircut calculations",
    },
    {
      label: "Positive PnL",
      value: fmtCompact(pnlPosTot),
      tip: "Sum of all winning positions. If this exceeds vault, winners get a proportional haircut",
      color: haircutRisk > 80 ? "text-[var(--short)]" : undefined,
    },
    {
      label: "Insurance",
      value: fmtCompact(insurance),
      tip: "Insurance fund balance — absorbs losses from liquidations",
    },
    {
      label: "Open Interest",
      value: fmtCompact(totalOI),
      tip: "Total open interest across all positions",
    },
    {
      label: "Active Accounts",
      value: accounts.toString(),
      tip: "Number of active accounts (traders + LPs) in this market",
    },
  ];

  return (
    <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
      <div className="mb-3 flex items-center gap-1">
        <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
          System Capital
        </span>
        <InfoIcon tooltip="Aggregate capital metrics from the on-chain risk engine" />
      </div>

      <div className="mb-3 grid grid-cols-2 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="flex flex-col">
            <div className="mb-1 flex items-center gap-1">
              <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">{s.label}</span>
              <InfoIcon tooltip={s.tip} />
            </div>
            <span className={`text-sm font-bold font-mono ${s.color || "text-[var(--text)]"}`}>{s.value}</span>
          </div>
        ))}
      </div>

      {/* LP Exposure Section */}
      <div className="rounded-none border border-[var(--border)]/30 bg-[var(--bg-elevated)] p-2">
        <div className="mb-2 flex items-center gap-1">
          <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">LP Exposure</span>
          <InfoIcon tooltip="LP position aggregates — net exposure drives funding rates, concentration shows whale risk" />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="flex flex-col">
            <span className="text-[9px] text-[var(--text-dim)]">Net</span>
            <span className={`text-xs font-bold font-mono ${netLpColor}`}>{fmtCompact(netLp)}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-[9px] text-[var(--text-dim)]">Total</span>
            <span className="text-xs font-bold font-mono text-[var(--text)]">{fmtCompact(lpSum)}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-[9px] text-[var(--text-dim)]">Concentration</span>
            <span className={`text-xs font-bold font-mono ${lpConcentration > 80 ? "text-[var(--short)]" : "text-[var(--text)]"}`}>
              {lpConcentration.toFixed(1)}%
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
