"use client";

import { FC } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { sanitizeOnChainValue, sanitizeAccountCount } from "@/lib/health";
import { InfoIcon } from "@/components/ui/Tooltip";

function fmtCompact(n: number): string {
  if (!isFinite(n) || n > 1e12 || n < -1e12) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs > 0 && abs < 0.01) return `${sign}<0.01`;
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(2) + "K";
  return n.toFixed(2);
}

export const SystemCapitalCard: FC = () => {
  // insuranceBalance / totalOI / oiLong / oiShort work on BOTH v12 and v17.
  // engine-only fields (vault, cTot, pnlPosTot, numUsedAccounts, LP aggregates)
  // are null on v17 → those rows render "—".
  const { engine, loading, hasData, insuranceBalance, totalOI, oiLong, oiShort } = useEngineState();
  const { config } = useSlabState();
  const tokenMeta = useTokenMeta(config?.collateralMint ?? null);
  const decimals = tokenMeta?.decimals ?? 6;
  const divisor = 10 ** decimals;

  if (loading) {
    return (
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <span className="text-[10px] text-[var(--text-secondary)]">Loading...</span>
      </div>
    );
  }
  if (!hasData) {
    return (
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <span className="text-[10px] text-[var(--text-secondary)]">No capital data for this market</span>
      </div>
    );
  }

  // Cross-version metrics (real on v12 AND v17). Null → "—".
  const fmtAtoms = (v: bigint | null): string =>
    v == null ? "—" : fmtCompact(Number(sanitizeOnChainValue(v)) / divisor);
  const insuranceStr = fmtAtoms(insuranceBalance);
  const totalOIStr = fmtAtoms(totalOI);
  const oiLongStr = fmtAtoms(oiLong);
  const oiShortStr = fmtAtoms(oiShort);

  // Legacy-only (v12 engine block) — "—" when engine is null (v17).
  const vaultStr = engine ? fmtCompact(Number(sanitizeOnChainValue(engine.vault ?? 0n)) / divisor) : "—";
  const cTotStr = engine ? fmtCompact(Number(sanitizeOnChainValue(engine.cTot ?? 0n)) / divisor) : "—";
  const pnlPosTotStr = engine ? fmtCompact(Number(sanitizeOnChainValue(engine.pnlPosTot ?? 0n)) / divisor) : "—";
  const accountsStr = engine ? sanitizeAccountCount(engine.numUsedAccounts ?? 0).toString() : "—";

  // LP aggregates (v12-only). Kept as numbers for the LP Exposure section below.
  const vault = engine ? Number(sanitizeOnChainValue(engine.vault ?? 0n)) / divisor : 0;
  const pnlPosTot = engine ? Number(sanitizeOnChainValue(engine.pnlPosTot ?? 0n)) / divisor : 0;
  const netLp = engine ? Number(sanitizeOnChainValue(engine.netLpPos ?? 0n)) / divisor : 0;
  const lpSum = engine ? Number(sanitizeOnChainValue(engine.lpSumAbs ?? 0n)) / divisor : 0;
  const lpMax = engine ? Number(sanitizeOnChainValue(engine.lpMaxAbs ?? 0n)) / divisor : 0;

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
      value: vaultStr,
      tip: "Total collateral deposited in this market's vault",
    },
    {
      label: "Total Capital",
      value: cTotStr,
      tip: "Sum of all account capital (C_tot). Used for haircut calculations",
    },
    {
      label: "Positive PnL",
      value: pnlPosTotStr,
      tip: "Sum of all winning positions. If this exceeds vault, winners get a proportional haircut",
      color: engine && haircutRisk > 80 ? "text-[var(--short)]" : undefined,
    },
    {
      label: "Insurance",
      value: insuranceStr,
      tip: "Insurance fund balance — absorbs losses from liquidations",
    },
    {
      label: "Open Interest",
      value: totalOIStr,
      tip: "Total open interest across all positions",
    },
    {
      label: "OI Long",
      value: oiLongStr,
      tip: "Open interest held by long positions",
      color: oiLong != null ? "text-[var(--long)]" : undefined,
    },
    {
      label: "OI Short",
      value: oiShortStr,
      tip: "Open interest held by short positions",
      color: oiShort != null ? "text-[var(--short)]" : undefined,
    },
    {
      label: "Active Accounts",
      value: accountsStr,
      tip: "Number of active accounts (traders + LPs) in this market",
    },
  ];

  return (
    <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
      <div className="mb-3 flex items-center gap-1">
        <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-secondary)]">
          System Capital
        </span>
        <InfoIcon tooltip="Aggregate capital metrics from the on-chain risk engine" />
      </div>

      <div className="mb-3 grid grid-cols-2 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="flex flex-col">
            <div className="mb-1 flex items-center gap-1">
              <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-secondary)]">{s.label}</span>
              <InfoIcon tooltip={s.tip} />
            </div>
            <span className={`text-sm font-bold font-mono ${s.color || "text-[var(--text)]"}`}>{s.value}</span>
          </div>
        ))}
      </div>

      {/* LP Exposure Section */}
      <div className="rounded-none border border-[var(--border)]/30 bg-[var(--bg-elevated)] p-2">
        <div className="mb-2 flex items-center gap-1">
          <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-secondary)]">LP Exposure</span>
          <InfoIcon tooltip="LP position aggregates - net exposure drives funding rates, concentration shows whale risk" />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="flex flex-col">
            <span className="text-[9px] text-[var(--text-secondary)]">Net</span>
            <span className={`text-xs font-bold font-mono ${engine ? netLpColor : "text-[var(--text)]"}`}>{engine ? fmtCompact(netLp) : "—"}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-[9px] text-[var(--text-secondary)]">Total</span>
            <span className="text-xs font-bold font-mono text-[var(--text)]">{engine ? fmtCompact(lpSum) : "—"}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-[9px] text-[var(--text-secondary)]">Concentration</span>
            <span className={`text-xs font-bold font-mono ${engine && lpConcentration > 80 ? "text-[var(--short)]" : "text-[var(--text)]"}`}>
              {engine ? `${lpConcentration.toFixed(1)}%` : "—"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
