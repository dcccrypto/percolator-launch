"use client";

/**
 * useMarketFillCap — the market's trade-size limits, for the order ticket.
 *
 * Surfaces the matcher's `maxFillAbs` / `maxInventoryAbs` (NEARLY immutable —
 * see below) AND the LP's live `inventoryBase` (changes with every fill) so the
 * ticket can refuse an order the market physically cannot fill INSTEAD of
 * letting the user sign a transaction that reverts with a bare
 * `InvalidAccountData`. Two distinct rejections are prevented:
 *
 *   1. size > maxFillAbs                      — over the per-trade cap
 *   2. |inventory ± size| > maxInventoryAbs   — over the LP's NET exposure cap
 *
 * (2) is why the live inventory is here: a one-sided market fills up, and
 * from then on even small same-direction orders bounce while the other
 * direction still works. See lib/marketCapacity.ts for the sign conventions.
 *
 * Both are re-read on the same 20s visible-tab poll. The inventory because
 * every fill moves it, and telling the user how much room is left is the whole
 * point. The caps because they are NOT immutable: lib/matcherCaps.ts is
 * explicit that SetMatcherConfig (tag 68) can re-point or disable the matcher
 * at any time, so it bounds staleness with a 300s TTL and exposes
 * invalidateMatcherCaps() (called from useTrade on a trade failure). Neither
 * can reach this hook unless it asks again — within the TTL, asking is a
 * module-cache hit, not a network call.
 *
 * Two rules the re-read follows, both learned the hard way:
 *   - a caps read that comes back null NEVER blanks a good value. getMatcherCaps
 *     returns null for "no matcher config" AND for "the RPC call failed" and
 *     cannot tell them apart, so the safe default for a VALIDATION layer is to
 *     keep blocking over-cap orders rather than silently permit everything.
 *   - the FIRST resolve retries on a bounded backoff. Without it a single 429
 *     at mount disabled the cap guards for the entire market visit.
 */
import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { getLpInventoryState, getMatcherCaps, type MatcherCaps } from "@/lib/matcherCaps";
import { lpInventoryRoomQ } from "@/lib/limits/lp-inventory-room";
import type { TradeSide } from "@/lib/marketCapacity";
import { pollWhenVisible } from "@/lib/pollWhenVisible";

const INVENTORY_POLL_MS = 20_000;
/**
 * Backoff for retrying the FIRST caps resolve. getMatcherCaps returns null for
 * both "this market has no matcher config" and "the RPC call failed", so the
 * hook cannot tell them apart and simply retries a bounded number of times:
 * enough that a transient 429 at mount doesn't disable the cap guards for the
 * whole visit, few enough that a genuinely cap-less market (v12 slab, mock
 * slab, broken launch) doesn't sit in an unbounded getProgramAccounts loop.
 */
const CAPS_RETRY_BACKOFF_MS = [2_000, 8_000, 30_000];

export interface MarketFillLimits extends MatcherCaps {
  /**
   * LP's live net inventory in base q units (positive = LP long), or null
   * while unknown. Null disables the inventory check — never the fill cap.
   */
  inventoryBase: bigint | null;
  /**
   * The LP's REAL (ADL-effective) engine position, or null while unknown. The counter above goes
   * stale on liquidation / ADL / reset (matcher-inventory drift 2026-10-03).
   */
  lpRealQ: bigint | null;
  /** The upgraded wrapper + matcher price from the real position (lib/program-upgrade-detect.ts). */
  syncLive: boolean;
  /**
   * The LP's inventory room on `side` (`lpInventoryRoomQ`): min(counter, real) until the upgrade
   * is detected, the real position after. null = unknown (no inventory check).
   */
  sideRoomQ: (side: TradeSide) => bigint | null;
}

