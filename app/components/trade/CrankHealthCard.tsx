"use client";

import { FC } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { InfoIcon } from "@/components/ui/Tooltip";
import { useEffect, useState } from "react";

export const CrankHealthCard: FC = () => {
  const { engine, loading } = useEngineState();
  const { connection } = useConnectionCompat();
  const [currentSlot, setCurrentSlot] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      try {
        const slot = await connection.getSlot();
        if (!cancelled) setCurrentSlot(slot);
      } catch { /* ignore */ }
    };
    fetch();
    const interval = setInterval(fetch, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [connection]);

  if (loading || !engine) {
    return (
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-2">
        <span className="text-[10px] text-[var(--text-dim)]">Loading...</span>
      </div>
    );
  }

  const lastCrank = Number(engine.lastCrankSlot ?? 0n);
  const maxStaleness = Number(engine.maxCrankStalenessSlots ?? 0n);
  const slotsBehind = currentSlot ? currentSlot - lastCrank : 0;
  const secondsBehind = (slotsBehind * 0.4).toFixed(1);
  const stalenessRatio = maxStaleness > 0 ? slotsBehind / maxStaleness : 0;
  const progressPercent = Math.min(stalenessRatio * 100, 100);

  let statusLabel: string;
  let statusColor: string;
  let dotColor: string;
  let barColor: string;
  if (stalenessRatio < 0.5) {
    statusLabel = "FRESH";
    statusColor = "text-[var(--long)]";
    dotColor = "bg-[var(--long)]";
    barColor = "bg-[var(--long)]";
  } else if (stalenessRatio < 0.9) {
    statusLabel = "AGING";
    statusColor = "text-[var(--warning)]";
    dotColor = "bg-[var(--warning)]";
    barColor = "bg-[var(--warning)]";
  } else {
    statusLabel = "STALE";
    statusColor = "text-[var(--short)]";
    dotColor = "bg-[var(--short)]";
    barColor = "bg-[var(--short)]";
  }

  return (
    <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-1">
          <span className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
            Crank Health
          </span>
          <InfoIcon tooltip="The crank processes funding accrual, liquidation checks, and position updates every slot" />
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`inline-block h-2 w-2 rounded-full ${dotColor}`} />
          <span className={`text-[8px] uppercase tracking-[0.15em] ${statusColor}`}>{statusLabel}</span>
        </div>
      </div>

      {/* Staleness progress bar */}
      <div className="mb-1.5">
        <div className="mb-1 flex items-center justify-between text-[9px] text-[var(--text-dim)]">
          <span>Last update: {secondsBehind}s ago ({slotsBehind.toLocaleString()} slots)</span>
          <span>Max: {maxStaleness.toLocaleString()} slots</span>
        </div>
        <div className="h-1 w-full rounded-none bg-[var(--border)]">
          <div
            className={`h-1 rounded-none transition-all duration-500 ${barColor}`}
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-px">
        <div className="px-1.5 py-1 border-b border-r border-[var(--border)]/20 last:border-r-0 [&:nth-child(2n)]:border-r-0 [&:nth-last-child(-n+2)]:border-b-0">
          <span className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
            Lifetime Liquidations
          </span>
          <p className="text-[11px] font-medium text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
            {Number(engine.lifetimeLiquidations ?? 0n).toLocaleString()}
          </p>
        </div>
        <div className="px-1.5 py-1 border-b border-r border-[var(--border)]/20 last:border-r-0 [&:nth-child(2n)]:border-r-0 [&:nth-last-child(-n+2)]:border-b-0">
          <span className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
            Force Closes
          </span>
          <p className="text-[11px] font-medium text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
            {Number(engine.lifetimeForceCloses ?? 0n).toLocaleString()}
          </p>
        </div>
      </div>
    </div>
  );
};
