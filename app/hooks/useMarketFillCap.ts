"use client";

/**
 * useMarketFillCap — the market's per-trade size ceiling, for the order ticket.
 *
 * Surfaces the matcher's `maxFillAbs` (and `maxInventoryAbs`) so the ticket can
 * refuse an order the market physically cannot fill INSTEAD of letting the user
 * sign a transaction that reverts with a bare `InvalidAccountData`. See
 * lib/matcherCaps.ts for why exceeding the cap fails outright rather than
 * partially filling.
 *
 * The caps are immutable per market, so this resolves once and is cached
 * process-wide by getMatcherCaps.
 */
import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { getMatcherCaps, type MatcherCaps } from "@/lib/matcherCaps";

export function useMarketFillCap(slabAddress: string): MatcherCaps | null {
  const { connection } = useConnectionCompat();
  const { programId } = useSlabState();
  const [caps, setCaps] = useState<MatcherCaps | null>(null);

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
    return () => {
      cancelled = true;
    };
  }, [connection, programId, slabAddress]);

  return caps;
}
