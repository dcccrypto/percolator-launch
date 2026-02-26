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

  // Stable key for the mints array
  const mintsKey = mints.map((m) => m.toBase58()).sort().join(",");

  useEffect(() => {
    if (mints.length === 0) {
      setMetaMap(new Map());
      return;
    }

    let cancelled = false;

    fetchTokenMetaBatch(connection, mints)
      .then((map) => {
        if (!cancelled) setMetaMap(map);
      })
      .catch(() => {
        // Keep existing map on error
      });

    return () => { cancelled = true; };
  }, [connection, mintsKey]);

  return metaMap;
}
