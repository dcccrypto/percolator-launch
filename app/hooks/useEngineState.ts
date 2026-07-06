"use client";

import { useMemo } from "react";
import { useSlabState } from "@/components/providers/SlabProvider";
import {
  isV17Account,
  parseMarketGroupV17OI,
  type EngineState,
  type RiskParams,
  type InsuranceFund,
} from "@percolatorct/sdk";

export interface DerivedEngineState {
  engine: EngineState | null;
  params: RiskParams | null;
  insuranceFund: InsuranceFund | null;
  /** Insurance-fund balance (atoms). Works on BOTH v12 (engine) and v17 (market-group). */
  insuranceBalance: bigint | null;
  vault: bigint | null;
  /** Total open interest = long + short (atoms). v12 engine or v17 market-group. */
  totalOI: bigint | null;
  oiLong: bigint | null;
  oiShort: bigint | null;
  fundingRate: bigint | null;
  /** True for a v17 market (no legacy engine block; metrics come from the slab group). */
  isV17: boolean;
  /** True when there's real market data to render (v12 engine OR v17 group parsed ok). */
  hasData: boolean;
  loading: boolean;
}

/**
 * Market-level engine/health metrics for the dashboard cards.
 *
 * v12 markets carry a legacy engine block (`useSlabState().engine`). v17 markets
 * DON'T — that block is null — so historically every card fell back to
 * "Not available on v17 markets yet". The equivalent v17 data lives in the slab's
 * market group: `parseMarketGroupV17OI(raw)` yields the live insurance-fund
 * balance + long/short open interest. This hook now surfaces those so the cards
 * render real numbers on v17. (Legacy-only fields — cTot/pnlPos/crank counters —
 * stay null on v17; cards show "—" for those specific rows.)
 */
export function useEngineState(): DerivedEngineState {
  const { engine, params, loading, raw } = useSlabState();
  return useMemo(() => {
    const rawBytes = raw ?? null;
    const isV17 =
      !engine && rawBytes != null && rawBytes.length > 0 && isV17Account(rawBytes);

    let v17Insurance: bigint | null = null;
    let v17OiLong: bigint | null = null;
    let v17OiShort: bigint | null = null;
    if (isV17) {
      try {
        const oi = parseMarketGroupV17OI(rawBytes!);
        v17Insurance = oi.insuranceBalance ?? null;
        v17OiLong = oi.totalLongOiQ ?? null;
        v17OiShort = oi.totalShortOiQ ?? null;
      } catch {
        /* fall through — cards handle null gracefully */
      }
    }

    const insuranceBalance = engine?.insuranceFund?.balance ?? v17Insurance;
    const oiLong = v17OiLong;
    const oiShort = v17OiShort;
    const totalOI =
      engine?.totalOpenInterest ??
      (v17OiLong != null && v17OiShort != null ? v17OiLong + v17OiShort : null);

    const hasData = !!engine || v17Insurance != null || totalOI != null;

    return {
      engine,
      params,
      insuranceFund: engine?.insuranceFund ?? null,
      insuranceBalance,
      vault: engine?.vault ?? null,
      totalOI,
      oiLong,
      oiShort,
      fundingRate: engine?.fundingRateBpsPerSlotLast ?? null,
      isV17,
      hasData,
      loading,
    };
  }, [engine, params, loading, raw]);
}
