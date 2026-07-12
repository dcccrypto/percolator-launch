"use client";

import { useEffect, useState } from "react";
import type { Connection } from "@solana/web3.js";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { pollWhenVisible } from "@/lib/pollWhenVisible";

/**
 * H6 (2026-07-08): ENGINE accrue-staleness — distinct from `useOracleFreshness`,
 * which tracks the KEEPER'S PRICE PUSH cadence (`markEwmaLastSlot`, bumped on
 * every `UpdateHyperpMark`/`PushAuthMark`, ~10s, regardless of whether the
 * engine itself has accrued against that price).
 *
 * The engine only advances `lastGoodOracleSlot` when a crank/trade actually
 * ACCRUES the market against a fresh price. A market where the keeper is
 * still happily pushing AuthMark every ~10s (so `useOracleFreshness` reads
 * "fresh", and the UI shows a live, ticking green price) can still be
 * cliff-dead at the engine level if nothing has cranked/traded it in ~500
 * slots (~190s) — every trade/close on it reverts `EngineStale(19)` or
 * `EngineLockActive(21)`, permanently, until a maintainer re-seeds the
 * market. This is exactly the SOL/JUP/TRUMP situation verified live on
 * devnet (273k-283k slots past the cliff) in DEFINITIVE-PLAN-2026-07-08.md
 * §H6 — "the single most dangerous divergence": dead markets display a live
 * price. `useOracleFreshness` cannot catch this on its own; this hook reads
 * the ENGINE's own accrue slot instead of the oracle-push slot.
 *
 * `lastGoodOracleSlot` is exposed both at the wrapper-config level (asset 0,
 * what single-asset playground markets use) and per-asset in
 * `AssetOracleProfileV17` — see percolator-prog `last_good_oracle_slot`,
 * which only advances via crank/trade accrual, never via a bare price push
 * (percolator-prog README §"stamped last_good_oracle_slot").
 */
const ENGINE_STALE_SLOT_LAG = 450n; // cliff is ~500 slots; block with a safety margin
const SLOT_POLL_MS = 10_000;

export interface EngineFreshnessState {
  /** True once the engine's accrue slot has fallen further than ~450 slots behind the live cluster slot. */
  engineStale: boolean;
  /** currentSlot - lastGoodOracleSlot, or null until both are known. */
  slotLag: bigint | null;
  /** Live cluster slot, polled every ~10s (not the reactive slab-poll slot). */
  currentSlot: bigint | null;
  /** The engine's last-accrued slot (wrapper-level `lastGoodOracleSlot`), or null if not yet loaded. */
  lastGoodOracleSlot: bigint | null;
}

/**
 * Module-level shared slot ticker — mirrors useOracleFreshness's shared 1s
 * tick (same problem, different cadence): every `useEngineFreshness()`
 * instance used to run its OWN 10s `getSlot()` poll. OrderTicket,
 * PositionsDock's PositionRow (one per open position), PositionPanel,
 * OtherMarketPositions, and portfolio/page.tsx all mount this hook for the
 * same market simultaneously — 2+ identical RPC pollers hitting the same
 * endpoint for the same value. Collapse to a single interval, refcounted by
 * subscriber count, and pause it entirely while the tab is hidden via
 * `pollWhenVisible` (a backgrounded trade tab has no business polling
 * slots). `connection` is a module-level singleton itself (see
 * useWalletCompat.ts's `getSharedConnection`), so there is only ever one
 * poller regardless of which instance's `connection` value starts it.
 */
let sharedEngineSlot: bigint | null = null;
let sharedEngineSlotListeners: Set<(slot: bigint) => void> | null = null;
let sharedEngineSlotDisposer: (() => void) | null = null;

function subscribeSharedSlot(connection: Connection, listener: (slot: bigint) => void): () => void {
  if (sharedEngineSlotListeners === null) sharedEngineSlotListeners = new Set();
  sharedEngineSlotListeners.add(listener);
  // Replay the last known slot immediately so a newly-mounted subscriber
  // doesn't wait a full poll cycle to see a value the ticker already has.
  if (sharedEngineSlot !== null) listener(sharedEngineSlot);

  if (sharedEngineSlotDisposer === null) {
    const poll = () => {
      connection.getSlot("confirmed").then((slot) => {
        sharedEngineSlot = BigInt(slot);
        sharedEngineSlotListeners?.forEach((cb) => cb(sharedEngineSlot!));
      }).catch(() => {
        // Transient RPC hiccup — keep the last known slot rather than flip
        // to "unknown" (and therefore non-stale) on a single dropped call.
      });
    };
    poll();
    sharedEngineSlotDisposer = pollWhenVisible(poll, SLOT_POLL_MS);
  }

  return () => {
    sharedEngineSlotListeners?.delete(listener);
    if (sharedEngineSlotListeners?.size === 0 && sharedEngineSlotDisposer !== null) {
      sharedEngineSlotDisposer();
      sharedEngineSlotDisposer = null;
      sharedEngineSlot = null;
    }
  };
}

export function useEngineFreshness(): EngineFreshnessState {
  const { wrapperConfigV17 } = useSlabState();
  const { connection } = useConnectionCompat();
  const [currentSlot, setCurrentSlot] = useState<bigint | null>(null);

  useEffect(() => {
    return subscribeSharedSlot(connection, setCurrentSlot);
  }, [connection]);

  // 0n means "never accrued yet" (e.g. a market mid-creation) — treat as
  // unknown rather than infinitely stale so a brand-new market doesn't
  // immediately trip the guard before its first crank lands.
  const lastGoodOracleSlot = wrapperConfigV17 && wrapperConfigV17.lastGoodOracleSlot > 0n
    ? wrapperConfigV17.lastGoodOracleSlot
    : null;

  const slotLag = currentSlot !== null && lastGoodOracleSlot !== null
    ? currentSlot - lastGoodOracleSlot
    : null;

  const engineStale = slotLag !== null && slotLag > ENGINE_STALE_SLOT_LAG;

  return { engineStale, slotLag, currentSlot, lastGoodOracleSlot };
}
