"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { fetchTokenMeta, type TokenMeta } from "@/lib/tokenMeta";

/**
 * Fetch TokenMeta for an array of mints in parallel.
 * Returns a Map keyed by base58 mint address.
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

    // Deduplicate mints
    const unique = [...new Set(mints.map((m) => m.toBase58()))];

    Promise.all(
      unique.map(async (base58) => {
        try {
          const meta = await fetchTokenMeta(connection, new PublicKey(base58));
          return [base58, meta] as const;
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      const map = new Map<string, TokenMeta>();
      for (const r of results) {
        if (r) map.set(r[0], r[1]);
      }
      setMetaMap(map);
    });

    return () => { cancelled = true; };
  }, [connection, mintsKey]);

  return metaMap;
}
