"use client";

/**
 * The lifecycle state of every market on the /markets list (lib/v22/market-lifecycle.ts), read from chain.
 *
 * One `getMultipleAccountsInfo` per 100 slabs with a `dataSlice` of the market-group header (a market is far larger), refreshed every
 * 30 s, plus the shared cluster slot. v2.2 builds only: with the flag off nothing is read, `ready` is true and the map is empty.
 *
 * Blocklisted slabs never reach this hook from /markets (the list filters them before), so "retired" here means a CloseSlab tombstone;
 * the blocklist is still passed to the derivation so any other caller gets it right.
 *
 * The returned map keeps its identity while no market changes state: the 10 s cluster-slot tick re-derives, but an unchanged result
 * does not refilter the list.
 */
import { useMemo, useRef } from "react";
import useSWR from "swr";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { useClusterSlot } from "@/hooks/useClusterSlot";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { isBlockedSlab } from "@/lib/blocklist";
import { LIFECYCLE_SLICE_LEN, deriveMarketLifecycle, type MarketLifecycle } from "@/lib/v22/market-lifecycle";

const BATCH = 100;
const EMPTY: ReadonlyMap<string, MarketLifecycle> = new Map();

/** Same states and windows for every slab = same map. */
function sameLifecycles(a: ReadonlyMap<string, MarketLifecycle>, b: ReadonlyMap<string, MarketLifecycle>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || w.state !== v.state || w.ownerOnlyEndsAtSlot !== v.ownerOnlyEndsAtSlot) return false;
  }
  return true;
}

export interface MarketLifecycles {
  lifecycles: ReadonlyMap<string, MarketLifecycle>;
  /** The first read finished (or nothing is read: flag off, no markets). Until then the list should not claim a state. */
  ready: boolean;
}

export function useMarketLifecycles(slabs: readonly string[]): MarketLifecycles {
  const { connection } = useConnectionCompat();
  const enabled = isDevnetV22Enabled();
  const clusterSlot = useClusterSlot(enabled);
  const key = enabled && slabs.length > 0 ? `market-lifecycle-bytes:${[...slabs].sort().join(",")}` : null;
  const { data, error } = useSWR<Map<string, Uint8Array | null>>(
    key,
    async () => {
      const out = new Map<string, Uint8Array | null>();
      for (let i = 0; i < slabs.length; i += BATCH) {
        const batch = slabs.slice(i, i + BATCH);
        const keys: PublicKey[] = [];
        for (const s of batch) {
          try {
            keys.push(new PublicKey(s));
          } catch {
            out.set(s, null);
          }
        }
        const infos = await connection.getMultipleAccountsInfo(keys, { commitment: "confirmed", dataSlice: { offset: 0, length: LIFECYCLE_SLICE_LEN } });
        keys.forEach((k, j) => {
          const info = infos[j];
          out.set(k.toBase58(), info ? new Uint8Array(info.data) : null);
        });
      }
      return out;
    },
    { dedupingInterval: 30_000, refreshInterval: 30_000, revalidateOnFocus: false },
  );

  const prev = useRef<ReadonlyMap<string, MarketLifecycle>>(EMPTY);
  const slabsKey = slabs.join(",");
  const lifecycles = useMemo(() => {
    if (!data) return EMPTY;
    const next = new Map<string, MarketLifecycle>();
    for (const s of slabs) next.set(s, deriveMarketLifecycle({ data: data.get(s) ?? null, clusterSlot, blocklisted: isBlockedSlab(s) }));
    if (sameLifecycles(prev.current, next)) return prev.current;
    prev.current = next;
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- slabs is keyed on slabsKey (stable string)
  }, [data, clusterSlot, slabsKey]);

  // A failed read is not "loading for ever": the list then shows every market as live (nothing claimed), as before this feature.
  const ready = !enabled || slabs.length === 0 || data !== undefined || error !== undefined;
  return { lifecycles, ready };
}
