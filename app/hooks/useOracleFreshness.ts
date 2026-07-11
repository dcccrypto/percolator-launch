"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useSlabState } from "@/components/providers/SlabProvider";
import { detectOracleMode, type OracleMode } from "@/lib/oraclePrice";

// GH#1338: "unavailable" = oracle has never been cranked (no valid price exists on-chain).
// Distinct from "stale" (had a price, but it's old). Unavailable → hard block on trading.
export type FreshnessLevel = "fresh" | "aging" | "stale" | "unavailable";

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

/** Freshness thresholds in seconds.
 * Hyperp markets are cranked every ~30s but the slab poll interval is longer,
 * so the frontend may not see a price change for 60-90s. Use generous thresholds
 * to avoid false "ORACLE STALE" warnings that block trading.
 */
const FRESH_THRESHOLD = 30;
const AGING_THRESHOLD = 60;

/**
 * BUG 20 fix: previously every `useOracleFreshness()` call created its OWN
 * `setInterval(tick, 1000)` (see the effect below). Trade pages mount this
 * hook from OrderTicket, MarketInfoBar, PositionsDock, and PositionPanel
 * simultaneously (plus OracleFreshnessIndicator / OracleDetailsPanel when
 * open) — that's 4-6 independent 1s timers all recomputing the same
 * elapsed-time math for the same market. Consolidate to a single shared 1s
 * pulse; each hook instance still recomputes its own elapsedSecs/level from
 * its own `lastUpdateMs` in response to the pulse, so per-consumer values and
 * the hook's return shape are unchanged — only the timer is shared.
 */
let sharedTickListeners: Set<() => void> | null = null;
let sharedTickTimer: ReturnType<typeof setInterval> | undefined;

function subscribeSharedTick(listener: () => void): () => void {
  if (sharedTickListeners === null) sharedTickListeners = new Set();
  sharedTickListeners.add(listener);
  if (sharedTickTimer === undefined) {
    sharedTickTimer = setInterval(() => {
      sharedTickListeners?.forEach((cb) => cb());
    }, 1000);
  }
  return () => {
    sharedTickListeners?.delete(listener);
    if (sharedTickListeners?.size === 0 && sharedTickTimer !== undefined) {
      clearInterval(sharedTickTimer);
      sharedTickTimer = undefined;
    }
  };
}

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
    case "unavailable":
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
    case "keeper":
      return "KEEPER";
  }
}

/**
 * Track oracle price freshness for the current market.
 *
 * For admin mode: uses authorityTimestamp (real unix timestamp).
 * For hyperp/pyth modes: tracks when lastEffectivePriceE6 last changed.
 */
