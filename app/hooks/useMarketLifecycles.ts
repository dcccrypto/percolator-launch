"use client";

/**
 * The lifecycle state of every market on the /markets list (lib/v22/market-lifecycle.ts), read from chain.
 *
 * One `getMultipleAccountsInfo` per 100 slabs with a 1,280-byte `dataSlice` (the wrapper config and the group header; a market
 * is far larger), refreshed every 30 s, plus the shared cluster slot. v2.2 builds only: with the flag off nothing is read and
 * the map is empty (the caller then falls back to the blocklist alone).
 */
import { useMemo } from "react";
import useSWR from "swr";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { useClusterSlot } from "@/hooks/useClusterSlot";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { isBlockedSlab } from "@/lib/blocklist";
import { LIFECYCLE_SLICE_LEN, decodeMarketLifecycleFields, deriveMarketLifecycle, type MarketLifecycle, type MarketLifecycleFields } from "@/lib/v22/market-lifecycle";

const BATCH = 100;
const EMPTY: ReadonlyMap<string, MarketLifecycle> = new Map();

export function useMarketLifecycles(slabs: readonly string[]): ReadonlyMap<string, MarketLifecycle> {
  const { connection } = useConnectionCompat();
  const enabled = isDevnetV22Enabled();
  const clusterSlot = useClusterSlot(enabled);
  const key = enabled && slabs.length > 0 ? `market-lifecycle-fields:${[...slabs].sort().join(",")}` : null;
  const { data } = useSWR<Map<string, MarketLifecycleFields | null>>(
    key,
    async () => {
      const out = new Map<string, MarketLifecycleFields | null>();
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
          out.set(k.toBase58(), info ? decodeMarketLifecycleFields(new Uint8Array(info.data)) : null);
        });
      }
      return out;
    },
    { dedupingInterval: 30_000, refreshInterval: 30_000, revalidateOnFocus: false },
  );

  const slabsKey = slabs.join(",");
  return useMemoMap(data, clusterSlot, slabsKey, slabs);
}

function useMemoMap(
  data: Map<string, MarketLifecycleFields | null> | undefined,
  clusterSlot: bigint | null,
  slabsKey: string,
  slabs: readonly string[],
): ReadonlyMap<string, MarketLifecycle> {
  return useMemo(() => {
    if (!data) return EMPTY;
    const out = new Map<string, MarketLifecycle>();
    for (const s of slabs) out.set(s, deriveMarketLifecycle({ fields: data.get(s) ?? null, clusterSlot, blocklisted: isBlockedSlab(s) }));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- slabs is keyed on slabsKey (stable string)
  }, [data, clusterSlot, slabsKey]);
}
