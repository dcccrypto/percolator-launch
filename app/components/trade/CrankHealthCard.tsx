"use client";

import { FC } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { useConnection } from "@solana/wallet-adapter-react";
import { InfoIcon } from "@/components/ui/Tooltip";
import { useEffect, useState } from "react";

export const CrankHealthCard: FC = () => {
  const { engine, loading } = useEngineState();
  const { connection } = useConnection();
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
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <span className="text-[10px] text-[var(--text-dim)]">Loading...</span>
      </div>
    );
  }

  const lastCrank = Number(engine.lastCrankSlot);
  const maxStaleness = Number(engine.maxCrankStalenessSlots);
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
    <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-1">
          <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
            Crank Health
          </span>
          <InfoIcon tooltip="The crank processes funding accrual, liquidation checks, and position updates every slot" />
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`inline-block h-2 w-2 rounded-full ${dotColor}`} />
          <span className={`text-[10px] font-bold uppercase tracking-[0.15em] ${statusColor}`}>{statusLabel}</span>
        </div>
      </div>

      {/* Staleness progress bar */}
      <div className="mb-3">
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
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col">
          <span className="mb-1 text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
            Lifetime Liquidations
          </span>
          <span className="text-sm font-bold text-[var(--text)] font-mono">
            {Number(engine.lifetimeLiquidations).toLocaleString()}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="mb-1 text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
            Force Closes
          </span>
          <span className="text-sm font-bold text-[var(--text)] font-mono">
            {Number(engine.lifetimeForceCloses).toLocaleString()}
          </span>
        </div>
      </div>
    </div>
  );
};
