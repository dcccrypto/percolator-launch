"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { fetchTokenMetaBatch, type TokenMeta } from "@/lib/tokenMeta";

/**
 * Fetch TokenMeta for an array of mints using efficient batch resolution.
 * Uses Helius DAS getAssetBatch + batched Metaplex PDA lookups instead of
 * N individual RPC calls. Returns a Map keyed by base58 mint address.
 */
export function useMultiTokenMeta(mints: PublicKey[]): Map<string, TokenMeta> {
  const { connection } = useConnectionCompat();
  const [metaMap, setMetaMap] = useState<Map<string, TokenMeta>>(new Map());

  // Defense-in-depth: some callers derive mints from market config shims that
  // can be undefined for markets whose type doesn't match the caller's
  // assumption (e.g. v17 markets returning an empty `market.config` from the
  // SDK). Filter those out here instead of crashing on `.toBase58()` below —
  // a missing mint degrades to "no metadata for this position" rather than
  // taking down the whole component tree.
  const definedMints = mints.filter((m): m is PublicKey => !!m);

  // Stable key for the mints array
  const mintsKey = definedMints.map((m) => m.toBase58()).sort().join(",");

  useEffect(() => {
    if (definedMints.length === 0) {
      setMetaMap(new Map());
      return;
    }

    let cancelled = false;

    fetchTokenMetaBatch(connection, definedMints)
      .then((map) => {
        if (!cancelled) setMetaMap(map);
      })
      .catch(() => {
        // GH#1808: On fetch failure, set an empty map explicitly so callers can detect
        // completion vs. never-resolved. Keeps existing data if we had partial results.
        if (!cancelled && metaMap.size === 0) {
          setMetaMap(new Map());
        }
      });

    return () => { cancelled = true; };
  }, [connection, mintsKey]);

  return metaMap;
}
