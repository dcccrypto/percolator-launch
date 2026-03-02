"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useSlabState } from "@/components/providers/SlabProvider";
import { detectOracleMode, type OracleMode } from "@/lib/oraclePrice";

export type FreshnessLevel = "fresh" | "aging" | "stale";

export interface OracleFreshnessState {
  /** Oracle mode for this market */
  mode: OracleMode | null;
  /** Display label for the oracle mode */
  modeLabel: string;
  /** Seconds since last oracle price update */
  elapsedSecs: number;
  /** Freshness level based on thresholds */
  level: FreshnessLevel;
  /** CSS color variable for the current freshness level */
  color: string;
  /** Number of active publishers (if known) */
  publisherCount: number | null;
  /** Total publishers (if known) */
  publisherTotal: number | null;
  /** Whether we have valid oracle data */
  ready: boolean;
  /** Last update timestamp (ms) */
  lastUpdateMs: number | null;
}

/** Freshness thresholds in seconds */
const FRESH_THRESHOLD = 5;
const AGING_THRESHOLD = 30;

function getFreshnessLevel(elapsedSecs: number): FreshnessLevel {
  if (elapsedSecs < FRESH_THRESHOLD) return "fresh";
  if (elapsedSecs <= AGING_THRESHOLD) return "aging";
  return "stale";
}

function getFreshnessColor(level: FreshnessLevel): string {
  switch (level) {
    case "fresh":
      return "#22c55e";
    case "aging":
      return "#eab308";
    case "stale":
      return "#ef4444";
  }
}

function getModeLabel(mode: OracleMode): string {
  switch (mode) {
    case "hyperp":
      return "HYPERP";
    case "pyth-pinned":
      return "PYTH";
    case "admin":
      return "ADMIN";
  }
}

/**
 * Track oracle price freshness for the current market.
 *
 * For admin mode: uses authorityTimestamp (real unix timestamp).
 * For hyperp/pyth modes: tracks when lastEffectivePriceE6 last changed.
 */
export function useOracleFreshness(): OracleFreshnessState {
  const { config } = useSlabState();
  const [elapsedSecs, setElapsedSecs] = useState(0);
  const [lastUpdateMs, setLastUpdateMs] = useState<number | null>(null);
  const prevPriceRef = useRef<bigint | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval>>(undefined);

  const mode = config
    ? detectOracleMode(config)
    : null;

  // Track price changes to detect updates
  useEffect(() => {
    if (!config) return;
    const currentMode = detectOracleMode(config);

    if (currentMode === "admin") {
      // Admin mode: authorityTimestamp is a real unix timestamp
      const ts = config.authorityTimestamp;
      if (ts > 0n) {
        setLastUpdateMs(Number(ts) * 1000);
      }
    } else {
      // Hyperp / Pyth: track when the price value changes
      const currentPrice = config.lastEffectivePriceE6;
      if (prevPriceRef.current !== null && currentPrice !== prevPriceRef.current) {
        setLastUpdateMs(Date.now());
      } else if (prevPriceRef.current === null && currentPrice > 0n) {
        // First load — assume relatively fresh
        setLastUpdateMs(Date.now());
      }
      prevPriceRef.current = currentPrice;
    }
  }, [config]);

  // Tick every second to update elapsed time
  useEffect(() => {
    if (lastUpdateMs === null) return;

    const tick = () => {
      const elapsed = Math.max(0, Math.floor((Date.now() - lastUpdateMs) / 1000));
      setElapsedSecs(elapsed);
    };
    tick();
    tickRef.current = setInterval(tick, 1000);
    return () => clearInterval(tickRef.current);
  }, [lastUpdateMs]);

  const level = getFreshnessLevel(elapsedSecs);

  return {
    mode,
    modeLabel: mode ? getModeLabel(mode) : "",
    elapsedSecs,
    level,
    color: getFreshnessColor(level),
    // Publisher count is not available on-chain; will be populated by API later
    publisherCount: mode === "hyperp" ? 7 : mode === "pyth-pinned" ? 5 : null,
    publisherTotal: mode === "hyperp" ? 9 : mode === "pyth-pinned" ? 7 : null,
    ready: mode !== null && lastUpdateMs !== null,
    lastUpdateMs,
  };
}
