"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { discoverMarkets, type DiscoveredMarket } from "@percolator/sdk";
import { getConfig } from "@/lib/config";

/** Get all unique program IDs to scan (default + all slab tier programs) */
function getAllProgramIds(): PublicKey[] {
  const cfg = getConfig();
  const ids = new Set<string>();
  if (cfg.programId) ids.add(cfg.programId);
  const byTier = (cfg as any).programsBySlabTier as Record<string, string> | undefined;
  if (byTier) {
    Object.values(byTier).forEach((id) => { if (id) ids.add(id); });
  }
  return [...ids].filter(Boolean).map((id) => new PublicKey(id));
}

/**
 * Discovers all Percolator markets across all known program deployments.
 */
export function useMarketDiscovery() {
  const { connection } = useConnectionCompat();
  const [markets, setMarkets] = useState<DiscoveredMarket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const programIds = getAllProgramIds();
    if (programIds.length === 0) {
      setLoading(false);
      setError("PROGRAM_ID not configured");
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const results = await Promise.all(
          programIds.map((pid) => discoverMarkets(connection, pid).catch(() => [] as DiscoveredMarket[]))
        );
        if (!cancelled) {
          setMarkets(results.flat());
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    // Refetch every 30 seconds
    const interval = setInterval(load, 30_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [connection]);

  return { markets, loading, error };
}
