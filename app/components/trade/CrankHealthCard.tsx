"use client";

import { FC } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useEngineFreshness } from "@/hooks/useEngineFreshness";
import { InfoIcon } from "@/components/ui/Tooltip";
import { readV17AssetSlotLast, readV17MaxAccrualDtSlots } from "@/lib/v17-engine-clock";

// A1: v17 markets carry no legacy engine block, so this card always fell
// through to "Not available on v17 markets yet" — and even the v12 code path
// it was hiding behind is unsafe on v17: v17's parsed RiskParams hardcodes
// maxCrankStalenessSlots to 0n (lib/v17-engine-config.ts has no on-chain
// source for it), which made the ratio math below always compute 0 → "FRESH"
// regardless of true staleness.
//
// The real "is this market still being cranked" signal on v17 is the asset's
// accrue slot (`AssetStateV16Account.slot_last`), which advances only via
// crank/trade — NOT PushAuthMark, the display-price push. Read with the shared
// v18-correct reader (lib/v17-engine-clock.ts; this file used to hardcode the
// v17 512-byte wrapper and read zeros on v18 → permanent "STALE"). The
// threshold is the market's own `max_accrual_dt_slots` — one accrual covers at
// most that many slots, so past it trades/closes start reverting.
const V17_STALE_THRESHOLD_FALLBACK_SLOTS = 500; // live max_accrual_dt_slots on every devnet market

export const CrankHealthCard: FC = () => {
  const { engine, loading, isV17 } = useEngineState();
  const { raw } = useSlabState();
  // Shared, visibility-gated 10s slot ticker (useEngineFreshness) instead of a
  // private 5s getSlot poll — the staleness cliff is ~500 slots (~190s), so
  // 10s granularity loses nothing and this card stops being its own RPC poller.
  const { currentSlot: currentSlotBig } = useEngineFreshness();
  const currentSlot = currentSlotBig === null ? null : Number(currentSlotBig);

  if (loading) {
    return (
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-2">
        <span className="text-[10px] text-[var(--text-secondary)]">Loading...</span>
      </div>
    );
  }

  if (!engine && !isV17) {
    return (
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-2">
        <span className="text-[10px] text-[var(--text-secondary)]">No update data for this market</span>
      </div>
    );
  }

  let lastCrank: number;
  let maxStaleness: number;
  let lifetimeLiquidations: bigint | null;
  let lifetimeForceCloses: bigint | null;

  if (isV17) {
    const slotLast = raw ? readV17AssetSlotLast(raw) : null;
    const maxAccrualDt = raw ? readV17MaxAccrualDtSlots(raw) : null;
    if (slotLast == null) {
      return (
        <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-2">
          <span className="text-[10px] text-[var(--text-secondary)]">No update data for this market</span>
        </div>
      );
    }
    lastCrank = Number(slotLast);
    maxStaleness = maxAccrualDt !== null ? Number(maxAccrualDt) : V17_STALE_THRESHOLD_FALLBACK_SLOTS;
    lifetimeLiquidations = null; // legacy engine-only counter — "—" on v17
    lifetimeForceCloses = null;
  } else {
    lastCrank = Number(engine!.lastCrankSlot ?? 0n);
    maxStaleness = Number(engine!.maxCrankStalenessSlots ?? 0n);
    lifetimeLiquidations = engine!.lifetimeLiquidations ?? 0n;
    lifetimeForceCloses = engine!.lifetimeForceCloses ?? 0n;
  }

  // Until the first cluster-slot read lands (or while it keeps failing from the start) the
  // lag is unknown — not 0, which read as a green FRESH "0.0s ago" even with updates stopped.
  // Clamped: an update can land after the last 10s cluster-slot read (slot_last ahead of it).
  const slotsBehind = currentSlot !== null ? Math.max(0, currentSlot - lastCrank) : null;
  const secondsBehind = slotsBehind !== null ? (slotsBehind * 0.4).toFixed(1) : null;
  const stalenessRatio = slotsBehind !== null && maxStaleness > 0 ? slotsBehind / maxStaleness : 0;
  const progressPercent = Math.min(stalenessRatio * 100, 100);

  let statusLabel: string;
  let statusColor: string;
  let dotColor: string;
  let barColor: string;
  if (slotsBehind === null) {
    statusLabel = "CHECKING";
    statusColor = "text-[var(--text-secondary)]";
    dotColor = "bg-[var(--text-secondary)]";
    barColor = "bg-[var(--text-secondary)]";
  } else if (stalenessRatio < 0.5) {
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
          <span className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">
            Market updates
          </span>
          <InfoIcon tooltip="The market updates funding, liquidation checks and positions continuously, automatically." />
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`inline-block h-2 w-2 rounded-full ${dotColor}`} />
          <span className={`text-[8px] uppercase tracking-[0.15em] ${statusColor}`}>{statusLabel}</span>
        </div>
      </div>

      {/* Staleness progress bar */}
      <div className="mb-1.5">
        <div className="mb-1 flex items-center justify-between text-[9px] text-[var(--text-secondary)]">
          <span>Last update: {secondsBehind !== null ? `${secondsBehind}s ago` : "—"}</span>
          <span>Max: about {Math.max(1, Math.round((maxStaleness * 0.4) / 60))} min</span>
        </div>
        <div className="h-1 w-full rounded-none bg-[var(--border)]">
          <div
            className={`h-1 rounded-none transition-[width,background-color] duration-500 ${barColor}`}
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      {/* Stats — lifetimeLiquidations/lifetimeForceCloses are legacy engine-only
          counters (explicitly nulled in the isV17 branch above), so this grid
          is always dead ("—"/"—") on v17. Omit it there; the staleness bar
          above is v17-correct and stays for both versions. */}
      {!isV17 && (
        <div className="grid grid-cols-2 gap-px">
          <div className="px-1.5 py-1 border-b border-r border-[var(--border)]/20 last:border-r-0 [&:nth-child(2n)]:border-r-0 [&:nth-last-child(-n+2)]:border-b-0">
            <span className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">
              Lifetime Liquidations
            </span>
            <p className="text-[11px] font-medium text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
              {lifetimeLiquidations != null ? Number(lifetimeLiquidations).toLocaleString() : "—"}
            </p>
          </div>
          <div className="px-1.5 py-1 border-b border-r border-[var(--border)]/20 last:border-r-0 [&:nth-child(2n)]:border-r-0 [&:nth-last-child(-n+2)]:border-b-0">
            <span className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">
              Force Closes
            </span>
            <p className="text-[11px] font-medium text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
              {lifetimeForceCloses != null ? Number(lifetimeForceCloses).toLocaleString() : "—"}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
