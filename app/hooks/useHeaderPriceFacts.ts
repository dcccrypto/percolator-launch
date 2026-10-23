"use client";

import { useMemo } from "react";
import { useOracleFreshness } from "@/hooks/useOracleFreshness";
import { oracleAgeSecs } from "@/lib/oracle-stale-gate";
import type { HeaderPriceFacts } from "@/lib/market-header-status";

/**
 * C2: the price facts the header chip, the header status line and the header price share, read from the same
 * freshness hook the ticket reads, so the three surfaces cannot disagree about the price state.
 */
export function useHeaderPriceFacts(): HeaderPriceFacts {
  const { level, ready, elapsedSecs, lastUpdateMs } = useOracleFreshness();
  return useMemo(
    () => ({
      oracleStale: level === "stale",
      priceAgeSecs: ready && level !== "unavailable" ? oracleAgeSecs(lastUpdateMs, elapsedSecs) : null,
    }),
    [level, ready, elapsedSecs, lastUpdateMs],
  );
}
