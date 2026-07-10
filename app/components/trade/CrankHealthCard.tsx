"use client";

import { FC } from "react";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { InfoIcon } from "@/components/ui/Tooltip";
import { useEffect, useState } from "react";
import {
  V17_MARKET_GROUP_OFF,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_ASSET_SLOT_LEN,
} from "@percolatorct/sdk";

// A1: v17 markets carry no legacy engine block, so this card always fell
// through to "Not available on v17 markets yet" — and even the v12 code path
// it was hiding behind is unsafe on v17: v17's parsed RiskParams hardcodes
// maxCrankStalenessSlots to 0n (lib/v17-engine-config.ts has no on-chain
// source for it), which made the ratio math below always compute 0 → "FRESH"
// regardless of true staleness.
//
// The real "is this market still being cranked" signal on v17 is the asset's
// accrue slot (`AssetStateV16Account.slot_last`), which advances only via
// crank/trade — NOT PushAuthMark, the display-price push (see
// v17_engine_accrue_staleness). There is no SDK parser for it yet, so it's
// read directly off raw bytes here. The ~500-slot (~190s) threshold below
// matches the on-chain accrue cliff past which trades/closes/cranks start
// reverting EngineStale(19)/EngineLockActive(21).
//
// Offset derivation (fully-packed repr(C) Pod struct, zero padding — verified
// by reproducing the SDK's own offsets exactly): AssetStateV16Account =
// market_id(8) + retired_slot(8) + lifecycle(1) + raw_oracle_target_price(8) +
// effective_price(8) + fund_px_last(8) = 41 bytes before slot_last (u64).
// Continuing the same packed sum through a_long..oi_eff_long_q lands exactly
// on the SDK's V17_ASSET_STATE_OI_LONG_REL=273, cross-confirming the method.
const V17_ASSET_SLOT_WRAPPER_SIZE = 512; // 512-byte T-wrapper preceding AssetStateV16Account in each slot
const V17_ASSET_STATE_SLOT_LAST_REL = 41; // slot_last offset within AssetStateV16Account
const V17_STALE_THRESHOLD_SLOTS = 500; // ~190s accrue cliff (EngineStale/EngineLockActive)

/** Read `AssetStateV16Account.slot_last` for one asset slot of a v17 market-group account. */
function readV17AssetSlotLast(data: Uint8Array, assetIndex = 0): bigint | null {
  const slotsBase = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN;
  const slotBase = slotsBase + assetIndex * V17_MARKET_ASSET_SLOT_LEN;
  const off = slotBase + V17_ASSET_SLOT_WRAPPER_SIZE + V17_ASSET_STATE_SLOT_LAST_REL;
  if (off + 8 > data.length) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return dv.getBigUint64(off, true);
}

export const CrankHealthCard: FC = () => {
  const { engine, loading, isV17 } = useEngineState();
  const { raw } = useSlabState();
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
        <span className="text-[10px] text-[var(--text-secondary)]">No crank data for this market</span>
      </div>
    );
  }

  let lastCrank: number;
  let maxStaleness: number;
  let lifetimeLiquidations: bigint | null;
  let lifetimeForceCloses: bigint | null;

  if (isV17) {
    const slotLast = raw ? readV17AssetSlotLast(raw) : null;
    if (slotLast == null) {
      return (
        <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-2">
          <span className="text-[10px] text-[var(--text-secondary)]">No crank data for this market</span>
        </div>
      );
    }
    lastCrank = Number(slotLast);
    maxStaleness = V17_STALE_THRESHOLD_SLOTS;
    lifetimeLiquidations = null; // legacy engine-only counter — "—" on v17
    lifetimeForceCloses = null;
  } else {
    lastCrank = Number(engine!.lastCrankSlot ?? 0n);
    maxStaleness = Number(engine!.maxCrankStalenessSlots ?? 0n);
    lifetimeLiquidations = engine!.lifetimeLiquidations ?? 0n;
    lifetimeForceCloses = engine!.lifetimeForceCloses ?? 0n;
  }

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
          <span className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">
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
        <div className="mb-1 flex items-center justify-between text-[9px] text-[var(--text-secondary)]">
          <span>Last update: {secondsBehind}s ago ({slotsBehind.toLocaleString()} slots)</span>
          <span>Max: {maxStaleness.toLocaleString()} slots</span>
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
