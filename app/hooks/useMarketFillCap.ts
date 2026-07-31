"use client";

/**
 * useMarketFillCap — the market's trade-size limits, for the order ticket.
 *
 * Surfaces the matcher's `maxFillAbs` / `maxInventoryAbs` (immutable, cached
 * forever) AND the LP's live `inventoryBase` (changes with every fill) so the
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
 * The caps resolve once (process-wide cache in getMatcherCaps); the inventory
 * fetches immediately, then refreshes on a 20s visible-tab poll — every fill
 * moves it, and telling the user how much room is left is the whole point.
 */
import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { getMatcherCaps, getMatcherInventory, type MatcherCaps } from "@/lib/matcherCaps";
import { pollWhenVisible } from "@/lib/pollWhenVisible";

const INVENTORY_POLL_MS = 20_000;

export interface MarketFillLimits extends MatcherCaps {
  /**
   * LP's live net inventory in base q units (positive = LP long), or null
   * while unknown. Null disables the inventory check — never the fill cap.
   */
  inventoryBase: bigint | null;
}

export function useMarketFillCap(slabAddress: string): MarketFillLimits | null {
  const { connection } = useConnectionCompat();
  const { programId } = useSlabState();
  const [caps, setCaps] = useState<MatcherCaps | null>(null);
  const [inventoryBase, setInventoryBase] = useState<bigint | null>(null);

  useEffect(() => {
    if (!programId || !slabAddress) return;
    let cancelled = false;
    let slabPk: PublicKey;
    try {
      slabPk = new PublicKey(slabAddress);
    } catch {
      return; // malformed address — nothing to resolve
    }
    void getMatcherCaps(connection, programId, slabPk).then((c) => {
      if (!cancelled) setCaps(c);
    });
    // Live inventory: one immediate read (pollWhenVisible does NOT tick on
    // start), then the visible-tab poll. In-flight guard so a slow RPC can't
    // stack requests.
    let fetching = false;
    const refresh = () => {
      if (fetching) return;
      fetching = true;
      void getMatcherInventory(connection, programId, slabPk)
        .then((inv) => {
          if (!cancelled && inv !== null) setInventoryBase(inv);
        })
        .finally(() => {
          fetching = false;
        });
    };
    refresh();
    const dispose = pollWhenVisible(refresh, INVENTORY_POLL_MS);
    return () => {
      cancelled = true;
      dispose();
    };
  }, [connection, programId, slabAddress]);

  if (!caps) return null;
  return { ...caps, inventoryBase };
}