export function useOracleFreshness(): OracleFreshnessState {
  const { config, engine, wrapperConfigV17 } = useSlabState();
  const [elapsedSecs, setElapsedSecs] = useState(0);
  const [lastUpdateMs, setLastUpdateMs] = useState<number | null>(null);
  const prevPriceRef = useRef<bigint | null>(null);
  const prevSlotRef = useRef<bigint | null>(null);

  // Guard: detectOracleMode requires both PublicKey fields — skip if either is missing
  // (e.g. partial mock configs in test environments).
  const hasOracleKeys = config?.oracleAuthority != null && config?.indexFeedId != null;
  // v17: pass the raw on-chain oracle_mode byte so byte=3 (AUTH_MARK/keeper) markets are
  // labeled "keeper" instead of falling back to "hyperp" (SlabProvider forces
  // indexFeedId=ZERO for all non-admin v17 modes, so key-based detection alone can't
  // tell keeper apart from hyperp). Matches the other detectOracleMode call sites
  // (MarketStatsCard, MarketBrowser, markets/page.tsx).
  // Memoized: detectOracleMode was recomputed with a fresh {...config} spread on
  // every render. config identity is stable between on-chain updates, so this
  // now recomputes only when the inputs actually change. (The effect below keeps
  // its own recompute — it runs far less often than render.)
  const mode = useMemo(
    () => (config && hasOracleKeys)
      ? detectOracleMode({ ...config, oracleModeByte: wrapperConfigV17?.oracleMode })
      : null,
    [config, hasOracleKeys, wrapperConfigV17?.oracleMode],
  );

  // Track price changes to detect updates
  useEffect(() => {
    if (!config || !hasOracleKeys) return;
    const currentMode = detectOracleMode({ ...config, oracleModeByte: wrapperConfigV17?.oracleMode });

    if (currentMode === "admin") {
      // Admin mode: authorityTimestamp is a real unix timestamp
      const ts = config.authorityTimestamp;
      if (ts > 0n) {
        setLastUpdateMs(Number(ts) * 1000);
      } else {
        // Fallback: admin price is set but timestamp is zero (legacy/static markets).
        // Use authorityPriceE6 (the canonical admin price, matching resolveMarketPriceE6)
        // and fall back to lastEffectivePriceE6 only if authority price is zero.
        const adminPrice = config.authorityPriceE6 > 0n
          ? config.authorityPriceE6
          : config.lastEffectivePriceE6;
        if (adminPrice > 0n) {
          // Reset freshness on each observed price change so the elapsed timer restarts.
          if (prevPriceRef.current !== null && adminPrice !== prevPriceRef.current) {
            setLastUpdateMs(Date.now());
          } else if (prevPriceRef.current === null) {
            // First load — assume relatively fresh
            setLastUpdateMs(Date.now());
          }
          prevPriceRef.current = adminPrice;
        }
      }
    } else {
      // Both hyperp and pyth-pinned: track lastEffectivePriceE6 (= markEwmaE6 for hyperp,
      // updated by the keeper every ~10s via KeeperCrank / UpdateHyperpMark).
      // For hyperp markets, authorityPriceE6 == oracleTargetPriceE6 — a static constant
      // that never changes — so tracking it would prevent freshness from ever resetting
      // and the oracle would always appear stale after 60s. lastEffectivePriceE6 is the
      // live keeper-pushed mark value and is the correct liveness signal.
      // NOTE: Do NOT use authorityTimestamp here — for Hyperp mode that field
      // stores the funding rate, not a unix timestamp.
      const currentPrice = config.lastEffectivePriceE6;

      // v17 keeper/hyperp: the reliable liveness signal is the last-push SLOT
      // (markEwmaLastSlot), which the keeper advances on EVERY push (~10s) even
      // when the price VALUE is unchanged. Tracking the value alone falsely goes
      // stale on a flat/slow market — the EWMA doesn't move between pushes, so
      // the change never fires and trading gets disabled despite a live oracle.
      const pushSlot = wrapperConfigV17?.markEwmaLastSlot ?? null;

      // GH#1338: For hyperp mode, also check lastEffectivePriceE6 (index price from
      // on-chain crank). If it's 0, the oracle-keeper has never cranked this market —
      // the oracle is genuinely unavailable, not just stale. Don't assume "first load = fresh".
      if (currentMode === "hyperp" && config.lastEffectivePriceE6 === 0n && (pushSlot === null || pushSlot === 0n)) {
        // Oracle has never been cranked — mark as unavailable (lastUpdateMs stays null)
        prevPriceRef.current = currentPrice;
        return;
      }

      // Preferred path (v17): reset the freshness timer whenever the push slot
      // advances. The keeper bumps it every ~10s, well under the stale threshold,
      // so a live-but-flat market never falsely reads stale.
      if (pushSlot !== null && pushSlot > 0n) {
        if (prevSlotRef.current === null || pushSlot !== prevSlotRef.current) {
          // First observation OR the keeper pushed again → treat as just-updated.
          setLastUpdateMs(Date.now());
        }
        prevSlotRef.current = pushSlot;
        prevPriceRef.current = currentPrice;
        return;
      }

      // Legacy fallback (v12, no push-slot available): value-change detection.
      if (prevPriceRef.current !== null && currentPrice !== prevPriceRef.current) {
        setLastUpdateMs(Date.now());
      } else if (prevPriceRef.current === null && currentPrice > 0n) {
        // First load — estimate actual staleness from on-chain slot data rather
        // than assuming the price is fresh. engine.currentSlot is the slot at the
        // time the slab was last written; engine.lastCrankSlot is the slot of the
        // last oracle crank. The difference, multiplied by ~400ms/slot, gives the
        // elapsed time since the last real update.
        if (engine != null && engine.currentSlot > 0n && engine.lastCrankSlot > 0n) {
          const slotDelta = Number(engine.currentSlot - engine.lastCrankSlot);
          const estimatedElapsedMs = Math.max(0, slotDelta) * 400;
          setLastUpdateMs(Date.now() - estimatedElapsedMs);
        } else {
          // engine data not yet loaded — optimistically treat as fresh.
          // The elapsed timer will advance naturally; if the price doesn't change
          // it will age to "aging"/"stale" on its own. This avoids a false stale
          // warning on first render before engine state is available.
          setLastUpdateMs(Date.now());
        }
      }
      prevPriceRef.current = currentPrice;
    }
  }, [config, engine, wrapperConfigV17]);

  // Tick every second to update elapsed time — subscribes to the single
  // shared ticker (see subscribeSharedTick above) instead of running its own
  // setInterval per hook instance.
  useEffect(() => {
    if (lastUpdateMs === null) return;

    const tick = () => {
      const elapsed = Math.max(0, Math.floor((Date.now() - lastUpdateMs) / 1000));
      setElapsedSecs(elapsed);
    };
    tick();
    return subscribeSharedTick(tick);
  }, [lastUpdateMs]);

  // GH#1338: If mode is detected but we never got a lastUpdateMs, the oracle is unavailable
  // (e.g. hyperp market never cranked). This is distinct from stale (had a price but it's old).
  const isUnavailable = mode !== null && lastUpdateMs === null;
  const level = isUnavailable ? "unavailable" as FreshnessLevel : getFreshnessLevel(elapsedSecs);

  return {
    mode,
    modeLabel: mode ? getModeLabel(mode) : "",
    elapsedSecs,
    level,
    color: getFreshnessColor(level),
    // Publisher data now fetched dynamically by useOraclePublishers hook (PERC-371)
    publisherCount: null,
    publisherTotal: null,
    ready: mode !== null && lastUpdateMs !== null,
    lastUpdateMs,
  };
}