export function useMarketFillCap(slabAddress: string): MarketFillLimits | null {
  const { connection } = useConnectionCompat();
  const { programId } = useSlabState();
  const [caps, setCaps] = useState<MatcherCaps | null>(null);
  const [inventoryBase, setInventoryBase] = useState<bigint | null>(null);
  const [lpRealQ, setLpRealQ] = useState<bigint | null>(null);
  const [syncLive, setSyncLive] = useState(false);

  // PERC-9204: stable primitive standing in for `programId` below. The effect
  // BLANKS caps+inventory before refetching, which is right on a real market
  // switch and wrong on a poll. SlabProvider rebuilds programId as a brand-new
  // PublicKey on every slab poll (`programId: owner ?? s.programId`, where
  // `owner` comes fresh off each getAccountInfo), and parseSlab only
  // short-circuits on byte-identical slabs — so on any market with activity
  // the identity churned every ~3s, the effect re-ran, and the capacity row
  // blinked out. base58 is stable across polls and still changes on a real
  // program change. Mirrors usePositionNft.ts and useUserAccount.ts.
  const programIdStr = programId?.toBase58() ?? null;

  useEffect(() => {
    // Reset on market switch: without this, market B's order briefly
    // validates against market A's caps and inventory.
    setCaps(null);
    setInventoryBase(null);
    setLpRealQ(null);
    setSyncLive(false);
    if (!programIdStr || !slabAddress) return;
    let cancelled = false;
    let dispose: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let slabPk: PublicKey;
    let programPk: PublicKey;
    try {
      slabPk = new PublicKey(slabAddress);
      programPk = new PublicKey(programIdStr);
    } catch {
      return; // malformed address — nothing to resolve
    }
    // Live inventory: one immediate read (pollWhenVisible does NOT tick on
    // start), then the visible-tab poll. In-flight guard so a slow RPC can't
    // stack requests.
    let fetching = false;
    const refresh = () => {
      if (fetching) return;
      fetching = true;
      void getLpInventoryState(connection, programPk, slabPk)
        .then((st) => {
          if (cancelled || st === null) return;
          if (st.counterQ !== null) setInventoryBase(st.counterQ);
          if (st.realQ !== null) setLpRealQ(st.realQ);
          setSyncLive(st.syncLive);
        })
        .finally(() => {
          fetching = false;
        });
    };
    // One poll tick re-reads BOTH. Caps within the 300s TTL is a module-cache
    // hit, so this costs nothing until the TTL lapses or useTrade invalidates
    // after a failed trade — which is exactly when the ticket needs to hear
    // about it. A null here is NOT allowed to blank a good value: see the
    // header. Inventory has the same rule, in `refresh` above.
    const tick = () => {
      void getMatcherCaps(connection, programPk, slabPk).then((c) => {
        if (!cancelled && c) setCaps(c);
      });
      refresh();
    };

    // Polling starts ONLY once caps resolve: a market with no matcher config
    // would otherwise re-run a full getProgramAccounts scan every 20s per
    // mounted instance, forever, for nothing.
    let attempt = 0;
    const resolveCaps = () => {
      void getMatcherCaps(connection, programPk, slabPk).then((c) => {
        if (cancelled) return;
        setCaps(c);
        if (c) {
          refresh();
          dispose = pollWhenVisible(tick, INVENTORY_POLL_MS);
          return;
        }
        // Either there is no matcher config or the read failed, and we can't
        // distinguish. Retry a bounded number of times rather than leaving the
        // ticket with no cap guards for the rest of the visit.
        if (attempt < CAPS_RETRY_BACKOFF_MS.length) {
          retryTimer = setTimeout(resolveCaps, CAPS_RETRY_BACKOFF_MS[attempt++]);
        }
      });
    };
    resolveCaps();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      dispose?.();
    };
  }, [connection, programIdStr, slabAddress]);

  if (!caps) return null;
  const sideRoomQ = (side: TradeSide) =>
    lpInventoryRoomQ({ counterQ: inventoryBase, realQ: lpRealQ, maxInventoryAbs: caps.maxInventoryAbs, syncLive }, side);
  return { ...caps, inventoryBase, lpRealQ, syncLive, sideRoomQ };
}
