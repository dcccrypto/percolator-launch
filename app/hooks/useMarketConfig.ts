"use client";

import { useMemo } from "react";
import { useSlabState } from "@/components/providers/SlabProvider";
import type { MarketConfig } from "@percolator/sdk";

export function useMarketConfig(): MarketConfig | null {
  const { config } = useSlabState();
  return useMemo(() => config, [config]);
}
