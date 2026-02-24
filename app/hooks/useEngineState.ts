"use client";

import { useMemo } from "react";
import { useSlabState } from "@/components/providers/SlabProvider";
import type { EngineState, RiskParams, InsuranceFund } from "@percolator/sdk";

export interface DerivedEngineState {
  engine: EngineState | null;
  params: RiskParams | null;
  insuranceFund: InsuranceFund | null;
  vault: bigint | null;
  totalOI: bigint | null;
  fundingRate: bigint | null;
  loading: boolean;
}

export function useEngineState(): DerivedEngineState {
  const { engine, params, loading } = useSlabState();
  return useMemo(() => ({
    engine, params,
    insuranceFund: engine?.insuranceFund ?? null,
    vault: engine?.vault ?? null,
    totalOI: engine?.totalOpenInterest ?? null,
    fundingRate: engine?.fundingRateBpsPerSlotLast ?? null,
    loading,
  }), [engine, params, loading]);
}
